/**
 * TrustValidator — seven-step plugin trust pipeline (SPEC-019-3-01..04).
 *
 * Implements TDD-019 §10.2's seven-step validation order. SPEC-019-3-01
 * lays the skeleton: every step is stubbed to return a trusted verdict so
 * the class compiles and is importable. Subsequent specs replace each stub:
 *
 *   - SPEC-019-3-02 fills in `stepTrustStatus` (allowlist / permissive /
 *     strict) and the strict-mode privileged-reviewer arm of
 *     `stepCapabilityValidation`.
 *   - SPEC-019-3-03 replaces `verifySignature` with a real Ed25519 / RSA-PSS
 *     verifier and implements `stepMetaReviewerAudit`.
 *   - SPEC-019-3-04 wires `isTrusted` through `reloadTrustedSet` + the
 *     audit emitter.
 *
 * The class is constructed with the active `ExtensionsConfig`, the shared
 * `ValidationPipeline` (from PLAN-019-2; consumed by `stepManifestSyntax`
 * once SPEC-019-3-02+ wires it), and the absolute path to the trusted-keys
 * directory (`~/.claude/trusted-keys/` by default).
 *
 * @module intake/hooks/trust-validator
 */

import type {
  ExtensionsConfig,
  HookManifest,
  TrustVerdict,
} from './types';
import type { ValidationPipeline } from './validation-pipeline';
import type { MetaReviewCache, MetaReviewVerdict } from './meta-review-cache';
import { SignatureVerifier } from './signature-verifier';
import type {
  AuditDecision,
  TrustAuditEmitter,
  TrustAuditEntry,
} from './audit-emitter';

/**
 * Pluggable spawner contract for invoking the `agent-meta-reviewer` agent
 * (SPEC-019-3-03). Real implementation comes from PLAN-005 / agent
 * registry; tests inject a stub that returns a fixed verdict.
 */
export interface AgentSpawner {
  invoke(
    agentName: 'agent-meta-reviewer',
    payload: { manifest: HookManifest; triggerReasons: string[] },
  ): Promise<{ pass: boolean; findings: string[] }>;
}

/**
 * Optional dependencies for the trust validator. SPEC-019-3-01 leaves
 * them undefined (skeleton stubs); SPEC-019-3-03 injects real
 * implementations. Keeping them optional means the skeleton remains
 * importable without dragging in crypto / agent infrastructure.
 */
export interface TrustValidatorDeps {
  /** Real Ed25519 / RSA-PSS verifier; SPEC-019-3-03. */
  signatureVerifier?: SignatureVerifier;
  /** File-backed verdict cache; SPEC-019-3-03. */
  metaReviewCache?: MetaReviewCache;
  /** Agent spawner used for `agent-meta-reviewer` invocation; SPEC-019-3-03. */
  agentSpawner?: AgentSpawner;
  /** Audit emitter for trust decisions; SPEC-019-3-04. */
  auditEmitter?: TrustAuditEmitter;
}

/**
 * Critical hook points per TDD-019 §6 — failure_mode `block` on these
 * triggers the meta-review.
 */
const CRITICAL_HOOK_POINTS: ReadonlySet<string> = new Set([
  'pre-tool-use',
  'pre-commit',
  'pre-push',
]);

export class TrustValidator {
  protected readonly signatureVerifier?: SignatureVerifier;
  protected readonly metaReviewCache?: MetaReviewCache;
  protected readonly agentSpawner?: AgentSpawner;
  protected readonly auditEmitter?: TrustAuditEmitter;
  /**
   * O(1) trust set rebuilt by `reloadTrustedSet()`. Lookup beats a
   * linear scan over `config.allowlist` once the allowlist grows past
   * a few entries, and is required by the executor's per-call check
   * (SPEC-019-3-04 isTrusted benchmark: <2µs at 10k entries).
   */
  protected trustedSet: Set<string> = new Set();

  /**
   * @param config the `extensions` section of the active autonomous-dev
   *   config. Treat as immutable for the lifetime of the validator; reloads
   *   construct a new instance.
   * @param validationPipeline shared pipeline used by `stepManifestSyntax`
   *   to validate the manifest against `hook-manifest-v1.json`. Wiring
   *   lands in SPEC-019-3-02+.
   * @param trustedKeysDir absolute path to the trusted-keys directory
   *   (`~/.claude/trusted-keys/` by default). Read by SPEC-019-3-03's
   *   signature verifier.
   * @param deps optional crypto / agent / cache dependencies. When
   *   omitted, `signatureVerifier` defaults to one rooted at
   *   `trustedKeysDir`; `metaReviewCache` and `agentSpawner` remain
   *   undefined and any meta-review trigger short-circuits to trusted
   *   (the SPEC-019-3-03 stub fallback).
   */
  constructor(
    protected readonly config: ExtensionsConfig,
    protected readonly validationPipeline: ValidationPipeline,
    protected readonly trustedKeysDir: string,
    deps: TrustValidatorDeps = {},
  ) {
    this.signatureVerifier =
      deps.signatureVerifier ?? new SignatureVerifier(trustedKeysDir);
    this.metaReviewCache = deps.metaReviewCache;
    this.agentSpawner = deps.agentSpawner;
    this.auditEmitter = deps.auditEmitter;
    this.reloadTrustedSet();
  }

  /**
   * Rebuild the trusted-id Set from the active config's allowlist.
   * Called by the constructor and by the SIGUSR1 reload handler
   * (PLAN-019-1) after the new config is loaded so revocations
   * propagate to the executor without recreating the validator.
   */
  reloadTrustedSet(): void {
    this.trustedSet = new Set(this.config.allowlist);
  }

  /**
   * Run the seven-step validation order. Returns the first failing
   * verdict; if every step passes, returns `{ trusted: true }`.
   *
   * The step methods are private and intentionally narrow — each one
   * decides one orthogonal question and returns a verdict the outer loop
   * can short-circuit on.
   */
  async validatePlugin(
    manifest: HookManifest,
    manifestPath: string,
  ): Promise<TrustVerdict> {
    const steps: Array<() => Promise<TrustVerdict>> = [
      () => this.stepManifestSyntax(manifest, manifestPath),
      () => this.stepTrustStatus(manifest, manifestPath),
      () => this.stepSignatureVerification(manifest, manifestPath),
      () => this.stepCapabilityValidation(manifest),
      () => this.stepMetaReviewerAudit(manifest),
      () => this.stepDependencyResolution(manifest),
      () => this.stepRegistration(manifest),
    ];
    let aggregateRequiresMetaReview = false;
    let aggregateVerdict: TrustVerdict['metaReviewVerdict'];
    for (const step of steps) {
      const result = await step();
      if (result.requiresMetaReview) aggregateRequiresMetaReview = true;
      if (result.metaReviewVerdict) {
        aggregateVerdict = result.metaReviewVerdict;
        // Per SPEC-019-3-04: meta-review invocations always emit a
        // dedicated entry in addition to the registered/rejected entry.
        this.emitAudit(
          'meta-review-verdict',
          manifest,
          undefined,
          result.metaReviewVerdict,
        );
      }
      if (!result.trusted) {
        this.emitAudit('rejected', manifest, result.reason);
        return result;
      }
    }
    this.emitAudit(
      'registered',
      manifest,
      undefined,
      aggregateVerdict,
    );
    return {
      trusted: true,
      requiresMetaReview: aggregateRequiresMetaReview,
      ...(aggregateVerdict ? { metaReviewVerdict: aggregateVerdict } : {}),
    };
  }

  /**
   * Emit a single trust-decision audit entry. No-op when no audit
   * emitter is wired (the skeleton fallback used in tests that do not
   * exercise audit assertions).
   */
  protected emitAudit(
    decision: AuditDecision,
    manifest: HookManifest,
    reason?: string,
    metaReviewVerdict?: { pass: boolean; findings: string[] },
  ): void {
    if (!this.auditEmitter) return;
    const entry: TrustAuditEntry = {
      decision,
      pluginId: manifest.id,
      pluginVersion: manifest.version,
      timestamp: new Date().toISOString(),
      ...(reason !== undefined ? { reason } : {}),
      ...(metaReviewVerdict ? { metaReviewVerdict } : {}),
    };
    this.auditEmitter.emit(entry);
  }

  /**
   * O(1) runtime trust check (SPEC-019-3-04). Backed by `trustedSet`
   * so the executor's per-call lookup is constant-time regardless of
   * allowlist size. The audit entry for a runtime revocation is
   * emitted by the executor (which knows the hook point), not here.
   */
  isTrusted(pluginId: string): boolean {
    return this.trustedSet.has(pluginId);
  }

  // ------------------------------------------------------------------
  // Seven steps — names match TDD-019 §10.2 verbatim. Stubs return
  // trusted verdicts; replaced incrementally by SPEC-019-3-02..04.
  // ------------------------------------------------------------------

  protected async stepManifestSyntax(
    _manifest: HookManifest,
    _manifestPath: string,
  ): Promise<TrustVerdict> {
    return { trusted: true, requiresMetaReview: false };
  }

  /**
   * Per-mode trust dispatch (SPEC-019-3-02). Switches over
   * `config.trust_mode` and delegates to one of three private helpers.
   * Exhaustiveness is checked at compile time via the `never` cast in
   * the default branch — adding a new TrustMode without a case here is
   * a TS error.
   */
  protected async stepTrustStatus(
    manifest: HookManifest,
    manifestPath: string,
  ): Promise<TrustVerdict> {
    switch (this.config.trust_mode) {
      case 'allowlist':
        return this.checkAllowlistMode(manifest);
      case 'permissive':
        return this.checkPermissiveMode(manifest, manifestPath);
      case 'strict':
        return this.checkStrictMode(manifest, manifestPath);
      default: {
        const exhaustive: never = this.config.trust_mode;
        return {
          trusted: false,
          reason: `unknown trust_mode: ${String(exhaustive)}`,
          requiresMetaReview: false,
        };
      }
    }
  }

  /**
   * Allowlist mode (SPEC-019-3-02): plugin id MUST appear in
   * `extensions.allowlist`. Signature is NOT consulted — operator's
   * manual trust decision is sufficient.
   */
  private checkAllowlistMode(manifest: HookManifest): TrustVerdict {
    if (!this.config.allowlist.includes(manifest.id)) {
      return {
        trusted: false,
        reason: 'not in allowlist',
        requiresMetaReview: false,
      };
    }
    return { trusted: true, requiresMetaReview: false };
  }

  /**
   * Permissive mode (SPEC-019-3-02): trust by default. If
   * `signature_verification` is on, gate on signature; otherwise
   * trust everything. Allowlist is advisory.
   */
  private async checkPermissiveMode(
    manifest: HookManifest,
    manifestPath: string,
  ): Promise<TrustVerdict> {
    if (!this.config.signature_verification) {
      return { trusted: true, requiresMetaReview: false };
    }
    const signed = await this.verifySignature(manifest, manifestPath);
    if (!signed) {
      return {
        trusted: false,
        reason:
          'permissive mode requires valid signature; none found or invalid',
        requiresMetaReview: false,
      };
    }
    return { trusted: true, requiresMetaReview: false };
  }

  /**
   * Strict mode (SPEC-019-3-02): plugin MUST be on allowlist AND have a
   * valid signature. The privileged-reviewer check fires in
   * `stepCapabilityValidation` — see SPEC-019-3-02 §"strict mode" notes
   * for why the rejection is split across steps (audit attribution).
   */
  private async checkStrictMode(
    manifest: HookManifest,
    manifestPath: string,
  ): Promise<TrustVerdict> {
    if (!this.config.allowlist.includes(manifest.id)) {
      return {
        trusted: false,
        reason: 'strict mode: plugin not in allowlist',
        requiresMetaReview: false,
      };
    }
    const signed = await this.verifySignature(manifest, manifestPath);
    if (!signed) {
      return {
        trusted: false,
        reason: 'strict mode: missing or invalid signature',
        requiresMetaReview: false,
      };
    }
    return { trusted: true, requiresMetaReview: false };
  }

  protected async stepSignatureVerification(
    _manifest: HookManifest,
    _manifestPath: string,
  ): Promise<TrustVerdict> {
    return { trusted: true, requiresMetaReview: false };
  }

  /**
   * Capability validation (SPEC-019-3-02 strict-mode arm). In strict mode,
   * any plugin declaring a `code-review` or `security-review` reviewer slot
   * MUST also appear on `extensions.privileged_reviewers`. In other modes
   * the meta-review trigger (SPEC-019-3-03) is the gate; this step is a
   * no-op so non-strict configs cannot reject here.
   *
   * Note: this check is independent of meta-review — even a manually
   * privileged plugin in strict mode must still pass meta-review when its
   * trigger conditions match (per PLAN-019-3 risks).
   */
  protected async stepCapabilityValidation(
    manifest: HookManifest,
  ): Promise<TrustVerdict> {
    if (this.config.trust_mode !== 'strict') {
      return { trusted: true, requiresMetaReview: false };
    }
    const reviewerSlots = manifest.reviewer_slots ?? [];
    const declaresPrivilegedReview = reviewerSlots.some(
      (s) => s === 'code-review' || s === 'security-review',
    );
    if (
      declaresPrivilegedReview &&
      !this.config.privileged_reviewers.includes(manifest.id)
    ) {
      return {
        trusted: false,
        reason:
          'strict mode: privileged reviewer not in privileged_reviewers list',
        requiresMetaReview: false,
      };
    }
    return { trusted: true, requiresMetaReview: false };
  }

  /**
   * Meta-reviewer step (SPEC-019-3-03). Evaluates the six trigger
   * conditions; if any match, consults the cache and otherwise invokes
   * the `agent-meta-reviewer`. PASS verdicts continue the pipeline;
   * FAIL verdicts reject with a reason that quotes the findings.
   *
   * If the agent spawner / cache are not injected (skeleton fallback),
   * the trigger evaluation still runs and is reported via
   * `requiresMetaReview`, but the step trusts the plugin to keep the
   * skeleton path operable.
   */
  protected async stepMetaReviewerAudit(
    manifest: HookManifest,
  ): Promise<TrustVerdict> {
    const { triggered, reasons } = this.evaluateMetaReviewTriggers(manifest);
    if (!triggered) {
      return { trusted: true, requiresMetaReview: false };
    }

    // Without a wired agent spawner we cannot make a real verdict; flag
    // the meta-review requirement and pass through. This keeps the
    // skeleton importable in environments that have not opted into the
    // agent infrastructure yet.
    if (!this.agentSpawner) {
      return { trusted: true, requiresMetaReview: true };
    }

    if (this.metaReviewCache) {
      const cached = await this.metaReviewCache.get(manifest.id, manifest.version);
      if (cached) {
        return this.verdictFromMetaReview(cached);
      }
    }

    const verdict = await this.agentSpawner.invoke('agent-meta-reviewer', {
      manifest,
      triggerReasons: reasons,
    });
    if (this.metaReviewCache) {
      await this.metaReviewCache.set(manifest.id, manifest.version, verdict);
    }
    return this.verdictFromMetaReview({
      ...verdict,
      reviewedAt: new Date().toISOString(),
    });
  }

  /**
   * Evaluate the six meta-review trigger conditions (TDD-019 §10.3).
   * Returns the list of human-readable reasons for any match. The
   * reasons strings are part of the audit-log contract — adding new
   * triggers must append, not rename.
   */
  evaluateMetaReviewTriggers(manifest: HookManifest): {
    triggered: boolean;
    reasons: string[];
  } {
    const reasons: string[] = [];
    const slots = manifest.reviewer_slots ?? [];
    if (slots.some((s) => s === 'code-review' || s === 'security-review')) {
      reasons.push('privileged reviewer slot');
    }
    const caps = manifest.capabilities ?? [];
    if (caps.includes('network')) reasons.push('network capability');
    if (caps.includes('privileged-env')) reasons.push('privileged-env capability');
    const fsWrites = manifest.filesystem_write_paths ?? [];
    if (fsWrites.some((p) => !p.startsWith('/tmp/'))) {
      reasons.push('filesystem-write outside /tmp');
    }
    const hooks = manifest.hooks ?? [];
    if (hooks.some((h) => h.allow_child_processes === true)) {
      reasons.push('allow_child_processes');
    }
    if (
      hooks.some(
        (h) =>
          h.failure_mode === 'block' && CRITICAL_HOOK_POINTS.has(h.hook_point),
      )
    ) {
      reasons.push('failure_mode=block on critical hook');
    }
    return { triggered: reasons.length > 0, reasons };
  }

  /** Lift a meta-review verdict into a TrustVerdict. */
  private verdictFromMetaReview(verdict: MetaReviewVerdict): TrustVerdict {
    if (verdict.pass) {
      return {
        trusted: true,
        requiresMetaReview: true,
        metaReviewVerdict: { pass: true, findings: verdict.findings },
      };
    }
    return {
      trusted: false,
      reason: `meta-review FAIL: ${verdict.findings.join('; ')}`,
      requiresMetaReview: true,
      metaReviewVerdict: { pass: false, findings: verdict.findings },
    };
  }

  protected async stepDependencyResolution(
    _manifest: HookManifest,
  ): Promise<TrustVerdict> {
    return { trusted: true, requiresMetaReview: false };
  }

  protected async stepRegistration(
    _manifest: HookManifest,
  ): Promise<TrustVerdict> {
    return { trusted: true, requiresMetaReview: false };
  }

  /**
   * Verify the manifest's detached signature (SPEC-019-3-03). The
   * convention is `<manifestPath>.sig` next to the manifest; the
   * SignatureVerifier walks every key in `trustedKeysDir` and returns
   * true on the first match.
   *
   * `protected` so SPEC-019-3-02's truth-table tests can subclass and
   * override to simulate signed/unsigned/invalid without real keys.
   */
  protected async verifySignature(
    _manifest: HookManifest,
    manifestPath: string,
  ): Promise<boolean> {
    if (!this.signatureVerifier) return false;
    const sigPath = `${manifestPath}.sig`;
    return this.signatureVerifier.verify(manifestPath, sigPath);
  }
}

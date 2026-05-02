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

export class TrustValidator {
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
   */
  constructor(
    protected readonly config: ExtensionsConfig,
    protected readonly validationPipeline: ValidationPipeline,
    protected readonly trustedKeysDir: string,
  ) {}

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
      if (result.metaReviewVerdict) aggregateVerdict = result.metaReviewVerdict;
      if (!result.trusted) return result;
    }
    return {
      trusted: true,
      requiresMetaReview: aggregateRequiresMetaReview,
      ...(aggregateVerdict ? { metaReviewVerdict: aggregateVerdict } : {}),
    };
  }

  /**
   * O(1) runtime trust check. Used by `HookExecutor` before each
   * invocation so revocations propagate without waiting for SIGUSR1.
   *
   * SPEC-019-3-04 swaps this for a `Set`-backed lookup with audit
   * emission. The skeleton returns the allowlist-membership boolean.
   */
  isTrusted(pluginId: string): boolean {
    return this.config.allowlist.includes(pluginId);
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

  protected async stepMetaReviewerAudit(
    _manifest: HookManifest,
  ): Promise<TrustVerdict> {
    return { trusted: true, requiresMetaReview: false };
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
   * Stub signature verifier. SPEC-019-3-03 replaces this with a real
   * Ed25519 / RSA-PSS verifier delegated to `SignatureVerifier`.
   *
   * Marked `protected` so unit tests in SPEC-019-3-02 can subclass and
   * override to simulate signed/unsigned/invalid scenarios without
   * needing real key material.
   */
  protected async verifySignature(
    _manifest: HookManifest,
    _manifestPath: string,
  ): Promise<boolean> {
    // Safe default until SPEC-019-3-03 wires the real verifier: nothing is
    // signed. Allowlist mode never calls this; permissive-no-verify
    // short-circuits before reaching it.
    return false;
  }
}

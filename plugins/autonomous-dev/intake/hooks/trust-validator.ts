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

  protected async stepTrustStatus(
    _manifest: HookManifest,
    _manifestPath: string,
  ): Promise<TrustVerdict> {
    return { trusted: true, requiresMetaReview: false };
  }

  protected async stepSignatureVerification(
    _manifest: HookManifest,
    _manifestPath: string,
  ): Promise<TrustVerdict> {
    return { trusted: true, requiresMetaReview: false };
  }

  protected async stepCapabilityValidation(
    _manifest: HookManifest,
  ): Promise<TrustVerdict> {
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

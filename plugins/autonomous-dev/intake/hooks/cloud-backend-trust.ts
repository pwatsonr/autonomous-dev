/**
 * Cloud-backend trust extension (SPEC-024-3-02).
 *
 * Two checks beyond the existing PLAN-019-3 trust validator:
 *   1. The plugin's `name` appears in `extensions.privileged_backends[]`.
 *   2. The agent-meta-reviewer (already triggered for plugins declaring
 *      `capabilities: ['network', 'privileged-env']`) returned approval.
 *
 * Either failing rejects the registration with a stable error code; tests
 * and operator docs reference these codes verbatim.
 *
 * @module intake/hooks/cloud-backend-trust
 */

/** Manifest fields this hook reads (kept intentionally minimal). */
export interface CloudBackendManifest {
  name: string;
  /** Discriminator — the hook only fires for `manifest.type === 'cloud-backend'`. */
  type?: string;
}

/** Subset of the autonomous-dev config the hook reads. */
export interface CloudBackendTrustConfig {
  extensions?: {
    privileged_backends?: readonly string[];
  };
}

/** Meta-review verdict shape consumed by the hook. */
export interface MetaReviewResult {
  status: 'approved' | 'rejected' | 'skipped' | 'failed' | string;
  notes?: string;
}

export type CloudBackendTrustResult =
  | { ok: true }
  | { ok: false; code: 'CLOUD_BACKEND_NOT_PRIVILEGED' | 'CLOUD_BACKEND_META_REVIEW_FAILED'; reason: string };

/**
 * Run the two cloud-backend-specific checks. Pure function — no I/O —
 * so the existing trust validator can call it inline.
 */
export async function validateCloudBackendTrust(
  manifest: CloudBackendManifest,
  config: CloudBackendTrustConfig,
  metaReviewResult: MetaReviewResult,
): Promise<CloudBackendTrustResult> {
  const privileged = config.extensions?.privileged_backends ?? [];
  if (!privileged.includes(manifest.name)) {
    return {
      ok: false,
      code: 'CLOUD_BACKEND_NOT_PRIVILEGED',
      reason:
        `Cloud backend "${manifest.name}" is not in extensions.privileged_backends. ` +
        'Add it to your config to enable, after security review.',
    };
  }
  if (metaReviewResult.status !== 'approved') {
    return {
      ok: false,
      code: 'CLOUD_BACKEND_META_REVIEW_FAILED',
      reason:
        `Cloud backend "${manifest.name}" failed agent-meta-reviewer: ${metaReviewResult.notes ?? 'no notes'}.`,
    };
  }
  return { ok: true };
}

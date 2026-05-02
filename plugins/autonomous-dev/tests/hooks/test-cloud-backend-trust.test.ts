/**
 * Unit tests for `validateCloudBackendTrust` (SPEC-024-3-04).
 *
 * Pure function — no mocks.
 */

import {
  validateCloudBackendTrust,
  type CloudBackendManifest,
  type CloudBackendTrustConfig,
  type MetaReviewResult,
} from '../../intake/hooks/cloud-backend-trust';

const APPROVED: MetaReviewResult = { status: 'approved' };
const REJECTED: MetaReviewResult = { status: 'rejected', notes: 'capability creep' };

describe('validateCloudBackendTrust', () => {
  test('plugin not in privileged_backends → CLOUD_BACKEND_NOT_PRIVILEGED', async () => {
    const manifest: CloudBackendManifest = { name: 'autonomous-dev-deploy-aws', type: 'cloud-backend' };
    const config: CloudBackendTrustConfig = { extensions: { privileged_backends: [] } };
    const r = await validateCloudBackendTrust(manifest, config, APPROVED);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('CLOUD_BACKEND_NOT_PRIVILEGED');
      expect(r.reason).toContain('autonomous-dev-deploy-aws');
    }
  });

  test('plugin in privileged_backends but meta-review rejected → CLOUD_BACKEND_META_REVIEW_FAILED with notes', async () => {
    const manifest: CloudBackendManifest = { name: 'autonomous-dev-deploy-aws', type: 'cloud-backend' };
    const config: CloudBackendTrustConfig = {
      extensions: { privileged_backends: ['autonomous-dev-deploy-aws'] },
    };
    const r = await validateCloudBackendTrust(manifest, config, REJECTED);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('CLOUD_BACKEND_META_REVIEW_FAILED');
      expect(r.reason).toContain('autonomous-dev-deploy-aws');
      expect(r.reason).toContain('capability creep');
    }
  });

  test('plugin in privileged_backends AND meta-review approved → ok:true', async () => {
    const manifest: CloudBackendManifest = { name: 'autonomous-dev-deploy-aws', type: 'cloud-backend' };
    const config: CloudBackendTrustConfig = {
      extensions: { privileged_backends: ['autonomous-dev-deploy-aws'] },
    };
    const r = await validateCloudBackendTrust(manifest, config, APPROVED);
    expect(r).toEqual({ ok: true });
  });

  test('empty privileged_backends config rejects (treated as no plugins approved)', async () => {
    const manifest: CloudBackendManifest = { name: 'p', type: 'cloud-backend' };
    const r = await validateCloudBackendTrust(manifest, {}, APPROVED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('CLOUD_BACKEND_NOT_PRIVILEGED');
  });

  test('reason strings include the plugin name verbatim', async () => {
    const m: CloudBackendManifest = { name: 'my-cloud-backend-x', type: 'cloud-backend' };
    const r1 = await validateCloudBackendTrust(m, { extensions: { privileged_backends: [] } }, APPROVED);
    const r2 = await validateCloudBackendTrust(
      m,
      { extensions: { privileged_backends: ['my-cloud-backend-x'] } },
      REJECTED,
    );
    if (!r1.ok) expect(r1.reason).toContain('my-cloud-backend-x');
    if (!r2.ok) expect(r2.reason).toContain('my-cloud-backend-x');
  });

  test('meta-review status "skipped" or "failed" is treated as not approved', async () => {
    const manifest: CloudBackendManifest = { name: 'p', type: 'cloud-backend' };
    const config: CloudBackendTrustConfig = { extensions: { privileged_backends: ['p'] } };
    const skipped = await validateCloudBackendTrust(manifest, config, { status: 'skipped' });
    const failed = await validateCloudBackendTrust(manifest, config, { status: 'failed' });
    expect(skipped.ok).toBe(false);
    expect(failed.ok).toBe(false);
    if (!skipped.ok) expect(skipped.code).toBe('CLOUD_BACKEND_META_REVIEW_FAILED');
    if (!failed.ok) expect(failed.code).toBe('CLOUD_BACKEND_META_REVIEW_FAILED');
  });

  test('absent meta-review notes default to "no notes" string in reason', async () => {
    const manifest: CloudBackendManifest = { name: 'p', type: 'cloud-backend' };
    const config: CloudBackendTrustConfig = { extensions: { privileged_backends: ['p'] } };
    const r = await validateCloudBackendTrust(manifest, config, { status: 'rejected' });
    if (!r.ok) expect(r.reason).toContain('no notes');
  });
});

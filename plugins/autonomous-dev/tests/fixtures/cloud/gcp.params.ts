/**
 * Valid GCP `DeployParameters` fixture (SPEC-024-1-05).
 *
 * Shape matches `@autonomous-dev/deploy-gcp/backend` `PARAM_SCHEMA`. Used
 * by `tests/deploy/cloud-conformance.test.ts` to drive the conformance
 * battery against `GCPBackend`.
 */

import type { DeployParameters } from '../../../intake/deploy/types';

export const gcpValidParams: DeployParameters = {
  project_id: 'test-project',
  region: 'us-central1',
  service_name: 'api',
  image_repo: 'api',
  cpu: '1',
  memory_mib: 512,
  health_path: '/health',
  health_timeout_seconds: 30,
};

export default gcpValidParams;

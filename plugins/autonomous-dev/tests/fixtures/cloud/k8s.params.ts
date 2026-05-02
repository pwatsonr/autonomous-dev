/**
 * Valid K8s `DeployParameters` fixture (SPEC-024-1-05).
 *
 * Shape matches `@autonomous-dev/deploy-k8s/backend` `PARAM_SCHEMA`. The
 * `manifest_path` is a fixture YAML written into a tmp directory by the
 * conformance test. Used by `tests/deploy/cloud-conformance.test.ts`.
 */

import type { DeployParameters } from '../../../intake/deploy/types';

export const k8sValidParams = (manifestPath: string): DeployParameters => ({
  namespace: 'default',
  manifest_path: manifestPath,
  deployment_name: 'web',
  context_name: 'test-cluster',
  ready_timeout_seconds: 30,
});

export default k8sValidParams;

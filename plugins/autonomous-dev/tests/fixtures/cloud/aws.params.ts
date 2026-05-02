/**
 * Valid AWS `DeployParameters` fixture (SPEC-024-1-05).
 *
 * Shape matches `@autonomous-dev/deploy-aws/backend` `PARAM_SCHEMA`. Used
 * by `tests/deploy/cloud-conformance.test.ts`.
 */

import type { DeployParameters } from '../../../intake/deploy/types';

export const awsValidParams: DeployParameters = {
  account_id: '123456789012',
  region: 'us-east-1',
  cluster_name: 'web-cluster',
  service_name: 'web-svc',
  ecr_repo: 'web',
  task_family: 'web-svc',
  target_group_arn:
    'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/web-tg/1234567890abcdef',
  health_timeout_seconds: 30,
  desired_count: 2,
};

export default awsValidParams;

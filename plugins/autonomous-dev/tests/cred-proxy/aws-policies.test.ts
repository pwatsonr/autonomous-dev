/**
 * Committed snapshot of every entry in `AWS_OPERATIONS` (SPEC-024-2-05).
 *
 * The snapshot file at `__snapshots__/aws-policies.test.ts.snap` is the
 * authoritative expectation for the inline session policies produced by
 * `awsPolicyFor`. Any diff in `operation-catalog.ts` (action additions,
 * resource ARN changes) or `aws-policy-for.ts` (policy shape changes)
 * fails CI here without an explicit `jest -u` regeneration. PR reviewers
 * are expected to scrutinise any snapshot delta as a potential
 * scope-widening event.
 *
 * Note on filename: the spec lists this snapshot as `aws-policies.snap`,
 * but Jest's standard snapshotResolver names the file
 * `aws-policies.test.ts.snap`. We follow Jest convention; the file's
 * purpose and contents match the spec exactly.
 */

import {
  AWS_OPERATIONS,
  type AwsOperationSpec,
} from '../../intake/cred-proxy/scopers/operation-catalog';
import { awsPolicyFor } from '../../intake/cred-proxy/scopers/aws-policy-for';

/**
 * Canonical scope inputs per operation. Keep deterministic so the
 * resulting Resource ARNs are stable in the snapshot.
 */
const FIXTURES: Record<string, Record<string, string>> = {
  'ECS:UpdateService': {
    region: 'us-east-1',
    account: '123456789012',
    cluster: 'prod',
    service: 'api',
  },
  'Lambda:UpdateFunctionCode': {
    region: 'us-west-2',
    account: '123456789012',
    functionName: 'fn1',
  },
  'S3:PutObject': {
    bucket: 'my-bucket',
    key: 'releases/2026/build.tar.gz',
  },
  'ECR:PushImage': {
    region: 'us-east-1',
    account: '123456789012',
    repository: 'my-app',
  },
  'CloudWatchLogs:PutLogEvents': {
    region: 'us-east-1',
    account: '123456789012',
    logGroup: '/aws/ecs/my-app',
  },
  'ELBv2:DescribeTargetHealth': {
    region: 'us-east-1',
    account: '123456789012',
    targetGroup: 'my-tg',
    targetGroupId: 'aaa1111',
  },
};

describe('AWS_OPERATIONS snapshots', () => {
  // Iterate the catalog directly so a newly-added operation without a
  // FIXTURES entry fails loudly rather than silently skipping.
  for (const op of Object.keys(AWS_OPERATIONS)) {
    it(`policy for ${op}`, () => {
      const fixture = FIXTURES[op];
      if (!fixture) {
        throw new Error(
          `aws-policies.test.ts is missing a FIXTURES entry for '${op}'. ` +
            `Add one and regenerate the snapshot with 'jest -u'.`,
        );
      }
      // Touch the spec so the catalog import is exercised at runtime.
      const spec: AwsOperationSpec = AWS_OPERATIONS[op];
      expect(spec.actions.length).toBeGreaterThan(0);
      expect(awsPolicyFor(op, fixture)).toMatchSnapshot();
    });
  }
});

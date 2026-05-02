/**
 * Snapshot tests for `awsPolicyFor` (SPEC-024-2-02).
 *
 * Snapshot files live under `__snapshots__/` and are checked in. Any
 * change to `AWS_OPERATIONS` or to the policy shape causes a clear diff
 * against the committed snapshot — the developer must regenerate
 * (`jest -u`) AND justify the change in the PR.
 */

import { awsPolicyFor } from '../../intake/cred-proxy/scopers/aws-policy-for';

describe('awsPolicyFor', () => {
  it('snapshots ECS:UpdateService minimal scope', () => {
    expect(
      awsPolicyFor('ECS:UpdateService', {
        region: 'us-east-1',
        account: '123456789012',
        cluster: 'prod',
        service: 'api',
      }),
    ).toMatchSnapshot();
  });

  it('snapshots Lambda:UpdateFunctionCode', () => {
    expect(
      awsPolicyFor('Lambda:UpdateFunctionCode', {
        region: 'us-west-2',
        account: '123456789012',
        functionName: 'fn1',
      }),
    ).toMatchSnapshot();
  });

  it('snapshots S3:PutObject', () => {
    expect(
      awsPolicyFor('S3:PutObject', {
        bucket: 'my-bucket',
        key: 'releases/2026/build.tar.gz',
      }),
    ).toMatchSnapshot();
  });

  it('snapshots ECR:PushImage', () => {
    expect(
      awsPolicyFor('ECR:PushImage', {
        region: 'us-east-1',
        account: '123456789012',
        repository: 'my-app',
      }),
    ).toMatchSnapshot();
  });

  it('snapshots CloudWatchLogs:PutLogEvents', () => {
    expect(
      awsPolicyFor('CloudWatchLogs:PutLogEvents', {
        region: 'us-east-1',
        account: '123456789012',
        logGroup: '/aws/ecs/my-app',
      }),
    ).toMatchSnapshot();
  });

  it('snapshots ELBv2:DescribeTargetHealth', () => {
    expect(
      awsPolicyFor('ELBv2:DescribeTargetHealth', {
        region: 'us-east-1',
        account: '123456789012',
        targetGroup: 'my-tg',
        targetGroupId: 'aaa1111',
      }),
    ).toMatchSnapshot();
  });

  it('throws on unknown operation', () => {
    expect(() => awsPolicyFor('UnknownOp', {})).toThrow(/unknown AWS operation/);
  });

  it('throws when a required scope key is missing', () => {
    expect(() =>
      awsPolicyFor('ECS:UpdateService', {
        region: 'us-east-1',
        account: '123',
        cluster: 'prod',
      }),
    ).toThrow(/missing required scope key 'service'/);
  });

  it('does NOT shell-expand or IAM-wildcard-expand scope values', () => {
    // Adversarial input: wildcards, semicolons, command-injection styles.
    // The generator MUST NOT alter the strings — the cloud is the
    // authority. The literal characters appear in the resulting Resource.
    const policy = awsPolicyFor('ECS:UpdateService', {
      region: 'us-east-1; --',
      account: '123',
      cluster: '*',
      service: '*',
    });
    expect(policy.Statement[0].Resource).toBe(
      'arn:aws:ecs:us-east-1; --:123:service/*/*',
    );
  });
});

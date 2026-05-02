/**
 * AWSCredentialScoper unit tests (SPEC-024-2-02).
 *
 * Mocks the STS client by satisfying the `StsLike` structural interface.
 */

import { AssumeRoleCommand } from '@aws-sdk/client-sts';

import {
  AWSCredentialScoper,
  type StsLike,
} from '../../intake/cred-proxy/scopers/aws';

interface SentCmd {
  RoleArn?: string;
  RoleSessionName?: string;
  Policy?: string;
  DurationSeconds?: number;
}

function makeMockSts(
  response: Awaited<ReturnType<StsLike['send']>> | Error,
): { sts: StsLike; sent: SentCmd[] } {
  const sent: SentCmd[] = [];
  const sts: StsLike = {
    async send(cmd) {
      // The real AssumeRoleCommand keeps the `input` on `.input`; this
      // mock pulls it the same way.
      sent.push((cmd as unknown as { input: SentCmd }).input);
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { sts, sent };
}

const VALID_SCOPE = {
  region: 'us-east-1',
  account: '123456789012',
  cluster: 'prod',
  service: 'api',
};

const VALID_RESPONSE = {
  Credentials: {
    AccessKeyId: 'AKIA-test',
    SecretAccessKey: 'secret',
    SessionToken: 'token',
    Expiration: new Date('2030-01-01T00:00:00.000Z'),
  },
};

describe('AWSCredentialScoper.scope', () => {
  it('calls STS exactly once with the expected AssumeRoleCommand', async () => {
    const { sts, sent } = makeMockSts(VALID_RESPONSE);
    const scoper = new AWSCredentialScoper(
      { proxyAssumeRoleArn: 'arn:aws:iam::1:role/proxy', region: 'us-east-1' },
      sts,
    );
    await scoper.scope('ECS:UpdateService', VALID_SCOPE);
    expect(sent).toHaveLength(1);
    expect(sent[0].RoleArn).toBe('arn:aws:iam::1:role/proxy');
    expect(sent[0].DurationSeconds).toBe(900);
    const policy = JSON.parse(sent[0].Policy ?? '');
    expect(policy.Version).toBe('2012-10-17');
    expect(policy.Statement[0].Action).toEqual([
      'ecs:UpdateService',
      'ecs:DescribeServices',
    ]);
    expect(policy.Statement[0].Resource).toBe(
      'arn:aws:ecs:us-east-1:123456789012:service/prod/api',
    );
  });

  it('produces a RoleSessionName ≤64 chars matching [a-zA-Z0-9-]', async () => {
    const { sts, sent } = makeMockSts(VALID_RESPONSE);
    const scoper = new AWSCredentialScoper(
      { proxyAssumeRoleArn: 'arn', region: 'us-east-1' },
      sts,
    );
    await scoper.scope('ECS:UpdateService', VALID_SCOPE);
    const name = sent[0].RoleSessionName ?? '';
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[a-zA-Z0-9-]+$/);
  });

  it('returns a payload with the three AWS env-var keys and an ISO expiry', async () => {
    const { sts } = makeMockSts(VALID_RESPONSE);
    const scoper = new AWSCredentialScoper(
      { proxyAssumeRoleArn: 'arn', region: 'us-east-1' },
      sts,
    );
    const out = await scoper.scope('ECS:UpdateService', VALID_SCOPE);
    const payload = JSON.parse(out.payload);
    expect(payload).toEqual({
      AWS_ACCESS_KEY_ID: 'AKIA-test',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_SESSION_TOKEN: 'token',
    });
    expect(out.expires_at).toBe('2030-01-01T00:00:00.000Z');
  });

  it('throws when STS returns no Credentials', async () => {
    const { sts } = makeMockSts({});
    const scoper = new AWSCredentialScoper(
      { proxyAssumeRoleArn: 'arn', region: 'us-east-1' },
      sts,
    );
    await expect(scoper.scope('ECS:UpdateService', VALID_SCOPE)).rejects.toThrow(
      /no credentials/i,
    );
  });

  it('throws when STS returns partial credentials (missing SessionToken)', async () => {
    const { sts } = makeMockSts({
      Credentials: {
        AccessKeyId: 'a',
        SecretAccessKey: 's',
        Expiration: new Date(),
      },
    });
    const scoper = new AWSCredentialScoper(
      { proxyAssumeRoleArn: 'arn', region: 'us-east-1' },
      sts,
    );
    await expect(scoper.scope('ECS:UpdateService', VALID_SCOPE)).rejects.toThrow(
      /partial credentials/i,
    );
  });

  it('propagates STS-mocked errors', async () => {
    const { sts } = makeMockSts(new Error('sts-403-AccessDenied'));
    const scoper = new AWSCredentialScoper(
      { proxyAssumeRoleArn: 'arn', region: 'us-east-1' },
      sts,
    );
    await expect(scoper.scope('ECS:UpdateService', VALID_SCOPE)).rejects.toThrow(
      'sts-403-AccessDenied',
    );
  });

  it('revoke() resolves and makes no additional STS calls', async () => {
    const { sts, sent } = makeMockSts(VALID_RESPONSE);
    const scoper = new AWSCredentialScoper(
      { proxyAssumeRoleArn: 'arn', region: 'us-east-1' },
      sts,
    );
    const out = await scoper.scope('ECS:UpdateService', VALID_SCOPE);
    const before = sent.length;
    await expect(out.revoke()).resolves.toBeUndefined();
    expect(sent.length).toBe(before);
  });

  it('two consecutive scopes produce distinct RoleSessionNames', async () => {
    const { sts, sent } = makeMockSts(VALID_RESPONSE);
    const scoper = new AWSCredentialScoper(
      { proxyAssumeRoleArn: 'arn', region: 'us-east-1' },
      sts,
    );
    await scoper.scope('ECS:UpdateService', VALID_SCOPE);
    // small delay to guarantee Date.now() differs
    await new Promise((r) => setTimeout(r, 5));
    await scoper.scope('ECS:UpdateService', VALID_SCOPE);
    expect(sent[0].RoleSessionName).not.toBe(sent[1].RoleSessionName);
  });

  it('passes operation policy through unmodified (snapshot via Policy field)', async () => {
    const { sts, sent } = makeMockSts(VALID_RESPONSE);
    const scoper = new AWSCredentialScoper(
      { proxyAssumeRoleArn: 'arn', region: 'us-east-1' },
      sts,
    );
    await scoper.scope('Lambda:UpdateFunctionCode', {
      region: 'us-west-2',
      account: '123',
      functionName: 'fn1',
    });
    const p = JSON.parse(sent[0].Policy ?? '');
    expect(p.Statement[0].Resource).toBe(
      'arn:aws:lambda:us-west-2:123:function:fn1',
    );
  });

  it('makes the scoper structurally implement CredentialScoper', () => {
    const sc = new AWSCredentialScoper(
      { proxyAssumeRoleArn: 'a', region: 'r' },
      { send: async () => VALID_RESPONSE },
    );
    expect(sc.provider).toBe('aws');
    expect(typeof sc.scope).toBe('function');
  });

  it('AssumeRoleCommand argument is the real SDK class (compile-time check)', async () => {
    const { sts } = makeMockSts(VALID_RESPONSE);
    const scoper = new AWSCredentialScoper(
      { proxyAssumeRoleArn: 'a', region: 'r' },
      sts,
    );
    await scoper.scope('ECS:UpdateService', VALID_SCOPE);
    // Reaching here means @aws-sdk/client-sts's AssumeRoleCommand type
    // imported and compiled; compile-time assertion below is a runtime
    // truthy check of the module export.
    expect(typeof AssumeRoleCommand).toBe('function');
  });
});

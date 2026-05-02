/**
 * AWSCredentialScoper — STS `AssumeRole` with inline session policy
 * (SPEC-024-2-02, TDD-024 §7.2).
 *
 * The scoper is a pure adapter: given an operation name and a resource
 * scope, it (a) generates the minimal IAM policy via `awsPolicyFor`,
 * (b) calls `STSClient.send(AssumeRoleCommand)` with that policy as the
 * inline session policy, and (c) returns the temporary credential plus
 * a `revoke()` no-op (STS sessions cannot be revoked early — the cloud
 * TTL of 900s is the authoritative limit, documented in PLAN-024-2's
 * risk register).
 *
 * The STS client is constructor-injected so unit tests pass mocks; the
 * default constructor builds a real client only if the production
 * caller does not supply one.
 *
 * @module intake/cred-proxy/scopers/aws
 */

import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';

import type { CredentialScoper, Provider, Scope } from '../types';
import { awsPolicyFor } from './aws-policy-for';

export interface AwsScoperConfig {
  /**
   * Pre-provisioned IAM role the proxy assumes. The inline session
   * policy supplied per call narrows it further; this role's permissions
   * are the **superset** of every operation the proxy will ever scope
   * down from. Trust policy on this role allows the daemon's host
   * identity to `sts:AssumeRole`.
   */
  readonly proxyAssumeRoleArn: string;
  readonly region: string;
}

/**
 * Minimal structural interface of the STS client we use. Declared here
 * to keep the scoper testable with hand-rolled mocks while still
 * accepting a real `STSClient`. The real client's `.send` method
 * matches this shape via TS structural compat.
 */
export interface StsLike {
  send(cmd: AssumeRoleCommand): Promise<{
    Credentials?: {
      AccessKeyId?: string;
      SecretAccessKey?: string;
      SessionToken?: string;
      Expiration?: Date;
    };
  }>;
}

export class AWSCredentialScoper implements CredentialScoper {
  readonly provider: Provider = 'aws';

  constructor(
    private readonly cfg: AwsScoperConfig,
    private readonly sts: StsLike = new STSClient({ region: cfg.region }),
  ) {}

  async scope(operation: string, scope: Scope) {
    const policy = awsPolicyFor(operation, scope as Record<string, string>);
    const sessionName = makeSessionName(operation);
    const out = await this.sts.send(
      new AssumeRoleCommand({
        RoleArn: this.cfg.proxyAssumeRoleArn,
        RoleSessionName: sessionName,
        Policy: JSON.stringify(policy),
        DurationSeconds: 900,
      }),
    );
    if (!out.Credentials) {
      throw new Error('STS AssumeRole returned no credentials');
    }
    const { AccessKeyId, SecretAccessKey, SessionToken, Expiration } =
      out.Credentials;
    if (!AccessKeyId || !SecretAccessKey || !SessionToken || !Expiration) {
      throw new Error('STS AssumeRole returned partial credentials');
    }
    return {
      payload: JSON.stringify({
        AWS_ACCESS_KEY_ID: AccessKeyId,
        AWS_SECRET_ACCESS_KEY: SecretAccessKey,
        AWS_SESSION_TOKEN: SessionToken,
      }),
      expires_at: Expiration.toISOString(),
      revoke: async () => {
        // STS sessions cannot be revoked early. The cloud's 900s TTL is
        // the authoritative limit. The audit log still records intent;
        // backends MUST stop using the credential when the audit
        // 'credential_revoked' event fires.
      },
    };
  }
}

/**
 * STS hard-limits `RoleSessionName` to 64 chars and the regex
 * `[\w+=,.@-]+`. We narrow further to `[a-zA-Z0-9-]` for log readability.
 */
function makeSessionName(operation: string): string {
  const safe = operation.replace(/[^a-zA-Z0-9-]/g, '-');
  const stamp = Date.now().toString();
  return `cred-proxy-${safe}-${stamp}`.slice(0, 64);
}

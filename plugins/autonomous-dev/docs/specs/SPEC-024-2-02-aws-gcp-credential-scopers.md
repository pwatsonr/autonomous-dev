# SPEC-024-2-02: AWS and GCP Credential Scopers

## Metadata
- **Parent Plan**: PLAN-024-2
- **Tasks Covered**: Task 3 (AWS scoper + `awsPolicyFor` policy generator), Task 4 (GCP scoper)
- **Estimated effort**: 11 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-024-2-02-aws-gcp-credential-scopers.md`

## Description
Implement the first two of four `CredentialScoper` instances per TDD-024 §7.2: AWS and GCP. Each scoper translates an `(operation, scope)` pair into the provider-native short-lived credential by (a) generating a minimal IAM policy / IAM binding and (b) calling the provider API to issue a 15-minute credential bound to that policy. Each scoper also returns a `revoke()` callback that the proxy invokes at TTL or on early `release(token_id)`.

The AWS scoper uses STS `AssumeRole` with an inline session policy generated on the fly by `awsPolicyFor(operation, scope)` — the policy lists ONLY the IAM actions and resource ARNs required for that one operation. STS sessions are 900 seconds; revocation is a no-op (STS sessions cannot be revoked early — the cloud's TTL is authoritative, see Risks).

The GCP scoper creates a temporary IAM binding via `setIamPolicy` scoped to a single resource (e.g., one Cloud Run service for `Run.Deploy`), calls `iamcredentials.generateAccessToken` with the delegated permissions, and records the binding for removal on `revoke()`.

Both scopers are pure adapters — they implement the `CredentialScoper` interface from SPEC-024-2-01 and have no knowledge of the proxy, the allowlist, or the audit log. The proxy wires them in (SPEC-024-2-04). This spec is scope-agnostic about how the credential reaches the backend; delivery is SPEC-024-2-04.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/cred-proxy/scopers/aws-policy-for.ts` | Create | Pure function: `(operation, scope) → IAM policy JSON` |
| `plugins/autonomous-dev/src/cred-proxy/scopers/aws.ts` | Create | `AWSCredentialScoper` class, calls STS AssumeRole |
| `plugins/autonomous-dev/src/cred-proxy/scopers/gcp.ts` | Create | `GCPCredentialScoper` class, IAM binding + token issuance |
| `plugins/autonomous-dev/src/cred-proxy/scopers/operation-catalog.ts` | Create | Static map: operation name → required actions/role |
| `plugins/autonomous-dev/tests/cred-proxy/test-aws-policy-for.test.ts` | Create | Snapshot tests for 6+ operations |
| `plugins/autonomous-dev/tests/cred-proxy/test-aws-scoper.test.ts` | Create | STS mock, success + error paths |
| `plugins/autonomous-dev/tests/cred-proxy/test-gcp-scoper.test.ts` | Create | IAM/credentials mocks, binding revocation |
| `plugins/autonomous-dev/package.json` | Modify | Add `@aws-sdk/client-sts`, `@google-cloud/iam-credentials`, `@google-cloud/resource-manager` (or equivalents) |

## Implementation Details

### `src/cred-proxy/scopers/operation-catalog.ts`

A single source of truth for "what permissions does each declared operation require." Keeping it separate from the scopers keeps the policy logic data-driven and snapshot-testable.

```ts
export interface AwsOperationSpec {
  actions: readonly string[];                              // e.g., ['ecs:UpdateService', 'ecs:DescribeServices']
  resourceArn: (scope: Record<string, string>) => string;  // builds ARN from scope keys
  requiredScopeKeys: readonly string[];                    // validated before scoping
}

export interface GcpOperationSpec {
  role: string;                                  // e.g., 'roles/run.developer'
  resourceType: 'service' | 'bucket' | 'project'; // controls which API to call for the binding
  resourcePath: (scope: Record<string, string>) => string; // e.g., projects/p/locations/.../services/s
  requiredScopeKeys: readonly string[];
}

export const AWS_OPERATIONS: Readonly<Record<string, AwsOperationSpec>> = {
  'ECS:UpdateService': {
    actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
    resourceArn: (s) => `arn:aws:ecs:${s.region}:${s.account}:service/${s.cluster}/${s.service}`,
    requiredScopeKeys: ['region', 'account', 'cluster', 'service'],
  },
  'Lambda:UpdateFunctionCode': {
    actions: ['lambda:UpdateFunctionCode', 'lambda:GetFunction'],
    resourceArn: (s) => `arn:aws:lambda:${s.region}:${s.account}:function:${s.functionName}`,
    requiredScopeKeys: ['region', 'account', 'functionName'],
  },
  // Additional entries added as cloud backends register them.
};

export const GCP_OPERATIONS: Readonly<Record<string, GcpOperationSpec>> = {
  'Run.Deploy': {
    role: 'roles/run.developer',
    resourceType: 'service',
    resourcePath: (s) => `projects/${s.project}/locations/${s.location}/services/${s.service}`,
    requiredScopeKeys: ['project', 'location', 'service'],
  },
  'Storage.Upload': {
    role: 'roles/storage.objectCreator',
    resourceType: 'bucket',
    resourcePath: (s) => `projects/_/buckets/${s.bucket}`,
    requiredScopeKeys: ['bucket'],
  },
};
```

### `src/cred-proxy/scopers/aws-policy-for.ts`

```ts
import { AWS_OPERATIONS } from './operation-catalog';

export interface IamPolicy {
  Version: '2012-10-17';
  Statement: Array<{
    Effect: 'Allow';
    Action: readonly string[];
    Resource: string;
  }>;
}

export function awsPolicyFor(operation: string, scope: Record<string, string>): IamPolicy {
  const spec = AWS_OPERATIONS[operation];
  if (!spec) {
    throw new Error(`unknown AWS operation: ${operation}`);
  }
  for (const key of spec.requiredScopeKeys) {
    if (!scope[key]) throw new Error(`missing required scope key '${key}' for ${operation}`);
  }
  return {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: spec.actions, Resource: spec.resourceArn(scope) }],
  };
}
```

The policy generator is a **pure function** with no I/O — this is essential for the snapshot tests below.

### `src/cred-proxy/scopers/aws.ts`

```ts
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import type { CredentialScoper, Scope } from '../types';
import { awsPolicyFor } from './aws-policy-for';

export interface AwsScoperConfig {
  /** Pre-provisioned IAM role the proxy assumes; the inline session policy narrows it further. */
  readonly proxyAssumeRoleArn: string;
  readonly region: string;
}

export class AWSCredentialScoper implements CredentialScoper {
  readonly provider = 'aws' as const;
  constructor(
    private readonly cfg: AwsScoperConfig,
    private readonly sts: STSClient = new STSClient({ region: cfg.region }),
  ) {}

  async scope(operation: string, scope: Scope) {
    const policy = awsPolicyFor(operation, scope);
    const sessionName = `cred-proxy-${operation.replace(/[^a-zA-Z0-9-]/g, '-')}-${Date.now()}`.slice(0, 64);
    const out = await this.sts.send(new AssumeRoleCommand({
      RoleArn: this.cfg.proxyAssumeRoleArn,
      RoleSessionName: sessionName,
      Policy: JSON.stringify(policy),
      DurationSeconds: 900,
    }));
    if (!out.Credentials) throw new Error('STS AssumeRole returned no credentials');
    const { AccessKeyId, SecretAccessKey, SessionToken, Expiration } = out.Credentials;
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
        // STS sessions cannot be revoked early. The cloud's TTL is authoritative.
        // No-op kept to satisfy the CredentialScoper interface.
      },
    };
  }
}
```

### `src/cred-proxy/scopers/gcp.ts`

```ts
import { IAMCredentialsClient } from '@google-cloud/iam-credentials';
import { ServicesClient } from '@google-cloud/run';   // example for Run.Deploy resource
import { Storage } from '@google-cloud/storage';
import type { CredentialScoper, Scope } from '../types';
import { GCP_OPERATIONS } from './operation-catalog';

export interface GcpScoperConfig {
  /** Service account the proxy impersonates to mint downstream tokens. */
  readonly proxyServiceAccount: string;
  /** Pre-provisioned service account whose permissions will be issued to the backend. */
  readonly delegatedServiceAccount: string;
}

export class GCPCredentialScoper implements CredentialScoper {
  readonly provider = 'gcp' as const;
  constructor(
    private readonly cfg: GcpScoperConfig,
    private readonly creds: IAMCredentialsClient = new IAMCredentialsClient(),
  ) {}

  async scope(operation: string, scope: Scope) {
    const spec = GCP_OPERATIONS[operation];
    if (!spec) throw new Error(`unknown GCP operation: ${operation}`);
    for (const key of spec.requiredScopeKeys) {
      if (!scope[key]) throw new Error(`missing required scope key '${key}' for ${operation}`);
    }

    // 1. Create a temporary IAM binding on the resource for the delegated SA.
    const resourcePath = spec.resourcePath(scope as Record<string, string>);
    const removeBinding = await this.addBinding(spec.resourceType, resourcePath, this.cfg.delegatedServiceAccount, spec.role);

    // 2. Mint a 900-second access token impersonating the delegated SA.
    const [tokenResp] = await this.creds.generateAccessToken({
      name: `projects/-/serviceAccounts/${this.cfg.delegatedServiceAccount}`,
      scope: ['https://www.googleapis.com/auth/cloud-platform'],
      lifetime: { seconds: 900 },
    });
    const expires_at = new Date(Date.now() + 900_000).toISOString();
    if (!tokenResp.accessToken) throw new Error('GCP generateAccessToken returned no token');

    return {
      payload: JSON.stringify({ access_token: tokenResp.accessToken, expires_at }),
      expires_at,
      revoke: async () => {
        try { await removeBinding(); }
        catch (err) { /* logged by the proxy's revoke() wrapper in SPEC-024-2-04 */ throw err; }
      },
    };
  }

  private async addBinding(
    resourceType: 'service' | 'bucket' | 'project',
    resource: string,
    member: string,
    role: string,
  ): Promise<() => Promise<void>> {
    // Returns a "remove this binding" closure. Implementation switches on resourceType
    // and dispatches to the right *Client.{getIamPolicy,setIamPolicy} pair.
    // Each implementation:
    //   1. getIamPolicy → existing policy
    //   2. add { role, members: [`serviceAccount:${member}`] } binding (or merge if role exists)
    //   3. setIamPolicy with the etag from step 1
    //   4. Return closure that does the inverse with a fresh getIamPolicy/setIamPolicy round-trip
    throw new Error('NotImplemented: per-resourceType dispatch implemented in this spec');
    // ^ remove this throw and implement the three branches; pseudocode above.
  }
}
```

The `addBinding` helper has three branches (`service` → `ServicesClient`, `bucket` → `Storage`, `project` → `ProjectsClient`) — each a ~20-line `getIamPolicy`/`setIamPolicy` round-trip. The closure returned by each branch must use a **fresh** `getIamPolicy` to fetch the current etag at revoke time (the policy may have been modified by other actors between issuance and revocation; refusing to overwrite is correct behavior — log and rethrow on `etag` mismatch).

## Acceptance Criteria

### `awsPolicyFor` snapshot tests

- [ ] `awsPolicyFor('ECS:UpdateService', { region: 'us-east-1', account: '123456789012', cluster: 'prod', service: 'api' })` returns a policy whose single statement has `Action: ['ecs:UpdateService', 'ecs:DescribeServices']` and `Resource: 'arn:aws:ecs:us-east-1:123456789012:service/prod/api'`.
- [ ] `awsPolicyFor('Lambda:UpdateFunctionCode', { region: 'us-west-2', account: '123', functionName: 'fn1' })` returns the documented Lambda policy with the correct ARN.
- [ ] At least 6 distinct operations have committed snapshot test cases. Snapshot files are checked in.
- [ ] Calling `awsPolicyFor('UnknownOp', {})` throws `Error` with message containing `'unknown AWS operation'`.
- [ ] Calling `awsPolicyFor('ECS:UpdateService', { region: 'us-east-1', account: '123', cluster: 'prod' })` (missing `service`) throws `Error` with message containing `"missing required scope key 'service'"`.
- [ ] Adversarial test: feeding `{ region: 'us-east-1; --', account: '123', cluster: '*', service: '*' }` produces a policy where the wildcards appear literally in the ARN string (no shell expansion, no IAM wildcard expansion at the proxy layer — the cloud is the authority).

### AWS scoper

- [ ] `scope('ECS:UpdateService', validScope)` calls `STSClient.send` exactly once with `AssumeRoleCommand` whose `Policy` deserializes back to the output of `awsPolicyFor`.
- [ ] The `AssumeRoleCommand` has `DurationSeconds === 900` (verified on the mock).
- [ ] `RoleSessionName` is ≤ 64 chars (STS hard limit) and contains only `[a-zA-Z0-9-]`.
- [ ] Returned `payload` parses as JSON with the three expected AWS env-var keys (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`).
- [ ] Returned `expires_at` matches the STS-mocked `Expiration` (ISO-8601).
- [ ] STS returning no `Credentials` propagates as an `Error` with message containing `'no credentials'`.
- [ ] STS returning partial credentials (e.g., missing `SessionToken`) throws `'partial credentials'`.
- [ ] `revoke()` resolves successfully without making any network calls (verified by zero additional mock invocations).

### GCP scoper

- [ ] `scope('Run.Deploy', { project: 'p1', location: 'us-central1', service: 's1' })` results in: (a) `ServicesClient.getIamPolicy` called once, (b) `setIamPolicy` called once with a binding adding the delegated SA to `roles/run.developer`, (c) `IAMCredentialsClient.generateAccessToken` called with `lifetime.seconds === 900`.
- [ ] Returned `payload` parses as JSON with `access_token` and `expires_at` fields.
- [ ] Returned `expires_at` is exactly 900 seconds from a stable `Date.now()` (test uses fake timers).
- [ ] `revoke()` calls `getIamPolicy` again (fresh etag), removes the binding for the delegated SA on that role, and calls `setIamPolicy` with the new policy + fresh etag.
- [ ] If `getIamPolicy` at revoke time returns a policy whose etag conflicts at `setIamPolicy`, the error propagates (caller is responsible for retry — no internal retry in the scoper).
- [ ] `scope('Storage.Upload', { bucket: 'b1' })` dispatches to the bucket-IAM branch and produces a binding on `projects/_/buckets/b1`.
- [ ] `scope('UnknownOp', {})` throws `Error` containing `'unknown GCP operation'`.
- [ ] Missing required scope key throws with the same shape as the AWS scoper.

### Both

- [ ] Both scoper classes implement `CredentialScoper` (verified by TypeScript: assignment to `const s: CredentialScoper = new AWSCredentialScoper(...)` compiles).
- [ ] No scoper reads `process.env` at scoping time (verified by grep + inspection — config is constructor-injected).
- [ ] Both scopers are unit-testable with NO real cloud calls — all SDK clients are constructor-injected so tests can pass mocks.
- [ ] Coverage ≥ 95% per file (measured by the project's coverage tool against the new test files).

## Dependencies

- SPEC-024-2-01 — provides `CredentialScoper` and `Scope` types.
- `@aws-sdk/client-sts` (peer of the AWS SDK v3 already in use elsewhere; pin to a single major).
- `@google-cloud/iam-credentials`, `@google-cloud/run`, `@google-cloud/storage`, `@google-cloud/resource-manager` for the GCP branches.
- IAM prerequisites (operator-side, documented but not enforced by code):
  - AWS: a pre-provisioned role whose trust policy allows the daemon's host identity to `sts:AssumeRole`. The role's permissions are the **superset** of all operations the proxy will scope down from.
  - GCP: a pre-provisioned service account (`delegatedServiceAccount`) with the same superset; the proxy's own identity (`proxyServiceAccount`) needs `roles/iam.serviceAccountTokenCreator` on the delegated SA.

## Notes

- **STS revocation gap:** AWS STS sessions cannot be revoked before their `DurationSeconds` expires. This is captured in PLAN-024-2's risk register: the cloud's TTL is the authoritative limit; the proxy's `revoke()` for AWS is a no-op so the audit log still records the intent ("revoked at T+30s"), but the credential remains valid until T+900s in the cloud. Backend plugins MUST treat the credential as already-revoked once the audit event fires (i.e., stop using it). Operator documentation (out of scope here) explains this explicitly.
- **GCP binding race:** Between `getIamPolicy` and `setIamPolicy`, another principal could mutate the policy. The etag check on `setIamPolicy` causes a 409 in that case. The current behavior is to surface that error; future refinement (out of scope) could add bounded retry. The same race exists at revocation time; same handling.
- **Operation catalog is data, not code:** Adding a new operation is a one-liner in `operation-catalog.ts`. Each new operation REQUIRES a snapshot test for `awsPolicyFor` (covered by the PR template change in PLAN-024-2's risk register).
- **Why pure `awsPolicyFor`:** snapshot-testing IAM policy JSON is the cheapest defense against accidentally widening a scope. Keeping policy generation as a pure function makes the snapshot tests trivial — no SDK mock needed, no async setup, no network.
- **No K8s or Azure here:** SPEC-024-2-03. Splitting AWS+GCP from Azure+K8s keeps each spec under the 220-line guideline and lets reviewers focus on the cloud-specific permissions models without a 600-line spec to read.
- **GCP `addBinding` `NotImplemented` throw is a placeholder for the spec body** — the implementation must replace it with the three documented `resourceType` branches before the spec's tests can pass. Each branch is a straight-line `getIamPolicy → mutate → setIamPolicy` round-trip; reference the `@google-cloud/run` Quickstart if needed.

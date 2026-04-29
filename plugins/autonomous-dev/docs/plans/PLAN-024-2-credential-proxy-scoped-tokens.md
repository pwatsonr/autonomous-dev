# PLAN-024-2: CredentialProxy + Per-Provider Scoped Token Issuance + Delivery Mechanisms

## Metadata
- **Parent TDD**: TDD-024-cloud-backends-credential-proxy
- **Estimated effort**: 6 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0

## Objective
Implement the `CredentialProxy` per TDD §7 — the security-critical service that issues 15-minute, operation-scoped cloud credentials to backend plugins via stdin (preferred) or unix domain socket. The proxy enforces the privileged-backends allowlist, generates the minimal IAM policy / IAM binding / Role Assignment / ServiceAccount token for each requested operation, audits every issuance and revocation, and revokes tokens early on backend completion. Each cloud provider has a custom scoper (`AWSCredentialScoper`, `GCPCredentialScoper`, `AzureCredentialScoper`, `K8sCredentialScoper`) that translates an operation name + scope into the provider-native scoped credential. This plan ensures backend plugins NEVER hold long-lived cloud credentials and CANNOT exceed their declared operation scope.

## Scope
### In Scope
- `CredentialProxy` class at `src/cred-proxy/proxy.ts` per TDD §7.1: in-process service running inside the autonomous-dev daemon, exposing `acquire(provider, operation, scope)` returning a `ScopedCredential` (15-min TTL hard-coded), and `revoke(token_id)` for early release
- `ScopedCredential` interface per TDD §7.1: `provider`, `delivery: 'stdin'|'socket'`, `payload: string`, `expires_at`, `token_id`, `scope: {operation, resources}`
- Privileged-backends allowlist enforcement: every `acquire` call verifies the caller plugin appears in `extensions.privileged_backends[]` (config). Otherwise rejects with `SecurityError`. Caller is identified via the parent process / IPC context.
- AWS credential scoper at `src/cred-proxy/scopers/aws.ts` per TDD §7.2: STS AssumeRole with on-the-fly inline session policy generated from the operation name. `awsPolicyFor('ECS:UpdateService', scope)` returns the minimal IAM policy. Session is 900 seconds.
- GCP credential scoper at `src/cred-proxy/scopers/gcp.ts`: `generateAccessToken` with delegated permissions; the proxy creates a temporary IAM binding scoped to a single resource for 15 minutes, then revokes on TTL.
- Azure credential scoper at `src/cred-proxy/scopers/azure.ts`: Managed Identity with Role Assignment scoped to the specific resource; assignment created at acquire, removed at TTL.
- K8s credential scoper at `src/cred-proxy/scopers/k8s.ts`: ServiceAccount-issued token with namespace-scoped Role binding; certificate has 15-min `Not After` from issuance.
- Stdin delivery (preferred) per TDD §7.3: when daemon spawns a backend child process, payload is written to the child's stdin. Child reads stdin once, parses, uses creds. No on-disk storage.
- Unix socket fallback per TDD §7.3: for backends needing to acquire multiple credentials during a long deploy, the daemon listens on `/tmp/autonomous-dev-cred.sock` (mode 0o600) and serves credentials per request. Backend connects with `SCM_RIGHTS` for authentication.
- TTL enforcement per TDD §7.4: hard-coded 900s in proxy code (NOT configurable). Backend plugins SHALL renew before expiry; explicit `release(token_id)` for early return. Tokens auto-revoke at TTL via per-provider revocation calls.
- Audit log entries per TDD §7.1: `credential_issued`, `credential_revoked`, `credential_expired`, `credential_denied` events flowing into the existing audit-log infrastructure (PLAN-019-4)
- `extensions.privileged_backends[]` config field listing allowed plugin IDs that can call `acquire`
- `autonomous-dev cred-proxy status` CLI: shows currently-issued tokens, expirations, and audit summary
- `autonomous-dev cred-proxy revoke <token_id>` CLI for emergency revocation
- Unit tests per scoper covering: minimal-policy generation, token creation, revocation
- Integration test: backend plugin calls `acquire`, receives scoped creds, attempts an out-of-scope operation, the cloud rejects (proves scope enforcement works at the cloud level)

### Out of Scope
- Cloud backend implementations -- delivered by PLAN-024-1 (this plan provides the proxy they call)
- Per-process egress firewall (network restrictions) -- PLAN-024-3
- Trust validation of plugins (allowlist check is here, but the broader trust framework) -- PLAN-019-3 (existing)
- Cost estimation per cloud -- PLAN-024-3
- Long-lived credential rotation (e.g., the daemon's own AWS deploy role secret) -- ops concern
- Audit log shape -- delivered by PLAN-019-4 (this plan emits via the existing writer)

## Tasks

1. **Author `ScopedCredential` interface and proxy skeleton** -- Create `src/cred-proxy/types.ts` (interfaces) and `src/cred-proxy/proxy.ts` (class skeleton with `acquire` and `revoke` methods). 15-minute TTL is a private constant.
   - Files to create: `plugins/autonomous-dev/src/cred-proxy/types.ts`, `plugins/autonomous-dev/src/cred-proxy/proxy.ts`
   - Acceptance criteria: TypeScript compiles. `TTL_SECONDS = 900` is `const` in module scope (not configurable). `acquire` returns `Promise<ScopedCredential>`. `revoke` returns `Promise<void>`.
   - Estimated effort: 1.5h

2. **Implement privileged-backends allowlist check** -- In `acquire`, verify the calling plugin is in `config.extensions.privileged_backends[]`. Caller identification uses `process.env.AUTONOMOUS_DEV_PLUGIN_ID` (set by the daemon when spawning the backend) — but ALSO cross-checks against the SCM_RIGHTS authentication on the socket if delivery=socket.
   - Files to modify: `plugins/autonomous-dev/src/cred-proxy/proxy.ts`
   - Acceptance criteria: Plugin not in allowlist → `SecurityError`. Plugin in allowlist with valid SCM_RIGHTS → proceed. Spoofed plugin ID (env var set but socket auth fails) → reject. Tests cover all three.
   - Estimated effort: 3h

3. **Implement AWS credential scoper** -- Create `src/cred-proxy/scopers/aws.ts` per TDD §7.2 with `scope(operation, scope) -> {token, id, expires}`. Generates inline session policy from operation name (e.g., `ECS:UpdateService` produces a policy granting only `ecs:UpdateService` and `ecs:DescribeServices` for the specific service ARN). Calls STS `AssumeRole` with the policy, returns the temporary credentials.
   - Files to create: `plugins/autonomous-dev/src/cred-proxy/scopers/aws.ts`, `awsPolicyFor.ts` (the policy-generation helper)
   - Acceptance criteria: `scope('ECS:UpdateService', {region: 'us-east-1', account: '123', cluster: 'prod', service: 'api'})` produces a policy granting only `ecs:UpdateService`/`ecs:DescribeServices` on `arn:aws:ecs:us-east-1:123:service/prod/api`. STS `AssumeRole` is called with the policy. Returned credential has `Expiration` 15 minutes from now. Tests use AWS SDK mocks.
   - Estimated effort: 6h

4. **Implement GCP credential scoper** -- `src/cred-proxy/scopers/gcp.ts` per TDD §7.2. Creates a temporary IAM binding via `setIamPolicy` scoped to a single resource (e.g., a specific Cloud Run service for `Run.Deploy`). Calls `iamcredentials.generateAccessToken` with the delegated permissions. Records the binding for revocation at TTL.
   - Files to create: `plugins/autonomous-dev/src/cred-proxy/scopers/gcp.ts`
   - Acceptance criteria: `scope('Run.Deploy', {project: 'p1', service: 's1'})` creates a binding granting `roles/run.developer` on the service for 15 minutes. Token returned has the right scope. Revocation removes the binding. Tests use GCP SDK mocks.
   - Estimated effort: 5h

5. **Implement Azure credential scoper** -- `src/cred-proxy/scopers/azure.ts`. Creates a Role Assignment scoped to a specific resource (Azure Container Apps deployment) for 15 minutes. Returns Managed Identity credential. Removes assignment on revocation.
   - Files to create: `plugins/autonomous-dev/src/cred-proxy/scopers/azure.ts`
   - Acceptance criteria: `scope('ContainerApps.Deploy', {resourceGroup: 'rg', appName: 'app'})` creates a Role Assignment on the resource. Returns Managed Identity creds. Revocation removes assignment. Tests use Azure SDK mocks.
   - Estimated effort: 5h

6. **Implement K8s credential scoper** -- `src/cred-proxy/scopers/k8s.ts`. Issues a ServiceAccount token with a Role binding scoped to a specific namespace. Generates a kubeconfig embedding the token. Cert has 15-min `Not After`.
   - Files to create: `plugins/autonomous-dev/src/cred-proxy/scopers/k8s.ts`
   - Acceptance criteria: `scope('deploy', {cluster: 'c1', namespace: 'ns1'})` returns a kubeconfig with embedded token. Token grants only namespace-scoped permissions. Tests use kubernetes-client mocks plus a kind cluster integration test verifying a deploy succeeds and an out-of-namespace operation fails.
   - Estimated effort: 5h

7. **Implement stdin delivery** -- In the daemon's session-spawn helper (PLAN-018-2 / earlier infrastructure), when spawning a privileged-backend child process, write the scoped credential payload to the child's stdin and close stdin. Child must read stdin once on startup.
   - Files to modify: `plugins/autonomous-dev/src/sessions/session-spawner.ts` (or its TS equivalent)
   - Acceptance criteria: A backend child spawned with `delivery: 'stdin'` receives the credential JSON via stdin. Reading stdin a second time returns EOF. Tests use a fixture child that prints what it reads to stdout for assertion.
   - Estimated effort: 3h

8. **Implement unix socket fallback** -- Daemon listens on `/tmp/autonomous-dev-cred.sock` with mode 0o600. Backends connect using SCM_RIGHTS for caller authentication. Each request is one JSON line; response is one JSON line. Server handles requests sequentially.
   - Files to create: `plugins/autonomous-dev/src/cred-proxy/socket-server.ts`
   - Acceptance criteria: Socket file exists at the documented path with mode 0o600. SCM_RIGHTS-authenticated request succeeds. Non-authenticated connection rejected. Concurrent requests serialized (no race). Tests use real Unix sockets in temp directories.
   - Estimated effort: 4h

9. **Implement TTL enforcement and auto-revocation** -- A background timer per active token fires at the TTL deadline and calls the appropriate scoper's `revoke()`. Early `release(token_id)` cancels the timer and revokes immediately.
   - Files to modify: `plugins/autonomous-dev/src/cred-proxy/proxy.ts`
   - Acceptance criteria: Token issued at T+0 is auto-revoked at T+900s. `release(token_id)` revokes immediately and cancels the auto-revoke timer. Daemon shutdown revokes all active tokens before exit. Tests use mocked timers.
   - Estimated effort: 3h

10. **Audit log integration** -- Every `credential_issued`, `credential_revoked`, `credential_expired`, `credential_denied` event flows into the audit log writer from PLAN-019-4. Events include caller plugin, provider, operation, scope, token_id.
    - Files to modify: `plugins/autonomous-dev/src/cred-proxy/proxy.ts`
    - Acceptance criteria: 1 issuance + 1 revocation produces 2 audit entries with HMAC chain intact. Failed authorization (non-allowlisted plugin) produces a `credential_denied` entry. Tests verify entry counts and types.
    - Estimated effort: 1.5h

11. **Implement `cred-proxy status` and `revoke` CLI** -- `cred-proxy status` lists active tokens with TTL remaining, caller, provider, operation. `cred-proxy revoke <token_id>` triggers immediate revocation (admin-only).
    - Files to create: `plugins/autonomous-dev/src/cli/commands/cred-proxy.ts`
    - Acceptance criteria: `status` shows columns: token_id, caller, provider, operation, expires_at. JSON mode emits structured data. `revoke abc123` revokes and audits. Non-admin invocation rejected.
    - Estimated effort: 1.5h

12. **Unit tests per scoper** -- `tests/cred-proxy/test-{aws,gcp,azure,k8s}-scoper.test.ts` covering minimal-policy generation, token creation, revocation, error handling.
    - Files to create: 4 test files
    - Acceptance criteria: All tests pass. Coverage ≥95% per scoper. Mocked SDK calls verify the right operations and parameters.
    - Estimated effort: 6h

13. **Integration test: scope enforcement** -- `tests/integration/test-cred-proxy-scope.test.ts` for K8s (only one with a real emulator: kind cluster). Backend acquires a kubeconfig scoped to namespace `ns-a`, attempts an operation in `ns-b`, the K8s API rejects. Verifies scoping works at the cloud level (not just at the proxy).
    - Files to create: `plugins/autonomous-dev/tests/integration/test-cred-proxy-scope.test.ts`
    - Acceptance criteria: Test passes deterministically against kind. The out-of-scope operation receives a 403 from the K8s API. Test runs in <2min.
    - Estimated effort: 3h

## Dependencies & Integration Points

**Exposes to other plans:**
- `CredentialProxy.acquire()` API consumed by all four cloud backends in PLAN-024-1.
- Per-provider scoper pattern reusable for any future cloud (e.g., Oracle Cloud, IBM Cloud) — the same shape applies.
- Stdin/socket delivery pattern reusable for any future privileged child process that needs short-lived credentials.
- `extensions.privileged_backends[]` config pattern reusable for any future privileged-allowlist scenario.
- Audit event shape (`credential_*` event types) consumed by future observability dashboards.

**Consumes from other plans:**
- **PLAN-024-1** (companion): cloud backends call `proxy.acquire()` for every cloud operation.
- **PLAN-019-4** (existing on main): audit log writer for credential events.
- **PLAN-019-3** (existing on main): trust framework defines admin role for `cred-proxy revoke`; the privileged-backends allowlist sits alongside the privileged-reviewers allowlist.
- **PLAN-018-2** (existing on main): session-spawn helper extended for stdin credential delivery.

## Testing Strategy

- **Unit tests per scoper (task 12):** Minimal policy generation, token creation, revocation. ≥95% coverage.
- **Integration test (task 13):** K8s scope enforcement against a real kind cluster.
- **Negative tests:** Non-allowlisted plugin attempts `acquire` → rejected. Spoofed caller ID rejected. Expired token used → cloud-API rejection.
- **Audit chain integrity:** 1000 issue/revoke events, full HMAC chain verification.
- **Performance:** Token issuance latency <500ms p95 per provider (STS/IAM API call dominates).
- **TTL precision:** Token revocation fires within ±2 seconds of the 900s deadline.
- **Manual smoke at release time:** Real cloud accounts (AWS/GCP/Azure) verify proxy issues working short-lived creds; cloud audit logs show the operations.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Inline session policy generation has a bug allowing wider scope than intended | Low | Critical -- privilege escalation | Each scoper's policy generator has snapshot tests covering 10+ operation types. Cross-reference with the cloud's least-privilege docs annually. PR template requires "did you regenerate snapshot for new operation?" Adversarial test: generate a policy for a known-bad operation, verify it rejects. |
| Stdin delivery is observed by a co-tenant on a multi-tenant host (e.g., shared CI) | Medium | High -- credential leak via /proc | Daemon's child processes have private process trees (no shared parent that could attach via ptrace). Documentation: deploy host should not have other unprivileged users. Operator-guide warning for multi-tenant scenarios. Future: move to memfd-based delivery on Linux. |
| Unix socket file mode is set after creation; race between create and chmod allows brief world-writable window | Low | Medium -- credential interception | Use `fs.openSync` with mode 0o600 in the flags (no separate chmod). Tested with `os.umask(0)` set to verify mode is set atomically. |
| Auto-revocation timer fires but the cloud API revoke call fails (network blip), token remains valid for full TTL | Medium | Medium -- credential outlives expected window | Auto-revoke retries 3× with backoff. If all fail, the token still expires at the cloud's TTL (15 min). The proxy is a defense-in-depth layer; the cloud's TTL is the authoritative limit. Documented. |
| `extensions.privileged_backends` allowlist drift (operator adds plugin without security review) | High | High -- privilege escalation via untrusted plugin | Adding to the allowlist requires admin auth (CLI `cred-proxy allow <plugin>` with admin role). All additions audited. Periodic operator review documented as a security hygiene practice. |
| K8s ServiceAccount token issuance fails for clusters without TokenRequest API (older versions) | Medium | Medium -- K8s backend doesn't work | Backend's metadata declares `min_k8s_version: 1.22`. Older clusters get a clear "K8s 1.22+ required" error at backend registration. Documented in the K8s plugin's README. |

## Definition of Done

- [ ] `CredentialProxy` exists with `acquire` and `revoke` methods; TTL hard-coded at 900s
- [ ] Privileged-backends allowlist check rejects non-allowlisted callers
- [ ] All four scopers (AWS, GCP, Azure, K8s) generate minimal-scope tokens
- [ ] Stdin delivery works for spawned backend processes
- [ ] Unix socket fallback works with SCM_RIGHTS authentication and mode 0o600
- [ ] Auto-revocation fires within ±2s of TTL deadline
- [ ] Early `release(token_id)` revokes immediately
- [ ] Audit log emits `credential_*` events with HMAC chain intact
- [ ] `cred-proxy status` and `revoke` CLI subcommands work; `revoke` is admin-only
- [ ] Unit tests per scoper pass with ≥95% coverage
- [ ] Integration test demonstrates K8s scope enforcement against kind
- [ ] Token issuance latency <500ms p95 per provider
- [ ] Snapshot tests lock in the policy/binding shape for each scoper
- [ ] Operator documentation explains the privileged-backends allowlist process
- [ ] No regressions in existing cloud backend or audit-log functionality

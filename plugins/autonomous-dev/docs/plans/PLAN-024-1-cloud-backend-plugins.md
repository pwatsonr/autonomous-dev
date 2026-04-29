# PLAN-024-1: Cloud Backend Plugin Shape + GCP/AWS/Azure/K8s Implementations

## Metadata
- **Parent TDD**: TDD-024-cloud-backends-credential-proxy
- **Estimated effort**: 6 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0

## Objective
Ship four separate cloud-deployment plugins (`autonomous-dev-deploy-gcp`, `-aws`, `-azure`, `-k8s`), each implementing the `DeploymentBackend` interface from PLAN-023-1 against its target cloud's APIs. This plan delivers the plugin packaging shape per TDD §5 (separate `plugins/autonomous-dev-deploy-*/` directories with manifest extensions), the four backend implementations per TDD §6 covering build/deploy/healthCheck/rollback for each cloud, and the `aws-deploy-expert`-style helper agent in each plugin. Credential acquisition goes through the `CredentialProxy` from PLAN-024-2 (consumed but not implemented here); egress firewall is layered in by PLAN-024-3.

## Scope
### In Scope
- Four new plugin directories: `plugins/autonomous-dev-deploy-gcp/`, `-aws/`, `-azure/`, `-k8s/` per TDD §5
- Each plugin's `plugin.json` declares `extends: ["autonomous-dev"]`, version, dependencies, and a `deployment_backend` block with `name`, `regions_supported[]`, `services_supported[]`, `credential_provider: "credential-proxy"`
- `GCPBackend` per TDD §6.1: build via Cloud Build, deploy via Cloud Run, healthCheck via URL polling, rollback via `rollbackToRevision`
- `AWSBackend` per TDD §6.2: build via ECR (docker push), deploy via ECS Fargate `UpdateService`, healthCheck via ALB, rollback via task-definition revert
- `AzureBackend` per TDD §6.3: build via ACR, deploy via Container Apps, healthCheck via Front Door, rollback via revision swap
- `K8sBackend` per TDD §6.4: deploy via `kubectl apply` with scoped kubeconfig from proxy (no build step — assumes pre-built image), healthCheck via Pod readiness, rollback via `kubectl rollout undo`
- Each backend uses vendored cloud SDKs (`@google-cloud/run`, `@aws-sdk/client-ecs`, `@azure/arm-appcontainers`, `@kubernetes/client-node`)
- Helper agents per plugin: `aws-deploy-expert.md`, `gcp-deploy-expert.md`, `azure-deploy-expert.md`, `k8s-deploy-expert.md` — each is a read-only reviewer that the daemon can consult for best-practices guidance during deploy planning
- Conformance test pass: each backend passes the conformance suite from PLAN-023-1
- Integration tests using cloud emulators / test accounts where possible:
  - GCP: Cloud Run emulator + Cloud Build via local Docker
  - AWS: LocalStack for ECS/ECR
  - Azure: stub-only (Azure has no good emulator; manual smoke required)
  - K8s: kind cluster
- Plugin-specific README.md documenting prerequisites (cloud account, IAM role, etc.)
- CLI integration via PLAN-023-2's `BackendSelector`: when a plugin is installed, the cloud backend appears in `deploy backends list`

### Out of Scope
- `CredentialProxy` implementation — delivered by PLAN-024-2 (this plan calls `proxy.acquire()` but doesn't implement it)
- Per-process egress firewall (nftables/pfctl) — PLAN-024-3
- Trust integration / privileged-backends allowlist — PLAN-024-3
- Cost estimation per cloud — PLAN-024-3
- Threat model / security audit — PLAN-024-3 documents; full audit is a separate ops concern
- Backend selection logic / multi-env config — delivered by PLAN-023-2
- Health monitor / observability / cost ledger — delivered by PLAN-023-3 (this plan's backends emit events that the framework consumes)
- Auto-scaling, load-balancer config, service mesh — NG-list from TDD-023; not added here
- Multi-region / multi-account support beyond what each backend's metadata declares (single-region per deploy is the v1 scope)

## Tasks

1. **Scaffold four plugin directories** -- Create `plugins/autonomous-dev-deploy-{gcp,aws,azure,k8s}/` with the structure: `.claude-plugin/plugin.json`, `src/backend.ts`, `agents/`, `README.md`. Each `plugin.json` declares the extension, version `0.1.0`, supported regions/services per TDD §5.
   - Files to create: 4 directories × 5+ files each
   - Acceptance criteria: All four plugin manifests validate against the v2 schema from PLAN-022-1. Each declares `extends: ["autonomous-dev"]`. The `deployment_backend` block matches the TDD example. `claude plugin validate` passes for each.
   - Estimated effort: 4h

2. **Implement `GCPBackend`** -- `plugins/autonomous-dev-deploy-gcp/src/backend.ts` per TDD §6.1. Uses `@google-cloud/run` and `@google-cloud/cloudbuild`. Build acquires creds via `proxy.acquire('gcp', 'CloudBuild:CreateBuild', ...)`, runs Cloud Build, returns artifact URI. Deploy acquires creds for `Run.Deploy`, deploys revision. HealthCheck polls the Cloud Run service URL `/health`. Rollback uses `Run.UpdateService` to point traffic at the previous revision.
   - Files to create: `plugins/autonomous-dev-deploy-gcp/src/backend.ts`, `cloud-build-helper.ts`, `cloud-run-helper.ts`
   - Acceptance criteria: Conformance suite passes. Mocked SDK calls verify the right operation names and scopes are passed to the proxy. Build returns a valid `BuildArtifact`. Deploy returns a valid `DeploymentRecord`. Tests cover happy path, build failure, deploy failure, rollback success.
   - Estimated effort: 8h

3. **Implement `AWSBackend`** -- `plugins/autonomous-dev-deploy-aws/src/backend.ts` per TDD §6.2. Uses `@aws-sdk/client-ecs` and `@aws-sdk/client-ecr`. Build pushes a Docker image to ECR (via vendored docker client; no shell). Deploy updates the ECS service. HealthCheck polls the ALB target group. Rollback reverts the ECS task definition.
   - Files to create: `plugins/autonomous-dev-deploy-aws/src/backend.ts`, `ecr-builder.ts`, `ecs-deployer.ts`, `health-checker.ts`
   - Acceptance criteria: Conformance suite passes. Each operation acquires the minimal-scope STS creds via the proxy. Tests use LocalStack for ECS/ECR; verify image-push and service-update happen. Rollback reverts to the previous task-definition revision.
   - Estimated effort: 10h

4. **Implement `AzureBackend`** -- `plugins/autonomous-dev-deploy-azure/src/backend.ts` per TDD §6.3. Uses `@azure/arm-appcontainers`. Build via ACR push. Deploy via Container Apps revision. HealthCheck via Front Door probe. Rollback via revision swap (Container Apps native).
   - Files to create: `plugins/autonomous-dev-deploy-azure/src/backend.ts`, plus helpers
   - Acceptance criteria: Conformance suite passes. Each operation uses Managed Identity (acquired via proxy). Tests use Azure SDK mocks (no public emulator). Manual smoke test against a real Azure subscription documented as a release-time validation step.
   - Estimated effort: 8h

5. **Implement `K8sBackend`** -- `plugins/autonomous-dev-deploy-k8s/src/backend.ts` per TDD §6.4. Uses `@kubernetes/client-node`. Build is a no-op (assumes image already in a registry). Deploy applies a manifest via `kubectl apply` with scoped kubeconfig from proxy. HealthCheck polls Pod readiness. Rollback via `kubectl rollout undo`.
   - Files to create: `plugins/autonomous-dev-deploy-k8s/src/backend.ts`, `manifest-applier.ts`
   - Acceptance criteria: Conformance suite passes. Backend uses scoped kubeconfig; cannot access namespaces outside the configured one. Tests use a kind cluster. Rollback uses `rollout undo` correctly. Tests cover happy path and rollout failure.
   - Estimated effort: 8h

6. **Author cloud-specific helper agents** -- Create `agents/{aws,gcp,azure,k8s}-deploy-expert.md` in each plugin. Read-only reviewer agents (tools: `Read, Glob, Grep`) that consume `deploy.yaml` and emit best-practices recommendations. Not part of the deploy phase itself; consulted by the daemon when an operator asks for guidance.
   - Files to create: 4 agent files
   - Acceptance criteria: Each agent passes the agent-meta-reviewer (PLAN-017-2) for read-only tools. Frontmatter declares the right name + description. Each agent's prompt covers cloud-specific concerns (e.g., aws-deploy-expert covers IAM least-privilege, ECR image scanning, ECS health check tuning).
   - Estimated effort: 4h

7. **Vendor cloud SDKs as dependencies** -- Add SDK packages to each plugin's `package.json` per the canonical versions: `@google-cloud/run@^1.x`, `@aws-sdk/client-ecs@^3.x`, `@azure/arm-appcontainers@^2.x`, `@kubernetes/client-node@^0.20.x`. Pin major version; allow minor/patch via Dependabot.
   - Files to modify: 4 `package.json` files
   - Acceptance criteria: `npm install` in each plugin directory succeeds. Plugin lockfiles committed. CI installs all dependencies in <2min total.
   - Estimated effort: 1.5h

8. **Conformance suite extension** -- Add a per-cloud conformance test that runs the PLAN-023-1 suite against each new backend. Fixtures use mocked SDK responses for determinism.
   - Files to create: `tests/deploy/cloud-conformance.test.ts` (one file with parameterized tests across the four backends)
   - Acceptance criteria: All four backends pass the same conformance battery as the bundled `local`/`static`/`docker-local`/`github-pages`. Mocked responses are stored in `tests/fixtures/cloud/`. Tests run in <30s total.
   - Estimated effort: 4h

9. **Plugin-specific README.md** -- Each plugin gets a README documenting: prerequisites (e.g., GCP project, AWS account with deploy IAM role, Azure subscription, Kubernetes cluster credentials), `deploy.yaml` example for that cloud, troubleshooting common issues.
   - Files to create: 4 README.md files
   - Acceptance criteria: Each README has a "Prerequisites" section, a "Configuration example" section with a working `deploy.yaml`, a "Troubleshooting" section with at least 5 common issues. Documentation reviewer (manual) confirms accuracy before merge.
   - Estimated effort: 4h

10. **Integration tests with emulators** -- For GCP and K8s where good emulators exist (Cloud Run emulator, kind), integration tests run real backend invocations. For AWS, LocalStack is used. For Azure, integration tests are skipped in CI but documented as a manual release-time step.
    - Files to create: `tests/integration/test-{gcp,aws,k8s}-backend.test.ts` (3 files; Azure stub-only)
    - Acceptance criteria: GCP test runs against Cloud Run emulator (build → deploy → health → rollback). AWS test runs against LocalStack. K8s test runs against kind cluster. All three complete in <5min total. Azure integration is captured as a release-checklist item.
    - Estimated effort: 8h

11. **Plugin-installation smoke test** -- After implementing all four plugins, verify `claude plugin install autonomous-dev-deploy-aws` (etc.) works against a local marketplace, the plugin appears in `deploy backends list`, and `deploy backends describe aws` shows the metadata.
    - Files to modify: None (test-only)
    - Acceptance criteria: Each plugin installs successfully. After install, the new backend is selectable via `deploy plan --env <env> --backend aws`. Documentation in each plugin's README reflects the canonical install path.
    - Estimated effort: 2h

## Dependencies & Integration Points

**Exposes to other plans:**
- The four cloud-backend plugins that operators install on demand. They become first-class entries in `deploy backends list`.
- The cloud-helper agent pattern (`*-deploy-expert.md`) reusable for any future cloud or third-party service that needs guidance.
- Plugin packaging shape (`plugins/autonomous-dev-deploy-*/`) reusable for any future cloud-specific extension.
- Cloud SDK pinning conventions documented; future plugins follow the same versioning.

**Consumes from other plans:**
- **PLAN-023-1** (existing on main): `DeploymentBackend` interface, conformance suite, parameter validation, HMAC-signed records.
- **PLAN-023-2** (existing on main): `BackendRegistry`, `BackendSelector`, `EnvironmentResolver`.
- **PLAN-023-3** (existing on main): health monitor, cost ledger, observability infrastructure.
- **PLAN-024-2** (companion): `CredentialProxy` consumed via `proxy.acquire(...)` calls.
- **PLAN-024-3** (companion): egress firewall protects each backend's network access.
- **PLAN-019-1** (existing on main): plugin discovery loads each cloud plugin.
- **PLAN-019-3** (existing on main): trust validator gates each plugin's registration; agent-meta-reviewer audits the helper agents.

## Testing Strategy

- **Conformance tests (task 8):** Same battery as PLAN-023-1's bundled backends. Each cloud backend must pass.
- **Integration tests with emulators (task 10):** GCP, AWS, K8s have CI-runnable emulator-based tests. Azure has a release-time manual smoke step.
- **Mocked SDK tests:** Each backend's unit tests use SDK mocks to verify operation names, scoping, and error handling.
- **Negative tests:** SDK errors (auth failure, quota exceeded, region unavailable) flow into structured `DeployError`.
- **Plugin-install smoke (task 11):** Real plugin install + `deploy backends list` confirms the backend is registered.
- **Manual smoke at release time:** Real cloud account end-to-end (build + deploy + health + rollback) for each cloud. Documented in each plugin's release checklist.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Cloud SDK major version bump introduces breaking changes (e.g., AWS SDK v3 → v4) | Medium | High -- backend stops working | Pin major version. Dependabot opens PRs for minor/patch updates only. Major upgrades are explicit follow-up plans. CI smoke test exercises each SDK at least once per release. |
| Cloud emulator (LocalStack, Cloud Run emulator) doesn't faithfully reproduce the real API behavior | High | Medium -- tests pass but real cloud fails | Manual release-time smoke against real cloud account is the safety net. Documented as a release-checklist requirement per plugin. CI tests catch regressions from one release to the next; release-time tests catch SDK divergence. |
| `proxy.acquire()` returns a credential the SDK rejects (e.g., session policy too restrictive) | Medium | High -- deploy fails after creds acquired | Each backend's tests verify the SDK accepts the proxy-issued cred for the requested operation. Failures point at the proxy's policy generation (PLAN-024-2 task 4). Operators can extend the policy via `extensions.aws_session_policies` config. |
| Backend's helper agent (e.g., `aws-deploy-expert`) drifts from cloud best practices over time | High | Low -- recommendations become stale | Annual review of each helper agent's prompt. PRD-002's reviewer eval suite includes cloud-deployment scenarios so drift is detected. |
| K8s `kubectl apply` with stdin-piped manifest is rejected by the cluster's policy engine (e.g., OPA Gatekeeper) | Medium | Medium -- deploy fails on managed clusters | Backend reads the cluster's policy violations from the apply error and surfaces them in `DeployError`. Operator guides explain how to align the deployed manifest with cluster policies. Test fixtures cover at least one OPA-rejected scenario. |
| Plugin `plugin.json` extension fields (`deployment_backend`) conflict with future v3 schema | Low | Low -- migration needed | The v2 schema (PLAN-022-1) is permissive on extension fields. v3 (future) will preserve the `deployment_backend` block. Documented as a stable extension surface. |

## Definition of Done

- [ ] Four plugin directories exist with valid `plugin.json` declaring `extends`, `deployment_backend`, and metadata
- [ ] All four backends implement `DeploymentBackend` and pass the conformance suite
- [ ] Cloud SDKs are pinned at major version with Dependabot for minor/patch
- [ ] Helper agents per cloud (`*-deploy-expert.md`) pass agent-meta-reviewer
- [ ] Each plugin's README documents prerequisites, configuration example, and troubleshooting
- [ ] Integration tests pass against emulators (GCP Cloud Run, LocalStack ECS/ECR, kind cluster)
- [ ] Azure manual release-checklist documented (no CI emulator)
- [ ] Plugin install smoke confirms each backend appears in `deploy backends list`
- [ ] All operations call `proxy.acquire()` with the minimal-scope operation name and resource scope
- [ ] No backend has shell-injection vulnerabilities (all external commands via `execFile` argv)
- [ ] No regressions in PLAN-023-1/2/3 functionality
- [ ] Operator documentation (cross-cloud comparison table) helps operators choose between backends

# PLAN-023-2: Multi-Environment Configuration + Backend Selection + Trust Integration

## Metadata
- **Parent TDD**: TDD-023-deployment-backend-framework-core
- **Estimated effort**: 4 days
- **Dependencies**: []
- **Blocked by**: [PLAN-023-1]
- **Priority**: P0

## Objective
Wire the deployment backends from PLAN-023-1 into a real production-quality deploy phase: the multi-environment configuration model per TDD §9 (`environments.dev|staging|prod` with per-environment backend selection, parameter overrides, approval requirements, and cost caps), the deterministic backend-selection algorithm per TDD §10 (priority order: per-request override → per-env config → repo default → autonomous-dev fallback), and the trust integration per TDD §11 (per-environment approval gates routed through PRD-009's escalation system). Health-check monitoring, observability, and cost cap enforcement are layered in by PLAN-023-3.

## Scope
### In Scope
- `<repo>/.autonomous-dev/deploy.yaml` config schema per TDD §9 with `environments` object containing `dev`, `staging`, `prod` (and optional custom env names). Each environment specifies `backend` (required), `parameters` (validated against backend's parameter schema from PLAN-023-1), `approval` (one of: `none`, `single`, `two-person`, `admin`), `cost_cap_usd` (per-deployment), `auto_promote_from?` (optional, e.g., staging auto-promotes from dev after success)
- `~/.claude/autonomous-dev.json` `deploy.global_caps` section: `max_deploys_per_hour`, `max_deploys_per_day`, `cost_cap_usd_per_day`. Operator-controlled global gates (independent of per-env caps)
- `EnvironmentResolver` at `src/deploy/environment.ts` that loads `deploy.yaml`, validates against the schema, applies inheritance (env-specific params override the env's defaults; defaults inherit from repo-level fallback)
- `BackendSelector` at `src/deploy/selector.ts` per TDD §10: deterministic algorithm choosing the backend for a given request + environment. Priority order: per-request override (CLI flag `--backend`) → per-env config (`environments.<env>.backend`) → repo default (`deploy.default_backend`) → autonomous-dev fallback (`local`). Selection logged to telemetry.
- Trust integration per TDD §11: for each deploy invocation, the resolver consults the per-environment `approval` field. `none` proceeds; `single` requires one operator approval via TDD-009 escalation; `two-person` requires two distinct operators; `admin` requires an org admin (per PLAN-019-3's admin definition).
- Approval state persisted at `<request>/.autonomous-dev/deployments/<deployId>.approval.json` with HMAC chaining (similar to PLAN-022-2's chain approvals). Survives daemon restarts.
- CLI `autonomous-dev deploy approve <deployId>` and `deploy reject <deployId> [--reason]` for operator approval. Both require the appropriate role (single approval from any allowlisted operator; admin requires admin role; two-person requires distinct approvers).
- CLI `autonomous-dev deploy plan [--env <env>]` previews what backend would be selected and what parameters would be applied for a given environment, without actually deploying
- Per-environment cost-cap pre-check: before invoking the backend, the cost cap is consulted; if estimated cost (passed by the backend's `estimateDeployCost(params)` method, defaulting to 0 for backends without estimation) would exceed the cap, the deploy is rejected with a clear error
- Telemetry: every backend selection emits `{request_id, env, selected_backend, source, timestamp}` to the metrics pipeline
- Unit tests for: schema validation, environment resolver (per-env override + inheritance), backend selector (priority order), approval state machine
- Integration test: dev → staging → prod promotion flow with approval gates at each step

### Out of Scope
- Backend interface, bundled backends, parameter validation, HMAC-signed records -- delivered by PLAN-023-1
- Health-check monitor (continuous polling, SLA tracking) -- PLAN-023-3
- Per-deploy log directory (observability) -- PLAN-023-3
- Cost cap enforcement at the global daily level (this plan does the per-env pre-check; PLAN-023-3 does the daily aggregation enforcement)
- Cloud backends (gcp/aws/azure/k8s) -- TDD-024
- Auto-promotion from dev to staging on success — the config field exists in the schema but the orchestration logic is a separate plan
- Rollback orchestration across environments — basic per-deploy rollback is in PLAN-023-1; cross-env rollback is a future enhancement

## Tasks

1. **Author `deploy.yaml` schema** -- Create `plugins/autonomous-dev/schemas/deploy-config-v1.json` with the structure from TDD §9. Required: `version: '1.0'`, `environments: {dev|staging|prod}`. Optional: `default_backend`, `auto_promote_from`. Per-env required: `backend`, `parameters`, `approval`, `cost_cap_usd`.
   - Files to create: `plugins/autonomous-dev/schemas/deploy-config-v1.json`
   - Acceptance criteria: Schema validates the TDD §9 example. Missing `backend` on an env fails. `approval: 'optional'` (not in enum) fails. `cost_cap_usd: -10` fails. Schema includes worked example.
   - Estimated effort: 2h

2. **Implement `EnvironmentResolver`** -- Create `src/deploy/environment.ts` with `loadConfig(repoPath)`, `resolveEnvironment(config, envName)`. Loads `deploy.yaml`, validates, applies inheritance (env params override repo defaults), returns `ResolvedEnvironment` with all fields populated.
   - Files to create: `plugins/autonomous-dev/src/deploy/environment.ts`
   - Acceptance criteria: Loading a valid `deploy.yaml` resolves correctly. A repo without `deploy.yaml` returns a fallback `ResolvedEnvironment` using the default `local` backend with `approval: none`. Env-specific params override repo-level params. Tests cover all paths.
   - Estimated effort: 3h

3. **Implement `BackendSelector`** -- Create `src/deploy/selector.ts` with `selectBackend(context)` per TDD §10. Priority order: per-request override → per-env config → repo default → autonomous-dev fallback. Returns `{backend, source, parameters}`.
   - Files to create: `plugins/autonomous-dev/src/deploy/selector.ts`
   - Acceptance criteria: With `--backend static` CLI override, returns `static`. Without override but with env config `backend: docker-local`, returns `docker-local`. Without override or env config, returns repo's `default_backend`. Without any config, returns `local`. Each path's `source` field is set correctly. Tests cover all four sources.
   - Estimated effort: 2h

4. **Implement parameter merging** -- When the selector returns a backend + parameters, validate the parameters against the backend's parameter schema (from PLAN-023-1). The selector merges per-env params with backend defaults. Validation runs server-side (using the framework from PLAN-023-1).
   - Files to modify: `plugins/autonomous-dev/src/deploy/selector.ts`
   - Acceptance criteria: A backend declares `parameters: {target_dir: {type: string, format: path}}`. Env config has `parameters: {target_dir: '/var/www'}`. Selector merges and validates; result is `{target_dir: '/var/www'}`. Invalid value (`target_dir: '/etc/passwd'`) fails validation with clear error. Tests cover happy path and validation failure.
   - Estimated effort: 2.5h

5. **Implement approval state machine** -- Create `src/deploy/approval.ts` with `requestApproval(deployId, env, approvalRequirement)`, `recordApproval(deployId, approver)`, `checkApprovalStatus(deployId)`. Approval state is persisted at `<request>/.autonomous-dev/deployments/<deployId>.approval.json` with HMAC chaining.
   - Files to create: `plugins/autonomous-dev/src/deploy/approval.ts`
   - Acceptance criteria: `single` approval: one approver suffices. `two-person`: two distinct approvers required. `admin`: only admin role can approve. State persists across daemon restarts. HMAC tampering rejected on read. Tests cover each approval type.
   - Estimated effort: 4h

6. **Wire approval into deploy phase** -- Modify the deploy phase entry point (in `bin/supervisor-loop.sh` or its TypeScript equivalent) to: resolve environment → check approval requirement → if approval needed, raise escalation and pause; if approved, invoke the backend. Resume on approval grant.
   - Files to modify: `plugins/autonomous-dev/src/deploy/orchestrator.ts` (create if absent), `plugins/autonomous-dev/bin/supervisor-loop.sh`
   - Acceptance criteria: A deploy to dev with `approval: none` proceeds immediately. To staging with `approval: single` pauses and emits an escalation. After `deploy approve <id>`, the deploy resumes. To prod with `approval: two-person` requires two approvers. Each escalation goes through PLAN-009-X (existing) routing.
   - Estimated effort: 4h

7. **Implement `deploy approve` and `deploy reject` CLI** -- `autonomous-dev deploy approve <deployId>` records an approval; resumes the deploy when threshold is met. `deploy reject <deployId> [--reason]` cancels the deploy with the reason persisted.
   - Files to create: `plugins/autonomous-dev/src/cli/commands/deploy-approve.ts`, `deploy-reject.ts`
   - Acceptance criteria: Approval from any allowlisted operator counts toward `single`. Two distinct operators advance `two-person`. Same operator approving twice is rejected. Admin-only approvals reject non-admin attempts with clear error. Tests cover each scenario.
   - Estimated effort: 2.5h

8. **Implement `deploy plan` CLI subcommand** -- `autonomous-dev deploy plan [--env <env>] [--backend <name>]` previews the resolved backend, parameters, and approval requirement for a given env. No side effects.
   - Files to create: `plugins/autonomous-dev/src/cli/commands/deploy-plan.ts`
   - Acceptance criteria: `deploy plan --env staging` prints: backend (with source), parameters (after merge), approval requirement, cost cap. `--backend static` overrides the selection (preview only). JSON output mode works. Tests cover both modes.
   - Estimated effort: 1.5h

9. **Implement per-env cost-cap pre-check** -- Before invoking the backend's `deploy()`, check that the backend's `estimateDeployCost(params)` (defaulting to 0 if not implemented) plus the day's accumulated deploys for this env stays under `cost_cap_usd`. Reject with `CostCapExceededError` if not.
   - Files to modify: `plugins/autonomous-dev/src/deploy/orchestrator.ts`
   - Acceptance criteria: With `cost_cap_usd: 10` and an estimated $12 deploy, rejects with `CostCapExceededError`. With $5 estimate plus $4 already accumulated today, rejects ($9 + $5 = $14 > $10). With $5 + $2 = $7 < $10, proceeds. Daily ledger shared across deploys to the same env. Tests cover boundary cases.
   - Estimated effort: 3h

10. **Telemetry integration** -- Emit `{request_id, env, selected_backend, source, timestamp, approval_requirement, cost_estimate}` per deploy initiation; emit completion event on success/failure.
    - Files to modify: `plugins/autonomous-dev/src/deploy/orchestrator.ts`
    - Acceptance criteria: One init event + one completion event per deploy. Event shapes match documentation. Tests verify emission for both successful and failed deploys.
    - Estimated effort: 1.5h

11. **Unit tests** -- `tests/deploy/test-environment-resolver.test.ts`, `test-backend-selector.test.ts`, `test-approval-state.test.ts` covering all paths from tasks 2-5. ≥95% coverage.
    - Files to create: three test files
    - Acceptance criteria: All tests pass. Tests use fixture `deploy.yaml` files. HMAC chain integrity tested.
    - Estimated effort: 4h

12. **Integration test: dev→staging→prod promotion** -- `tests/integration/test-deploy-promotion.test.ts` that submits a request, deploys to dev (no approval), then to staging (single approval — requires `deploy approve`), then to prod (two-person approval — requires two distinct approvers). Asserts each gate behaves correctly.
    - Files to create: `plugins/autonomous-dev/tests/integration/test-deploy-promotion.test.ts`
    - Acceptance criteria: Test passes deterministically (mocked backend invocations). Each environment's gate behavior is verified. Approval state survives a simulated daemon restart between staging and prod.
    - Estimated effort: 4h

## Dependencies & Integration Points

**Exposes to other plans:**
- `deploy.yaml` schema and `EnvironmentResolver` consumed by PLAN-023-3 (cost cap aggregation), PLAN-024-* (cloud backends inherit env config), and any future deploy-related plan.
- `BackendSelector` priority pattern reusable for future selection scenarios.
- Approval state machine pattern reusable for any future per-env human-gated workflow.
- `deploy approve` / `reject` / `plan` CLI patterns for future deploy operations.

**Consumes from other plans:**
- **PLAN-023-1** (blocking): `BackendRegistry`, `DeploymentBackend` interface, parameter validation framework, HMAC-signed records.
- **PLAN-009-X** (existing on main): escalation router for approval notifications.
- **PLAN-019-3** (existing on main): admin role definition for `admin` approval level.
- TDD-007 / PLAN-007-X: telemetry pipeline.

## Testing Strategy

- **Unit tests (task 11):** Schema, resolver, selector, approval state. ≥95% coverage.
- **Integration test (task 12):** Full dev→staging→prod promotion with approval gates.
- **Approval persistence test:** Daemon restart between approval and deploy completion; verify state recovers correctly.
- **Negative tests:** Missing `deploy.yaml` falls back to local. Invalid env name rejected. Unknown backend in config rejected at validation.
- **Manual smoke:** Real repo with a `deploy.yaml` configured; deploy to staging via CLI; approve via `deploy approve`; verify deploy proceeds.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Operator approves the wrong deploy ID by typo, advancing an unintended deploy | Medium | High -- production deploy without intent | `deploy approve` shows the deploy summary (env, backend, params, requestor) and requires explicit confirmation. CLI flag `--yes` skips confirmation but is documented as dangerous. |
| Parameter validation passes but backend invocation fails with cryptic error from external tool | High | Medium -- operator unsure what went wrong | Each backend's deploy method wraps external errors with a structured `DeployError` containing the backend name, command, exit code, stderr. Errors flow into the deployment record's `failure_reason` field. |
| Cost-cap pre-check uses estimated cost but actual cost exceeds it (estimate inaccurate) | High | Medium -- per-env cap exceeded | Estimate is best-effort. PLAN-023-3 enforces post-deploy actuals against the daily cap (independent budget). Documented: per-env cap is a pre-flight gate; daily cap is the actuals enforcement. |
| Approval state file corruption causes deploys to remain permanently paused | Low | High -- operator can't resume | Approval state file uses two-phase commit (temp + rename). HMAC chain detects tampering. Recovery procedure: delete `<deployId>.approval.json` and re-request approval (operator action documented). |
| Backend selector chooses a backend that doesn't support the target environment (e.g., `local` for prod) | Medium | High -- prod deploy goes to a PR instead of a real target | Backend's `metadata.supportedTargets` is checked against the env's intended target. Mismatch produces a validation error at config-load time, not at deploy time. Tests cover this. |
| Two-person approval is bypassed by the same operator using two SSH-key identities | Low | Medium -- governance hole | Approval records the operator's verified email (per PLAN-019-3 trust framework). Same-email accounts are treated as the same operator. Documented in operator guide. |

## Definition of Done

- [ ] `deploy-config-v1.json` schema validates the TDD §9 example
- [ ] `EnvironmentResolver` loads `deploy.yaml` and applies inheritance correctly
- [ ] `BackendSelector` follows the four-priority order and logs the source
- [ ] Parameter merging validates against the backend's parameter schema
- [ ] Approval state machine handles `none`, `single`, `two-person`, `admin`
- [ ] Approval state persists across daemon restarts via HMAC-chained file
- [ ] Deploy phase pauses on approval requirement; resumes on grant
- [ ] `deploy approve`, `deploy reject`, `deploy plan` CLI subcommands work
- [ ] Per-env cost-cap pre-check rejects deploys exceeding the cap
- [ ] Telemetry emits init + completion events with full context
- [ ] Unit tests pass with ≥95% coverage on new modules
- [ ] Integration test demonstrates dev→staging→prod promotion with all gates
- [ ] No regressions in PLAN-023-1 functionality

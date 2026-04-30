# SPEC-023-2-05: Unit Tests + Dev→Staging→Prod Promotion Integration Test

## Metadata
- **Parent Plan**: PLAN-023-2
- **Tasks Covered**: Task 11 (unit tests for resolver, selector, approval), Task 12 (integration test for full dev→staging→prod promotion with approvals)
- **Estimated effort**: 8 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-023-2-05-unit-and-promotion-integration-tests.md`

## Description
Round out PLAN-023-2 with the test surface required by the Definition of Done: comprehensive unit tests for `EnvironmentResolver`, `BackendSelector`, and the approval state machine (≥95% coverage on the new modules from SPECs 023-2-01/02/03/04), plus a deterministic integration test that exercises the full dev→staging→prod promotion flow with all approval gates, a simulated daemon restart, and assertions on telemetry events and cost-cap behavior. The integration test is the contractual proof that the four prior specs compose correctly.

The unit tests in this spec **augment** (not replace) the inline test files declared in earlier specs. SPECs 023-2-01..04 each list one test file scoped to that spec; this spec adds shared fixtures, the integration harness, and any cross-cutting tests that don't naturally belong to a single module.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/deploy/test-environment-resolver.test.ts` | Create | All paths from SPEC-023-2-01 (loader, fallback, inheritance, schema rejection) |
| `plugins/autonomous-dev/tests/deploy/test-backend-selector.test.ts` | Augment | Already created in SPEC-023-2-02; add edge cases here (empty registry, malformed override) |
| `plugins/autonomous-dev/tests/deploy/test-approval-state.test.ts` | Create | All paths from SPEC-023-2-03 (state machine, HMAC chain, persistence, tampering) |
| `plugins/autonomous-dev/tests/deploy/fixtures/deploy-config-valid.yaml` | Create | Canonical valid config used across tests |
| `plugins/autonomous-dev/tests/deploy/fixtures/deploy-config-bad-enum.yaml` | Create | `approval: optional` to trigger schema failure |
| `plugins/autonomous-dev/tests/deploy/fixtures/deploy-config-missing-backend.yaml` | Create | Env entry without `backend` |
| `plugins/autonomous-dev/tests/deploy/helpers/test-registry.ts` | Create | `makeStubRegistry()` with deterministic stub backends for tests |
| `plugins/autonomous-dev/tests/deploy/helpers/test-identity.ts` | Create | `makeApprover(email, role)` to forge PLAN-019-3 identities in-memory |
| `plugins/autonomous-dev/tests/integration/test-deploy-promotion.test.ts` | Create | Full dev→staging→prod promotion flow |

## Implementation Details

### Unit Test Coverage Targets

| Module | Branches | Lines | Critical Paths |
|--------|----------|-------|----------------|
| `src/deploy/environment.ts` | ≥95% | ≥95% | loadConfig (file present, absent, malformed); resolveEnvironment (config-backed, fallback, env-not-found); inheritance merge |
| `src/deploy/selector.ts` | ≥95% | ≥95% | All four selection sources; merge depth (shallow); validation pass + fail; UnknownBackendError |
| `src/deploy/approval.ts` | ≥95% | ≥95% | All four levels (`none`, `single`, `two-person`, `admin`); duplicate-approver guard; admin-required guard; HMAC chain verification; tamper detection; two-phase commit |
| `src/deploy/cost-cap.ts` | ≥95% | ≥95% | Single-deploy cap; daily-aggregate cap; cap=0 (no limit); UTC day rollover; idempotent recordCost |

Coverage measured with the existing project test runner; thresholds enforced in CI per repo convention.

### Fixture: `deploy-config-valid.yaml`

```yaml
version: "1.0"
default_backend: "static-stub"
environments:
  dev:
    backend: "local-stub"
    parameters: {}
    approval: "none"
    cost_cap_usd: 0
  staging:
    backend: "static-stub"
    parameters:
      target_dir: "/tmp/staging-test"
    approval: "single"
    cost_cap_usd: 5
  prod:
    backend: "static-stub"
    parameters:
      target_dir: "/tmp/prod-test"
    approval: "two-person"
    cost_cap_usd: 25
```

### Stub Registry (`test-registry.ts`)

```ts
export function makeStubRegistry(): BackendRegistry {
  return registryFromList([
    {
      metadata: { name: "local-stub", version: "0.0.0", supportedTargets: ["github-pr"], capabilities: [] },
      parameterSchema: { type: "object", properties: {} },
      defaultParameters: {},
      build: async () => ({ artifactId: "stub", checksum: "0".repeat(64), sizeBytes: 0, type: "git-ref", location: "stub", metadata: {} }),
      deploy: async (artifact, env, params) => ({ deployId: "stub-deploy-id", backend: "local-stub", environment: env, artifactId: artifact.artifactId, deployedAt: nowIso(), status: "succeeded", hmac: "stub" }),
      healthCheck: async () => ({ healthy: true, checks: [] }),
      rollback: async () => ({ success: true, errors: [] }),
      estimateDeployCost: async () => 0,
    },
    {
      metadata: { name: "static-stub", version: "0.0.0", supportedTargets: ["filesystem"], capabilities: [] },
      parameterSchema: { type: "object", required: ["target_dir"], properties: { target_dir: { type: "string", format: "path" } } },
      defaultParameters: {},
      build: async () => ({ artifactId: "stub-static", checksum: "0".repeat(64), sizeBytes: 0, type: "static-bundle", location: "stub", metadata: {} }),
      deploy: async (artifact, env, params) => ({ deployId: `stub-static-${Date.now()}`, backend: "static-stub", environment: env, artifactId: artifact.artifactId, deployedAt: nowIso(), status: "succeeded", hmac: "stub" }),
      healthCheck: async () => ({ healthy: true, checks: [] }),
      rollback: async () => ({ success: true, errors: [] }),
      estimateDeployCost: async () => 1.5,  // deterministic estimate for cost-cap testing
    },
  ]);
}
```

### Integration Test: dev→staging→prod (`test-deploy-promotion.test.ts`)

```ts
describe("PLAN-023-2 promotion: dev -> staging -> prod", () => {
  let tmpRequestDir: string;
  let registry: BackendRegistry;
  let telemetrySink: DeployEvent[];

  beforeEach(async () => {
    tmpRequestDir = await mkdtemp("deploy-promo-");
    await writeFixtureConfig(tmpRequestDir, "deploy-config-valid.yaml");
    registry = makeStubRegistry();
    telemetrySink = [];
    setTelemetrySink(telemetrySink);
  });

  afterEach(async () => {
    await rm(tmpRequestDir, { recursive: true, force: true });
    resetTelemetrySink();
  });

  it("dev (none): proceeds without approval", async () => {
    const r = await runDeploy({ deployId: "d1", envName: "dev", requestDir: tmpRequestDir });
    expect(r.status).toBe("completed");
    expect(telemetrySink.filter(e => e.type === "deploy.init")).toHaveLength(1);
    expect(telemetrySink.filter(e => e.type === "deploy.completion")).toHaveLength(1);
    expect(telemetrySink[1].outcome).toBe("success");
  });

  it("staging (single): pauses, then resumes after one approval", async () => {
    const first = await runDeploy({ deployId: "s1", envName: "staging", requestDir: tmpRequestDir });
    expect(first.status).toBe("paused");
    expect(telemetrySink.filter(e => e.type === "deploy.init")).toHaveLength(1);
    expect(telemetrySink.filter(e => e.type === "deploy.completion")).toHaveLength(0);

    const op = makeApprover("alice@example.com", "operator");
    await recordApproval({ deployId: "s1", approver: op.email, role: op.role, requestDir: tmpRequestDir });

    const second = await runDeploy({ deployId: "s1", envName: "staging", requestDir: tmpRequestDir });
    expect(second.status).toBe("completed");
    expect(telemetrySink.filter(e => e.type === "deploy.completion")).toHaveLength(1);
  });

  it("prod (two-person): requires two distinct approvers; survives daemon restart between them", async () => {
    const first = await runDeploy({ deployId: "p1", envName: "prod", requestDir: tmpRequestDir });
    expect(first.status).toBe("paused");

    // First approver
    await recordApproval({ deployId: "p1", approver: "alice@example.com", role: "operator", requestDir: tmpRequestDir });

    // Simulate daemon restart: clear in-memory state, reload from disk
    await simulateDaemonRestart();

    // Same approver attempting to advance: should reject
    await expect(recordApproval({ deployId: "p1", approver: "alice@example.com", role: "operator", requestDir: tmpRequestDir }))
      .rejects.toThrow(DuplicateApproverError);

    // Distinct second approver
    await recordApproval({ deployId: "p1", approver: "bob@example.com", role: "operator", requestDir: tmpRequestDir });

    const second = await runDeploy({ deployId: "p1", envName: "prod", requestDir: tmpRequestDir });
    expect(second.status).toBe("completed");
  });

  it("rejection: rejected deploy does not proceed even after later approve attempts", async () => {
    await runDeploy({ deployId: "r1", envName: "staging", requestDir: tmpRequestDir }); // pauses
    await recordRejection({ deployId: "r1", approver: "alice@example.com", role: "operator", reason: "infra freeze", requestDir: tmpRequestDir });
    const after = await runDeploy({ deployId: "r1", envName: "staging", requestDir: tmpRequestDir });
    expect(after.status).toBe("rejected");
  });

  it("cost-cap: prod with cap $25 and $30 estimate fails fast with cost-cap-exceeded", async () => {
    overrideStubEstimate("static-stub", 30);
    await runDeploy({ deployId: "c1", envName: "prod", requestDir: tmpRequestDir }); // pauses
    await recordApproval({ deployId: "c1", approver: "alice@example.com", role: "operator", requestDir: tmpRequestDir });
    await recordApproval({ deployId: "c1", approver: "bob@example.com", role: "operator", requestDir: tmpRequestDir });

    await expect(runDeploy({ deployId: "c1", envName: "prod", requestDir: tmpRequestDir }))
      .rejects.toThrow(CostCapExceededError);

    const completion = telemetrySink.filter(e => e.type === "deploy.completion").pop();
    expect(completion?.outcome).toBe("cost-cap-exceeded");
  });
});
```

### Daemon Restart Simulation

`simulateDaemonRestart()` clears any module-level caches (none expected in the resolver/selector/approval modules, but defensive) and forces the next call to re-read from disk. Because the approval state file is the source of truth and the modules hold no in-memory caches, "restart" reduces to clearing test-doubles and asserting that `loadApprovalState()` reproduces the same state.

### Negative-Path Tests (in `test-environment-resolver.test.ts`)
- `loadConfig` on missing file → `null`.
- `loadConfig` on malformed YAML → `ConfigValidationError` with line number.
- `loadConfig` on `deploy-config-bad-enum.yaml` → `ConfigValidationError` referencing `/environments/dev/approval`.
- `loadConfig` on `deploy-config-missing-backend.yaml` → `ConfigValidationError` referencing missing `backend`.
- `resolveEnvironment(config, "ghost")` → `UnknownEnvironmentError` listing `[dev, staging, prod]`.

### HMAC Tampering Tests (in `test-approval-state.test.ts`)
- Write a valid two-entry state.
- Mutate `entries[0].recordedAt` on disk.
- `loadApprovalState` throws `ApprovalChainError` with `entryIndex: 0`.
- Mutate `entries[1].approver` on disk.
- `loadApprovalState` throws `ApprovalChainError` with `entryIndex: 1`.

## Acceptance Criteria
1. [ ] `npm test -- tests/deploy/test-environment-resolver.test.ts` passes; ≥95% line + branch coverage on `src/deploy/environment.ts`.
2. [ ] `npm test -- tests/deploy/test-backend-selector.test.ts` passes; ≥95% coverage on `src/deploy/selector.ts`.
3. [ ] `npm test -- tests/deploy/test-approval-state.test.ts` passes; ≥95% coverage on `src/deploy/approval.ts` and `src/deploy/approval-store.ts`.
4. [ ] `npm test -- tests/integration/test-deploy-promotion.test.ts` passes deterministically across 50 consecutive runs (no flake).
5. [ ] Fixture YAMLs validate (or fail) against the schema as documented; fixture-validation test included.
6. [ ] Stub registry produces backends that pass PLAN-023-1's conformance suite (sanity check that fixtures aren't lying).
7. [ ] Integration test "dev (none)" emits exactly one init event and one completion event with `outcome: "success"`.
8. [ ] Integration test "staging (single)" emits one init event on first invocation, no completion until after approval, then one completion with `outcome: "success"`.
9. [ ] Integration test "prod (two-person)" rejects same-approver double-approval with `DuplicateApproverError` after a simulated daemon restart.
10. [ ] Integration test "rejection" demonstrates that `decision: "rejected"` is terminal (later `runDeploy` returns `rejected`, no backend invocation).
11. [ ] Integration test "cost-cap" emits `deploy.completion` with `outcome: "cost-cap-exceeded"` and the cost ledger is NOT incremented for the failed deploy.
12. [ ] HMAC tampering tests verify that any single-byte mutation to a recorded entry causes `loadApprovalState` to throw with the exact `entryIndex`.
13. [ ] Tests do NOT touch real PLAN-009-X escalation routes; the router is replaced by a recording test double.
14. [ ] Tests do NOT touch real PLAN-019-3 identity verification; identities are forged via `makeApprover()` helper.
15. [ ] Test suite total runtime under 30 seconds on a stock developer laptop.

## Dependencies
- **Blocks**: nothing within PLAN-023-2; this is the terminal spec.
- **Consumes**: All four prior specs (SPEC-023-2-01/02/03/04). Also relies on PLAN-023-1's `BackendRegistry` and conformance suite, and on existing test infrastructure (test runner, coverage reporter).
- No new external test libraries; uses the same runner already in repo CI.

## Notes
- The test fixtures intentionally use stub backends (`local-stub`, `static-stub`) rather than the real PLAN-023-1 backends so that the integration test does not depend on `gh`, `git`, `docker`, or any external CLI being available in CI.
- Determinism is paramount: any source of randomness (timestamps, deploy IDs) is seeded via test helpers (`nowIso()` is replaced with a frozen clock in `beforeEach`).
- The "daemon restart" simulation is intentionally lightweight — production restart resilience is exercised by PLAN-002's chaos test suite. This spec only validates that the approval module has no hidden in-memory state that would break across restarts.
- Coverage thresholds (≥95%) are aspirational; if a specific defensive branch (e.g., `JSON.parse` failure on a freshly-written file) cannot be exercised, an `/* istanbul ignore next */` comment with rationale is acceptable but should be rare.
- This spec does NOT cover PLAN-023-3's continuous health monitor or the daily-aggregate global cost cap; those have their own integration tests in PLAN-023-3.
- Manual smoke test (per plan §"Testing Strategy") is operator-driven and not part of this spec's automated suite.

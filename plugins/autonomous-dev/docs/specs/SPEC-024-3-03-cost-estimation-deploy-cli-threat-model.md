# SPEC-024-3-03: Per-Cloud Cost Estimation + Deploy Wiring + Estimate CLI + Threat Model

## Metadata
- **Parent Plan**: PLAN-024-3
- **Tasks Covered**: Task 7 (per-cloud cost estimation), Task 8 (wire into deploy flow), Task 9 (`deploy estimate` CLI), Task 10 (threat model documentation)
- **Estimated effort**: 14 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-024-3-03-cost-estimation-deploy-cli-threat-model.md`

## Description
Deliver the cost-estimation layer of TDD-024 §10 plus the canonical threat-model document for the cloud subsystem.

Four artifacts:

1. **Per-cloud `estimateDeployCost(params)`** on each of the four cloud backends (AWS, GCP, Azure, K8s). Returns `{ estimated_cost_usd, currency: 'USD', breakdown: LineItem[], confidence: 0..1, notes?: string }`. Heuristics use static pricing fixtures; no live billing-API calls.
2. **Deploy-orchestrator wiring**: the existing PLAN-023-2/3 deploy orchestrator calls `estimateDeployCost(params)` before `deploy(params)`, records the estimate in PLAN-023-3's cost ledger, and rejects the deploy when the pre-check exceeds the env's daily cap.
3. **`deploy estimate` CLI**: `autonomous-dev deploy estimate --env <env> [--json]` resolves the backend for the env, builds the deploy params from the env's deploy spec, calls `estimateDeployCost`, and prints the breakdown — without invoking `deploy()`.
4. **Cloud-backend threat model**: `docs/security/cloud-backend-threat-model.md` covering ≥6 threat scenarios with mitigation chains. Each mitigation cites the PLAN that delivers it.

This spec depends on PLAN-024-1 (cloud backends exist as plugin scaffolds), PLAN-023-2 (deploy orchestrator), and PLAN-023-3 (cost ledger + cap enforcement). It does not implement firewall, trust, or schema work — those are SPEC-024-3-01 and -02.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/deploy/cost-estimation.ts` | Create | Shared `EstimateResult`, `LineItem`, `CostEstimator` interface |
| `plugins/autonomous-dev/src/deploy/pricing-fixtures.ts` | Create | Static USD pricing tables (AWS Fargate, GCP Cloud Run, Azure Container Apps) |
| `plugins/autonomous-dev-deploy-aws/src/backend.ts` | Modify | Add `estimateDeployCost(params)` |
| `plugins/autonomous-dev-deploy-gcp/src/backend.ts` | Modify | Add `estimateDeployCost(params)` |
| `plugins/autonomous-dev-deploy-azure/src/backend.ts` | Modify | Add `estimateDeployCost(params)` |
| `plugins/autonomous-dev-deploy-k8s/src/backend.ts` | Modify | Add `estimateDeployCost(params)` (returns $0 / confidence 0.0) |
| `plugins/autonomous-dev/src/deploy/orchestrator.ts` | Modify | Call estimate; pass into ledger; pre-check against cap |
| `plugins/autonomous-dev/src/cli/commands/deploy-estimate.ts` | Create | `deploy estimate --env <env>` subcommand |
| `plugins/autonomous-dev/src/cli/index.ts` | Modify | Register `deploy estimate` subcommand |
| `plugins/autonomous-dev/docs/security/cloud-backend-threat-model.md` | Create | ≥6 threat scenarios, each with mitigation chain |

## Implementation Details

### Shared interface (`deploy/cost-estimation.ts`)

```ts
export interface LineItem {
  label: string;          // e.g. "Fargate vCPU-hours"
  quantity: number;       // e.g. 1.0
  unit: string;           // e.g. "vCPU-hour"
  unit_price_usd: number; // e.g. 0.04048
  subtotal_usd: number;   // quantity * unit_price_usd
}
export interface EstimateResult {
  estimated_cost_usd: number;   // sum of line subtotals
  currency: 'USD';
  breakdown: LineItem[];
  confidence: number;           // 0.0 (no idea) .. 1.0 (fixed-price)
  notes?: string;
}
export interface CostEstimator<P> {
  estimateDeployCost(params: P): Promise<EstimateResult>;
}
```

The `DeploymentBackend` interface (defined in PLAN-024-1) is extended to require `estimateDeployCost`.

### Pricing fixtures (`pricing-fixtures.ts`)

Static export of USD prices, captured from public pricing pages on the spec date and pinned. Each entry includes `source_url` and `captured_on` for auditability.

```ts
export const PRICING = {
  aws: {
    fargate_vcpu_hour_usd: 0.04048,
    fargate_gb_hour_usd:   0.004445,
    ecr_storage_gb_month_usd: 0.10,
    source_url: 'https://aws.amazon.com/fargate/pricing/',
    captured_on: '2026-04-29',
  },
  gcp: {
    cloud_run_request_per_million_usd: 0.40,
    cloud_run_vcpu_second_usd: 0.000024,
    cloud_run_gib_second_usd:  0.0000025,
    source_url: 'https://cloud.google.com/run/pricing',
    captured_on: '2026-04-29',
  },
  azure: {
    container_apps_vcpu_second_usd: 0.000024,
    container_apps_gib_second_usd:  0.000003,
    container_apps_request_per_million_usd: 0.40,
    source_url: 'https://azure.microsoft.com/pricing/details/container-apps/',
    captured_on: '2026-04-29',
  },
} as const;
```

### Per-backend heuristics

**AWS** (`autonomous-dev-deploy-aws/src/backend.ts`):
```
fargate_cost = tasks * vcpu * vcpu_hours * fargate_vcpu_hour_usd
             + tasks * memory_gb * vcpu_hours * fargate_gb_hour_usd
ecr_cost     = image_size_gb * ecr_storage_gb_month_usd * (run_hours / 730)
total        = fargate_cost + ecr_cost
confidence   = 0.85   // Fargate is fixed-price, but per-second billing rounds up; data transfer is unmodeled
notes        = 'Excludes data transfer, NAT Gateway, and CloudWatch.'
```

**GCP** (`autonomous-dev-deploy-gcp/src/backend.ts`):
```
request_cost = (expected_requests / 1_000_000) * cloud_run_request_per_million_usd
cpu_cost     = vcpu * (vcpu_seconds) * cloud_run_vcpu_second_usd
mem_cost     = gib  * (gib_seconds)  * cloud_run_gib_second_usd
total        = request_cost + cpu_cost + mem_cost
confidence   = 0.65   // request volume is operator-supplied, often a guess
notes        = 'Free tier (2M requests/month) not subtracted; assumes always-on.'
```

**Azure** (`autonomous-dev-deploy-azure/src/backend.ts`):
Mirrors GCP shape with Azure pricing constants. `confidence: 0.6`.

**K8s** (`autonomous-dev-deploy-k8s/src/backend.ts`):
```
return { estimated_cost_usd: 0.0, currency: 'USD', breakdown: [], confidence: 0.0,
         notes: 'Cluster billing is the operator\'s responsibility; per-deploy cost is not estimated.' };
```

All four implementations must complete in <50ms (no network, no DNS — pure arithmetic).

### Orchestrator wiring (`deploy/orchestrator.ts`)

In the existing `runDeploy(env)` flow, between "params resolved" and "backend.deploy invoked":

```ts
const estimate = await backend.estimateDeployCost(params);
const capCheck = await costLedger.checkCap(env, estimate.estimated_cost_usd);
if (!capCheck.ok) {
  throw new DeployRejectedError(
    `Deploy rejected: estimated $${estimate.estimated_cost_usd.toFixed(2)} would exceed ` +
    `${capCheck.windowLabel} cap of $${capCheck.capUsd.toFixed(2)} ` +
    `(current usage $${capCheck.currentUsd.toFixed(2)}, confidence ${estimate.confidence}).`
  );
}
await costLedger.recordEstimate({
  env, backend: backend.name, deploy_id: deployId,
  estimated_cost_usd: estimate.estimated_cost_usd, breakdown: estimate.breakdown,
  confidence: estimate.confidence, ts: Date.now(),
});
const result = await backend.deploy(params);
// Actual cost (when known) updates the same record via costLedger.recordActual(deployId, …) -- out of scope here.
return result;
```

`costLedger.checkCap` and `recordEstimate` are PLAN-023-3 contracts; this spec consumes them.

### `deploy estimate` CLI (`cli/commands/deploy-estimate.ts`)

```
autonomous-dev deploy estimate --env <env> [--json]
```

Behaviour:
1. Resolve the env's deploy spec via the existing config loader.
2. Resolve the backend via PLAN-023-2's backend registry.
3. Build deploy params via the same builder the live deploy uses.
4. Call `backend.estimateDeployCost(params)`.
5. Format output:
   - **Default (table)**: backend name, env, total, confidence, then a table of breakdown line items (label, quantity, unit, unit_price_usd, subtotal_usd). Notes printed below.
   - **`--json`**: stdout is the `EstimateResult` plus `{ env, backend }` wrapper, no other text.
6. Exit code 0 on success; 2 on missing env or unresolvable backend; 3 on backend error.

The CLI does NOT invoke `deploy()` and does NOT touch the cost ledger (estimate-only).

### Threat model document

`docs/security/cloud-backend-threat-model.md`. Required structure:

```
# Cloud Backend Threat Model
## Scope
## Assumptions
## Threat Scenarios
### T1: Malicious or compromised cloud-backend plugin
- Attack: ...
- Impact: ...
- Mitigation chain: PLAN-019-3 trust validator → PLAN-024-2 privileged_backends allowlist
                  → SPEC-024-3-02 cloud-backend trust hook → SPEC-024-3-01/02 egress firewall
                  → PLAN-024-2 scoped credentials with 15-min TTL
- Residual risk: ...
### T2: Credential exfiltration to attacker host
### T3: Excessive cloud spend (intentional or accidental)
### T4: Supply-chain attack on cloud SDK dependency
### T5: DNS rebinding to bypass egress allowlist
### T6: Privilege escalation via shared filesystem (/tmp leak)
## Out of Scope
## References
```

Each scenario includes Attack, Impact, Mitigation chain (with PLAN/SPEC citations), and Residual risk. The document must be reviewed by an external reviewer before merge (tracked in PR description, not enforced by CI).

## Acceptance Criteria

- [ ] `estimateDeployCost` is declared on the `DeploymentBackend` interface (TypeScript compile fails if any of the four backends omits it).
- [ ] AWS backend: for `params = { tasks: 2, vcpu: 0.5, memory_gb: 1.0, vcpu_hours: 1.0, image_size_gb: 0.5, run_hours: 1.0 }`, `estimated_cost_usd` is within ±$0.005 of `2 * 0.5 * 1.0 * 0.04048 + 2 * 1.0 * 1.0 * 0.004445 + 0.5 * 0.10 * (1/730)`. Confidence is 0.85.
- [ ] GCP backend: for `params = { expected_requests: 1_000_000, vcpu: 1, vcpu_seconds: 0, gib: 0.5, gib_seconds: 0 }`, `estimated_cost_usd` is exactly `0.40` (request-only). Confidence is 0.65.
- [ ] Azure backend: returns a numeric `estimated_cost_usd` ≥ 0 with confidence 0.6 for any well-formed params.
- [ ] K8s backend: always returns `{ estimated_cost_usd: 0.0, confidence: 0.0, breakdown: [], notes: <non-empty> }`.
- [ ] Each backend's `estimateDeployCost` returns in <50ms (microbenchmark in unit tests; SPEC-024-3-04 enforces the gate).
- [ ] Orchestrator calls `estimateDeployCost` exactly once before `deploy()`; verified by spy.
- [ ] Pre-deploy: with a $50 estimate against a $100 daily cap (current usage $0), `runDeploy` proceeds.
- [ ] Pre-deploy: with a $50 estimate against a $40 daily cap (current usage $0), `runDeploy` throws `DeployRejectedError` whose message contains the env name, the estimated dollar amount, the cap dollar amount, and the confidence value.
- [ ] On success, `costLedger.recordEstimate` is called exactly once with `{env, backend, deploy_id, estimated_cost_usd, breakdown, confidence, ts}`.
- [ ] On `DeployRejectedError`, `backend.deploy` is NOT called and `costLedger.recordEstimate` is NOT called.
- [ ] `autonomous-dev deploy estimate --env staging` prints a table with the resolved backend, total, confidence, and a row per breakdown item; exit code 0.
- [ ] `autonomous-dev deploy estimate --env staging --json` writes valid JSON to stdout that parses back into `EstimateResult & { env, backend }` and contains no extra log lines.
- [ ] `autonomous-dev deploy estimate --env nonexistent` exits with code 2 and a clear "env not found" message.
- [ ] `cloud-backend-threat-model.md` exists, contains exactly the headings listed in the structure above, and includes ≥6 threat scenarios numbered T1..T6 (or higher).
- [ ] Each threat scenario in the doc cites at least one PLAN or SPEC identifier in its Mitigation chain (regex check in CI: each `### T` block contains `PLAN-` or `SPEC-`).
- [ ] Pricing fixtures include `source_url` and `captured_on` for each cloud (regex check in CI).

## Dependencies

- **Blocks**: SPEC-024-3-04 (unit tests for cost estimation; integration test does not depend on this spec but the cost-estimation tests do).
- **Blocked by**: PLAN-024-1 (cloud-backend plugin shells exist with `DeploymentBackend` interface); PLAN-023-2 (deploy orchestrator); PLAN-023-3 (cost ledger + `checkCap` + `recordEstimate`); PLAN-019-3 (only loosely — for the threat-model citations).
- **External**: None — all pricing is offline fixtures.

## Notes

- Pricing fixtures are deliberately pinned and dated. Stale fixtures will produce stale estimates; the spec accepts this trade-off because (a) cost estimates are best-effort by design (per the risks table in PLAN-024-3) and (b) the `confidence` field signals to operators that the number is approximate. A future enhancement may pull live pricing from each cloud's pricing API; out of scope for v1.
- Confidence values (0.85 AWS, 0.65 GCP, 0.6 Azure, 0.0 K8s) reflect the predictability of each pricing model: Fargate is per-second flat-rate; Cloud Run/Container Apps depend on request volume which is operator-guessed; K8s cluster cost is structurally not per-deploy.
- The orchestrator's pre-check uses `estimated_cost_usd`, NOT the upper bound from confidence. Operators with low-confidence backends should set conservative caps. Documented in the operator guide (out of scope here).
- The `deploy estimate` CLI intentionally bypasses the cap pre-check — its purpose is to reveal the estimate so operators can decide whether to adjust the cap before deploying. Calling `deploy` after a successful estimate runs the full pre-check.
- Threat-model document is canonical; future cloud-related plans (PLAN-024-4+) update it with new scenarios. The structure (Scope/Assumptions/Threats/Out of Scope/References) is fixed.
- The `notes` field on each `EstimateResult` is intended for operator-facing caveats ("excludes data transfer", "free tier not subtracted") and is rendered verbatim by the CLI.
- K8s returning `$0` with `confidence: 0.0` is intentional — operators running on existing clusters already have separate tooling for cluster cost (Kubecost, Prometheus). Estimating per-deploy K8s cost would be misleading without cluster context.

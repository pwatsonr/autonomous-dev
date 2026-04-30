# SPEC-023-2-04: Deploy CLI (approve/reject/plan), Per-Env Cost-Cap Pre-Check, Telemetry

## Metadata
- **Parent Plan**: PLAN-023-2
- **Tasks Covered**: Task 7 (`deploy approve` / `deploy reject` CLI), Task 8 (`deploy plan` CLI), Task 9 (per-env cost-cap pre-check), Task 10 (telemetry integration)
- **Estimated effort**: 8.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-023-2-04-deploy-cli-cost-cap-telemetry.md`

## Description
Surface the deploy framework to operators and finish the orchestrator. This spec ships three CLI subcommands (`deploy approve`, `deploy reject`, `deploy plan`), the per-environment cost-cap pre-check that gates backend invocation, and the telemetry emission for selection + completion events. Together these complete the operator-facing contract for PLAN-023-2: an operator can preview a deploy (`deploy plan`), authorize it (`deploy approve`), or kill it (`deploy reject`), with per-env cost limits enforced before any backend work and structured telemetry emitted to the metrics pipeline.

The orchestrator (introduced in SPEC-023-2-03) is extended here: cost-cap pre-check runs after approval but before `backend.deploy()`; telemetry init event is emitted at the start of `runDeploy`, and a completion event is emitted on every terminal outcome (success, rejection, failure, cap exceeded).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/cli/commands/deploy-approve.ts` | Create | `autonomous-dev deploy approve <deployId> [--yes]` |
| `plugins/autonomous-dev/src/cli/commands/deploy-reject.ts` | Create | `autonomous-dev deploy reject <deployId> --reason <text>` |
| `plugins/autonomous-dev/src/cli/commands/deploy-plan.ts` | Create | `autonomous-dev deploy plan [--env <name>] [--backend <name>] [--json]` |
| `plugins/autonomous-dev/src/cli/index.ts` | Modify | Register the three new subcommands |
| `plugins/autonomous-dev/src/deploy/cost-cap.ts` | Create | `checkCostCap()`, daily ledger reader/writer at `<requestDir>/.autonomous-dev/deployments/cost-ledger-<env>.json` |
| `plugins/autonomous-dev/src/deploy/orchestrator.ts` | Modify | Insert cost-cap pre-check + telemetry emission around backend invocation |
| `plugins/autonomous-dev/src/deploy/telemetry.ts` | Create | `emitDeployInit()`, `emitDeployCompletion()` thin wrappers over PLAN-007-X pipeline |

## Implementation Details

### `deploy approve` Command

```
Usage: autonomous-dev deploy approve <deployId> [--yes] [--request-dir <path>]

Behavior:
  1. Resolve approver identity via PLAN-019-3 (verified email + role).
  2. Load <deployId>.approval.json via SPEC-023-2-03 loader.
  3. Print summary table: env, backend, source, parameters, requirement, current entries.
  4. Unless --yes: prompt "Approve this deploy? [y/N]" on stdin (TTY only).
  5. Call recordApproval({deployId, approver, role, requestDir}).
  6. On threshold met: print "Approval threshold met. Deploy will resume on next supervisor tick."
     On still-pending (e.g., two-person needs another): print remaining-approver count.
  7. Exit codes: 0 = recorded successfully; 2 = duplicate approver; 3 = admin required;
     4 = state file corrupt; 5 = deploy not found.
```

### `deploy reject` Command

```
Usage: autonomous-dev deploy reject <deployId> --reason <text> [--yes] [--request-dir <path>]

Behavior:
  1. Resolve approver identity.
  2. Validate --reason is non-empty (≥ 5 chars).
  3. Load + display deploy summary (same table as approve).
  4. Unless --yes: prompt "Reject this deploy? [y/N]".
  5. Call recordRejection(...).
  6. Print "Deploy <deployId> rejected. Reason persisted."
  7. Exit 0 on success; non-zero per the same code map as approve.
```

### `deploy plan` Command (Read-Only Preview)

```
Usage: autonomous-dev deploy plan [--env <name>] [--backend <name>] [--json] [--request-dir <path>]

Behavior (NO side effects, no telemetry, no state writes):
  1. loadConfig(requestDir) -> may be null
  2. resolveEnvironment(config, env ?? "dev") -> ResolvedEnvironment
  3. selectBackend({resolved, registry, override: backend ? {backend} : undefined,
                    repoDefaultBackend: config?.default_backend}) -> BackendSelection
  4. Compute estimated cost via backend.estimateDeployCost?.(selection.parameters) ?? 0
  5. Read cost ledger total for the env's current UTC day
  6. Render either:
     - Human format (default): table with rows
         Environment, Backend, Selection source, Approval, Cost cap (USD),
         Estimated cost (USD), Today's cost so far (USD), Headroom (USD),
         Parameters (key=value list)
     - JSON format (--json): single object with the same fields, lower-camel keys
```

### Cost-Cap Pre-Check (`cost-cap.ts`)

```ts
export interface CostLedger {
  envName: string;
  dayUtc: string;          // "YYYY-MM-DD"
  totalUsd: number;        // sum of accepted deploys today
  entries: Array<{ deployId: string; usd: number; ts: string }>;
}

export async function checkCostCap(args: {
  requestDir: string;
  envName: string;
  capUsd: number;          // 0 means "no cap"
  estimatedUsd: number;
}): Promise<{ allowed: true; ledger: CostLedger } | { allowed: false; reason: string; ledger: CostLedger }>;

// Append a successful deploy's cost to today's ledger. Idempotent on deployId.
export async function recordCost(args: {
  requestDir: string;
  envName: string;
  deployId: string;
  usd: number;
}): Promise<void>;
```

Rules:
- `capUsd === 0` → always allowed (no cap configured); ledger still updated.
- `estimatedUsd > capUsd` → rejected (`reason: "single deploy estimate exceeds cap"`).
- `ledger.totalUsd + estimatedUsd > capUsd` → rejected (`reason: "estimate would exceed daily cap"`).
- Day boundary: ledger key is UTC date; first deploy after UTC midnight starts a fresh ledger (old file rolled to `.archive/`).
- Two-phase commit for ledger writes (same pattern as approval store).

### Orchestrator Integration (modify `orchestrator.ts`)

Insertion points after the approval gate from SPEC-023-2-03:

```ts
// (after approval check passes and before backend invocation)
const estimatedCost = await safeEstimate(backend, selection.parameters);  // 0 on throw
emitDeployInit({
  requestId: args.deployId,
  envName: resolved.envName,
  selectedBackend: selection.backendName,
  source: selection.source,
  approvalRequirement: resolved.approval,
  costEstimate: estimatedCost,
  ts: nowIso(),
});

const capCheck = await checkCostCap({
  requestDir: args.requestDir,
  envName: resolved.envName,
  capUsd: resolved.costCapUsd,
  estimatedUsd: estimatedCost,
});
if (!capCheck.allowed) {
  emitDeployCompletion({ ... outcome: "cost-cap-exceeded", reason: capCheck.reason });
  throw new CostCapExceededError(capCheck.reason);
}

const result = await invokeBackend(selection); // PLAN-023-1's backend.deploy
await recordCost({ requestDir: args.requestDir, envName: resolved.envName, deployId: args.deployId, usd: estimatedCost });
emitDeployCompletion({ ... outcome: result.status, durationMs, actualCostUsd: estimatedCost });
```

### Telemetry Event Shapes (`telemetry.ts`)

```ts
export interface DeployInitEvent {
  type: "deploy.init";
  requestId: string;
  envName: string;
  selectedBackend: string;
  source: SelectionSource;        // from SPEC-023-2-02
  approvalRequirement: ApprovalLevel;
  costEstimate: number;
  ts: string;                     // ISO-8601 UTC
}

export interface DeployCompletionEvent {
  type: "deploy.completion";
  requestId: string;
  envName: string;
  selectedBackend: string;
  outcome: "success" | "failure" | "rejected" | "cost-cap-exceeded" | "paused";
  durationMs: number | null;       // null when outcome === "paused" (still in-flight)
  actualCostUsd: number;
  reason?: string;                 // present on failure / cost-cap-exceeded / rejected
  ts: string;
}
```

Both events are written via the existing PLAN-007-X telemetry pipeline (single-line JSON to the metrics sink).

## Acceptance Criteria
1. [ ] `deploy approve <id>` from an allowlisted operator on a `single` requirement records one entry and prints "Approval threshold met."
2. [ ] `deploy approve <id>` from a non-admin on an `admin` requirement exits with code 3 and prints "Admin role required."
3. [ ] `deploy approve <id>` twice from the same operator on a `two-person` requirement exits with code 2 (duplicate); state shows only one entry.
4. [ ] `deploy approve <id>` on a `two-person` requirement from two distinct operators (across two CLI invocations) advances state to `approved`.
5. [ ] `deploy reject <id> --reason "infra change required"` records a reject entry; subsequent `deploy approve` calls are no-ops (decision is terminal).
6. [ ] `deploy reject <id>` without `--reason` (or with reason < 5 chars) exits non-zero with a clear validation error.
7. [ ] `--yes` flag skips the interactive prompt; non-TTY invocation behaves as if `--yes` was passed (no prompt, no hang).
8. [ ] `deploy plan --env staging` prints a table including: backend (with source), parameters (post-merge), approval, cost cap, estimated cost, today's cost so far, headroom.
9. [ ] `deploy plan --env staging --backend static` shows the override taking effect (`source: request-override`) without writing any state.
10. [ ] `deploy plan --json` emits a single JSON object on stdout; no human prose; valid via `jq -e .`.
11. [ ] `deploy plan` does NOT emit telemetry, does NOT touch the cost ledger, does NOT raise escalations.
12. [ ] Cost-cap: with `cost_cap_usd: 10` and an estimated $12 deploy, orchestrator throws `CostCapExceededError`; `deploy.completion` event emitted with `outcome: "cost-cap-exceeded"` and `reason: "single deploy estimate exceeds cap"`.
13. [ ] Cost-cap: with cap $10, ledger total $4, estimate $5 → allowed (4+5=9 ≤ 10).
14. [ ] Cost-cap: with cap $10, ledger total $4, estimate $7 → rejected with reason mentioning daily cap (4+7=11 > 10).
15. [ ] Cost-cap: with `cap=0`, all deploys allowed; ledger still updated for observability.
16. [ ] Cost-cap ledger: simulated UTC day boundary creates a fresh ledger; old file moved to `.archive/cost-ledger-<env>-<date>.json`.
17. [ ] Telemetry: every `runDeploy` call emits exactly one `deploy.init` event; every terminal outcome emits exactly one `deploy.completion` event (no duplicates, no missing).
18. [ ] Telemetry: paused deploys (awaiting approval) emit `deploy.init` but NOT `deploy.completion` until they resolve (success / failure / rejected).
19. [ ] Telemetry event payloads match the documented `DeployInitEvent` / `DeployCompletionEvent` shapes; verified by snapshot test.
20. [ ] CLI `--help` for each subcommand documents all flags and exit codes.

## Dependencies
- **Blocks**: SPEC-023-2-05 (integration test asserts on telemetry events + cost-cap behavior + CLI commands).
- **Consumes**:
  - SPEC-023-2-01: `loadConfig`, `resolveEnvironment`.
  - SPEC-023-2-02: `selectBackend`, `BackendSelection`, `SelectionSource`.
  - SPEC-023-2-03: `requestApproval`, `recordApproval`, `recordRejection`, `checkApprovalStatus`, `runDeploy` orchestrator skeleton.
  - PLAN-023-1: `BackendRegistry`, optional `backend.estimateDeployCost(params)` method.
  - PLAN-019-3: operator identity + role resolution.
  - PLAN-007-X: telemetry pipeline (single-line JSON sink).
- No new external libraries.

## Notes
- The cost-cap pre-check is intentionally **best-effort**: it uses the backend's estimate, which may be inaccurate. PLAN-023-3 layers in actuals enforcement against the global daily cap (independent budget). This boundary is documented in the CLI `--help` for `deploy plan` ("Estimated; actuals may differ; daily aggregate enforced separately").
- `--yes` is documented as DANGEROUS in the CLI help text; the prompt exists specifically to prevent typo-driven approval of the wrong deploy ID (PLAN-023-2 risk table).
- `safeEstimate(backend, params)` wraps `backend.estimateDeployCost?.(params)` in a try/catch and defaults to 0 on throw or absence — backends that don't implement estimation (e.g., `local`) are treated as zero-cost.
- The completion event for `paused` deploys is emitted by the *resuming* call (not the initial one). The initial call returns `status: "paused"` but only the eventual approval/rejection emits `deploy.completion`.
- `recordCost` is called AFTER `backend.deploy()` returns success — failed deploys do NOT consume cap budget (operator wouldn't expect to be charged for a failure). Document this behavior in the operator guide.
- Cost ledger archiving uses simple file moves (`mv` on POSIX); no compression or pruning in this spec. PLAN-023-3 may add retention policies.
- Future enhancement: `deploy plan --watch` to recompute on file changes; out of scope here.

# SPEC-023-3-03: Deploy Cost Ledger + Cap Enforcement + Operator CLIs

## Metadata
- **Parent Plan**: PLAN-023-3
- **Tasks Covered**: Task 6 (cost ledger), Task 7 (cost-cap enforcement), Task 8 (`deploy cost` CLI), Task 9 (`deploy monitor` + `deploy logs` CLIs)
- **Estimated effort**: 10.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-023-3-03-cost-ledger-cap-enforcement-cli.md`

## Description
Deliver the deploy-side cost subsystem per TDD-023 §14, mirroring PLAN-019-4's audit-writer and PLAN-017-4's budget-gate semantics. Every deploy appends one HMAC-chained entry to `~/.autonomous-dev/deploy-cost-ledger.jsonl`. A new `CostCapEnforcer` aggregates spend by day, blocking new deploys at three thresholds: 80% emits a sticky warning escalation, 100% rejects the deploy with `DailyCostCapExceededError`, and 110% requires a single-use admin override (consumed by the rejected deploy on retry). Three operator CLIs round out the surface: `deploy cost` for spend reporting, `deploy monitor` for live monitor-log tailing, and `deploy logs` for per-component log retrieval.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/deploy/cost-ledger.ts` | Create | HMAC-chained appender, replay-safe |
| `plugins/autonomous-dev/src/deploy/cost-ledger-types.ts` | Create | `CostLedgerEntry`, `DailyAggregate` |
| `plugins/autonomous-dev/src/deploy/cost-cap-enforcer.ts` | Create | Threshold logic + override consumption |
| `plugins/autonomous-dev/src/deploy/errors.ts` | Modify | Add `DailyCostCapExceededError`, `AdminOverrideRequiredError`, `CostLedgerCorruptError` |
| `plugins/autonomous-dev/src/cli/commands/deploy-cost.ts` | Create | `deploy cost [--day|--month] [--env] [--backend] [--json]` |
| `plugins/autonomous-dev/src/cli/commands/deploy-monitor.ts` | Create | `deploy monitor [--deploy <id>] [--json]` (tail -f semantics) |
| `plugins/autonomous-dev/src/cli/commands/deploy-logs.ts` | Create | `deploy logs <deployId> [--component build\|deploy\|health\|monitor] [--json]` |
| `plugins/autonomous-dev/src/cli/index.ts` | Modify | Register the three new subcommands |
| `~/.claude/autonomous-dev.json` (operator-managed) | Document | New `deploy.global_caps` block |

## Implementation Details

### Ledger Entry

```ts
export interface CostLedgerEntry {
  deployId: string;
  env: string;
  backend: string;
  estimated_cost_usd: number;
  actual_cost_usd?: number;
  timestamp: string;          // ISO 8601 ms
  prev_hmac: string;          // hex of prior entry's hmac (or 64-char zero string for the genesis entry)
  hmac: string;               // HMAC-SHA256(prev_hmac || canonical(entry without hmac), key)
}
```

Canonicalization for HMAC input: `JSON.stringify` with sorted keys over the entry minus the `hmac` field. Same algorithm as PLAN-019-4's audit-writer; reuse the canonicalization helper if exported, otherwise inline.

### Append Algorithm (`CostLedger.append`)

1. Acquire an exclusive `flock` on `~/.autonomous-dev/deploy-cost-ledger.lock` (PLAN-019-4 pattern).
2. Read the last line of `deploy-cost-ledger.jsonl` (tail seek). If file is missing or empty, `prev_hmac = "0".repeat(64)`.
3. Verify the tail entry's HMAC; on mismatch throw `CostLedgerCorruptError(lineNumber)`.
4. Compute the new entry's HMAC.
5. Write to a temp file `deploy-cost-ledger.jsonl.tmp.<pid>`, then `fs.rename` to `deploy-cost-ledger.jsonl` after appending. Use POSIX `O_APPEND` for the append step so concurrent appenders cannot tear lines.
6. Release the lock.

Key sourced from `process.env.DEPLOY_COST_HMAC_KEY`. If absent at startup, the daemon logs a warning and refuses to write entries (deploys are blocked with a clear error directing the operator to set the env var).

### Aggregation

```ts
export class CostLedger {
  appendEstimated(entry: Omit<CostLedgerEntry, 'hmac' | 'prev_hmac' | 'timestamp'>): Promise<CostLedgerEntry>;
  recordActual(deployId: string, actual_cost_usd: number): Promise<void>; // appends a follow-up entry
  aggregate(opts: {
    window: 'day' | 'month';
    asOf?: Date;
    env?: string;
    backend?: string;
  }): Promise<DailyAggregate>;
}

export interface DailyAggregate {
  totalEstimated: number;
  totalActual: number;
  byEnv: Record<string, number>;
  byBackend: Record<string, number>;
  entryCount: number;
}
```

`recordActual` is invoked by the post-deploy reconciliation hook (existing). Both estimated and actual totals are returned; cap enforcement uses `totalActual + totalEstimated_for_open_deploys` (i.e., already-completed actuals + estimates for in-flight that have not yet reconciled).

### `CostCapEnforcer`

```ts
export class CostCapEnforcer {
  constructor(private deps: {
    ledger: CostLedger;
    config: () => Promise<{ cost_cap_usd_per_day: number; admin_override_window_ms?: number }>;
    escalate: (msg: EscalationMessage) => Promise<void>;
    isAdmin: (actor: string) => Promise<boolean>;          // PLAN-019-3 admin role
    overrides: AdminOverrideStore;                          // see below
  }) {}

  async check(req: { actor: string; estimated_cost_usd: number; deployId: string; env: string; backend: string }): Promise<void>;
}
```

`check()` flow:

1. `agg = ledger.aggregate({ window: 'day' })`
2. `projected = agg.totalActual + agg.openEstimates + req.estimated_cost_usd`
3. `pct = projected / cap`
4. If `pct >= 1.10`:
   - If `overrides.consume(req.deployId)` returns true → allow.
   - Else throw `AdminOverrideRequiredError({ projected, cap, threshold: 1.10 })`.
5. Else if `pct >= 1.00` → throw `DailyCostCapExceededError({ projected, cap })`.
6. Else if `pct >= 0.80`:
   - Emit a sticky warning escalation (idempotent per UTC day; tracked in `~/.autonomous-dev/deploy-cap-warnings.json`).
   - Allow the deploy.
7. Else allow silently.

`AdminOverrideStore` persists a single-use token at `~/.autonomous-dev/deploy-cap-overrides.json`:

```json
{ "overrides": [{ "actor": "op@example", "deployId": "<id>", "expires_at": "2026-04-30T18:00:00Z" }] }
```

Tokens are minted by an admin (separate `deploy override` CLI is OUT OF SCOPE for this spec — covered in a follow-up; this spec only consumes them). For now, admins write the file directly. Document the schema in the spec but ship no minting helper.

### CLI: `deploy cost`

```
autonomous-dev deploy cost [--day|--month] [--env <env>] [--backend <name>] [--json]
```

- Default window: `--day`.
- Text mode: aligned table with `Estimated`, `Actual`, `Open` columns plus per-env and per-backend breakdowns. Footer shows `% of cap` and current cap value.
- JSON mode: emits `DailyAggregate` plus `cap_usd`, `pct_of_cap`, `window`.
- Exit code 0 on success; 2 on ledger corruption (with stderr message and pointer to recovery doc).

### CLI: `deploy monitor`

```
autonomous-dev deploy monitor [--deploy <deployId>] [--json]
```

- Without `--deploy`: tails `monitor/monitor.log` for every active deploy (interleaved by timestamp).
- With `--deploy`: tails only that deploy's monitor log.
- Streams new lines as they appear (tail-f using `fs.watchFile` polling at 250ms — no extra dependency).
- Text mode: pretty-prints `[ts] [LEVEL] message {fields}`.
- JSON mode: emits raw JSONL lines unchanged (line-buffered).
- Ctrl-C exits cleanly with code 0.

### CLI: `deploy logs`

```
autonomous-dev deploy logs <deployId> [--component build|deploy|health|monitor] [--json]
```

- Default component: `deploy`.
- Reads the entire current log file plus all rotations in chronological order (`<comp>.log.10` → `<comp>.log.1` → `<comp>.log`).
- Text mode: `[ts] [LEVEL] message {fields}` (same format as `deploy monitor`).
- JSON mode: emits raw JSONL.
- Exit code 0 on success; 1 if `<deployId>` directory does not exist; 2 if a log file is malformed (with line number).

### Operator Config (`~/.claude/autonomous-dev.json`)

```json
{
  "deploy": {
    "global_caps": {
      "cost_cap_usd_per_day": 100.0,
      "admin_override_window_ms": 21600000
    }
  }
}
```

Defaults if absent: `cost_cap_usd_per_day: 50.0`, `admin_override_window_ms: 21_600_000` (6h).

## Acceptance Criteria

- [ ] Each successful deploy appends exactly one entry to `~/.autonomous-dev/deploy-cost-ledger.jsonl` with all required fields.
- [ ] HMAC chain is intact across 1000 sequential entries (verifiable by walking the file and re-computing each `hmac`).
- [ ] Tampering with any entry's `estimated_cost_usd` causes the next `append()` to throw `CostLedgerCorruptError` with the offending line number.
- [ ] Genesis entry has `prev_hmac` of 64 zero hex chars.
- [ ] Concurrent appenders (two processes) serialize via `flock`; resulting file has no torn lines and a valid HMAC chain (verified with a stress test of 100 parallel appends across 10 processes).
- [ ] Ledger uses `tmp + rename` on the directory (not on the JSONL line). Append uses `O_APPEND`. Daemon kill mid-append leaves the file with at most one partial line; the next `append()` truncates the partial line, logs a warning, and re-walks.
- [ ] With `cost_cap_usd_per_day: 100`: a deploy costing $79 is allowed silently. A second deploy costing $1 (totaling $80) emits one warning escalation. A third costing $20 (totaling $100) is rejected with `DailyCostCapExceededError`. A fourth costing $10 (totaling $110) is rejected with `AdminOverrideRequiredError`.
- [ ] An admin override for a specific `deployId` is consumed exactly once: the same override does not allow a second deploy.
- [ ] The 80% sticky warning escalates at most once per UTC day per actor, even across daemon restarts (state in `deploy-cap-warnings.json`).
- [ ] `deploy cost --day` text mode shows estimated, actual, open, per-env, per-backend, total, and `% of cap`. Numbers reconcile with manual ledger inspection.
- [ ] `deploy cost --month` aggregates the entire current calendar month (UTC).
- [ ] `deploy cost --json` emits a JSON object containing `totalEstimated`, `totalActual`, `byEnv`, `byBackend`, `entryCount`, `cap_usd`, `pct_of_cap`, `window`.
- [ ] `deploy monitor` (no flag) prints new lines from every active deploy's `monitor.log` interleaved by timestamp; new lines appear within 1s of being written.
- [ ] `deploy monitor --deploy <id>` filters to one deploy.
- [ ] `deploy logs <deployId>` defaults to `--component deploy` and prints rotations in chronological order, ending with the current log.
- [ ] `deploy logs <missing-id>` exits with code 1 and a clear stderr message.
- [ ] All three CLIs accept `--json` and produce machine-parseable output (validated by `jq -c .` on every line).
- [ ] If `DEPLOY_COST_HMAC_KEY` is unset, deploys are blocked with `CostLedgerKeyMissingError` and a stderr message naming the env var to set.

## Dependencies

- **PLAN-023-1** (blocking): Deploy entrypoint that calls `CostCapEnforcer.check()` before invoking the backend, and `CostLedger.appendEstimated()` after backend success.
- **PLAN-023-2** (blocking): Per-env cost cap (works alongside this plan's daily cap; both must pass).
- **SPEC-023-3-02**: `DeployLogger` component layout consumed by `deploy logs` and `deploy monitor`.
- **PLAN-019-3** (existing): Admin role for 110% override.
- **PLAN-019-4** (existing): HMAC canonicalization helper and `flock` pattern.
- **PLAN-009-X** (existing): Escalation router for 80% warnings.

## Notes

- The 80%/100%/110% threshold layout is intentional symmetry with PLAN-017-4's budget-gate so operators see one mental model across token spend and dollar spend.
- This spec leaves the override-minting CLI out of scope — admins write the JSON file directly. A follow-up plan adds `deploy override` with its own audit trail. The consumption logic here is fully forward-compatible.
- Cost numbers in the ledger are USD floats stored to two decimal places. Aggregations sum with `Number` arithmetic (acceptable for the daily/monthly horizons we care about); if accuracy concerns arise, switch to integer cents in a future spec.
- `deploy monitor` uses `fs.watchFile` (polling) rather than `fs.watch` (event-based) to avoid platform-specific behavior on macOS/Linux/WSL. The 250ms poll is a reasonable trade-off between latency and CPU.
- Per-deploy `monitor.log` files come from the `HealthMonitor` (SPEC-023-3-01 + SPEC-023-3-02) writing through `DeployLogger`. This spec consumes them; it does not produce them.

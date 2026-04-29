# SPEC-015-3-01: Cost Aggregation Engine (Per-Day, Per-Month, Per-Request Rollups)

## Metadata
- **Parent Plan**: PLAN-015-3
- **Tasks Covered**: TASK-001 (CostAggregator + types + queries), TASK-008 (CostCapMonitor)
- **Estimated effort**: 6 hours

## Description
Implement the read-only cost aggregation engine that consumes `cost-ledger.jsonl` (NDJSON, append-only ledger from PLAN-010-2) and produces structured rollups for the portal cost dashboard. This spec covers data models, file ingestion, four aggregation functions (daily, monthly, per-repository, per-phase), top-N most-expensive request queries, a 7-day trailing average projection, and the cost-cap monitor that compares current spend against configured daily/monthly limits. SVG rendering is in SPEC-015-3-02; route handlers are downstream consumers and are out of scope here.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `portal/cost/types.ts` | Create | `CostLedgerEntry`, `DailySummary`, `MonthlySummary`, `RepoBreakdown`, `PhaseBreakdown`, `TopRequest`, `Projection`, `CapStatus` |
| `portal/cost/aggregator.ts` | Create | `CostAggregator` class with all rollup methods and projection algorithm |
| `portal/cost/queries.ts` | Create | Pure helpers: `aggregateByDay`, `aggregateByMonth`, `aggregateByRepo`, `aggregateByPhase`, `topNExpensive`, `sevenDayProjection` |
| `portal/cost/cap_monitor.ts` | Create | `CostCapMonitor` class: daily/monthly cap evaluation, severity (`ok`/`warn`/`exceeded`), month-end projection |
| `portal/cost/__tests__/aggregator.test.ts` | Create (covered in SPEC-015-3-04) | Smoke import only here; full suite in SPEC-015-3-04 |

## Implementation Details

### Type Definitions (`portal/cost/types.ts`)

```typescript
// Ledger format (NDJSON line) — produced by PLAN-010-2.
export interface CostLedgerEntry {
  timestamp: string;           // ISO-8601 UTC
  request_id: string;          // REQ-NNNNNN
  repository: string;          // absolute repo path
  phase: 'PRD' | 'TDD' | 'Plan' | 'Spec' | 'Code' | 'Review' | 'Deploy';
  cost_tokens: number;         // total tokens (input + output) for the call
  cost_usd: number;            // dollars (post-rate-card conversion)
  model: string;               // e.g. "claude-opus-4"
  operation: string;           // e.g. "session.spawn", "review.iterate"
}

export interface DailySummary {
  date: string;                // YYYY-MM-DD
  total_cost_usd: number;
  total_tokens: number;
  request_count: number;       // distinct request_ids on this day
}

export interface MonthlySummary {
  month: string;               // YYYY-MM
  total_cost_usd: number;
  total_tokens: number;
  request_count: number;
}

export interface RepoBreakdown {
  repository: string;
  total_cost_usd: number;
  request_count: number;
  pct_of_total: number;        // 0..100, two decimals
}

export interface PhaseBreakdown {
  phase: CostLedgerEntry['phase'];
  total_cost_usd: number;
  pct_of_total: number;
}

export interface TopRequest {
  request_id: string;
  repository: string;
  total_cost_usd: number;
  drill_down_url: string;      // `/requests/${request_id}`
}

export interface Projection {
  trailing_avg_usd_per_day: number;
  projected_seven_day_usd: number;
  basis_days: number;          // <=7; how many days of data fed the average
}

export interface CapStatus {
  scope: 'daily' | 'monthly';
  current_usd: number;
  limit_usd: number;
  pct_of_limit: number;        // 0..N (can exceed 100)
  severity: 'ok' | 'warn' | 'exceeded';
  projected_total_usd?: number; // monthly only: month-end projection
}
```

### `CostAggregator` Class (`portal/cost/aggregator.ts`)

```typescript
export class CostAggregator {
  constructor(
    private ledgerPath: string,
    private clock: () => Date = () => new Date(),
    private logger?: { debug: (m: string) => void; warn: (m: string) => void },
  ) {}

  async loadLedger(): Promise<CostLedgerEntry[]>;
  async loadLedgerStream(): AsyncIterable<CostLedgerEntry>;  // for files >10MB

  daily(entries: CostLedgerEntry[], startDate: string, endDate: string): DailySummary[];
  monthly(entries: CostLedgerEntry[], startMonth: string, endMonth: string): MonthlySummary[];
  byRepository(entries: CostLedgerEntry[]): RepoBreakdown[];
  byPhase(entries: CostLedgerEntry[]): PhaseBreakdown[];
  topExpensive(entries: CostLedgerEntry[], limit: number): TopRequest[];
  projectSevenDay(entries: CostLedgerEntry[]): Projection;
}
```

### Algorithm

**`loadLedger()`** (eager, files <=10MB):
1. `stat = await fs.stat(this.ledgerPath)`. If `stat.size > 10 * 1024 * 1024`, log warn and recommend `loadLedgerStream`. Continue eager load anyway (caller is in control).
2. Read file, split on `\n`, drop blank lines.
3. For each line, attempt `JSON.parse`. On parse failure, increment a `skip_count`, log debug with line number, continue.
4. Validate each parsed entry against `CostLedgerEntry` shape (all required keys present, `cost_usd >= 0`, `phase` in enum). Drop and log warn on failure.
5. Return the validated entries. Caller is responsible for time-window filtering.

**`loadLedgerStream()`**:
- Use `readline.createInterface({ input: fs.createReadStream(path) })`. Yield validated entries one at a time. Same skip/warn semantics.

**`daily(entries, startDate, endDate)`**:
1. Build a map keyed by `YYYY-MM-DD` (UTC slice of `entry.timestamp`).
2. For each entry whose date is within `[startDate, endDate]` inclusive, accumulate `total_cost_usd`, `total_tokens`, and add `request_id` to a `Set`.
3. Walk the date range day-by-day; for each missing day, emit a zero-filled `DailySummary` so the chart has continuous data.
4. Return summaries sorted ascending by date. `request_count = set.size` per day.

**`monthly(entries, startMonth, endMonth)`**: identical to `daily` but keyed by `YYYY-MM`. Iterate calendar months between bounds inclusive.

**`byRepository(entries)`**:
1. Group by `entry.repository`. Sum `cost_usd`, count distinct `request_id`s.
2. Compute grand total, then `pct_of_total = (group_sum / grand_total) * 100` rounded to 2 decimals (handle zero total → all zeros, no NaN).
3. Sort descending by `total_cost_usd`. Return all groups (no truncation; caller paginates).

**`byPhase(entries)`**: group by `entry.phase`, sum `cost_usd`, compute `pct_of_total`. Return all 7 phases (zero-fill missing). Order matches the canonical phase progression (PRD → TDD → Plan → Spec → Code → Review → Deploy).

**`topExpensive(entries, limit)`**:
1. Group by `request_id`. Sum `cost_usd`. Track first-seen `repository`.
2. Sort descending by sum. Take top `limit` (default caller-supplied; aggregator does not impose a default).
3. Map to `TopRequest` with `drill_down_url = '/requests/' + request_id`.
4. If `limit <= 0`, return `[]`.

**`projectSevenDay(entries)`**:
1. Determine `now = this.clock()` and the rolling window: last 7 calendar days ending on `now` (UTC, inclusive of today partial).
2. Filter entries within the window. Group by date.
3. `basis_days = min(7, distinct_dates_with_data)`. If `basis_days === 0`, return `{ trailing_avg_usd_per_day: 0, projected_seven_day_usd: 0, basis_days: 0 }`.
4. `trailing_avg_usd_per_day = sum(cost_usd in window) / basis_days`.
5. `projected_seven_day_usd = trailing_avg_usd_per_day * 7` rounded to 2 decimals.

### `CostCapMonitor` Class (`portal/cost/cap_monitor.ts`)

```typescript
export interface CapConfig { daily_usd?: number; monthly_usd?: number }

export class CostCapMonitor {
  constructor(
    private aggregator: CostAggregator,
    private getConfig: () => Promise<CapConfig>,   // reads from portal settings
    private clock: () => Date = () => new Date(),
  ) {}

  async dailyStatus(entries: CostLedgerEntry[]): Promise<CapStatus | null>;
  async monthlyStatus(entries: CostLedgerEntry[]): Promise<CapStatus | null>;
}
```

**`dailyStatus`**:
1. `cfg = await this.getConfig()`. If `cfg.daily_usd` is undefined or `<= 0`, return `null` (cap not configured).
2. Compute today's date string (UTC). Sum `cost_usd` of entries with that date.
3. `pct = (current / limit) * 100`.
4. `severity = pct >= 100 ? 'exceeded' : pct >= 80 ? 'warn' : 'ok'`.

**`monthlyStatus`**:
1. `cfg = await this.getConfig()`. If `cfg.monthly_usd` is undefined or `<= 0`, return `null`.
2. Compute current month string (UTC). Sum `cost_usd` for that month.
3. `pct = (current / limit) * 100`.
4. Compute `projected_total_usd = current * (days_in_month / day_of_month)`, rounded to 2 decimals. If `day_of_month === 0` (impossible in practice), set projected = current.
5. Severity thresholds same as daily.

### Error Handling
- All file reads are wrapped: missing ledger → return `[]` and log warn (the dashboard renders an empty state, not an error).
- Any individual line parse failure is absorbed; aggregate functions never throw on bad data.
- `CostCapMonitor` returns `null` when the cap is unconfigured — UI suppresses the card.
- Negative `cost_usd` values are dropped during validation (treat as corruption).

## Acceptance Criteria

- [ ] `loadLedger()` parses a 1000-line valid NDJSON ledger and returns 1000 entries with no skips logged.
- [ ] `loadLedger()` skips malformed lines and continues; final result excludes them; warn count surfaces in logger output.
- [ ] `daily(entries, '2026-04-01', '2026-04-07')` returns exactly 7 `DailySummary` objects in date order, including zero-filled days that have no entries.
- [ ] `monthly(entries, '2026-01', '2026-12')` returns exactly 12 `MonthlySummary` objects, zero-filled where appropriate.
- [ ] `byRepository(entries)` percentages sum to 100.00 (±0.01) when there is data, and to 0 when there is none.
- [ ] `byPhase(entries)` always returns exactly 7 entries in canonical phase order, even when some phases have no data.
- [ ] `topExpensive(entries, 10)` returns at most 10 results, sorted by `total_cost_usd` descending; ties broken by `request_id` ascending; `drill_down_url` populated.
- [ ] `topExpensive(entries, 0)` returns `[]`.
- [ ] `projectSevenDay` with no data returns `{ trailing_avg_usd_per_day: 0, projected_seven_day_usd: 0, basis_days: 0 }`.
- [ ] `projectSevenDay` with 3 days of data uses `basis_days=3` (not 7) — averaging over actual observed days, not calendar days.
- [ ] `CostCapMonitor.dailyStatus` returns `null` when `daily_usd` is unset.
- [ ] `CostCapMonitor.dailyStatus` severity transitions: 79% → `ok`, 80% → `warn`, 100% → `exceeded`, 150% → `exceeded`.
- [ ] `CostCapMonitor.monthlyStatus.projected_total_usd` for day 10 of a 30-day month with $100 spent equals $300.00.
- [ ] Missing ledger file: `loadLedger()` returns `[]` without throwing.
- [ ] Performance: `loadLedger()` of 100K entries (≈12MB) completes in <2s on the CI runner; `daily/monthly/byRepository/byPhase` each complete in <100ms over 100K entries.

## Dependencies

- Node `fs/promises`, `readline`, `path` builtins. No third-party dependencies.
- `cost-ledger.jsonl` location: read from a constructor argument; default path is the daemon's configured ledger (PLAN-010-2 owns the format and write path). This spec is read-only.
- Portal settings reader (for `CostCapMonitor.getConfig`): provided by PLAN-015-2; this spec only consumes the function.

## Notes

- Date arithmetic is UTC end-to-end. Localizing timestamps is a presentation concern handled by templates.
- `request_count` in daily/monthly summaries is the count of *distinct* `request_id`s, not the count of ledger entries (a single request emits many entries across phases).
- The 7-day projection deliberately uses simple averaging per PR-8 review feedback; do not introduce trend-fitting or ML smoothing.
- Stream-based loading is offered for very large ledgers (>10MB) but the eager path is the default — most callers operate on a 30-day window which is well under the limit.
- All percentages are computed once and stored; templates must NOT recompute. This keeps the chart input deterministic.

# SPEC-036-1-05: Standards Drift Summary — v1.1 Region (Portfolio Hits Card)

## Metadata
- **Parent Plan**: PLAN-036-1 (Dashboard Surface Re-skin)
- **Parent TDD**: TDD-036, §6.1 (Dashboard, Standards drift summary — v1.1 addition)
- **Parent PRD**: PRD-018, R-16 (v1.1)
- **Tasks Covered**: PLAN-036-1 Task 6 (`fragments/standards-drift.tsx`)
- **Estimated effort**: 0.25 day
- **Dependencies**: SPEC-035-2-02 (`Chip` primitive — `variant: 'status'`, tones), SPEC-036-1-01 (route handler computes `standardsDrift` + `totalBlockingHits`), SPEC-036-1-06 (`StandardsHit`, `StandardsDriftEntry`, `StandardRule` types and `EmptyState` fragment).
- **Priority**: P0 (v1.1 region; required for first-flip surface).
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Implement `fragments/standards-drift.tsx` — a card rendered between the approval queue strip and the active requests table, showing total blocking standards hits across the portfolio (header) and a per-repo mini-table (`Repo` / `Hits` / `Max severity`). The data is server-side aggregated by SPEC-036-1-01 from `data.standards` and `data.requests`; this fragment is purely presentational. Empty data delegates to the shared `EmptyState`.

## Acceptance Criteria

1. **Prop signature**:
   ```ts
   export interface StandardsDriftSummaryProps {
       drift: StandardsDriftEntry[];
       totalBlockingHits: number;
   }
   export const StandardsDriftSummary: FC<StandardsDriftSummaryProps>;
   ```
2. **Section container**: `<section id="standards-drift" class="sec standards-drift">` with the `id` exposed for the `dashboard:standards` SSE OOB channel.
3. **Section head**: `<h2>Standards drift</h2>` + `<span class="meta-mono dim">{totalBlockingHits} blocking hits MTD</span>`.
4. **Populated render** (`drift.length > 0`): `<table class="tbl tight">` with `<thead><tr><th>Repo</th><th>Hits</th><th>Max severity</th></tr></thead>` and one `<tr>` per entry. Hits cell uses `meta-mono`; max severity cell uses `<Chip variant="status" tone={severityTone(d.severityMax)}>{d.severityMax}</Chip>`.
5. **Severity tone mapping** (helper `severityTone`):
   - `blocking` → `err`
   - `warn` → `warn`
   - `advisory` → `info`
6. **Empty render** (`drift.length === 0`): `<EmptyState noun="blocking hits" />` from SPEC-036-1-06; the section header still renders (so the operator sees "0 blocking hits MTD" rather than the section disappearing). This differs from the Approval Queue Strip's null-when-empty contract.
7. **Sort assumption**: input `drift` is pre-sorted by `hitCount` descending (route handler responsibility per SPEC-036-1-01); fragment does not re-sort.
8. **`StandardsHit` and `StandardsDriftEntry` types** are introduced in SPEC-036-1-06; this spec only consumes them.

## Implementation

**File**: `plugins/autonomous-dev-portal/server/templates/fragments/standards-drift.tsx`

```tsx
import type { FC } from "hono/jsx";
import { Chip } from "../../components/primitives";
import { EmptyState } from "./empty-state";
import type { StandardsDriftEntry } from "../../types/render";

const severityTone = (s: StandardsDriftEntry["severityMax"]) =>
    s === "blocking" ? "err" : s === "warn" ? "warn" : "info";

export interface StandardsDriftSummaryProps {
    drift: StandardsDriftEntry[];
    totalBlockingHits: number;
}

export const StandardsDriftSummary: FC<StandardsDriftSummaryProps> = ({
    drift,
    totalBlockingHits,
}) => (
    <section id="standards-drift" class="sec standards-drift">
        <div class="sec-head">
            <h2>Standards drift</h2>
            <span class="meta-mono dim">{totalBlockingHits} blocking hits MTD</span>
        </div>
        {drift.length > 0 ? (
            <table class="tbl tight">
                <thead>
                    <tr>
                        <th>Repo</th>
                        <th>Hits</th>
                        <th>Max severity</th>
                    </tr>
                </thead>
                <tbody>
                    {drift.map((d) => (
                        <tr key={d.repo}>
                            <td>{d.repo}</td>
                            <td class="meta-mono">{d.hitCount}</td>
                            <td>
                                <Chip variant="status" tone={severityTone(d.severityMax)}>
                                    {d.severityMax}
                                </Chip>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        ) : (
            <EmptyState noun="blocking hits" />
        )}
    </section>
);
```

## Tests

| Test | Assertion |
|------|-----------|
| Populated render | `drift` of 3 entries → 3 `<tr>` in `<tbody>`; `<thead>` has 3 `<th>` |
| Severity tones | `blocking` → err chip; `warn` → warn chip; `advisory` → info chip |
| Empty render | `drift: []` → `EmptyState noun="blocking hits"` rendered; section header still present |
| Section id | `<section id="standards-drift">` for SSE OOB |
| `totalBlockingHits` shown | header span text contains the number passed in (e.g., "0 blocking hits MTD") |
| Hits cell mono | `<td class="meta-mono">` wraps each `hitCount` |
| Sort preserved | input order `[{hits:7},{hits:4},{hits:2}]` rendered in same order |

## Verification

- `bun test plugins/autonomous-dev-portal/tests/unit/standards-drift.test.tsx` passes (populated, empty, severity-tone cases).
- `bun test plugins/autonomous-dev-portal/tests/integration/dashboard.test.ts` finds `.standards-drift` and either `.tbl` or `EmptyState` text per data variant.
- Visual regression: the table layout matches the kit's `Dashboard.jsx` lines 95-130 in light + dark.
- Token compliance: `grep -E "#[0-9a-f]" server/templates/fragments/standards-drift.tsx` returns zero matches.

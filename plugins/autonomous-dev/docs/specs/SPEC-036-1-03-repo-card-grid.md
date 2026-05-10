# SPEC-036-1-03: Repo Card Grid — 6-region Card with Phase-Colored Left Bar

## Metadata
- **Parent Plan**: PLAN-036-1 (Dashboard Surface Re-skin)
- **Parent TDD**: TDD-036, §6.1 (Dashboard, RepoCard layout regions)
- **Parent PRD**: PRD-018, R-08, R-12, R-15a, R-16
- **Tasks Covered**: PLAN-036-1 Task 4 (update `fragments/repo-card.tsx` to kit-faithful 6-region layout)
- **Estimated effort**: 0.5 day
- **Dependencies**: SPEC-035-2-05 (`Card` primitive — `leftBar?: PhaseName`, `padding?`), SPEC-035-2-02 (`Chip` — `variant: 'phase'|'status'`), SPEC-036-1-06 (`RepoSummary` extensions: `trust`, `phase`, `variant`, `backend`, `stack`, `gateCount`, `variantLabel`).
- **Priority**: P0 (one of the two visually anchoring regions of the Dashboard; the 4px phase-colored left bar is "the system's one decorative motif" per PRD-018 R-12).
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Rewrite `plugins/autonomous-dev-portal/server/templates/fragments/repo-card.tsx` to render the kit-faithful 6-region repo card per TDD-036 §6.1, consuming the `Card` primitive (with `leftBar` set to the active phase, or `--warn` color when `attn === true`) and `Chip` primitives. Render the grid as `<div id="repo-grid" class="repo-grid">` containing one `<RepoCard>` per repo.

## Acceptance Criteria

1. **6 regions per card** in this DOM order:
   1. **Top row**: repo name (14px bold) + trust-level badge (`L0..L3`, mono, 11px, bordered).
   2. **Path row**: `~/projects/{repo}` in mono 11px `--fg-3`.
   3. **Meta row 1**: phase chip (uppercase, phase-colored) + variant chip rendered from pre-resolved `variantLabel` (sentence case).
   4. **Meta row 2**: backend chip (info tint) + stack chip (neutral).
   5. **Footer** (separated by hairline `--line-1`): `{N} active` + `${X.XX} MTD` + either `{N} need approval` (warn tone) when `gateCount > 0`, else `last {N}m ago` (muted mono).
   6. **Left bar**: 4px solid `var(--phase-{phase})`. When `attn === true`, left bar uses `--warn` and the outer card carries the `--warn-line` token via the `Card` primitive's existing shadow allowance (no new untokened `box-shadow` — PRD-018 R-15a).
2. **`Card` primitive consumption**: rendered via `<Card leftBar={phaseOrUndefined} padding="md">`. When `attn === true`, the wrapper uses `<Card>` without `leftBar` and applies the warn class on an inner element so the phase-tokened left bar is replaced by `--warn` per the kit; the exact mechanism is left to the implementation as long as no untokened CSS values appear.
3. **`Chip` primitive consumption** (per R-08 prop surface): phase chip uses `<Chip variant="phase" tone={phase}>`; variant/backend/stack chips use `<Chip variant="status" tone="info"|"muted">`.
4. **Grid container**: `<div id="repo-grid" class="repo-grid">` — `id` exposed for `dashboard:repos` SSE OOB swap.
5. **Empty `repos` array**: `RepoCardGrid` is not rendered itself; the parent view substitutes `<EmptyState noun="repositories allowlisted" />` per SPEC-036-1-06.
6. **Trust badge formatting**: shows `r.trust` verbatim (`L0`/`L1`/`L2`/`L3`), mono, in a bordered span. When `trust` is undefined, the badge is omitted (no fallback string).
7. **Cost rendering**: MTD cost always 2 decimals (PRD-018 R-22): `${r.monthlyCostUsd.toFixed(2)}`.

## Implementation

**File**: `plugins/autonomous-dev-portal/server/templates/fragments/repo-card.tsx`

```tsx
import type { FC } from "hono/jsx";
import { Card } from "../../components/primitives";
import { Chip } from "../../components/primitives";
import type { RepoSummary } from "../../types/render";

export const RepoCard: FC<RepoSummary> = (r) => {
    const phaseForBar = r.attn ? undefined : (r.phase as PhaseName | undefined);
    return (
        <Card leftBar={phaseForBar} padding="md">
            <div class={`repo-card${r.attn ? " attn" : ""}`}>
                {/* 1. Top row */}
                <div class="rc-top">
                    <span class="rc-name">{r.repo}</span>
                    {r.trust && <span class="rc-trust meta-mono">{r.trust}</span>}
                </div>
                {/* 2. Path row */}
                <div class="rc-path meta-mono dim">~/projects/{r.repo}</div>
                {/* 3. Meta row 1 */}
                <div class="rc-meta">
                    {r.phase && <Chip variant="phase" tone={r.phase}>{r.phase.toUpperCase()}</Chip>}
                    {r.variantLabel && <Chip variant="status" tone="muted">{r.variantLabel}</Chip>}
                </div>
                {/* 4. Meta row 2 */}
                <div class="rc-meta">
                    {r.backend && <Chip variant="status" tone="info">{r.backend}</Chip>}
                    {r.stack && <Chip variant="status" tone="muted">{r.stack}</Chip>}
                </div>
                {/* 5. Footer */}
                <div class="rc-footer">
                    <span>{r.activeRequests} active</span>
                    <span class="meta-mono">${r.monthlyCostUsd.toFixed(2)} MTD</span>
                    {(r.gateCount ?? 0) > 0
                        ? <Chip variant="status" tone="warn">{r.gateCount} need approval</Chip>
                        : <span class="meta-mono dim">last {r.lastActivity}</span>}
                </div>
            </div>
        </Card>
    );
};

export const RepoCardGrid: FC<{ repos: RepoSummary[] }> = ({ repos }) => (
    <div id="repo-grid" class="repo-grid">
        {repos.map((r) => <RepoCard {...r} />)}
    </div>
);
```

CSS for `.repo-card`, `.rc-top`, `.rc-path`, `.rc-meta`, `.rc-footer`, `.rc-trust`, and the `.repo-card.attn` warn-line treatment lives in `server/static/dashboard.css`, referencing only design tokens.

## Tests

| Test | Assertion |
|------|-----------|
| 6 regions present | each `.repo-card` contains `.rc-top`, `.rc-path`, two `.rc-meta` rows, `.rc-footer` |
| Phase chip uppercase | phase chip text matches `/^[A-Z]+$/` |
| Phase left bar | rendered HTML contains `border-left: 4px solid var(--phase-{phase})` (delegated to `Card` primitive) |
| `attn === true` | repo card has `.attn` class; no `--phase-` left bar present |
| `gateCount > 0` | warn chip "need approval" rendered |
| `gateCount === 0` | last-activity span rendered with mono+dim classes |
| Cost format | MTD value matches `/^\$\d+\.\d{2} MTD$/` |
| Trust missing | no `.rc-trust` element when `trust` undefined |
| Empty repos delegation | `RepoCardGrid` with `[]` renders nothing (parent view supplies `EmptyState`) |
| Token compliance | grep returns zero hex literals in `repo-card.tsx` and its dedicated CSS section |

## Verification

- `bun test plugins/autonomous-dev-portal/tests/unit/repo-card.test.tsx` passes.
- `bun test plugins/autonomous-dev-portal/tests/integration/dashboard.test.ts` asserts left-bar color matches `--phase-{phase}` for the active phase and `--warn` when `attn === true`.
- `grep -rn "box-shadow" server/templates/fragments/repo-card.tsx` returns zero matches (R-15a — any shadow comes from the `Card` primitive or warn-line CSS via tokens).
- Visual regression snapshot pixel-faithfully matches `autonomous-dev-design-system/project/ui_kits/portal/Dashboard.jsx` repo-card region in light + dark themes.

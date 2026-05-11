# SPEC-037-4-01: Approvals page-head + KPI strip

## Metadata
- **Parent Plan**: PLAN-037-4 (Approvals surface rebuild)
- **Parent TDD**: TDD-037 (Portal kit parity)
- **Tasks Covered**: PLAN-037-4 Scope items (1) page-head, (2) KPI strip
- **Estimated effort**: 0.5 day
- **Dependencies**: PLAN-037-2 (`POST /api/approvals/bulk-approve` endpoint); SPEC-035-2-03 (`Btn` primitive); SPEC-036-1-01 (`KpiStrip` fragment)
- **Priority**: P1
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Replace the current `<h1>Approval queue</h1>` heading in `templates/views/approvals.tsx` with the kit's two-region header: a `.page-head` containing the page title and `.head-actions` (Settings link + Bulk approve button), and a 3-card `.kpi-strip` showing per-gate-type counts. This brings the surface in line with `/tmp/portal-design-v2/.../Approvals.jsx` lines 12-37.

## Acceptance Criteria

1. The view renders a top-level `<div class="page-head">` with `<h1>Approvals</h1>` and a `<div class="head-actions">` block.
2. `head-actions` contains, in order: an `<a href="/settings#approvals">Settings</a>` rendered via `Btn` (no `kind`, secondary look) and a primary `<button>` with `hx-post="/api/approvals/bulk-approve"` and text `Bulk approve…`. Wiring details live in SPEC-037-4-05; this spec only requires the markup shape.
3. The view renders `<div class="kpi-strip">` immediately below the page-head with exactly three `.kpi` cards in this order: `Reviewer chain`, `Standards violation`, `Cost cap`.
4. Each KPI card markup: `<div class="kpi"><div class="kpi-label">{label}</div><div class="kpi-num">{count}</div><div class="kpi-sub">{sub}</div></div>` (matches kit `.kpi-strip` rule at `app.css:351`).
5. KPI counts come from `props.items` partitioned by `gateType` (`reviewer-chain` | `standards-violation` | `cost-cap`). The data shape is provided by SPEC-037-4-04.
6. KPI sub-lines:
   - Reviewer chain → `"across {N} repos"` where N is `new Set(items.filter(...).map(i => i.repo)).size`.
   - Standards violation → `"of which {N} are blocking"` where N is `items.filter(i => i.gateType==='standards-violation' && i.detail?.blocking).length` (fallback to total count if `blocking` not present).
   - Cost cap → `"current cap ${X}/day"` where X comes from `props.costCapDailyUsd` (route handler supplies; defaults to `0`).
7. No raw hex colors in template (PRD-018 M-01). Styling is owned by `app.css` / `primitives.css`.

## Implementation

**File**: `plugins/autonomous-dev-portal/server/templates/views/approvals.tsx`

Replace the current `<section class="approvals"><h1>…` block with:

```tsx
<>
  <div class="page-head">
    <h1>Approvals</h1>
    <div class="head-actions">
      <Btn href="/settings#approvals">Settings</Btn>
      <Btn kind="primary" hxPost="/api/approvals/bulk-approve">
        Bulk approve…
      </Btn>
    </div>
  </div>

  <div class="kpi-strip">
    <div class="kpi">
      <div class="kpi-label">Reviewer chain</div>
      <div class="kpi-num">{reviewer.length}</div>
      <div class="kpi-sub">across {reviewerRepos} repos</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Standards violation</div>
      <div class="kpi-num">{standards.length}</div>
      <div class="kpi-sub">of which {blocking} are blocking</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Cost cap</div>
      <div class="kpi-num">{cost.length}</div>
      <div class="kpi-sub">current cap ${costCapDailyUsd}/day</div>
    </div>
  </div>
  {/* SPEC-037-4-02 segmented filter mounts here */}
  {/* SPEC-037-4-03 gate-list mounts here */}
</>
```

`Btn` must support `hxPost` (or `hx-post` pass-through) per SPEC-035-2-03. If absent, add an `hxPost?: string` prop pass-through.

## Tests

| Test | Assertion |
|------|-----------|
| Renders page-head | `.page-head h1` text equals `Approvals` |
| Settings link | `.head-actions a[href="/settings#approvals"]` present |
| Bulk approve button | `.head-actions button[hx-post="/api/approvals/bulk-approve"]` present, class includes `primary` |
| KPI count = 3 | Exactly 3 `.kpi` elements under `.kpi-strip` |
| KPI labels | Labels match `Reviewer chain`, `Standards violation`, `Cost cap` in order |
| Reviewer count | With 2 reviewer-chain items in stub, `.kpi-num` in card 1 reads `2` |
| Sub-line cost cap | `${costCapDailyUsd}/day` substitution renders correctly |

## Verification

- `bun test plugins/autonomous-dev-portal/tests/unit/approvals-view.test.tsx` passes.
- `curl -s http://127.0.0.1:19280/approvals | grep -c 'class="kpi"'` returns `3`.
- Visual: compare against kit `Approvals.jsx` lines 12-37 in light + dark themes.
- `grep -nE '#[0-9a-fA-F]{3,6}' plugins/autonomous-dev-portal/server/templates/views/approvals.tsx` returns no matches.

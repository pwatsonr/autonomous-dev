# SPEC-037-4-03: Approvals `.gate-list` + `.gate-row` (replaces `.approval-item`)

## Metadata
- **Parent Plan**: PLAN-037-4 (Approvals surface rebuild)
- **Parent TDD**: TDD-037 (Portal kit parity)
- **Tasks Covered**: PLAN-037-4 Scope item (4) gate-list + gate-row, item (5) empty state
- **Estimated effort**: 1 day
- **Dependencies**: SPEC-037-4-04 (data-shape extension); SPEC-035-2-02 (`Chip`); SPEC-035-2-03 (`Btn`); PLAN-037-2 (Approve/Reject endpoints)
- **Priority**: P1
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Replace the v0 `<article class="approval-item risk-{high,med}">` row markup with the kit's three-column `.gate-row` layout (`180px / 1fr / auto`) inside a `.gate-list` container. Each row reflects gate type via the `gate-{type}` class (which paints the left border per kit `app.css:432-439`). The legacy `.approval-item` / `risk-high|med` schema is removed; this is a v0→v1 schema break (per PLAN-037-4 risk row 1).

## Acceptance Criteria

1. Replace `fragments/approval-item.tsx` with a new `fragments/gate-row.tsx` exporting `GateRow: FC<ApprovalItem>` (data shape per SPEC-037-4-04). Old file is deleted.
2. **Row markup** (matches kit `Approvals.jsx:52-78` verbatim):
   ```tsx
   <div class={`gate-row gate-${g.gateType}`} data-gate-type={g.gateType} data-approval-id={g.id}>
     <div class="gate-left">
       <div class="gate-type-tag">{gateTypeLabel(g.gateType)}</div>
       <div class="gate-wait meta-mono">waited {g.waitedMin}m</div>
     </div>
     <div class="gate-mid">
       <div class="r-title">{g.summary}</div>
       <div class="gate-detail">{g.detail}</div>
       <div class="gate-meta">
         <span class="r-id meta-mono">{g.id}</span>
         <span class="dot-sep">·</span>
         <span>{g.repo}</span>
         <span class="dot-sep">·</span>
         <Chip variant="phase" tone={g.phase}>{g.phase.toUpperCase()}</Chip>
         <span class="dot-sep">·</span>
         <span class="chip variant sm">{variantLabel(g.variant)}</span>
       </div>
     </div>
     <div class="gate-right">
       <div class="gate-cost meta-mono">${g.cost.toFixed(2)}</div>
       <div class="gate-actions">
         <Btn size="sm" href={`/repo/${g.repo}/request/${g.id}`}>Open</Btn>
         <Btn size="sm" kind="primary"
              hxPost={`/api/approvals/${g.id}/approve`}>Approve</Btn>
         <Btn size="sm" kind="danger"
              hxPost={`/api/approvals/${g.id}/reject`}>Reject</Btn>
       </div>
     </div>
   </div>
   ```
3. **Helpers** (in the same module): `gateTypeLabel(t)` → `reviewer-chain`→`Reviewer chain`, `standards-violation`→`Standards`, `cost-cap`→`Cost cap`, else `t`. `variantLabel(v)` → returns the human-readable variant label (re-use `lib/variant-labels.ts` if present; otherwise fall back to `v`).
4. **Container**: view renders `<section class="sec"><div class="sec-head">…segmented filter…</div><div class="gate-list">{items.map(GateRow)}</div></section>`. The `sec-head` `<h2>Open gates · {items.length}</h2>` matches kit.
5. **Empty state**: when `items.length === 0`, render `<div class="empty">No open gates</div>` in place of the `.gate-list`. Filter-driven empty state is handled by SPEC-037-4-02.
6. **`data-gate-type` attribute** is required on every row so SPEC-037-4-02's JS can filter without re-parsing classes.
7. **Schema break**: all references to `ApprovalItemRow`, `.approval-item`, and `risk-{high|med|low}` in `server/templates/**` and tests are removed in the same PR (grep clean).

## Implementation

**Files**:
- `plugins/autonomous-dev-portal/server/templates/fragments/gate-row.tsx` (new — replaces `approval-item.tsx`)
- `plugins/autonomous-dev-portal/server/templates/views/approvals.tsx` — imports `GateRow`, renders the `<section class="sec">` block
- Delete: `plugins/autonomous-dev-portal/server/templates/fragments/approval-item.tsx`
- Update any importers (grep for `approval-item` / `ApprovalItemRow`).

Confirm kit CSS already covers `.gate-row`, `.gate-left/.mid/.right`, `.gate-cost`, `.gate-actions`, `.gate-type-tag`, `.gate-wait`, `.gate-detail`, `.gate-meta`, `.dot-sep` (see `/tmp/portal-design-v2/.../app.css:431-456`). If `primitives.css` is missing any rule after this rebuild, add it in the same PR.

## Tests

| Test | Assertion |
|------|-----------|
| Renders N rows | `.gate-list .gate-row` count equals `items.length` |
| gate-{type} class | Each row carries `gate-{gateType}` modifier class |
| data-gate-type attr | Each row has `data-gate-type` matching `gateType` |
| 180/1fr/auto layout | Row has `.gate-left`, `.gate-mid`, `.gate-right` children in order |
| Cost formatting | `.gate-cost` text matches `/^\$\d+\.\d{2}$/` |
| Action buttons | Each row has 3 buttons: Open (href), Approve (hx-post …/approve), Reject (hx-post …/reject) |
| Phase chip uppercase | `.chip.phase` text matches `/^[A-Z]+$/` |
| Empty state | `items: []` → `<div class="empty">No open gates</div>` rendered; no `.gate-list` |
| Schema cleanup | `grep -rn 'approval-item\|risk-high\|risk-med' server/templates` returns zero |

## Verification

- `bun test plugins/autonomous-dev-portal/tests/unit/gate-row.test.tsx` passes.
- `curl -s http://127.0.0.1:19280/approvals | grep -c 'gate-row'` ≥ 3 (PLAN-037-4 verification line).
- Visual diff against kit `Approvals.jsx` rendered output (light + dark themes).
- `grep -nE '#[0-9a-fA-F]{3,6}' plugins/autonomous-dev-portal/server/templates/fragments/gate-row.tsx` returns no matches.

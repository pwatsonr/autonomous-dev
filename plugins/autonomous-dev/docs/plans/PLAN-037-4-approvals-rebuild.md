# PLAN-037-4: Approvals surface rebuild

## Metadata
- **Parent**: PLAN-037-portal-kit-parity
- **Effort**: 3 days
- **Dependencies**: [PLAN-037-2] (approval action endpoints)
- **Priority**: P1 (highest-severity visual regression after rail/theme)

## Objective

`/approvals` currently renders a flat `<article class="approval-item risk-high">` list with no KPI strip, no segmented filter, no gate-row layout, and inconsistent design-vocabulary chips (`risk-high` / `risk-med` instead of gate-type-based severity). Rebuild to match the kit's `Approvals.jsx` exactly.

## Scope

### In Scope

Replace `templates/views/approvals.tsx` end-to-end. New shape:

1. **Page-head** with title + `head-actions`: `<a href="/settings#approvals">Settings</a>` + `<button class="btn primary" hx-post="/api/approvals/bulk-approve">Bulk approve…</button>`.
2. **KPI strip** (3 cards):
   - Reviewer chain — count + "across N repos" sub
   - Standards violation — count + "of which N are blocking"
   - Cost cap — count + "current cap $X/day"
3. **Segmented filter** above the gate list: `<div class="seg"><button class="seg-btn on" data-filter="all">All</button><button class="seg-btn" data-filter="reviewer-chain">Reviewer</button><button class="seg-btn" data-filter="standards-violation">Standards</button><button class="seg-btn" data-filter="cost-cap">Cost</button></div>`. Filter is client-side JS (hide/show via CSS class).
4. **Gate list** — `<div class="gate-list">` of `<div class="gate-row gate-{type}">` per kit. Each row layout: 180px gate-type-tag, 1fr center column (phase chip + variant chip + repo-id mono + gate detail + meta line), auto right column with `.gate-cost` + `.gate-actions` (3 buttons: Open / Approve / Reject).
5. **Empty state** when filtered count is 0: `<div class="empty">No <type> gates</div>`.
6. **Data-shape extension** — `ApprovalItem` adds `gateType: 'reviewer-chain'|'standards-violation'|'cost-cap'`, `phase`, `variant`, `repo`, `waitedMin`, `cost`, `detail` fields. Update `server/stubs/approvals.ts` to produce 3-5 example rows across all gate types.
7. **`segmented-filter.js`** small vanilla JS module that toggles `.hidden` based on the `data-filter` button.
8. **Tests**: unit test for the new template renders all 3 KPIs + 3 filter buttons + correct gate-row count; integration test for the bulk-approve POST.

### Out of Scope
- Building actual reviewer-chain data — stub data is fine for v1; live data wiring is a follow-up.
- "Open" button deep-link to RequestDetail works but doesn't pre-load the gate panel — that's already on RequestDetail.

## Verification
- `curl -s http://127.0.0.1:19280/approvals | grep -c 'gate-row'` >= 3.
- Visual match to `/tmp/portal-design-v2/autonomous-dev-design-system/project/ui_kits/portal/Approvals.jsx` rendered output.
- Clicking filter buttons hides/shows rows.
- Approve / Reject actions succeed (with PLAN-037-2's endpoints merged).

## Tests
- Unit: template renders correct shape.
- Integration: filter click hides rows; approve POST returns 200 + new fragment.

## Risks
| Risk | Mitigation |
|---|---|
| Existing approvals callers depend on `risk-high` / `risk-med` schema | Grep + update all callers in the same PR; this is a v0→v1 schema break |

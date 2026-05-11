# SPEC-037-4-05: Bulk-approve integration (wire button → PLAN-037-2 endpoint)

## Metadata
- **Parent Plan**: PLAN-037-4 (Approvals surface rebuild)
- **Parent TDD**: TDD-037 (Portal kit parity)
- **Tasks Covered**: PLAN-037-4 Scope item (1) Bulk approve button wiring + integration test
- **Estimated effort**: 0.5 day
- **Dependencies**: PLAN-037-2 (`POST /api/approvals/bulk-approve` endpoint); SPEC-037-4-01 (button markup); SPEC-037-4-03 (per-row Approve/Reject HTMX targets)
- **Priority**: P1
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Wire the `Bulk approve…` button in the approvals page-head to PLAN-037-2's `POST /api/approvals/bulk-approve` endpoint via HTMX, including a confirmation dialog, scoping by the currently-active segmented filter (so `Bulk approve` while `Reviewer` is selected only approves reviewer-chain gates), and an OOB-swap response that re-renders the `.gate-list` + `.kpi-strip`.

## Acceptance Criteria

1. **Button markup** (refines SPEC-037-4-01 AC-2):
   ```tsx
   <Btn
     kind="primary"
     hxPost="/api/approvals/bulk-approve"
     hxInclude="[data-segmented-filter='approvals'] .seg-btn.on"
     hxVals='js:{filter: document.querySelector("[data-segmented-filter=\\"approvals\\"] .seg-btn.on")?.dataset.filter}'
     hxConfirm="Approve every gate matching the current filter?"
     hxTarget=".gate-list"
     hxSwap="outerHTML"
   >Bulk approve…</Btn>
   ```
   - Sends the active filter (`all|reviewer-chain|standards-violation|cost-cap`) as a form field `filter`.
   - Server-side handler must interpret `filter=all` as "every open gate".
2. **Server route**: `POST /api/approvals/bulk-approve` (already defined by PLAN-037-2) accepts `{ filter: string }`, calls the underlying approval action for each matching gate, and returns an HTML fragment containing the updated `<div class="gate-list">…</div>` plus an HTMX OOB swap for the `.kpi-strip` (`<div class="kpi-strip" hx-swap-oob="outerHTML"> … </div>`). The portal route registers a single handler that re-renders both via fragments imported from SPEC-037-4-01 / -03.
3. **Confirmation**: native `hx-confirm` dialog runs before the POST. (Optional follow-up: replace with the existing `confirm-modal.tsx` fragment — out of scope for v1.)
4. **Empty result**: when zero gates match the filter, server returns an empty `<div class="gate-list"></div>` + `<div class="empty">No open gates</div>`; the KPI strip OOB swap zeroes the corresponding counts.
5. **Idempotency**: the bulk endpoint must be safe to re-issue (PLAN-037-2 already requires per-gate `If-Match` / ETag handling; this spec only verifies the wiring).
6. **HTMX swap-oob safe**: `kpi-strip` and `gate-list` outer markup carry stable selectors used by the OOB response (no inline IDs needed — the OOB hooks target by class via `hx-swap-oob="outerHTML:.kpi-strip"`).

## Implementation

**Files**:
- `plugins/autonomous-dev-portal/server/templates/views/approvals.tsx` — update the `Bulk approve…` `Btn` per AC-1.
- `plugins/autonomous-dev-portal/server/routes/approvals.ts` — wire `POST /api/approvals/bulk-approve` handler (delegates to PLAN-037-2's underlying bulk-approve service). Handler signature:
  ```ts
  app.post("/api/approvals/bulk-approve", async (c) => {
    const form = await c.req.formData();
    const filter = String(form.get("filter") ?? "all");
    const remaining = await bulkApproveByFilter(filter);   // service from PLAN-037-2
    return c.html(
      <>
        <div class="gate-list">{remaining.map(GateRow)}</div>
        <div class="kpi-strip" hx-swap-oob="outerHTML:.kpi-strip">{kpiStripFor(remaining, costCapDailyUsd)}</div>
      </>
    );
  });
  ```
- `plugins/autonomous-dev-portal/server/templates/fragments/kpi-strip.tsx` — extract the KPI strip JSX from SPEC-037-4-01 so both the view and the bulk-approve response can re-use it (function `kpiStripFor(items, cap)`).

## Tests

| Test | Assertion |
|------|-----------|
| Button shape | `.head-actions button[hx-post="/api/approvals/bulk-approve"][hx-confirm]` present |
| Filter passed | Stub-server integration: POST with `filter=reviewer-chain` calls the underlying service with that filter |
| Returns fragment | Response `Content-Type: text/html` and body contains `<div class="gate-list">` |
| OOB swap | Response body contains `hx-swap-oob="outerHTML:.kpi-strip"` |
| Empty fallback | When no gates match, response includes `<div class="empty">No open gates</div>` |
| Filter=all | POST with `filter=all` approves every open gate (count decreases to 0 in subsequent GET `/approvals`) |
| Idempotent | Repeated POST returns 200 and an empty gate-list without error |

## Verification

- `bun test plugins/autonomous-dev-portal/tests/integration/approvals-bulk.test.ts` passes (covers all rows above).
- Manual: load `/approvals` with 4 stub gates; click `Reviewer`, then `Bulk approve…`, accept confirm — only reviewer-chain gates disappear; KPI strip's reviewer count drops to 0; standards/cost counts unchanged.
- `curl -s -X POST http://127.0.0.1:19280/api/approvals/bulk-approve -d 'filter=all' | grep -c 'gate-list'` returns ≥1.
- No regressions in PLAN-037-2's existing bulk-approve unit tests.

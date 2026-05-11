// SPEC-013-3-03 §Views — approvals queue view component.
// SPEC-037-4-01/02/03/05 — Approvals surface rebuild to kit shape.
//
// Page composition (matches /tmp/portal-design-v2/.../Approvals.jsx):
//   1. <div class="page-head"> — title + Settings + Bulk approve
//   2. <ApprovalsKpiStrip>     — 3 cards (reviewer / standards / cost)
//   3. <section class="sec">   — gate-list section with segmented filter
//        - .sec-head:  <h2>Open gates · N</h2> + .seg (4 .seg-btn)
//        - .gate-list: GateRow per item (or .empty when none)
//
// The segmented filter is purely client-side (segmented-filter.js);
// the bulk-approve button POSTs the active filter and HTMX-swaps the
// gate-list while OOB-swapping the kpi-strip (SPEC-037-4-05).
//
// CSS lives in app.css / primitives.css; this template carries zero
// raw colors (PRD-018 M-01).

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";
import { Btn } from "../../components/primitives";
import { ApprovalsKpiStrip } from "../fragments/approvals-kpi-strip";
import { GateRow } from "../fragments/gate-row";

export const ApprovalsView: FC<RenderProps["approvals"]> = ({
    items,
    costCapDailyUsd,
}) => (
    <>
        <div class="page-head">
            <h1>Approvals</h1>
            <div class="head-actions">
                {/* Btn renders a <button>; we use an <a> wearing the
                    same class shape so the Settings link navigates
                    without an HTMX hop. */}
                <a class="btn" href="/settings#approvals">
                    Settings
                </a>
                <Btn
                    kind="primary"
                    hx-post="/api/approvals/bulk-approve"
                    hx-include="[data-segmented-filter='approvals'] .seg-btn.on"
                    hx-vals={
                        'js:{filter: document.querySelector("[data-segmented-filter=\\"approvals\\"] .seg-btn.on")?.dataset.filter}'
                    }
                    hx-confirm="Approve every gate matching the current filter?"
                    hx-target=".gate-list"
                    hx-swap="outerHTML"
                >
                    Bulk approve…
                </Btn>
            </div>
        </div>

        <ApprovalsKpiStrip items={items} costCapDailyUsd={costCapDailyUsd} />

        <section class="sec">
            <div class="sec-head">
                <h2>Open gates · {items.length}</h2>
                <div class="seg" data-segmented-filter="approvals">
                    <button
                        type="button"
                        class="seg-btn on"
                        data-filter="all"
                        aria-pressed="true"
                    >
                        All
                    </button>
                    <button
                        type="button"
                        class="seg-btn"
                        data-filter="reviewer-chain"
                        aria-pressed="false"
                    >
                        Reviewer
                    </button>
                    <button
                        type="button"
                        class="seg-btn"
                        data-filter="standards-violation"
                        aria-pressed="false"
                    >
                        Standards
                    </button>
                    <button
                        type="button"
                        class="seg-btn"
                        data-filter="cost-cap"
                        aria-pressed="false"
                    >
                        Cost
                    </button>
                </div>
            </div>
            {items.length === 0 ? (
                <div class="empty">No open gates</div>
            ) : (
                <div class="gate-list">
                    {items.map((it) => (
                        <GateRow {...it} />
                    ))}
                </div>
            )}
        </section>
    </>
);

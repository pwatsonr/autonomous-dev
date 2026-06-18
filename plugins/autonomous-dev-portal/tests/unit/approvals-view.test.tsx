// FR-026-30 — Approvals v3 view unit tests.
//
// Validates the rebuilt Approvals surface: Topbar shape (title + pending
// subTitle + seg + Bulk approve), filter strip, 6-column approval-row grid
// with cdot reviewer checks, selected-row preview card, and gate-stats-7d
// card with StatRow bars.
//
// Preserves existing hx-post endpoint coverage so the HTMX approve/reject
// wiring stays tested through the redesign.

import { describe, expect, test } from "bun:test";

import { ApprovalsView } from "../../server/templates/views/approvals";
import type { ApprovalItem } from "../../server/types/render";

async function render(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

const baseItem = (
    overrides: Partial<ApprovalItem> = {},
): ApprovalItem => ({
    id: "REQ-1",
    summary: "Stub summary",
    repo: "stub-repo",
    gateType: "reviewer-chain",
    phase: "review",
    variant: "vanilla",
    waitedMin: 5,
    cost: 1.23,
    detail: "stub detail",
    actions: [
        { id: "approve", label: "Approve", confirm: null },
        { id: "reject", label: "Reject", confirm: null },
    ],
    ...overrides,
});

// ---- Topbar -----------------------------------------------------------------

describe("ApprovalsView — FR-026-30 Topbar", () => {
    test("renders <header class=\"topbar\"> with title Approvals", async () => {
        const html = await render(
            <ApprovalsView items={[baseItem()]} costCapDailyUsd={25} />,
        );
        expect(html).toContain('<header class="topbar">');
        expect(html).toContain(">Approvals<");
    });

    test("subTitle shows N pending count", async () => {
        const html = await render(
            <ApprovalsView items={[baseItem(), baseItem({ id: "REQ-2" })]} costCapDailyUsd={25} />,
        );
        expect(html).toContain("2 pending");
    });

    test("#429 — Pending/Approved/Rejected tabs are present and HTMX-wired", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        // #429: tabs are now REAL filters over gate-decision history (no
        // longer dead controls). Each is an HTMX link that re-fetches the
        // body with ?tab=<id>.
        expect(html).toContain('class="approvals-tabs"');
        expect(html).toContain("Pending");
        expect(html).toContain("Approved");
        expect(html).toContain("Rejected");
        expect(html).toContain('href="/approvals?tab=approved"');
        expect(html).toContain('href="/approvals?tab=rejected"');
        expect(html).toContain('hx-get="/approvals?tab=rejected"');
        // Pending tab is active by default.
        expect(html).toMatch(/class="approvals-tab active"[^>]*aria-selected="true"/);
        // Bulk approve stays.
        expect(html).toContain("Bulk approve");
    });

    test("Bulk approve button is present in topbar rightSlot", async () => {
        const html = await render(
            <ApprovalsView items={[baseItem()]} costCapDailyUsd={25} />,
        );
        expect(html).toContain("Bulk approve");
        expect(html).toContain('hx-post="/api/approvals/bulk-approve"');
    });

    test("Bulk approve button has bulk-approve class", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain('class="btn primary sm bulk-approve"');
    });

    test("Bulk approve button is disabled when items is empty", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        // disabled attribute on an empty items render
        expect(html).toContain("disabled");
    });
});

// ---- Filter strip -----------------------------------------------------------

describe("ApprovalsView — FR-026-30 filter strip", () => {
    test("renders .filter-strip with search input", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain('class="filter-strip"');
        expect(html).toContain('class="search"');
        expect(html).toContain('placeholder="Filter by id, title, repo…"');
    });

    test("gate-type seg carries data-segmented-filter=\"approvals\"", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain('data-segmented-filter="approvals"');
    });

    test("gate-type seg has 4 buttons: All gates / Review / Deploy / Spec", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain("All gates");
        expect(html).toContain("Review");
        expect(html).toContain("Deploy");
        expect(html).toContain("Spec");
    });

    test("first seg-btn in gate filter is active with data-filter=\"all\"", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain('data-filter="all"');
        // The first seg-btn should be active
        const firstBtn = html.match(/class="seg-btn[^"]*"[^>]*data-filter="all"/);
        expect(firstBtn?.[0] ?? "").toContain("active");
    });

    test("no invented SLA claim; honest gate-stats empty state", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        // #389-class honesty: no SLA is configured anywhere; the old meta
        // line claimed "SLA < 4h" and the stats card posed design-reference
        // constants (68/9/3/1, median 48m) as live telemetry.
        expect(html).not.toContain("SLA");
        expect(html).not.toContain("example data");
        expect(html).toContain("No gate history yet");
        expect(html).not.toContain("48m");
    });
});

// ---- Approvals table --------------------------------------------------------

describe("ApprovalsView — FR-026-30 6-column approval-row grid", () => {
    test("renders .card.approvals-card with table header", async () => {
        const html = await render(
            <ApprovalsView items={[baseItem()]} costCapDailyUsd={25} />,
        );
        expect(html).toContain("approvals-card");
        expect(html).toContain("approvals-table-head");
    });

    test("table header contains all 6 column labels", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain("Request");
        expect(html).toContain("Title");
        expect(html).toContain("Gate");
        expect(html).toContain("Reviewer checks");
        expect(html).toContain("Waiting");
        expect(html).toContain("Actions");
    });

    test("renders one .approval-row per item", async () => {
        const items = [
            baseItem({ id: "R1" }),
            baseItem({ id: "R2" }),
            baseItem({ id: "R3" }),
        ];
        const html = await render(
            <ApprovalsView items={items} costCapDailyUsd={10} />,
        );
        // Match only the row container divs (class starts with "approval-row"
        // followed by either " selected", space-terminated, or end-of-attr).
        const rowMatches =
            html.match(/class="approval-row(?:\s+selected)?"/g) ?? [];
        expect(rowMatches.length).toBe(3);
    });

    test("first row is selected by default when items exist", async () => {
        const html = await render(
            <ApprovalsView items={[baseItem({ id: "REQ-X" })]} costCapDailyUsd={25} />,
        );
        expect(html).toContain('class="approval-row selected"');
    });

    test("row carries data-approval-id matching item id", async () => {
        const html = await render(
            <ApprovalsView items={[baseItem({ id: "REQ-42" })]} costCapDailyUsd={25} />,
        );
        expect(html).toContain('data-approval-id="REQ-42"');
    });

    test("#504 — row id is a link to the detail page (.approval-row-id anchor)", async () => {
        const html = await render(
            <ApprovalsView
                items={[baseItem({ id: "REQ-99", repo: "acme" })]}
                costCapDailyUsd={25}
            />,
        );
        // #504: the id is now an <a> (covers the dropped INSPECT button) so
        // clicking it navigates to the REQ-XXXXXX detail page.
        expect(html).toContain(
            '<a class="approval-row-id" href="/repo/acme/request/REQ-99">REQ-99</a>',
        );
    });

    test("row shows phase chip with phase name", async () => {
        const html = await render(
            <ApprovalsView items={[baseItem({ phase: "review" })]} costCapDailyUsd={25} />,
        );
        expect(html).toContain('chip-phase review');
        expect(html).toContain("review");
    });

    test("waiting column shows waitedMin as N + m", async () => {
        const html = await render(
            <ApprovalsView
                items={[baseItem({ waitedMin: 22 })]}
                costCapDailyUsd={25}
            />,
        );
        expect(html).toContain(">22m<");
    });

    test("cdot elements render for items with checks", async () => {
        const itemWithChecks = {
            ...baseItem({ id: "R-checks" }),
            checks: ["pass", "pass", "warn", "pending"] as ("pass" | "warn" | "fail" | "pending")[],
        } as ApprovalItem & { checks: ("pass" | "warn" | "fail" | "pending")[] };
        const html = await render(
            <ApprovalsView items={[itemWithChecks]} costCapDailyUsd={25} />,
        );
        expect(html).toContain("cdot--pass");
        expect(html).toContain("cdot--warn");
        expect(html).toContain("cdot--pending");
    });

    test("empty state renders .approvals-empty when items is empty", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain("approvals-empty");
        expect(html).toContain("No pending approvals");
    });

    test("Approve button posts to correct endpoint with double-confirm", async () => {
        const html = await render(
            <ApprovalsView
                items={[baseItem({ id: "REQ-A", repo: "my-repo" })]}
                costCapDailyUsd={10}
            />,
        );
        expect(html).toContain('hx-post="/api/approvals/REQ-A/approve"');
        expect(html).toContain('hx-confirm=');
    });

    test("Reject button posts to correct endpoint with double-confirm", async () => {
        const html = await render(
            <ApprovalsView
                items={[baseItem({ id: "REQ-B", repo: "my-repo" })]}
                costCapDailyUsd={10}
            />,
        );
        expect(html).toContain('hx-post="/api/approvals/REQ-B/reject"');
        expect(html).toContain('hx-confirm=');
    });

    test("#504 — title link points to /repo/{repo}/request/{id} (INSPECT dropped)", async () => {
        const html = await render(
            <ApprovalsView
                items={[baseItem({ id: "REQ-C", repo: "acme-repo" })]}
                costCapDailyUsd={10}
            />,
        );
        // The id/title links cover navigation to detail, so the standalone
        // INSPECT button is removed.
        expect(html).toContain(
            '<a class="approval-row-title" href="/repo/acme-repo/request/REQ-C">',
        );
        expect(html).not.toContain("Inspect");
    });

    // #504 regression — the row MUST be a <div>, not a <button>. The old
    // <button> row wrapped nested <button>/<a> action elements, which is
    // invalid HTML: the parser hoisted them out of the grid cell and they
    // rendered stranded below the table. Per-row actions must live INSIDE
    // the .approval-row-actions cell, with no inline onclick (strict CSP).
    test("#504 — row is a div with Approve/Reject INSIDE .approval-row-actions; no nested button-in-button; no inline onclick", async () => {
        const html = await render(
            <ApprovalsView
                items={[baseItem({ id: "REQ-D" })]}
                costCapDailyUsd={10}
            />,
        );
        // Row container is a div.
        expect(html).toMatch(/<div class="approval-row[^"]*" data-approval-id="REQ-D"/);
        // No <button class="approval-row ...> wrapper (the old bug).
        expect(html).not.toMatch(/<button[^>]*class="approval-row/);
        // The actions cell contains both buttons, in order, before its close.
        const cell =
            html.match(
                /<span class="approval-row-actions">([\s\S]*?)<\/span><\/div>/,
            )?.[1] ?? "";
        expect(cell).toContain('hx-post="/api/approvals/REQ-D/approve"');
        expect(cell).toContain('hx-post="/api/approvals/REQ-D/reject"');
        // No inline event handlers anywhere (strict CSP).
        expect(html).not.toMatch(/onclick=|onClick=|hx-on/i);
    });

    // #504 — rows participate in the segmented filter (segmented-filter.js
    // targets [data-gate-type]); the old <button> rows omitted this so the
    // gate-type filter was a no-op on the approvals table.
    test("#504 — pending rows carry data-gate-type for the segmented filter", async () => {
        const html = await render(
            <ApprovalsView
                items={[baseItem({ id: "REQ-E", gateType: "reviewer-chain" })]}
                costCapDailyUsd={10}
            />,
        );
        expect(html).toContain('data-gate-type="reviewer-chain"');
    });
});

// ---- Preview card -----------------------------------------------------------

describe("ApprovalsView — FR-026-30 preview card", () => {
    test("renders .approvals-lower-grid with two .card elements", async () => {
        const html = await render(
            <ApprovalsView items={[baseItem()]} costCapDailyUsd={25} />,
        );
        expect(html).toContain("approvals-lower-grid");
        const cardMatches = html.match(/<div class="card[^"]*">/g) ?? [];
        expect(cardMatches.length).toBeGreaterThanOrEqual(2);
    });

    test("preview card shows Selected · {id} when items exist", async () => {
        const html = await render(
            <ApprovalsView items={[baseItem({ id: "REQ-P" })]} costCapDailyUsd={25} />,
        );
        expect(html).toContain("Selected · REQ-P");
    });

    test("preview card shows 'No selection' when items is empty", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain("No selection");
    });

    test("preview card has Open full link to the selected request", async () => {
        const html = await render(
            <ApprovalsView
                items={[baseItem({ id: "REQ-Q", repo: "qrepo" })]}
                costCapDailyUsd={25}
            />,
        );
        expect(html).toContain('href="/repo/qrepo/request/REQ-Q"');
    });
});

// ---- Gate stats card --------------------------------------------------------

describe("ApprovalsView — FR-026-30 gate-stats-7d card", () => {
    test("renders 'Gate stats · 7d' heading", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain("Gate stats · 7d");
    });

    test("renders the honest no-data state, never the design-reference constants", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        // #389-class honesty: with no decided gates the card stays empty —
        // the old card posed constants (Auto-approved 68, median 48m) as
        // live telemetry.
        expect(html).toContain("No gate history yet");
        expect(html).not.toContain("Auto-approved");
        expect(html).not.toContain("48m");
    });

    test("#429 — empty stats object (zero decided) still renders honest empty state", async () => {
        const html = await render(
            <ApprovalsView
                items={[]}
                costCapDailyUsd={25}
                gateStats={{
                    windowDays: 7,
                    total: 0,
                    approved: 0,
                    rejected: 0,
                    requestChanges: 0,
                    approveRate: 0,
                    rejectRate: 0,
                }}
            />,
        );
        // total === 0 must NOT render fabricated bars; honest empty card.
        expect(html).toContain("No gate history yet");
    });

    test("#429 — real stats render live counts + approve rate (no fabrication)", async () => {
        const html = await render(
            <ApprovalsView
                items={[]}
                costCapDailyUsd={25}
                gateStats={{
                    windowDays: 7,
                    total: 5,
                    approved: 3,
                    rejected: 1,
                    requestChanges: 1,
                    approveRate: 0.6,
                    rejectRate: 0.2,
                }}
            />,
        );
        expect(html).not.toContain("No gate history yet");
        // Live summary line: total decided + approve rate.
        expect(html).toContain("5 decided");
        expect(html).toContain("60% approved");
        // Stat rows present (apostrophe is HTML-escaped in the output).
        expect(html).toContain(">Approved<");
        expect(html).toContain(">Rejected<");
        expect(html).toContain("Re-spec");
    });
});

// ---- #429 history tabs ------------------------------------------------------

describe("ApprovalsView — #429 Approved/Rejected history tabs", () => {
    const hist = (
        overrides: Partial<import("../../server/types/render").GateHistoryItem> = {},
    ): import("../../server/types/render").GateHistoryItem => ({
        id: "REQ-100",
        repo: "acme",
        phase: "review",
        decision: "approved",
        decidedAt: "2026-06-17T10:30:00Z",
        decidedBy: "alice",
        ...overrides,
    });

    test("approved tab lists decided=approved gates from history", async () => {
        const html = await render(
            <ApprovalsView
                items={[]}
                costCapDailyUsd={25}
                tab="approved"
                history={[
                    hist({ id: "REQ-A1", decision: "approved" }),
                    hist({ id: "REQ-R1", decision: "rejected" }),
                ]}
            />,
        );
        expect(html).toContain("approvals-history-row");
        expect(html).toContain("REQ-A1");
        // The rejected row must not appear on the approved tab.
        expect(html).not.toContain("REQ-R1");
        // Decided-by + timestamp surfaced.
        expect(html).toContain("alice");
        expect(html).toContain("2026-06-17 10:30");
    });

    test("rejected tab lists decided=rejected gates from history", async () => {
        const html = await render(
            <ApprovalsView
                items={[]}
                costCapDailyUsd={25}
                tab="rejected"
                history={[
                    hist({ id: "REQ-A2", decision: "approved" }),
                    hist({ id: "REQ-R2", decision: "rejected" }),
                ]}
            />,
        );
        expect(html).toContain("REQ-R2");
        expect(html).not.toContain("REQ-A2");
    });

    test("approved tab with no decided gates shows honest empty row", async () => {
        const html = await render(
            <ApprovalsView
                items={[]}
                costCapDailyUsd={25}
                tab="approved"
                history={[]}
            />,
        );
        expect(html).toContain("No approved gates yet");
    });

    test("tab counts reflect the supplied history", async () => {
        const html = await render(
            <ApprovalsView
                items={[baseItem()]}
                costCapDailyUsd={25}
                tab="pending"
                history={[
                    hist({ id: "A", decision: "approved" }),
                    hist({ id: "B", decision: "approved" }),
                    hist({ id: "C", decision: "rejected" }),
                ]}
            />,
        );
        // Pending count = 1 item, approved = 2, rejected = 1.
        expect(html).toMatch(
            /Approved<span class="approvals-tab-count">2<\/span>/,
        );
        expect(html).toMatch(
            /Rejected<span class="approvals-tab-count">1<\/span>/,
        );
    });
});

// ---- Schema / token cleanliness --------------------------------------------

describe("ApprovalsView — schema / token cleanliness", () => {
    test("no raw hex color in rendered output", async () => {
        const html = await render(
            <ApprovalsView items={[baseItem()]} costCapDailyUsd={25} />,
        );
        expect(html).not.toMatch(/#[0-9a-fA-F]{6}/);
        expect(html).not.toMatch(/#[0-9a-fA-F]{3}\b/);
    });

    test("no legacy .approval-item or risk-* markup", async () => {
        const html = await render(
            <ApprovalsView items={[baseItem()]} costCapDailyUsd={25} />,
        );
        expect(html).not.toContain("approval-item");
        expect(html).not.toContain("risk-high");
        expect(html).not.toContain("risk-med");
        expect(html).not.toContain("risk-low");
    });

    test("polling wrapper id is #approvals-body", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain('id="approvals-body"');
    });
});

// #391 regression — every action button must carry the CSRF token via
// hx-include of the hidden _csrf field, or the enforcer 403s the action.
describe("ApprovalsView CSRF wiring (#391)", () => {
    test("renders the hidden _csrf input with the threaded token", async () => {
        const html = await render(
            ApprovalsView({
                items: [baseItem()],
                costCapDailyUsd: 25,
                csrfToken: "tok-391-test",
            }),
        );
        expect(html).toMatch(
            /<input[^>]*id="approvals-csrf"[^>]*name="_csrf"[^>]*value="tok-391-test"/,
        );
    });

    test("approve, reject, and bulk buttons hx-include the csrf field", async () => {
        const html = await render(
            ApprovalsView({
                items: [baseItem()],
                costCapDailyUsd: 25,
                csrfToken: "tok-391-test",
            }),
        );
        const approve = html.match(/<button[^>]*hx-post="\/api\/approvals\/REQ-1\/approve"[^>]*>/)?.[0] ?? "";
        const reject = html.match(/<button[^>]*hx-post="\/api\/approvals\/REQ-1\/reject"[^>]*>/)?.[0] ?? "";
        const bulk = html.match(/<button[^>]*hx-post="\/api\/approvals\/bulk-approve"[^>]*>/)?.[0] ?? "";
        expect(approve).toContain('hx-include="#approvals-csrf"');
        expect(reject).toContain('hx-include="#approvals-csrf"');
        expect(bulk).toContain("#approvals-csrf");
    });
});

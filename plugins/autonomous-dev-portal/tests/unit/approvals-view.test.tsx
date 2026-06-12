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

    test("topbar rightSlot contains Pending/Approved/Rejected seg buttons", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain("Pending");
        expect(html).toContain("Approved");
        expect(html).toContain("Rejected");
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

    test("SLA meta line is present", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain("SLA");
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

    test("row shows request id in .approval-row-id span", async () => {
        const html = await render(
            <ApprovalsView items={[baseItem({ id: "REQ-99" })]} costCapDailyUsd={25} />,
        );
        expect(html).toContain(
            '<span class="approval-row-id">REQ-99</span>',
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

    test("Inspect link href points to /repo/{repo}/request/{id}", async () => {
        const html = await render(
            <ApprovalsView
                items={[baseItem({ id: "REQ-C", repo: "acme-repo" })]}
                costCapDailyUsd={10}
            />,
        );
        expect(html).toContain('href="/repo/acme-repo/request/REQ-C"');
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

    test("renders Auto-approved / Operator approved / Rejected / Re-spec'd rows", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain("Auto-approved");
        expect(html).toContain("Operator approved");
        expect(html).toContain("Rejected");
        expect(html).toContain("Re-spec&#39;d");
    });

    test("renders median time-to-approve label", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain("Median time-to-approve");
    });

    test("stat-row-track elements have ARIA progressbar role", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain('role="progressbar"');
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

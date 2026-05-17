// SPEC-037-4-01 / -03 / -05 — Approvals view unit tests.
//
// Asserts: page-head shape (title + Settings link + Bulk approve button),
// KPI strip (3 cards, correct order, count derivation, sub-line copy),
// gate-list rendering (per-row markup, gate-{type} classes, data attrs),
// empty state, and that no legacy `riskLevel` / `approval-item` markup
// survives the rebuild.

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

describe("ApprovalsView — SPEC-037-4-01 page-head", () => {
    test("renders <div class=\"page-head\"> with <h1>Approvals</h1>", async () => {
        const html = await render(
            <ApprovalsView items={[baseItem()]} costCapDailyUsd={25} />,
        );
        expect(html).toContain('<div class="page-head">');
        expect(html).toContain("<h1>Approvals</h1>");
    });

    test("head-actions contains Settings link to /settings#approvals", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain('href="/settings#approvals"');
    });

    test("head-actions contains primary Bulk approve button posting to bulk-approve", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain('hx-post="/api/approvals/bulk-approve"');
        expect(html).toContain("Bulk approve");
        // The bulk approve button has the bulk-approve class and hx-post attribute
        expect(html).toMatch(/class="bulk-approve"[^>]*hx-post/);
    });
});

describe("ApprovalsView — SPEC-037-4-01 KPI strip", () => {
    test("renders exactly 3 .kpi cards in the kpi-strip", async () => {
        const html = await render(
            <ApprovalsView items={[baseItem()]} costCapDailyUsd={25} />,
        );
        const matches = html.match(/<div class="kpi">/g) ?? [];
        expect(matches.length).toBe(3);
    });

    test("KPI labels are Reviewer chain / Standards violation / Cost cap, in order", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        const labels = [...html.matchAll(/<div class="kpi-label">([^<]+)</g)].map(
            (m) => m[1],
        );
        expect(labels).toEqual([
            "Reviewer chain",
            "Standards violation",
            "Cost cap",
        ]);
    });

    test("KPI counts partition items by gateType", async () => {
        const items = [
            baseItem({ id: "R1", gateType: "reviewer-chain", repo: "a" }),
            baseItem({ id: "R2", gateType: "reviewer-chain", repo: "b" }),
            baseItem({ id: "S1", gateType: "standards-violation", repo: "a" }),
            baseItem({ id: "C1", gateType: "cost-cap", repo: "c" }),
        ];
        const html = await render(
            <ApprovalsView items={items} costCapDailyUsd={42} />,
        );
        const nums = [...html.matchAll(/<div class="kpi-num">([^<]+)</g)].map(
            (m) => m[1],
        );
        expect(nums).toEqual(["2", "1", "1"]);
    });

    test("Reviewer sub-line counts unique repos", async () => {
        const items = [
            baseItem({ id: "R1", gateType: "reviewer-chain", repo: "a" }),
            baseItem({ id: "R2", gateType: "reviewer-chain", repo: "a" }),
            baseItem({ id: "R3", gateType: "reviewer-chain", repo: "b" }),
        ];
        const html = await render(
            <ApprovalsView items={items} costCapDailyUsd={10} />,
        );
        expect(html).toContain("across 2 repos");
    });

    test("Cost cap sub-line describes gates blocking consistently", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={42} />,
        );
        expect(html).toContain("cost-cap gates blocking");
    });

    test("Standards sub-line uses blocking field when present", async () => {
        const items = [
            baseItem({
                id: "S1",
                gateType: "standards-violation",
                blocking: true,
            }),
            baseItem({
                id: "S2",
                gateType: "standards-violation",
                blocking: false,
            }),
        ];
        const html = await render(
            <ApprovalsView items={items} costCapDailyUsd={10} />,
        );
        expect(html).toContain("of which 1 are blocking");
    });
});

describe("ApprovalsView — SPEC-037-4-02 segmented filter", () => {
    test("renders 4 .seg-btn buttons; first carries class 'on'", async () => {
        const html = await render(
            <ApprovalsView items={[baseItem()]} costCapDailyUsd={25} />,
        );
        const btnMatches = html.match(/class="seg-btn[^"]*"/g) ?? [];
        expect(btnMatches.length).toBe(4);
        expect(btnMatches[0]).toContain("on");
        // Subsequent buttons do NOT have the "on" class.
        expect(btnMatches.slice(1).every((c) => !c.includes("on"))).toBe(true);
    });

    test("segmented filter group carries data-segmented-filter=\"approvals\"", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain('data-segmented-filter="approvals"');
    });

    test("each filter button has the correct data-filter value", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        for (const filter of [
            "all",
            "reviewer-chain",
            "standards-violation",
            "cost-cap",
        ]) {
            expect(html).toContain(`data-filter="${filter}"`);
        }
    });

    test("aria-pressed reflects the initial active state", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        const allBtn = html.match(
            /<button[^>]*data-filter="all"[^>]*>/,
        );
        expect(allBtn?.[0]).toContain('aria-pressed="true"');
    });
});

describe("ApprovalsView — SPEC-037-4-03 gate-list + rows", () => {
    test("renders <section class=\"sec\"> with <h2>Open gates · N</h2>", async () => {
        const html = await render(
            <ApprovalsView
                items={[baseItem(), baseItem({ id: "REQ-2" })]}
                costCapDailyUsd={25}
            />,
        );
        expect(html).toContain('<section class="sec">');
        expect(html).toContain("Open gates ");
        expect(html).toContain("2</h2>");
    });

    test("renders one .gate-row per item", async () => {
        const items = [
            baseItem({ id: "R1" }),
            baseItem({ id: "R2", gateType: "standards-violation" }),
            baseItem({ id: "R3", gateType: "cost-cap" }),
        ];
        const html = await render(
            <ApprovalsView items={items} costCapDailyUsd={10} />,
        );
        const rowMatches = html.match(/class="gate-row gate-/g) ?? [];
        expect(rowMatches.length).toBe(3);
    });

    test("each row carries data-gate-type matching gateType", async () => {
        const items = [
            baseItem({ id: "R1", gateType: "reviewer-chain" }),
            baseItem({ id: "S1", gateType: "standards-violation" }),
        ];
        const html = await render(
            <ApprovalsView items={items} costCapDailyUsd={10} />,
        );
        expect(html).toContain('data-gate-type="reviewer-chain"');
        expect(html).toContain('data-gate-type="standards-violation"');
    });

    test("each row carries the gate-{type} modifier class", async () => {
        const items = [
            baseItem({ gateType: "reviewer-chain" }),
            baseItem({ id: "S", gateType: "standards-violation" }),
            baseItem({ id: "C", gateType: "cost-cap" }),
        ];
        const html = await render(
            <ApprovalsView items={items} costCapDailyUsd={10} />,
        );
        expect(html).toContain("gate-reviewer-chain");
        expect(html).toContain("gate-standards-violation");
        expect(html).toContain("gate-cost-cap");
    });

    test("row has gate-left / gate-mid / gate-right in that order", async () => {
        const html = await render(
            <ApprovalsView items={[baseItem()]} costCapDailyUsd={10} />,
        );
        const leftIdx = html.indexOf('class="gate-left"');
        const midIdx = html.indexOf('class="gate-mid"');
        const rightIdx = html.indexOf('class="gate-right"');
        expect(leftIdx).toBeGreaterThan(0);
        expect(midIdx).toBeGreaterThan(leftIdx);
        expect(rightIdx).toBeGreaterThan(midIdx);
    });

    test("cost renders as $D.DD via toFixed(2)", async () => {
        const html = await render(
            <ApprovalsView
                items={[baseItem({ cost: 3.1 })]}
                costCapDailyUsd={10}
            />,
        );
        expect(html).toContain('<div class="gate-cost meta-mono">$3.10</div>');
    });

    test("row has Open anchor, Approve and Reject buttons with correct hx-post targets", async () => {
        const html = await render(
            <ApprovalsView
                items={[baseItem({ id: "REQ-X", repo: "acme" })]}
                costCapDailyUsd={10}
            />,
        );
        expect(html).toContain('href="/repo/acme/request/REQ-X"');
        expect(html).toContain('hx-post="/api/approvals/REQ-X/approve"');
        expect(html).toContain('hx-post="/api/approvals/REQ-X/reject"');
    });

    test("phase chip text is uppercase", async () => {
        const html = await render(
            <ApprovalsView
                items={[baseItem({ phase: "review" })]}
                costCapDailyUsd={10}
            />,
        );
        expect(html).toContain(">REVIEW<");
    });

    test("empty items renders <div class=\"empty\">No open gates</div> and no .gate-list", async () => {
        const html = await render(
            <ApprovalsView items={[]} costCapDailyUsd={25} />,
        );
        expect(html).toContain('<div class="empty">No open gates</div>');
        expect(html).not.toContain('<div class="gate-list">');
    });
});

describe("ApprovalsView — schema cleanup", () => {
    test("no legacy .approval-item / risk-* markup survives", async () => {
        const items = [
            baseItem(),
            baseItem({ id: "R2", gateType: "standards-violation" }),
        ];
        const html = await render(
            <ApprovalsView items={items} costCapDailyUsd={25} />,
        );
        expect(html).not.toContain("approval-item");
        expect(html).not.toContain("risk-high");
        expect(html).not.toContain("risk-med");
        expect(html).not.toContain("risk-low");
        expect(html).not.toContain("risk-badge");
    });

    test("no raw hex color sneaks into the rendered template", async () => {
        const html = await render(
            <ApprovalsView items={[baseItem()]} costCapDailyUsd={25} />,
        );
        // Tolerate hex inside `<svg>` (none here) and class names; only
        // catch literal #abc/#abcdef tokens.
        expect(html).not.toMatch(/#[0-9a-fA-F]{6}/);
        expect(html).not.toMatch(/#[0-9a-fA-F]{3}\b/);
    });
});

// SPEC-037-4-03 — GateRow fragment unit tests.
//
// Asserts: row markup matches the kit shape, helper functions
// (gateTypeLabel, variantLabel) produce the expected strings, and the
// optional fields (cost = 0, waitedMin = 0) render without crashing.

import { describe, expect, test } from "bun:test";

import {
    GateRow,
    gateTypeLabel,
    variantLabel,
} from "../../server/templates/fragments/gate-row";
import type { ApprovalItem } from "../../server/types/render";

async function render(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

const item = (overrides: Partial<ApprovalItem> = {}): ApprovalItem => ({
    id: "REQ-9000",
    summary: "Sample summary",
    repo: "sample-repo",
    gateType: "reviewer-chain",
    phase: "review",
    variant: "deep-research",
    waitedMin: 12,
    cost: 0.5,
    detail: "sample detail line",
    actions: [
        { id: "approve", label: "Approve", confirm: null },
        { id: "reject", label: "Reject", confirm: null },
    ],
    ...overrides,
});

describe("gateTypeLabel", () => {
    test("maps reviewer-chain to 'Reviewer chain'", () => {
        expect(gateTypeLabel("reviewer-chain")).toBe("Reviewer chain");
    });
    test("maps standards-violation to 'Standards'", () => {
        expect(gateTypeLabel("standards-violation")).toBe("Standards");
    });
    test("maps cost-cap to 'Cost cap'", () => {
        expect(gateTypeLabel("cost-cap")).toBe("Cost cap");
    });
    test("echoes unknown type verbatim", () => {
        expect(gateTypeLabel("custom-thing")).toBe("custom-thing");
    });
});

describe("variantLabel", () => {
    test("humanizes kebab-case", () => {
        expect(variantLabel("deep-research")).toBe("Deep Research");
    });
    test("returns empty string for empty input", () => {
        expect(variantLabel("")).toBe("");
    });
    test("single-word input is capitalized", () => {
        expect(variantLabel("vanilla")).toBe("Vanilla");
    });
});

describe("GateRow markup — SPEC-037-4-03", () => {
    test("emits gate-row.gate-{type} class plus data attributes", async () => {
        const html = await render(<GateRow {...item()} />);
        expect(html).toContain('class="gate-row gate-reviewer-chain"');
        expect(html).toContain('data-gate-type="reviewer-chain"');
        expect(html).toContain('data-approval-id="REQ-9000"');
    });

    test("renders gate-left meta column with type tag + waited", async () => {
        const html = await render(<GateRow {...item({ waitedMin: 7 })} />);
        expect(html).toContain('<div class="gate-type-tag">Reviewer chain</div>');
        expect(html).toContain(
            '<div class="gate-wait meta-mono">waited 7m</div>',
        );
    });

    test("renders gate-mid summary + detail + meta line", async () => {
        const html = await render(
            <GateRow
                {...item({
                    summary: "Hello",
                    detail: "world",
                    repo: "x",
                    id: "REQ-1",
                })}
            />,
        );
        expect(html).toContain('<div class="r-title">Hello</div>');
        expect(html).toContain('<div class="gate-detail">world</div>');
        expect(html).toContain('<span class="r-id meta-mono">REQ-1</span>');
        expect(html).toContain("<span>x</span>");
    });

    test("renders gate-right cost + action group", async () => {
        const html = await render(<GateRow {...item({ cost: 12.5 })} />);
        expect(html).toContain('<div class="gate-cost meta-mono">$12.50</div>');
        expect(html).toContain('<div class="gate-actions">');
    });

    test("cost=0 renders as $0.00", async () => {
        const html = await render(<GateRow {...item({ cost: 0 })} />);
        expect(html).toContain("$0.00");
    });

    test("waitedMin=0 renders as 'waited 0m'", async () => {
        const html = await render(<GateRow {...item({ waitedMin: 0 })} />);
        expect(html).toContain("waited 0m");
    });

    test("Open link uses /repo/{repo}/request/{id}", async () => {
        const html = await render(
            <GateRow {...item({ repo: "acme", id: "REQ-42" })} />,
        );
        expect(html).toContain('href="/repo/acme/request/REQ-42"');
    });

    test("Approve / Reject hx-post targets include the approval id", async () => {
        const html = await render(<GateRow {...item({ id: "REQ-77" })} />);
        expect(html).toContain('hx-post="/api/approvals/REQ-77/approve"');
        expect(html).toContain('hx-post="/api/approvals/REQ-77/reject"');
    });

    test("variant chip uses the humanized label", async () => {
        const html = await render(
            <GateRow {...item({ variant: "fast-iter" })} />,
        );
        expect(html).toContain('<span class="chip variant sm">Fast Iter</span>');
    });

    test("phase build maps to 'code' tone but text remains BUILD", async () => {
        const html = await render(<GateRow {...item({ phase: "build" })} />);
        // Phase chip text is the uppercase phase name.
        expect(html).toContain(">BUILD<");
    });

    test("all three gate types render without error", async () => {
        for (const gt of [
            "reviewer-chain",
            "standards-violation",
            "cost-cap",
        ] as const) {
            const html = await render(<GateRow {...item({ gateType: gt })} />);
            expect(html).toContain(`class="gate-row gate-${gt}"`);
        }
    });
});

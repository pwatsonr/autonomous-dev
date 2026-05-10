// SPEC-036-1-04 §ApprovalQueueStrip — unit tests.
//
// Asserts: empty contract (no DOM), section id for SSE OOB swap,
// gate-row markup, gateType tone/label maps, Review href format,
// totalCount override.

import { describe, expect, test } from "bun:test";

import {
    ApprovalQueueStrip,
    gateTypeLabel,
    gateTypeTone,
} from "../../server/templates/fragments/approval-queue";
import type { DashboardRequest } from "../../server/types/render";

async function render(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

const baseGate = (
    overrides: Partial<DashboardRequest> = {},
): DashboardRequest => ({
    id: "REQ-000001",
    repo: "acme",
    title: "x",
    phase: "code",
    status: "gate",
    cost: 0,
    turns: 0,
    score: 0,
    variant: "fast-track",
    gateType: "reviewer-chain",
    waitedMin: 5,
    ...overrides,
});

describe("ApprovalQueueStrip — SPEC-036-1-04", () => {
    test("AC #3: empty gates -> no section, no DOM", async () => {
        const html = await render(<ApprovalQueueStrip gates={[]} />);
        // Accept the empty fragment with no leading whitespace.
        expect(html).not.toContain("approval-queue");
        expect(html).not.toContain("<section");
    });

    test("AC #7: section id and class for SSE OOB", async () => {
        const html = await render(
            <ApprovalQueueStrip gates={[baseGate()]} totalCount={1} />,
        );
        expect(html).toContain('<section id="approval-queue"');
        expect(html).toContain('class="sec approval-queue"');
    });

    test("AC #7: header shows totalCount", async () => {
        const html = await render(
            <ApprovalQueueStrip
                gates={[baseGate(), baseGate({ id: "REQ-2" })]}
                totalCount={12}
            />,
        );
        expect(html).toContain("12 total");
    });

    test("AC #4: gate-row contains phase chip + repo + id + type chip + age + Review", async () => {
        const html = await render(
            <ApprovalQueueStrip gates={[baseGate()]} totalCount={1} />,
        );
        // phase chip (uppercase)
        expect(html).toContain("CODE");
        // repo
        expect(html).toContain('class="gate-repo">acme');
        // id mono
        expect(html).toContain('class="gate-id meta-mono">REQ-000001');
        // age mono dim
        expect(html).toContain('class="gate-age meta-mono dim">5m');
        // Review anchor with class shape `btn primary sm`
        expect(html).toContain(
            '<a class="btn primary sm" href="/repo/acme/request/REQ-000001">',
        );
    });

    test("AC #8: Review href format /repo/{repo}/request/{id}", async () => {
        const html = await render(
            <ApprovalQueueStrip
                gates={[baseGate({ repo: "beta", id: "REQ-7" })]}
            />,
        );
        expect(html).toContain('href="/repo/beta/request/REQ-7"');
    });
});

describe("gateTypeTone — SPEC-036-1-04 AC #5", () => {
    test("reviewer-chain -> warn", () => {
        expect(gateTypeTone("reviewer-chain")).toBe("warn");
    });
    test("standards-violation -> err", () => {
        expect(gateTypeTone("standards-violation")).toBe("err");
    });
    test("cost-cap -> info", () => {
        expect(gateTypeTone("cost-cap")).toBe("info");
    });
    test("unknown -> muted", () => {
        expect(gateTypeTone("nope")).toBe("muted");
    });
    test("undefined -> muted", () => {
        expect(gateTypeTone(undefined)).toBe("muted");
    });
});

describe("gateTypeLabel — SPEC-036-1-04 AC #6", () => {
    test("reviewer-chain -> 'Reviewer'", () => {
        expect(gateTypeLabel("reviewer-chain")).toBe("Reviewer");
    });
    test("standards-violation -> 'Standards'", () => {
        expect(gateTypeLabel("standards-violation")).toBe("Standards");
    });
    test("cost-cap -> 'Cost cap'", () => {
        expect(gateTypeLabel("cost-cap")).toBe("Cost cap");
    });
    test("unknown -> echoes raw type", () => {
        expect(gateTypeLabel("custom-gate")).toBe("custom-gate");
    });
    test("undefined -> 'Gate' fallback", () => {
        expect(gateTypeLabel(undefined)).toBe("Gate");
    });
});

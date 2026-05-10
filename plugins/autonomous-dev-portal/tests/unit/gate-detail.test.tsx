// SPEC-036-3-03 / SPEC-036-3-06 — gate-detail fragment unit tests.

import { describe, expect, test } from "bun:test";

import { GateDetail } from "../../server/templates/fragments/gate-detail";

async function render(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

describe("GateDetail — surface", () => {
    test("renders the section head with gate type label and waited time", async () => {
        const html = await render(
            <GateDetail
                requestId="REQ-000001"
                repo="acme"
                gateType="reviewer-chain"
                gateDetail="2 blocking findings"
                waitedMin={12}
                csrfToken="csrf-1"
            />,
        );
        expect(html).toContain("Gate · Reviewer chain");
        expect(html).toContain("waited 12m");
        expect(html).toContain("2 blocking findings");
    });

    test("falls back to raw gate type when no label is mapped", async () => {
        const html = await render(
            <GateDetail
                requestId="REQ-000001"
                repo="acme"
                gateType="custom-gate"
                gateDetail="x"
                waitedMin={0}
            />,
        );
        expect(html).toContain("Gate · custom-gate");
    });
});

describe("GateDetail — action buttons", () => {
    test("renders Approve / Request changes / Reject buttons", async () => {
        const html = await render(
            <GateDetail
                requestId="REQ-000001"
                repo="acme"
                gateType="reviewer-chain"
                gateDetail="x"
                waitedMin={0}
                csrfToken="csrf-1"
            />,
        );
        expect(html).toContain('data-gate-action="approve"');
        expect(html).toContain('data-gate-action="request-changes"');
        expect(html).toContain('data-gate-action="reject"');
        expect(html).toContain("Approve");
        expect(html).toContain("Request changes");
        expect(html).toContain("Reject");
    });

    test("Approve carries primary kind; Reject carries destructive kind", async () => {
        const html = await render(
            <GateDetail
                requestId="REQ-000001"
                repo="acme"
                gateType="reviewer-chain"
                gateDetail="x"
                waitedMin={0}
            />,
        );
        // Btn primitive: kind="primary" → class="btn primary sm"
        expect(html).toMatch(
            /class="btn primary sm"[^>]*data-gate-action="approve"/,
        );
        expect(html).toMatch(
            /class="btn destructive sm"[^>]*data-gate-action="reject"/,
        );
    });

    test("HTMX attrs target the meta region OOB swap id", async () => {
        const html = await render(
            <GateDetail
                requestId="REQ-000001"
                repo="acme"
                gateType="reviewer-chain"
                gateDetail="x"
                waitedMin={0}
                csrfToken="csrf-1"
            />,
        );
        expect(html).toContain('hx-target="#request-REQ-000001-meta"');
        expect(html).toContain(
            'hx-post="/repo/acme/request/REQ-000001/gate/approve"',
        );
        expect(html).toContain('hx-trigger="confirmed"');
        expect(html).toContain("X-CSRF-Token");
        expect(html).toContain("csrf-1");
    });
});

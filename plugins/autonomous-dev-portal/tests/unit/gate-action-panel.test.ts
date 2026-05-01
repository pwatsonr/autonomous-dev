// SPEC-015-2-01 — Gate action panel rendering tests.
//
// We render JSX to a string by reusing the same Hono JSX runtime the live
// renderer uses. Assertions are HTML-substring based: the goal is to verify
// the contracts the spec calls out (button hx-post URLs, data-* flags, the
// resolved-mode status line, slots for clarification / escalation /
// validation / service errors), not to parse the DOM.

import { describe, expect, test } from "bun:test";

import {
    GateActionPanel,
    type GateActionPanelProps,
} from "../../server/templates/fragments/gate-action-panel";

async function render(props: GateActionPanelProps): Promise<string> {
    const node = GateActionPanel(props) as unknown;
    return String(await Promise.resolve(node));
}

const baseActive: GateActionPanelProps = {
    requestId: "REQ-1",
    title: "Test request",
    repo: "test-repo",
    cost: { total: 10 },
    status: "pending-approval",
    panelMode: "active",
    csrfToken: "csrf-abc",
};

describe("GateActionPanel — active mode", () => {
    test("renders three buttons each posting to its own /gate/{action} URL", async () => {
        const html = await render(baseActive);
        expect(html).toContain(
            'hx-post="/repo/test-repo/request/REQ-1/gate/approve"',
        );
        expect(html).toContain(
            'hx-post="/repo/test-repo/request/REQ-1/gate/request-changes"',
        );
        expect(html).toContain(
            'hx-post="/repo/test-repo/request/REQ-1/gate/reject"',
        );
        expect(html).toContain('name="action" value="approve"');
        expect(html).toContain('name="action" value="request-changes"');
        expect(html).toContain('name="action" value="reject"');
    });

    test("each button has aria-label that includes the request id", async () => {
        const html = await render(baseActive);
        expect(html).toContain('aria-label="Approve request REQ-1"');
        expect(html).toContain('aria-label="Request Changes request REQ-1"');
        expect(html).toContain('aria-label="Reject request REQ-1"');
    });

    test("low cost: reject button has data-requires-confirm=\"false\"", async () => {
        const html = await render(baseActive);
        // Reject button block should carry the false flag.
        expect(html).toMatch(
            /name="action" value="reject"[^>]*data-requires-confirm="false"|data-requires-confirm="false"[^>]*name="action" value="reject"/,
        );
    });

    test("high cost (>$50): reject button has data-requires-confirm=\"true\"", async () => {
        const html = await render({ ...baseActive, cost: { total: 75 } });
        expect(html).toMatch(
            /name="action" value="reject"[^>]*data-requires-confirm="true"|data-requires-confirm="true"[^>]*name="action" value="reject"/,
        );
    });

    test("request-changes button has data-requires-comment=\"true\"", async () => {
        const html = await render(baseActive);
        expect(html).toMatch(
            /name="action" value="request-changes"[^>]*data-requires-comment="true"|data-requires-comment="true"[^>]*name="action" value="request-changes"/,
        );
    });

    test("textarea has maxlength=1000 and a sibling char counter span", async () => {
        const html = await render(baseActive);
        expect(html).toContain('maxlength="1000"');
        expect(html).toContain('id="char-count-REQ-1"');
        expect(html).toContain("0/1000");
        expect(html).toContain('aria-describedby="char-count-REQ-1"');
    });

    test("CSRF hidden input is present in the form", async () => {
        const html = await render(baseActive);
        expect(html).toContain('name="csrfToken"');
        expect(html).toContain('value="csrf-abc"');
    });

    test("HTMX form attributes target the panel root with outerHTML swap", async () => {
        const html = await render(baseActive);
        expect(html).toContain('hx-target="#gate-panel-REQ-1"');
        expect(html).toContain('hx-swap="outerHTML"');
        expect(html).toContain('hx-include="this"');
    });

    test("clarifyingQuestion renders an aside above the form", async () => {
        const html = await render({
            ...baseActive,
            clarifyingQuestion: {
                text: "Which library?",
                options: ["A", "B"],
                askedAt: "2026-04-30T12:00:00Z",
            },
        });
        expect(html).toContain('class="clarifying-questions"');
        expect(html).toContain("Which library?");
        expect(html).toContain("<li>A</li>");
        expect(html).toContain("<li>B</li>");
        // Aside appears before the form.
        const idxAside = html.indexOf("clarifying-questions");
        const idxForm = html.indexOf("gate-form");
        expect(idxAside).toBeGreaterThan(-1);
        expect(idxForm).toBeGreaterThan(idxAside);
    });

    test("escalatedAt renders the escalation badge with a <time> element", async () => {
        const html = await render({
            ...baseActive,
            escalatedAt: "2026-04-29T08:00:00Z",
        });
        expect(html).toContain('class="escalation-badge"');
        expect(html).toContain('datetime="2026-04-29T08:00:00Z"');
        expect(html).toContain("Escalated");
    });

    test("validationError slot renders an alert above the form", async () => {
        const html = await render({
            ...baseActive,
            validationError: "Comment is required",
        });
        expect(html).toContain('class="validation-error"');
        expect(html).toContain('role="alert"');
        expect(html).toContain("Comment is required");
    });

    test("serviceError slot renders the 503 retry message", async () => {
        const html = await render({
            ...baseActive,
            serviceError: "Intake router unavailable",
        });
        expect(html).toContain('class="service-error"');
        expect(html).toContain("Please retry in 30s");
    });
});

describe("GateActionPanel — resolved mode", () => {
    test("approve resolution renders 'Approved by ...' and no buttons", async () => {
        const html = await render({
            ...baseActive,
            panelMode: "resolved",
            resolvedAction: "approve",
            resolvedBy: "op1",
            resolvedAt: "2026-04-30T12:34:56Z",
        });
        expect(html).toContain("Approved");
        expect(html).toContain("op1");
        expect(html).not.toContain('class="gate-actions"');
        expect(html).not.toContain('hx-post=');
    });

    test("reject resolution with comment renders the blockquote", async () => {
        const html = await render({
            ...baseActive,
            panelMode: "resolved",
            resolvedAction: "reject",
            resolvedBy: "op1",
            resolvedAt: "2026-04-30T12:34:56Z",
            resolvedComment: "too expensive",
        });
        expect(html).toContain("Rejected");
        expect(html).toContain('class="resolution-comment"');
        expect(html).toContain("too expensive");
    });

    test("preserves the panel root id so subsequent swaps stay wired", async () => {
        const html = await render({
            ...baseActive,
            panelMode: "resolved",
            resolvedAction: "approve",
            resolvedBy: "op1",
            resolvedAt: "2026-04-30T12:34:56Z",
        });
        expect(html).toContain('id="gate-panel-REQ-1"');
    });
});

// #396 backlog batch 1 — fragment regressions:
//   1. rd-v3 gate panel must submit the `_csrf` field the enforcer's body
//      fallback actually reads (the old `csrf_token` name was ignored →
//      every gate decision 403'd silently).
//   2. dashboard swimlane cards must link to the real detail route
//      /repo/:repo/request/:id (the old /requests/:id href 404'd).

import { describe, expect, test } from "bun:test";

import { RdV3GatePanel } from "../../server/templates/fragments/rd-v3-gate-panel";
import { DashboardSwimlanes } from "../../server/templates/fragments/dashboard-swimlanes";

async function render(node: unknown): Promise<string> {
    return await Promise.resolve(node).then(String);
}

describe("RdV3GatePanel CSRF field (#396)", () => {
    test("submits _csrf (the enforcer's field), not csrf_token", async () => {
        const html = await render(
            RdV3GatePanel({
                requestId: "REQ-000099",
                repo: "some-repo",
                gateLabel: "Spec gate · review",
                reviewers: [],
                csrfToken: "tok-396",
                decision: null,
            } as any),
        );
        expect(html).toMatch(/name="_csrf"[^>]*value="tok-396"|value="tok-396"[^>]*name="_csrf"/);
        expect(html).not.toContain('name="csrf_token"');
        // buttons still include the hidden field by id
        expect(html).toContain('hx-include="#rd-gate-csrf');
    });
});

describe("swimlane card links (#396)", () => {
    test("cards link to /repo/:repo/request/:id, never the 404 /requests/:id", async () => {
        const html = await render(
            DashboardSwimlanes({
                groups: [{
                    phase: "code",
                    label: "Code",
                    cards: [{
                        id: "REQ-000017",
                        priority: "p1",
                        title: "t",
                        phase: "code",
                        pct: 50,
                        agent: "ad-validation-2026-05-17",
                        eta: "—",
                        cost: 1,
                        state: "live",
                    }],
                } as any],
            } as any),
        );
        expect(html).toContain('href="/repo/ad-validation-2026-05-17/request/REQ-000017"');
        expect(html).not.toContain('href="/requests/REQ-000017"');
    });
});

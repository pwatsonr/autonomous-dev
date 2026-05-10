// SPEC-036-3-04 — reviewer-chain fragment unit tests.

import { describe, expect, test } from "bun:test";

import { ReviewerChain } from "../../server/templates/fragments/reviewer-chain";
import type { RequestReviewer } from "../../server/types/render";

async function render(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

const REVIEWER: RequestReviewer = {
    name: "qa-edge-case-reviewer",
    version: "0.4.1",
    blocking: true,
    finding: "2 blocking findings",
    runId: "run-qa-7e2",
    dimensions: [
        { name: "edge cases", num: 12, den: 20 },
        { name: "concurrency", num: 4, den: 10 },
    ],
};

describe("ReviewerChain — populated", () => {
    test("renders one card per reviewer", async () => {
        const html = await render(
            <ReviewerChain reviewers={[REVIEWER, { ...REVIEWER, name: "x" }]} />,
        );
        const matches = html.match(/class="rev-card[^"]*"/g) || [];
        expect(matches.length).toBe(2);
    });

    test("blocking card carries 'blocking' class and BLOCKING chip", async () => {
        const html = await render(<ReviewerChain reviewers={[REVIEWER]} />);
        expect(html).toContain('class="rev-card blocking"');
        expect(html).toContain("BLOCKING");
    });

    test("agent run link is well-formed", async () => {
        const html = await render(<ReviewerChain reviewers={[REVIEWER]} />);
        expect(html).toContain(
            '<a class="rev-dim-link" href="/agents/qa-edge-case-reviewer/runs/run-qa-7e2">',
        );
    });

    test("Score primitive renders one row per dimension", async () => {
        const html = await render(<ReviewerChain reviewers={[REVIEWER]} />);
        // Score primitive emits class="score-inline"
        const scoreMatches = html.match(/class="score-inline"/g) || [];
        expect(scoreMatches.length).toBe(2);
    });

    test("agent version rendered in meta-mono dim", async () => {
        const html = await render(<ReviewerChain reviewers={[REVIEWER]} />);
        expect(html).toContain('class="rev-foot meta-mono dim"');
        expect(html).toContain("v0.4.1");
    });
});

describe("ReviewerChain — empty", () => {
    test("renders empty-state row when reviewers is empty", async () => {
        const html = await render(<ReviewerChain reviewers={[]} />);
        expect(html).toContain("No reviewers configured for this phase");
        expect(html).not.toContain("rev-card");
    });
});

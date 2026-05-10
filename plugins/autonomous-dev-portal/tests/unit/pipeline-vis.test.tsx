// SPEC-036-3-03 — pipeline-vis fragment unit tests.

import { describe, expect, test } from "bun:test";

import { PipelineVis } from "../../server/templates/fragments/pipeline-vis";

async function render(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

const PHASES = [
    "prd",
    "tdd",
    "plan",
    "spec",
    "code",
    "review",
    "deploy",
    "observe",
];

describe("PipelineVis — state classes", () => {
    test("now appears at currentPhase index", async () => {
        const html = await render(
            <PipelineVis phases={PHASES} currentPhase="spec" />,
        );
        expect(html).toMatch(
            /<button[^>]*data-phase="spec"[^>]*data-state="now"/,
        );
    });

    test("done before, pending after", async () => {
        const html = await render(
            <PipelineVis phases={PHASES} currentPhase="spec" />,
        );
        expect(html).toMatch(/data-phase="prd"[^>]*data-state="done"/);
        expect(html).toMatch(/data-phase="code"[^>]*data-state="pending"/);
    });

    test("first step gets 'first' class; last step gets 'last' class", async () => {
        const html = await render(
            <PipelineVis phases={PHASES} currentPhase="spec" />,
        );
        expect(html).toMatch(/<button[^>]*class="pipe-step done first/);
        expect(html).toMatch(/<button[^>]*class="pipe-step pending last/);
    });

    test("each step has data-phase attribute", async () => {
        const html = await render(
            <PipelineVis phases={PHASES} currentPhase="prd" />,
        );
        for (const p of PHASES) {
            expect(html).toContain(`data-phase="${p}"`);
        }
    });

    test("UPPERCASE phase names rendered", async () => {
        const html = await render(
            <PipelineVis phases={PHASES} currentPhase="prd" />,
        );
        expect(html).toContain(">PRD<");
        expect(html).toContain(">OBSERVE<");
    });
});

// SPEC-036-3-04 — deploy-pipeline fragment unit tests.

import { describe, expect, test } from "bun:test";

import { DeployPipeline } from "../../server/templates/fragments/deploy-pipeline";

async function render(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

describe("DeployPipeline — state classes", () => {
    test("now matches the deployStage", async () => {
        const html = await render(<DeployPipeline deployStage="build" />);
        expect(html).toMatch(/data-stage="build"[^>]*data-state="now"/);
    });

    test("done before, pending after", async () => {
        const html = await render(<DeployPipeline deployStage="deploy" />);
        expect(html).toMatch(/data-stage="preflight"[^>]*data-state="done"/);
        expect(html).toMatch(
            /data-stage="health-check"[^>]*data-state="pending"/,
        );
    });

    test("includes deployTarget label in section head when provided", async () => {
        const html = await render(
            <DeployPipeline deployStage="build" deployTarget="prod-cluster" />,
        );
        expect(html).toContain("Deploy · prod-cluster");
        expect(html).toContain("stage: build");
    });
});

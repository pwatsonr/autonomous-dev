// SPEC-036-4-07 — Snapshot/structure tests for `agent-table.tsx`.

import { describe, expect, test } from "bun:test";

import {
    AgentInspectModal,
    AgentTable,
} from "../../server/templates/fragments/agent-table";
import type { AgentRecord, AgentRunRef } from "../../server/types/render";

function mkAgent(
    name: string,
    state: AgentRecord["state"],
    runs: AgentRunRef[] = [],
): AgentRecord {
    return {
        name,
        role: "coder",
        state,
        approvalPct: 80,
        precisionPct: 75,
        recallPct: 70,
        version: "1.0.0",
        lastTrainedAt: "2026-04-01T09:00:00.000Z",
        recentRuns: runs,
    };
}

async function render(node: unknown): Promise<string> {
    return await Promise.resolve(node).then(String);
}

describe("AgentTable", () => {
    test("renders 18 agents in alphabetical order", async () => {
        const names = [
            "zed",
            "alpha",
            "merger",
            "coder",
            "intake",
            "linter",
            "planner",
            "explainer",
            "observer",
            "researcher",
            "merger-2",
            "code-reviewer",
            "docs-writer",
            "release-manager",
            "spec-author",
            "tdd-author",
            "prd-author",
            "gate-keeper",
        ];
        const agents = names.map((n) => mkAgent(n, "active"));
        const html = await render(AgentTable({ agents }));

        // Each name should appear; the first should be "alpha".
        const firstAgentRow = html.indexOf('data-agent="alpha"');
        const lastAgentRow = html.indexOf('data-agent="zed"');
        expect(firstAgentRow).toBeGreaterThan(0);
        expect(lastAgentRow).toBeGreaterThan(firstAgentRow);
        for (const n of names) {
            expect(html).toContain(`data-agent="${n}"`);
        }
    });

    test("Inspect Btn carries data-modal-open with the agent id", async () => {
        const html = await render(
            AgentTable({ agents: [mkAgent("coder", "active")] }),
        );
        expect(html).toContain('data-modal-open="inspect-agent-modal-coder"');
    });
});

describe("AgentInspectModal", () => {
    test("empty recentRuns renders the empty state", async () => {
        const html = await render(
            AgentInspectModal({ agent: mkAgent("coder", "active") }),
        );
        expect(html).toContain('data-empty="agent-runs"');
        expect(html).toContain("No runs yet");
    });

    test("renders 3 most recent runs sorted desc by startedAt", async () => {
        const runs: AgentRunRef[] = [
            {
                id: "r-1",
                startedAt: "2026-05-01T10:00:00.000Z",
                status: "success",
                durationMs: 1000,
                cost: 0.1,
            },
            {
                id: "r-2",
                startedAt: "2026-05-02T10:00:00.000Z",
                status: "failed",
                durationMs: 1200,
                cost: 0.2,
            },
            {
                id: "r-3",
                startedAt: "2026-05-03T10:00:00.000Z",
                status: "success",
                durationMs: 1300,
                cost: 0.3,
            },
            {
                id: "r-4",
                startedAt: "2026-05-04T10:00:00.000Z",
                status: "cancelled",
                durationMs: 1400,
                cost: 0.4,
            },
            {
                id: "r-5",
                startedAt: "2026-05-05T10:00:00.000Z",
                status: "success",
                durationMs: 1500,
                cost: 0.5,
            },
        ];
        const html = await render(
            AgentInspectModal({ agent: mkAgent("coder", "active", runs) }),
        );
        // The three most recent runs are 5, 4, 3.
        expect(html).toContain("2026-05-05");
        expect(html).toContain("2026-05-04");
        expect(html).toContain("2026-05-03");
        expect(html).not.toContain("2026-05-02");
        expect(html).not.toContain("2026-05-01");
    });

    test("Promote disabled when state is 'active'", async () => {
        const html = await render(
            AgentInspectModal({ agent: mkAgent("coder", "active") }),
        );
        // The Promote button is the first action; check disabled attr.
        const promoteIdx = html.indexOf("Promote");
        const sliceBefore = html.slice(0, promoteIdx);
        // The most recent <button ...> tag before "Promote" is the Promote btn.
        const lastBtnTag = sliceBefore.lastIndexOf("<button");
        const tag = html.slice(lastBtnTag, promoteIdx);
        expect(tag).toContain("disabled");
    });

    test("Freeze disabled when state is 'frozen'", async () => {
        const html = await render(
            AgentInspectModal({ agent: mkAgent("coder", "frozen") }),
        );
        const freezeIdx = html.indexOf("Freeze");
        const sliceBefore = html.slice(0, freezeIdx);
        const lastBtnTag = sliceBefore.lastIndexOf("<button");
        const tag = html.slice(lastBtnTag, freezeIdx);
        expect(tag).toContain("disabled");
    });
});

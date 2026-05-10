// SPEC-036-3-05 — run-history fragment unit tests.

import { describe, expect, test } from "bun:test";

import {
    RunHistory,
    outcomeTone,
    prepareRuns,
} from "../../server/templates/fragments/run-history";
import type { RequestRunRef } from "../../server/types/render";

async function render(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

const RUN = (
    id: string,
    ts: string,
    phase = "code",
    outcome: "pass" | "fail" | "block" = "pass",
    cost = 0.5,
): RequestRunRef => ({
    runId: id,
    timestamp: ts,
    phase,
    outcome,
    cost,
});

describe("outcomeTone", () => {
    test("pass → ok, fail → err, block → warn", () => {
        expect(outcomeTone("pass")).toBe("ok");
        expect(outcomeTone("fail")).toBe("err");
        expect(outcomeTone("block")).toBe("warn");
    });
});

describe("prepareRuns — sort + cap", () => {
    test("sorts descending by timestamp", () => {
        const runs = [
            RUN("a", "2026-05-08T10:00:00Z"),
            RUN("b", "2026-05-09T10:00:00Z"),
            RUN("c", "2026-05-07T10:00:00Z"),
        ];
        const out = prepareRuns(runs);
        expect(out.map((r) => r.runId)).toEqual(["b", "a", "c"]);
    });

    test("caps to last 50 entries", () => {
        const runs: RequestRunRef[] = [];
        for (let i = 0; i < 80; i += 1) {
            runs.push(
                RUN(
                    `r${i}`,
                    `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
                ),
            );
        }
        expect(prepareRuns(runs).length).toBe(50);
    });

    test("undefined input yields empty array", () => {
        expect(prepareRuns(undefined)).toEqual([]);
    });
});

describe("RunHistory — populated", () => {
    test("renders one row per run", async () => {
        const runs = [
            RUN("r1", "2026-05-09T10:00:00Z", "code", "pass", 1.23),
            RUN("r2", "2026-05-08T10:00:00Z", "review", "block", 0.42),
        ];
        const html = await render(<RunHistory runs={runs} />);
        expect(html).toContain('<table class="tbl tight">');
        const rowMatches = html.match(/<tr>/g) || [];
        // 1 thead row + 2 data rows = 3
        expect(rowMatches.length).toBe(3);
    });

    test("count text matches prepared length", async () => {
        const runs = [RUN("r1", "2026-05-09T10:00:00Z")];
        const html = await render(<RunHistory runs={runs} />);
        expect(html).toContain("1 runs");
    });

    test("cost rendered with $X.XX precision", async () => {
        const runs = [RUN("r1", "2026-05-09T10:00:00Z", "code", "pass", 1.2)];
        const html = await render(<RunHistory runs={runs} />);
        expect(html).toContain("$1.20");
    });
});

describe("RunHistory — empty", () => {
    test("renders EmptyState row when runs is empty", async () => {
        const html = await render(<RunHistory runs={[]} />);
        expect(html).toContain("No prior runs.");
        expect(html).not.toContain("<table");
    });

    test("renders EmptyState row when runs is undefined", async () => {
        const html = await render(<RunHistory />);
        expect(html).toContain("No prior runs.");
    });
});

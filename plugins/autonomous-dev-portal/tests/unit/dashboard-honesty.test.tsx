// #389 regression — the dashboard renders REAL data or honest empty
// states; the seeded demo builders and hardcoded KPI constants must never
// return. Pins: real ledger-driven cost bars, no fabricated swimlane
// cards, no fake activity feed/"Streaming" claim, no fake agents/fleet
// size, no invented $400 cap / 94.2 pass rate / SLA.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    groupRequestsByPhase,
    read14DayCostBars,
    readMonthlyCapUsd,
} from "../../server/wiring/dashboard-readers";
import { DashboardActivityFeed } from "../../server/templates/fragments/dashboard-activity";
import { DashboardAgentsMini } from "../../server/templates/fragments/dashboard-agents";
import { DashboardCostBars } from "../../server/templates/fragments/dashboard-cost-bars";
import { buildV3KpiTiles, type DashboardV3Extra } from "../../server/templates/views/dashboard";

async function render(node: unknown): Promise<string> {
    return await Promise.resolve(node).then(String);
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dash389-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("read14DayCostBars (#389)", () => {
    test("reads real daily totals from the ledger; missing days are zero; segs null", async () => {
        const today = new Date().toISOString().slice(0, 10);
        const ledger = join(dir, "cost-ledger.json");
        writeFileSync(ledger, JSON.stringify({
            daily: { [today]: { total_usd: 6.1, sessions: [] } },
        }));
        const days = await read14DayCostBars(ledger);
        expect(days).toHaveLength(14);
        expect(days[13]!.total).toBeCloseTo(6.1);
        expect(days[0]!.total).toBe(0);
        expect(days.every((d) => d.segs === null)).toBe(true);
        const grand = days.reduce((s, d) => s + d.total, 0);
        expect(grand).toBeCloseTo(6.1); // never $253 of fiction
    });

    test("missing ledger → 14 honest zero days", async () => {
        const days = await read14DayCostBars(join(dir, "nope.json"));
        expect(days).toHaveLength(14);
        expect(days.every((d) => d.total === 0)).toBe(true);
    });
});

describe("readMonthlyCapUsd (#389)", () => {
    test("no cost-cap.json → null (never an invented $400)", async () => {
        expect(await readMonthlyCapUsd(join(dir, "nope.json"))).toBeNull();
    });
    test("configured cap is returned", async () => {
        const p = join(dir, "cost-cap.json");
        writeFileSync(p, JSON.stringify({ monthly_usd: 250 }));
        expect(await readMonthlyCapUsd(p)).toBe(250);
    });
});

describe("groupRequestsByPhase (#389)", () => {
    test("zero active requests → empty lanes, no fabricated demo cards", () => {
        const lanes = groupRequestsByPhase([]);
        expect(lanes.length).toBeGreaterThan(0);
        expect(lanes.every((l) => l.cards.length === 0)).toBe(true);
        const flat = JSON.stringify(lanes);
        expect(flat).not.toContain("OAuth2 PKCE");
        expect(flat).not.toContain("REQ-000001");
    });
});

describe("empty-state fragments (#389)", () => {
    test("activity feed: empty rows → honest empty state, no Streaming/aria-live", async () => {
        const html = await render(DashboardActivityFeed({ rows: [] }));
        expect(html).toContain("No activity feed yet");
        expect(html).not.toContain("Streaming");
        expect(html).not.toContain("aria-live");
    });

    test("agents mini-grid: empty → honest empty state, no fake fleet size", async () => {
        const html = await render(DashboardAgentsMini({ agents: [] }));
        expect(html).toContain("No agent utilization data yet");
        expect(html).not.toContain("18 total");
    });

    test("cost bars with null segs: honest caption, single-tone bars, no phase claim", async () => {
        const days = Array.from({ length: 14 }, (_, i) => ({
            day: i, segs: null, total: i === 13 ? 5 : 0,
        }));
        const html = await render(DashboardCostBars({ days }));
        expect(html).toContain("per-phase attribution not recorded");
        expect(html).not.toContain("top phase");
        expect(html).toContain("seg-unattributed");
    });
});

describe("KPI tiles honesty (#389)", () => {
    const base: DashboardV3Extra = {
        swimlanes: [], activity: [], costBars: [], agents: [],
        sparks: { inFlight: [], burnRate: [], passRate: [], queue: [] },
        kpi: {
            inFlight: 0, inFlightSub: "p0:0 · p1:0 · p2:0 · p3:0",
            burnRatePerHr: 0, burnRateMtd: 21.05, burnRateCap: null,
            passRatePct: null, passRatePending: 0,
            queueCount: 0, queueOldestMin: 0,
        },
    };

    test("no cap configured → says so; never $400", () => {
        const tiles = buildV3KpiTiles(base);
        const burn = tiles.find((t) => t.label === "Burn rate")!;
        expect(burn.sub).toContain("no cap configured");
        expect(burn.sub).not.toContain("400");
    });

    test("no pass-rate source → em dash, never 94.2", () => {
        const tiles = buildV3KpiTiles(base);
        const pass = tiles.find((t) => t.label === "Gate pass rate")!;
        expect(pass.value).toBe("—");
        expect(pass.sub).toContain("no data source yet");
    });

    test("queue tile never invents an SLA", () => {
        const tiles = buildV3KpiTiles({
            ...base,
            kpi: { ...base.kpi, queueCount: 2, queueOldestMin: 30 },
        });
        const q = tiles.find((t) => t.label === "Approvals queue")!;
        expect(q.sub).toContain("oldest 0h 30m");
        expect(q.sub).not.toContain("SLA");
    });
});

// Page-2 crawl regression (#421-class) — the requests view must render
// the FULL status union; failed/cancelled used to show as green RUNNING
// and count as "Active".
import { RequestsView } from "../../server/templates/views/requests";

describe("requests view lifecycle honesty", () => {
    const row = (id: string, status: string) => ({
        id, repo: "r", title: "t", phase: "code", status,
        cost: 1, turns: 0, score: 0, variant: "",
    });

    test("failed and cancelled render their own chips, never RUNNING", async () => {
        const html = await render(RequestsView({
            items: [row("REQ-1", "failed"), row("REQ-2", "cancelled")] as any,
            aggregates: { activeCount: 0, inGateCount: 0, completedTodayCount: 0, totalCostMtdUsd: 0, repoCount: 1 } as any,
        } as any));
        expect(html).toContain("FAILED");
        expect(html).toContain("CANCELLED");
        expect(html).not.toContain(">RUNNING<");
    });

    test("terminal rows carry the completed filter token", async () => {
        const html = await render(RequestsView({
            items: [row("REQ-1", "failed")] as any,
            aggregates: { activeCount: 0, inGateCount: 0, completedTodayCount: 0, totalCostMtdUsd: 0, repoCount: 1 } as any,
        } as any));
        expect(html).toMatch(/data-gate-type="done"/);
    });
});

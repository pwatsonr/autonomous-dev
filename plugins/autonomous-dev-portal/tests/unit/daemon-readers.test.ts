// Unit tests for `server/wiring/daemon-readers.ts`.
//
// Coverage:
//   - readMtdSpend: missing file, malformed JSON, missing `daily`, current
//     month only, prior-month exclusion, non-numeric tolerance.
//   - readApprovalsCount: missing file, no items, mixed pending/decided.
//   - readKillSwitchEngaged: flag present, flag absent.
//   - Cache behavior: same-tick reads hit the cache; reads >5s later refresh.
//
// State isolation: each test points AUTONOMOUS_DEV_STATE_DIR at a fresh
// tmpdir and resets the module cache via `__resetDaemonReaderCacheForTests`.

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    test,
} from "bun:test";
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    __resetDaemonReaderCacheForTests,
    readApprovalsCount,
    readKillSwitchEngaged,
    readMtdSpend,
} from "../../server/wiring/daemon-readers";

interface Ctx {
    dir: string;
    prevEnv: string | undefined;
}

const ctx: Ctx = { dir: "", prevEnv: undefined };

beforeEach(() => {
    ctx.dir = mkdtempSync(join(tmpdir(), "daemon-readers-"));
    ctx.prevEnv = process.env["AUTONOMOUS_DEV_STATE_DIR"];
    process.env["AUTONOMOUS_DEV_STATE_DIR"] = ctx.dir;
    __resetDaemonReaderCacheForTests();
});

afterEach(() => {
    if (ctx.prevEnv === undefined) {
        delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
    } else {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = ctx.prevEnv;
    }
    if (ctx.dir) rmSync(ctx.dir, { recursive: true, force: true });
    __resetDaemonReaderCacheForTests();
});

function writeLedger(value: unknown): void {
    writeFileSync(
        join(ctx.dir, "cost-ledger.json"),
        JSON.stringify(value),
        "utf8",
    );
}

function writeQueue(value: unknown): void {
    writeFileSync(
        join(ctx.dir, "approvals-queue.json"),
        JSON.stringify(value),
        "utf8",
    );
}

function touchKillSwitch(): void {
    writeFileSync(join(ctx.dir, "kill-switch.flag"), "engaged\n", "utf8");
}

// A fixed clock so we can drive month-boundary logic deterministically.
// 2026-05-15T12:00:00Z — current month key = "2026-05".
const FIXED_NOW = Date.UTC(2026, 4, 15, 12, 0, 0);
const fixedNow = (): number => FIXED_NOW;

describe("readMtdSpend", () => {
    test("missing ledger file → 0", async () => {
        expect(await readMtdSpend(fixedNow)).toBe(0);
    });

    test("malformed JSON → 0 (never throws)", async () => {
        writeFileSync(join(ctx.dir, "cost-ledger.json"), "{not json", "utf8");
        expect(await readMtdSpend(fixedNow)).toBe(0);
    });

    test("ledger with no `daily` key → 0", async () => {
        writeLedger({ other: "field" });
        expect(await readMtdSpend(fixedNow)).toBe(0);
    });

    test("sums only the current UTC month", async () => {
        writeLedger({
            daily: {
                "2026-04-30": { total_usd: 9.99 }, // previous month — excluded
                "2026-05-01": { total_usd: 1.5 },
                "2026-05-14": { total_usd: 2.25 },
                "2026-05-15": { total_usd: 0.5 },
                "2026-06-01": { total_usd: 100 }, // future month — excluded
            },
        });
        expect(await readMtdSpend(fixedNow)).toBeCloseTo(4.25, 5);
    });

    test("tolerates non-numeric / missing total_usd entries", async () => {
        writeLedger({
            daily: {
                "2026-05-01": { total_usd: 1 },
                "2026-05-02": { total_usd: "nope" }, // bad type → ignored
                "2026-05-03": {}, // missing key → ignored
                "2026-05-04": null, // null bucket → ignored
                "2026-05-05": { total_usd: 2 },
            },
        });
        expect(await readMtdSpend(fixedNow)).toBeCloseTo(3, 5);
    });

    test("matches the real daemon-written schema (daily/total_usd/sessions)", async () => {
        // Verbatim shape from `bin/supervisor-loop.sh § update_cost_ledger`.
        writeLedger({
            daily: {
                "2026-05-10": {
                    total_usd: 0.42,
                    sessions: [
                        {
                            request_id: "REQ-1",
                            cost_usd: 0.42,
                            timestamp: "2026-05-10T03:14:15Z",
                        },
                    ],
                },
            },
        });
        expect(await readMtdSpend(fixedNow)).toBeCloseTo(0.42, 5);
    });
});

describe("readApprovalsCount", () => {
    test("missing queue file → 0", async () => {
        expect(await readApprovalsCount(fixedNow)).toBe(0);
    });

    test("empty items array → 0", async () => {
        writeQueue({ items: [] });
        expect(await readApprovalsCount(fixedNow)).toBe(0);
    });

    test("counts only pending items (default state = pending)", async () => {
        writeQueue({
            items: [
                { id: "A", state: "pending" },
                { id: "B" }, // no state → default pending
                { id: "C", state: "approved" },
                { id: "D", state: "rejected" },
                { id: "E", state: "pending" },
            ],
        });
        expect(await readApprovalsCount(fixedNow)).toBe(3);
    });

    test("malformed JSON → 0 (never throws)", async () => {
        writeFileSync(
            join(ctx.dir, "approvals-queue.json"),
            "garbage",
            "utf8",
        );
        expect(await readApprovalsCount(fixedNow)).toBe(0);
    });
});

describe("readKillSwitchEngaged", () => {
    test("flag absent → false", async () => {
        expect(await readKillSwitchEngaged(fixedNow)).toBe(false);
    });

    test("flag present → true (contents ignored)", async () => {
        touchKillSwitch();
        expect(await readKillSwitchEngaged(fixedNow)).toBe(true);
    });
});

describe("5s in-memory cache", () => {
    test("readMtdSpend returns the same value within TTL even if file changes", async () => {
        writeLedger({ daily: { "2026-05-01": { total_usd: 1 } } });
        const first = await readMtdSpend(fixedNow);
        expect(first).toBeCloseTo(1, 5);
        // Mutate the underlying file…
        writeLedger({ daily: { "2026-05-01": { total_usd: 999 } } });
        // …but stay within the 5s TTL window: cached value wins.
        const second = await readMtdSpend(() => FIXED_NOW + 1_000);
        expect(second).toBeCloseTo(1, 5);
    });

    test("readMtdSpend refreshes once the 5s TTL elapses", async () => {
        writeLedger({ daily: { "2026-05-01": { total_usd: 1 } } });
        await readMtdSpend(fixedNow);
        writeLedger({ daily: { "2026-05-01": { total_usd: 7 } } });
        // 6s later → cache expired → reads fresh value.
        const refreshed = await readMtdSpend(() => FIXED_NOW + 6_000);
        expect(refreshed).toBeCloseTo(7, 5);
    });

    test("readApprovalsCount caches within TTL", async () => {
        writeQueue({ items: [{ state: "pending" }] });
        expect(await readApprovalsCount(fixedNow)).toBe(1);
        writeQueue({ items: [{ state: "pending" }, { state: "pending" }] });
        expect(await readApprovalsCount(() => FIXED_NOW + 2_000)).toBe(1);
        expect(await readApprovalsCount(() => FIXED_NOW + 6_000)).toBe(2);
    });

    test("readKillSwitchEngaged caches within TTL", async () => {
        expect(await readKillSwitchEngaged(fixedNow)).toBe(false);
        touchKillSwitch();
        expect(await readKillSwitchEngaged(() => FIXED_NOW + 2_000)).toBe(false);
        expect(await readKillSwitchEngaged(() => FIXED_NOW + 6_000)).toBe(true);
    });
});

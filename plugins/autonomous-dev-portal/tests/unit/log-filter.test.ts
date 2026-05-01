// SPEC-015-3-04 — LogFilter unit suite.
//
// Validates AND-combination semantics, URL serialization round-trips,
// invalid-value silent drops, and 10K-entry performance budget.

import { describe, expect, test } from "bun:test";

import { LogFilter } from "../../server/logs/filter";
import type { LogEntry, LogFilterCriteria } from "../../server/logs/types";

const filter = new LogFilter();

function makeEntry(over: Partial<LogEntry> = {}): LogEntry {
    return {
        timestamp: "2026-04-15T12:00:00Z",
        level: "INFO",
        pid: 1,
        message: "hello",
        ...over,
    };
}

describe("LogFilter.fromQuery / toQuery", () => {
    test("populates a full criteria object from valid params", () => {
        const c = LogFilter.fromQuery({
            level: "INFO",
            request_id: "REQ-000123",
            time_range: "1h",
        });
        expect(c).toEqual({
            level: "INFO",
            request_id: "REQ-000123",
            time_range: "1h",
        });
    });

    test("invalid level dropped silently", () => {
        const c = LogFilter.fromQuery({ level: "BOGUS" });
        expect(c.level).toBeUndefined();
    });

    test("invalid request_id dropped silently", () => {
        const c = LogFilter.fromQuery({ request_id: "abc" });
        expect(c.request_id).toBeUndefined();
    });

    test("URL round-trip preserves every supported field", () => {
        const original: LogFilterCriteria = {
            level: "ERROR",
            request_id: "REQ-000999",
            time_range: "4h",
            start_time: "2026-04-15T00:00:00Z",
            end_time: "2026-04-15T23:59:59Z",
        };
        const q = LogFilter.toQuery(original);
        const back = LogFilter.fromQuery(q);
        expect(back).toEqual(original);
    });
});

describe("LogFilter.apply", () => {
    test("no criteria → all entries returned", () => {
        const entries = [makeEntry(), makeEntry({ level: "ERROR" })];
        expect(filter.apply(entries, {}).length).toBe(2);
    });

    test("level=ERROR filters non-error", () => {
        const entries = [
            makeEntry({ level: "INFO" }),
            makeEntry({ level: "ERROR" }),
            makeEntry({ level: "WARN" }),
        ];
        const out = filter.apply(entries, { level: "ERROR" });
        expect(out.length).toBe(1);
        expect(out[0]!.level).toBe("ERROR");
    });

    test("request_id exact match", () => {
        const entries = [
            makeEntry({ request_id: "REQ-000001" }),
            makeEntry({ request_id: "REQ-000002" }),
        ];
        const out = filter.apply(entries, { request_id: "REQ-000001" });
        expect(out.length).toBe(1);
    });

    test("time_range=1h excludes entries older than cutoff", () => {
        const now = new Date("2026-04-15T12:00:00Z");
        const entries = [
            makeEntry({ timestamp: "2026-04-15T11:30:00Z" }), // 30 min ago
            makeEntry({ timestamp: "2026-04-15T10:30:00Z" }), // 1.5h ago
        ];
        const out = filter.apply(entries, { time_range: "1h" }, () => now);
        expect(out.length).toBe(1);
        expect(out[0]!.timestamp).toBe("2026-04-15T11:30:00Z");
    });

    test("AND combination: level + request_id both must match", () => {
        const entries = [
            makeEntry({ level: "ERROR", request_id: "REQ-000001" }),
            makeEntry({ level: "ERROR", request_id: "REQ-000002" }),
            makeEntry({ level: "INFO", request_id: "REQ-000001" }),
        ];
        const out = filter.apply(entries, {
            level: "ERROR",
            request_id: "REQ-000001",
        });
        expect(out.length).toBe(1);
    });

    test("start_time + end_time overrides time_range", () => {
        const now = new Date("2026-04-15T12:00:00Z");
        const entries = [
            makeEntry({ timestamp: "2026-04-15T05:00:00Z" }),
            makeEntry({ timestamp: "2026-04-15T11:30:00Z" }),
        ];
        const out = filter.apply(
            entries,
            {
                time_range: "1h",
                start_time: "2026-04-15T04:00:00Z",
                end_time: "2026-04-15T06:00:00Z",
            },
            () => now,
        );
        // start/end window catches the 05:00 entry; 1h-only would not.
        expect(out.length).toBe(1);
        expect(out[0]!.timestamp).toBe("2026-04-15T05:00:00Z");
    });

    test("10K entries with all 3 filters in <500ms", () => {
        const now = new Date("2026-04-15T12:00:00Z");
        const entries: LogEntry[] = [];
        for (let i = 0; i < 10_000; i += 1) {
            const m = i % 60;
            entries.push(
                makeEntry({
                    timestamp: `2026-04-15T11:${String(m).padStart(2, "0")}:00Z`,
                    level: i % 4 === 0 ? "ERROR" : "INFO",
                    request_id:
                        i % 100 === 0
                            ? "REQ-000999"
                            : `REQ-${String(100000 + i).padStart(6, "0")}`,
                }),
            );
        }
        const start = performance.now();
        const out = filter.apply(
            entries,
            {
                level: "ERROR",
                request_id: "REQ-000999",
                time_range: "1h",
            },
            () => now,
        );
        const elapsed = performance.now() - start;
        expect(elapsed).toBeLessThan(500);
        expect(out.length).toBeGreaterThan(0);
    });
});

describe("LogFilter.matches", () => {
    test("returns false on level mismatch", () => {
        expect(
            filter.matches(makeEntry({ level: "INFO" }), { level: "ERROR" }),
        ).toBe(false);
    });

    test("returns true when no criteria set", () => {
        expect(filter.matches(makeEntry(), {})).toBe(true);
    });
});

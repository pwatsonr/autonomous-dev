// SPEC-015-1-05 — LogReader: reverse-read correctness, plain-text
// fallback, redaction applied to every line that leaves the process.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AggregationCache } from "../../server/cache/AggregationCache";
import { LogReader } from "../../server/readers/LogReader";
import {
    redactString,
    resetRedactionCounts,
    getRedactionCounts,
} from "../../server/readers/redaction";

interface Ctx {
    dir: string;
    cache: AggregationCache | null;
}

const ctx: Ctx = { dir: "", cache: null };

function setupRepo(): { dir: string; logPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "log-reader-"));
    mkdirSync(join(dir, ".autonomous-dev"), { recursive: true });
    return { dir, logPath: join(dir, ".autonomous-dev", "daemon.log") };
}

beforeEach(() => {
    ctx.dir = "";
    ctx.cache = null;
    resetRedactionCounts();
});

afterEach(() => {
    if (ctx.cache) {
        ctx.cache.shutdown();
        ctx.cache = null;
    }
    if (ctx.dir) rmSync(ctx.dir, { recursive: true, force: true });
});

describe("LogReader.readRecent", () => {
    test("missing daemon.log returns ok=true with empty array", async () => {
        const { dir } = setupRepo();
        ctx.dir = dir;
        ctx.cache = new AggregationCache({ defaultTTLMs: 5000 });
        const reader = new LogReader({ basePath: dir, cache: ctx.cache });
        const r = await reader.readRecent();
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toEqual([]);
    });

    test("structured JSONL lines parse to LogLine entries", async () => {
        const { dir, logPath } = setupRepo();
        ctx.dir = dir;
        ctx.cache = new AggregationCache({ defaultTTLMs: 5000 });
        const lines = [
            { ts: "2026-04-01T00:00:00Z", level: "info", message: "boot", source: "daemon" },
            { ts: "2026-04-02T00:00:00Z", level: "warn", message: "warn line", source: "daemon" },
            { ts: "2026-04-03T00:00:00Z", level: "error", message: "boom", source: "daemon" },
        ];
        writeFileSync(
            logPath,
            lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
        );
        const reader = new LogReader({ basePath: dir, cache: ctx.cache });
        const r = await reader.readRecent();
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.length).toBe(3);
            // Chronological order: oldest first.
            expect(r.value[0]!.message).toBe("boot");
            expect(r.value[2]!.level).toBe("error");
        }
    });

    test("plain-text legacy lines fall back to source='unknown' with raw populated", async () => {
        const { dir, logPath } = setupRepo();
        ctx.dir = dir;
        ctx.cache = new AggregationCache({ defaultTTLMs: 5000 });
        writeFileSync(logPath, "legacy plain text line\nanother one\n");
        const reader = new LogReader({ basePath: dir, cache: ctx.cache });
        const r = await reader.readRecent();
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.length).toBe(2);
            expect(r.value[0]!.source).toBe("unknown");
            expect(r.value[0]!.raw).toBe("legacy plain text line");
        }
    });

    test("limit caps the returned line count", async () => {
        const { dir, logPath } = setupRepo();
        ctx.dir = dir;
        ctx.cache = new AggregationCache({ defaultTTLMs: 5000 });
        const lines: string[] = [];
        for (let i = 0; i < 50; i += 1) {
            lines.push(
                JSON.stringify({
                    ts: `2026-04-01T00:00:${String(i).padStart(2, "0")}Z`,
                    level: "info",
                    message: `m${String(i)}`,
                    source: "daemon",
                }),
            );
        }
        writeFileSync(logPath, lines.join("\n") + "\n");
        const reader = new LogReader({ basePath: dir, cache: ctx.cache });
        const r = await reader.readRecent({ limit: 5 });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.length).toBe(5);
            // Last 5 lines, chronological order: m45..m49
            expect(r.value[0]!.message).toBe("m45");
            expect(r.value[4]!.message).toBe("m49");
        }
    });

    test("redaction is applied: API key in a log message is masked before return", async () => {
        const { dir, logPath } = setupRepo();
        ctx.dir = dir;
        ctx.cache = new AggregationCache({ defaultTTLMs: 5000 });
        const apiKey = "sk-" + "A".repeat(48); // 51 chars total — well above the 20-char minimum
        const line = JSON.stringify({
            ts: "2026-04-01T00:00:00Z",
            level: "info",
            message: `using token ${apiKey} for auth`,
            source: "daemon",
        });
        writeFileSync(logPath, line + "\n");
        const reader = new LogReader({ basePath: dir, cache: ctx.cache });
        const r = await reader.readRecent();
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value[0]!.message).not.toContain(apiKey);
            expect(r.value[0]!.message).toContain("sk-[REDACTED]");
        }
    });

    test("redactString fires the rule counter and is idempotent", () => {
        resetRedactionCounts();
        const longToken = "sk-" + "B".repeat(60);
        const input = `header ${longToken} trailer`;
        const out1 = redactString(input);
        const out2 = redactString(out1);
        expect(out1).toBe(out2);
        const counts = getRedactionCounts();
        expect(counts["api_key_sk"] ?? 0).toBeGreaterThanOrEqual(1);
    });

    test("level filter excludes non-matching entries", async () => {
        const { dir, logPath } = setupRepo();
        ctx.dir = dir;
        ctx.cache = new AggregationCache({ defaultTTLMs: 5000 });
        const lines = [
            { ts: "2026-04-01T00:00:00Z", level: "info", message: "info", source: "daemon" },
            { ts: "2026-04-01T00:00:01Z", level: "warn", message: "warn", source: "daemon" },
            { ts: "2026-04-01T00:00:02Z", level: "error", message: "err", source: "daemon" },
        ];
        writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
        const reader = new LogReader({ basePath: dir, cache: ctx.cache });
        const r = await reader.readRecent({ level: ["error"] });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.length).toBe(1);
            expect(r.value[0]!.level).toBe("error");
        }
    });

    test("reverse-read across multiple chunk boundaries returns the last N lines", async () => {
        const { dir, logPath } = setupRepo();
        ctx.dir = dir;
        ctx.cache = new AggregationCache({ defaultTTLMs: 5000 });
        // Write enough data to span ≥ 2 internal 64KB chunks.
        // Each line is ~ 200 bytes; 1000 lines ≈ 200KB.
        for (let i = 0; i < 1000; i += 1) {
            const line = JSON.stringify({
                ts: `2026-04-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
                level: "info",
                message: `chunk-test-line-${String(i).padStart(4, "0")}-` + "x".repeat(100),
                source: "daemon",
            });
            appendFileSync(logPath, line + "\n");
        }
        const reader = new LogReader({ basePath: dir, cache: ctx.cache });
        const r = await reader.readRecent({ limit: 10 });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.length).toBe(10);
            // Last line should be index 999.
            expect(r.value[9]!.message).toContain("0999");
            expect(r.value[0]!.message).toContain("0990");
        }
    });
});

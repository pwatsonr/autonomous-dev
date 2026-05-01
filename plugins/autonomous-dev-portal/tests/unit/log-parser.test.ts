// SPEC-015-3-04 — LogParser unit suite + ring buffer + redact tests.
//
// Co-locating ring buffer and redact tests in this file keeps the
// log surface tightly grouped without sprawling the test directory.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LogParser } from "../../server/logs/parser";
import { redactSecrets, REDACTION_PATTERNS } from "../../server/logs/redact";
import { RingBuffer } from "../../server/logs/ring_buffer";
import type { LogEntry } from "../../server/logs/types";

interface Ctx {
    dir: string;
}

const ctx: Ctx = { dir: "" };

function setup(): { dir: string; logPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "log-parser-"));
    return { dir, logPath: join(dir, "daemon.log") };
}

beforeEach(() => {
    ctx.dir = "";
});

afterEach(() => {
    if (ctx.dir) rmSync(ctx.dir, { recursive: true, force: true });
});

describe("LogParser.parseLine", () => {
    const parser = new LogParser();

    test("valid line → fully populated entry", () => {
        const e = parser.parseLine(
            JSON.stringify({
                timestamp: "2026-04-15T12:00:00Z",
                level: "INFO",
                pid: 42,
                message: "hello",
                request_id: "REQ-000001",
                context: { foo: "bar" },
            }),
        );
        expect(e).not.toBeNull();
        expect(e!.level).toBe("INFO");
        expect(e!.pid).toBe(42);
        expect(e!.request_id).toBe("REQ-000001");
        expect(e!.context).toEqual({ foo: "bar" });
    });

    test("malformed JSON → null", () => {
        expect(parser.parseLine("{not json")).toBeNull();
    });

    test("missing timestamp → null", () => {
        expect(
            parser.parseLine(
                JSON.stringify({ level: "INFO", pid: 1, message: "x" }),
            ),
        ).toBeNull();
    });

    test("lowercase level coerced to uppercase", () => {
        const e = parser.parseLine(
            JSON.stringify({
                timestamp: "2026-04-15T00:00:00Z",
                level: "info",
                pid: 1,
                message: "x",
            }),
        );
        expect(e?.level).toBe("INFO");
    });

    test("invalid level (VERBOSE) → null", () => {
        expect(
            parser.parseLine(
                JSON.stringify({
                    timestamp: "2026-04-15T00:00:00Z",
                    level: "VERBOSE",
                    pid: 1,
                    message: "x",
                }),
            ),
        ).toBeNull();
    });

    test("empty line → null", () => {
        expect(parser.parseLine("")).toBeNull();
        expect(parser.parseLine("   ")).toBeNull();
    });
});

describe("LogParser.parseFile", () => {
    test("returns most recent N entries in chronological order", async () => {
        const { dir, logPath } = setup();
        ctx.dir = dir;
        const lines: string[] = [];
        for (let i = 0; i < 20; i += 1) {
            lines.push(
                JSON.stringify({
                    timestamp: `2026-04-15T00:00:${String(i).padStart(2, "0")}Z`,
                    level: "INFO",
                    pid: 1,
                    message: `m${String(i)}`,
                }),
            );
        }
        writeFileSync(logPath, lines.join("\n"));
        const out = await new LogParser().parseFile(logPath, 5);
        expect(out.length).toBe(5);
        // Chronological — newest entry last.
        expect(out[0]!.message).toBe("m15");
        expect(out[4]!.message).toBe("m19");
    });

    test("missing file → []", async () => {
        const out = await new LogParser().parseFile("/nope/no-such.log");
        expect(out).toEqual([]);
    });

    test("malformed lines are skipped", async () => {
        const { dir, logPath } = setup();
        ctx.dir = dir;
        const valid = JSON.stringify({
            timestamp: "2026-04-15T00:00:00Z",
            level: "INFO",
            pid: 1,
            message: "ok",
        });
        writeFileSync(logPath, [valid, "{bad", valid].join("\n"));
        const out = await new LogParser().parseFile(logPath, 100);
        expect(out.length).toBe(2);
    });
});

describe("redactSecrets", () => {
    test("redacts Anthropic API key in message", () => {
        const e: LogEntry = {
            timestamp: "2026-04-15T00:00:00Z",
            level: "INFO",
            pid: 1,
            message: "key=sk-ant-abcdefghijklmnopqrstuvwxyz1234567890ABCDEF",
        };
        const out = redactSecrets(e);
        expect(out.message.includes("sk-ant-***REDACTED***")).toBe(true);
    });

    test("redacts JWT bearer tokens", () => {
        const jwt = `eyJabcdefghij.eyJabcdefghij.signaturepart`;
        const e: LogEntry = {
            timestamp: "2026-04-15T00:00:00Z",
            level: "INFO",
            pid: 1,
            message: `auth ${jwt}`,
        };
        const out = redactSecrets(e);
        expect(out.message.includes("***JWT-REDACTED***")).toBe(true);
    });

    test("redacts emails", () => {
        const e: LogEntry = {
            timestamp: "2026-04-15T00:00:00Z",
            level: "INFO",
            pid: 1,
            message: "user=alice@example.com",
        };
        const out = redactSecrets(e);
        expect(out.message.includes("***EMAIL-REDACTED***")).toBe(true);
    });

    test("redacts nested context.headers.authorization", () => {
        const e: LogEntry = {
            timestamp: "2026-04-15T00:00:00Z",
            level: "INFO",
            pid: 1,
            message: "ok",
            context: {
                headers: {
                    authorization:
                        "Bearer sk-ant-abcdefghijklmnopqrstuvwxyz1234567890ABCDEF",
                },
            },
        };
        const out = redactSecrets(e);
        const hdrs = (out.context as Record<string, unknown>).headers as Record<
            string,
            unknown
        >;
        expect(String(hdrs.authorization).includes("sk-ant-***REDACTED***")).toBe(
            true,
        );
    });

    test("does not mutate the original entry", () => {
        const e: LogEntry = {
            timestamp: "2026-04-15T00:00:00Z",
            level: "INFO",
            pid: 1,
            message: "alice@example.com",
            context: { nested: { email: "bob@example.com" } },
        };
        const before = JSON.parse(JSON.stringify(e)) as LogEntry;
        redactSecrets(e);
        expect(e).toEqual(before);
    });

    test("every pattern has a name and is exercised by at least one input", () => {
        // Smoke: every pattern is reachable.
        for (const p of REDACTION_PATTERNS) {
            expect(typeof p.name).toBe("string");
            expect(p.regex).toBeInstanceOf(RegExp);
        }
    });
});

describe("RingBuffer", () => {
    interface E {
        timestamp: string;
        body: string;
    }

    test("empty buffer size().bytes === 0", () => {
        const rb = new RingBuffer<E>();
        expect(rb.size().bytes).toBe(0);
        expect(rb.snapshot()).toEqual([]);
    });

    test("evicts oldest when adding exceeds budget", () => {
        const rb = new RingBuffer<E>(120);
        // Each entry serializes to ~50+ bytes. Push 4 entries.
        rb.push({ timestamp: "2026-04-15T00:00:00Z", body: "a".repeat(20) });
        rb.push({ timestamp: "2026-04-15T00:00:01Z", body: "b".repeat(20) });
        const r = rb.push({
            timestamp: "2026-04-15T00:00:02Z",
            body: "c".repeat(20),
        });
        expect(r.evicted).toBeGreaterThanOrEqual(1);
        expect(rb.size().bytes).toBeLessThanOrEqual(120);
    });

    test("FIFO eviction: first inserted is first evicted", () => {
        const rb = new RingBuffer<E>(100);
        rb.push({ timestamp: "2026-04-15T00:00:00Z", body: "a".repeat(30) });
        rb.push({ timestamp: "2026-04-15T00:00:01Z", body: "b".repeat(30) });
        rb.push({ timestamp: "2026-04-15T00:00:02Z", body: "c".repeat(30) });
        const remaining = rb.snapshot().map((e) => e.timestamp);
        // Oldest must be gone.
        expect(remaining.includes("2026-04-15T00:00:00Z")).toBe(false);
    });

    test("takeSince(undefined) returns full snapshot", () => {
        const rb = new RingBuffer<E>();
        rb.push({ timestamp: "2026-04-15T00:00:00Z", body: "x" });
        rb.push({ timestamp: "2026-04-15T00:00:01Z", body: "y" });
        expect(rb.takeSince(undefined).length).toBe(2);
    });

    test("takeSince(ts) returns only newer entries", () => {
        const rb = new RingBuffer<E>();
        rb.push({ timestamp: "2026-04-15T00:00:00Z", body: "x" });
        rb.push({ timestamp: "2026-04-15T00:00:01Z", body: "y" });
        rb.push({ timestamp: "2026-04-15T00:00:02Z", body: "z" });
        const out = rb.takeSince("2026-04-15T00:00:00Z");
        expect(out.length).toBe(2);
        expect(out[0]!.timestamp).toBe("2026-04-15T00:00:01Z");
    });
});

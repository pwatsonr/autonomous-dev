// REQ-000011 — Enhanced LogReader unit tests

import { test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { EnhancedLogReader } from "../../server/readers/EnhancedLogReader";
import { AggregationCache } from "../../server/cache/AggregationCache";

// Enhanced LogReader Tests
let tempDir: string;
let logReader: EnhancedLogReader;
let cache: AggregationCache;

beforeEach(async () => {
        // Create temporary directory
        tempDir = join(tmpdir(), `enhanced-log-reader-test-${Date.now()}`);
        await mkdir(tempDir, { recursive: true });
        await mkdir(join(tempDir, ".autonomous-dev", "logs"), { recursive: true });

        // Create cache and log reader
        cache = new AggregationCache({ defaultTTLMs: 1000 });
        logReader = new EnhancedLogReader({
            basePath: tempDir,
            cache,
        });
    });

afterEach(async () => {
    // Clean up
    cache.shutdown();
    await rm(tempDir, { recursive: true, force: true });
});

test("should read structured log lines", async () => {
        // Create test log file
        const logPath = join(tempDir, ".autonomous-dev", "logs", "daemon.log");
        const logLines = [
            '{"ts":"2025-05-01T10:00:00.000Z","level":"info","message":"test message 1","source":"daemon","request_id":"REQ-000001"}',
            '{"ts":"2025-05-01T10:00:01.000Z","level":"warn","message":"test message 2","source":"daemon","context":{"pid":1234}}',
            '{"ts":"2025-05-01T10:00:02.000Z","level":"error","message":"test message 3","source":"daemon"}',
        ];
        await writeFile(logPath, logLines.join('\n'));

        const result = await logReader.readLogs({
            sources: ["daemon"],
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.entries).toHaveLength(3);
            expect(result.value.entries[0].message).toBe("test message 3"); // Newest first
            expect(result.value.entries[1].message).toBe("test message 2");
            expect(result.value.entries[2].message).toBe("test message 1");
        }
    });

    test("should filter by log level", async () => {
        const logPath = join(tempDir, ".autonomous-dev", "logs", "daemon.log");
        const logLines = [
            '{"ts":"2025-05-01T10:00:00.000Z","level":"info","message":"info message","source":"daemon"}',
            '{"ts":"2025-05-01T10:00:01.000Z","level":"warn","message":"warn message","source":"daemon"}',
            '{"ts":"2025-05-01T10:00:02.000Z","level":"error","message":"error message","source":"daemon"}',
        ];
        await writeFile(logPath, logLines.join('\n'));

        const result = await logReader.readLogs({
            levels: ["error", "warn"],
            sources: ["daemon"],
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.entries).toHaveLength(2);
            expect(result.value.entries[0].level).toBe("error");
            expect(result.value.entries[1].level).toBe("warn");
        }
    });

    test("should perform full-text search", async () => {
        const logPath = join(tempDir, ".autonomous-dev", "logs", "daemon.log");
        const logLines = [
            '{"ts":"2025-05-01T10:00:00.000Z","level":"info","message":"user login successful","source":"daemon"}',
            '{"ts":"2025-05-01T10:00:01.000Z","level":"info","message":"user logout","source":"daemon"}',
            '{"ts":"2025-05-01T10:00:02.000Z","level":"info","message":"system startup","source":"daemon"}',
        ];
        await writeFile(logPath, logLines.join('\n'));

        const result = await logReader.readLogs({
            sources: ["daemon"],
            search: {
                query: "user",
                includeContext: true,
                caseSensitive: false,
            },
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.entries).toHaveLength(2);
            expect(result.value.entries[0].message).toContain("user");
            expect(result.value.entries[1].message).toContain("user");
        }
    });

    test("should apply search highlighting", async () => {
        const logPath = join(tempDir, ".autonomous-dev", "logs", "daemon.log");
        const logLines = [
            '{"ts":"2025-05-01T10:00:00.000Z","level":"info","message":"User login successful","source":"daemon"}',
        ];
        await writeFile(logPath, logLines.join('\n'));

        const result = await logReader.readLogs({
            sources: ["daemon"],
            search: {
                query: "User",
                includeContext: true,
                caseSensitive: false,
            },
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.entries).toHaveLength(1);
            const entry = result.value.entries[0];
            expect(entry.messageHighlights).toHaveLength(1);
            expect(entry.messageHighlights![0].start).toBe(0);
            expect(entry.messageHighlights![0].end).toBe(4);
            expect(entry.messageHighlights![0].text).toBe("User");
        }
    });

    test("should filter by time range", async () => {
        const logPath = join(tempDir, ".autonomous-dev", "logs", "daemon.log");
        const baseTime = new Date("2025-05-01T10:00:00.000Z");
        const logLines = [
            `{"ts":"${new Date(baseTime.getTime() - 3700000).toISOString()}","level":"info","message":"old message","source":"daemon"}`, // 1 hour 1 minute ago (excluded)
            `{"ts":"${new Date(baseTime.getTime() - 1800000).toISOString()}","level":"info","message":"recent message","source":"daemon"}`, // 30 minutes ago
            `{"ts":"${baseTime.toISOString()}","level":"info","message":"current message","source":"daemon"}`, // now
        ];
        await writeFile(logPath, logLines.join('\n'));

        // Mock the current time to be the base time
        const mockReader = new EnhancedLogReader({
            basePath: tempDir,
            cache,
            now: () => baseTime.getTime(),
        });

        const result = await mockReader.readLogs({
            sources: ["daemon"],
            timeRange: {
                relative: "1h",
            },
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.entries).toHaveLength(2); // Should exclude the 1-hour-old message
            expect(result.value.entries[0].message).toBe("current message");
            expect(result.value.entries[1].message).toBe("recent message");
        }
    });

    test("should handle context filters", async () => {
        const logPath = join(tempDir, ".autonomous-dev", "logs", "daemon.log");
        const logLines = [
            '{"ts":"2025-05-01T10:00:00.000Z","level":"info","message":"message 1","source":"daemon","context":{"pid":1234}}',
            '{"ts":"2025-05-01T10:00:01.000Z","level":"info","message":"message 2","source":"daemon","context":{"pid":5678}}',
            '{"ts":"2025-05-01T10:00:02.000Z","level":"info","message":"message 3","source":"daemon","context":{"pid":1234}}',
        ];
        await writeFile(logPath, logLines.join('\n'));

        const result = await logReader.readLogs({
            sources: ["daemon"],
            contextFilters: [
                {
                    path: "context.pid",
                    value: 1234,
                    operator: "equals",
                },
            ],
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.entries).toHaveLength(2);
            expect(result.value.entries[0].message).toBe("message 3");
            expect(result.value.entries[1].message).toBe("message 1");
        }
    });

    test("should handle pagination", async () => {
        const logPath = join(tempDir, ".autonomous-dev", "logs", "daemon.log");
        const logLines = [];
        for (let i = 0; i < 10; i++) {
            logLines.push(`{"ts":"2025-05-01T10:00:${i.toString().padStart(2, '0')}.000Z","level":"info","message":"message ${i}","source":"daemon"}`);
        }
        await writeFile(logPath, logLines.join('\n'));

        const result = await logReader.readLogs({
            sources: ["daemon"],
            pagination: {
                limit: 5,
            },
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.entries).toHaveLength(5);
            expect(result.value.hasMore).toBe(true);
            expect(result.value.nextCursor).toBeDefined();
        }
    });

    test("should handle missing log files gracefully", async () => {
        const result = await logReader.readLogs({
            sources: ["daemon"],
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.entries).toHaveLength(0);
            expect(result.value.hasMore).toBe(false);
        }
    });

    test("should generate stable log IDs", async () => {
        const logPath = join(tempDir, ".autonomous-dev", "logs", "daemon.log");
        const logLines = [
            '{"ts":"2025-05-01T10:00:00.000Z","level":"info","message":"same message","source":"daemon"}',
            '{"ts":"2025-05-01T10:00:01.000Z","level":"info","message":"same message","source":"daemon"}',
        ];
        await writeFile(logPath, logLines.join('\n'));

        const result = await logReader.readLogs({
            sources: ["daemon"],
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.entries).toHaveLength(2);
            // Different timestamps should generate different log IDs even with same message
            expect(result.value.entries[0].logId).not.toBe(result.value.entries[1].logId);
            expect(result.value.entries[0].logId).toMatch(/^log-\d+$/);
            expect(result.value.entries[1].logId).toMatch(/^log-\d+$/);
        }
    });
// BUG-14 regression test: /logs page reads live daemon log
//
// Write a synthetic ~/.autonomous-dev/logs/daemon.log with 3 known-content lines
// GET /logs
// Assert the response contains those 3 timestamps and messages
// Assert it does NOT contain the 2025-04-30 stub timestamp

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../../server/server";
import type { Server } from "bun";

interface TestContext {
    server: Server | null;
    tempDir: string;
    originalStateDir: string | undefined;
    originalPortalPort: string | undefined;
    testPort: number;
}

const ctx: TestContext = {
    server: null,
    tempDir: "",
    originalStateDir: undefined,
    originalPortalPort: undefined,
    testPort: 30200, // Use a test-specific port
};

beforeEach(() => {
    // Set up temp directory for test state
    ctx.tempDir = mkdtempSync(join(tmpdir(), "logs-test-"));

    // The LogReader expects <basePath>/.autonomous-dev/daemon.log
    // So we need tempDir to be the basePath, and create .autonomous-dev inside it
    mkdirSync(join(ctx.tempDir, ".autonomous-dev"), { recursive: true });

    // Set the state dir to tempDir/.autonomous-dev so stateDirRoot() returns that
    ctx.originalStateDir = process.env["AUTONOMOUS_DEV_STATE_DIR"];
    process.env["AUTONOMOUS_DEV_STATE_DIR"] = join(ctx.tempDir, ".autonomous-dev");

    // Set up test port to avoid conflicts
    ctx.originalPortalPort = process.env["PORTAL_PORT"];
    process.env["PORTAL_PORT"] = ctx.testPort.toString();
});

afterEach(async () => {
    if (ctx.server) {
        ctx.server.stop(true);
        ctx.server = null;
    }

    // Restore original state dir
    if (ctx.originalStateDir !== undefined) {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = ctx.originalStateDir;
    } else {
        delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
    }

    // Restore original port
    if (ctx.originalPortalPort !== undefined) {
        process.env["PORTAL_PORT"] = ctx.originalPortalPort;
    } else {
        delete process.env["PORTAL_PORT"];
    }

    // Clean up temp directory
    if (ctx.tempDir) {
        rmSync(ctx.tempDir, { recursive: true, force: true });
        ctx.tempDir = "";
    }
});

describe("BUG-14 logs live reader", () => {
    test("logs page reads live daemon log and excludes stub timestamps", async () => {
        // Write synthetic daemon.log with 3 known lines
        const daemonLogPath = join(ctx.tempDir, ".autonomous-dev", "daemon.log");
        const testTimestamp1 = "2026-05-17T10:00:00Z";
        const testTimestamp2 = "2026-05-17T10:01:00Z";
        const testTimestamp3 = "2026-05-17T10:02:00Z";

        const logLines = [
            JSON.stringify({
                ts: testTimestamp1,
                level: "info",
                message: "Test daemon started",
                source: "daemon",
            }),
            JSON.stringify({
                ts: testTimestamp2,
                level: "warn",
                message: "Test warning message",
                source: "daemon",
            }),
            JSON.stringify({
                ts: testTimestamp3,
                level: "error",
                message: "Test error occurred",
                source: "daemon",
            }),
        ];

        writeFileSync(daemonLogPath, logLines.join("\n") + "\n");

        // Start the server
        ctx.server = await startServer();

        // Wait for server to be ready
        await new Promise(resolve => setTimeout(resolve, 100));

        // Make request to /logs
        const response = await fetch(`http://localhost:${ctx.testPort}/logs`);
        expect(response.status).toBe(200);

        const html = await response.text();

        // Assert the response contains the 3 test timestamps and messages
        expect(html).toContain(testTimestamp1);
        expect(html).toContain(testTimestamp2);
        expect(html).toContain(testTimestamp3);
        expect(html).toContain("Test daemon started");
        expect(html).toContain("Test warning message");
        expect(html).toContain("Test error occurred");

        // Assert it does NOT contain the 2025-04-30 stub timestamp
        expect(html).not.toContain("2025-04-30");
        expect(html).not.toContain("request started: REQ-000001");
        expect(html).not.toContain("phase intake complete");
    });

    test("logs page falls back to current-time stub when no log files exist", async () => {
        // Don't write any log files

        // Start the server
        ctx.server = await startServer();

        // Wait for server to be ready
        await new Promise(resolve => setTimeout(resolve, 100));

        // Make request to /logs
        const response = await fetch(`http://localhost:${ctx.testPort}/logs`);
        expect(response.status).toBe(200);

        const html = await response.text();

        // Should contain fallback messages but NOT the old stub timestamps
        expect(html).not.toContain("2025-04-30");
        expect(html).toContain("Portal started - no daemon logs found");
    });

    test("logs page respects level filter query parameter", async () => {
        // Write daemon.log with mixed levels
        const daemonLogPath = join(ctx.tempDir, ".autonomous-dev", "daemon.log");
        const logLines = [
            JSON.stringify({
                ts: "2026-05-17T10:00:00Z",
                level: "info",
                message: "Info message",
                source: "daemon",
            }),
            JSON.stringify({
                ts: "2026-05-17T10:01:00Z",
                level: "error",
                message: "Error message",
                source: "daemon",
            }),
        ];

        writeFileSync(daemonLogPath, logLines.join("\n") + "\n");

        // Start the server
        ctx.server = await startServer();

        // Wait for server to be ready
        await new Promise(resolve => setTimeout(resolve, 100));

        // Make request to /logs?level=error
        const response = await fetch(`http://localhost:${ctx.testPort}/logs?level=error`);
        expect(response.status).toBe(200);

        const html = await response.text();

        // Should contain only the error message
        expect(html).toContain("Error message");
        expect(html).not.toContain("Info message");
    });

    test("logs page respects limit query parameter", async () => {
        // Write daemon.log with many lines
        const daemonLogPath = join(ctx.tempDir, ".autonomous-dev", "daemon.log");
        const logLines = [];
        for (let i = 0; i < 10; i++) {
            logLines.push(JSON.stringify({
                ts: `2026-05-17T10:${String(i).padStart(2, '0')}:00Z`,
                level: "info",
                message: `Message ${i}`,
                source: "daemon",
            }));
        }

        writeFileSync(daemonLogPath, logLines.join("\n") + "\n");

        // Start the server
        ctx.server = await startServer();

        // Wait for server to be ready
        await new Promise(resolve => setTimeout(resolve, 100));

        // Make request to /logs?limit=3
        const response = await fetch(`http://localhost:${ctx.testPort}/logs?limit=3`);
        expect(response.status).toBe(200);

        const html = await response.text();

        // Should contain only the last 3 messages (7, 8, 9)
        expect(html).toContain("Message 7");
        expect(html).toContain("Message 8");
        expect(html).toContain("Message 9");
        expect(html).not.toContain("Message 0");
        expect(html).not.toContain("Message 1");
    });
});
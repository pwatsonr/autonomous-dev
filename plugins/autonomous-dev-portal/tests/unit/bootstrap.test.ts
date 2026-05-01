// SPEC-013-2-05 §Task 9 (smoke) — Bootstrap smoke test.
//
// Verifies the end-to-end startServer() orchestration: config loads, the
// server binds to a random localhost port, the /health route responds
// with the documented JSON shape, and the cross-cutting middleware
// (request-id + Server-Timing + security headers) are present on the
// response. Each test cleans up the spawned listener via server.stop().

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Server } from "bun";

import { startServer } from "../../server/server";

const ENV_KEYS = [
    "PORTAL_PORT",
    "PORTAL_AUTH_MODE",
    "PORTAL_LOG_LEVEL",
    "PORTAL_BIND_HOST",
    "PORTAL_USER_CONFIG",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let tmpDir: string;
let activeServer: Server<unknown> | null = null;

function randomPort(): number {
    return 30200 + Math.floor(Math.random() * 5000);
}

beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
    }
    tmpDir = mkdtempSync(join(tmpdir(), "portal-bootstrap-test-"));
    // Point the user-config at a missing path so the loader silently uses
    // defaults; the state/logs paths are taken from defaults but the
    // startup-check relies on ~/.autonomous-dev existing. Override the
    // defaults via the user config to use our temp dir instead.
    const userConfigPath = join(tmpDir, "user.json");
    writeFileSync(
        userConfigPath,
        JSON.stringify({
            paths: {
                state_dir: tmpDir,
                logs_dir: tmpDir,
                user_config: userConfigPath,
            },
        }),
    );
    process.env["PORTAL_USER_CONFIG"] = userConfigPath;
});

afterEach(async () => {
    if (activeServer !== null) {
        try {
            activeServer.stop(true);
        } catch {
            // best-effort
        }
        activeServer = null;
    }
    // Detach signal handlers attached by setupGracefulShutdown so they do
    // not pile up across tests.
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) {
            delete process.env[k];
        } else {
            process.env[k] = savedEnv[k];
        }
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("startServer smoke", () => {
    test("binds to the configured port and returns a Server", async () => {
        const port = randomPort();
        process.env["PORTAL_PORT"] = String(port);
        const server = await startServer();
        activeServer = server;
        expect(server.port).toBe(port);
        expect(server.hostname).toBe("127.0.0.1");
    });

    test("GET /health returns 200 with the documented JSON shape", async () => {
        const port = randomPort();
        process.env["PORTAL_PORT"] = String(port);
        const server = await startServer();
        activeServer = server;
        const res = await fetch(`http://127.0.0.1:${String(port)}/health`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            status: string;
            uptime_ms: number;
            auth_mode: string;
        };
        expect(body.status).toBe("healthy");
        expect(typeof body.uptime_ms).toBe("number");
        expect(body.uptime_ms).toBeGreaterThanOrEqual(0);
        expect(body.auth_mode).toBe("localhost");
    });

    test("response carries x-request-id, Server-Timing, and CSP headers", async () => {
        const port = randomPort();
        process.env["PORTAL_PORT"] = String(port);
        const server = await startServer();
        activeServer = server;
        const res = await fetch(`http://127.0.0.1:${String(port)}/health`);
        expect(res.headers.get("x-request-id")).not.toBeNull();
        expect(res.headers.get("server-timing")).toMatch(/^total;dur=/);
        expect(res.headers.get("content-security-policy")).not.toBeNull();
    });

    test("invalid PORTAL_PORT causes startServer to throw", async () => {
        process.env["PORTAL_PORT"] = "99999";
        let caught: unknown = null;
        try {
            const s = await startServer();
            activeServer = s;
        } catch (e) {
            caught = e;
        }
        expect(caught).not.toBeNull();
    });
});

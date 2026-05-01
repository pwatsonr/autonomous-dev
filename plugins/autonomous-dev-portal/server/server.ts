// SPEC-013-2-01 §Task 3 — Bootstrap entry point for the autonomous-dev-portal
// MCP server. Owns ONLY the orchestration of startup phases; middleware
// bodies, binding security, and shutdown logic live in sibling specs:
//   - SPEC-013-2-02: applyMiddlewareChain
//   - SPEC-013-2-03: validateBindingConfig, resolveBindHostname
//   - SPEC-013-2-04: setupGracefulShutdown
//
// Order of operations is contractual: config → binding → middleware →
// routes → listen → shutdown handlers. Do not reorder.

import { serve, type Server } from "bun";
import { Hono } from "hono";

import { loadPortalConfig } from "./lib/config";
import { resolveBindHostname, validateBindingConfig } from "./lib/binding";
import { notFound } from "./lib/response-utils";
import {
    setupGracefulShutdown,
    setupShutdownPreBoot,
} from "./lib/shutdown";
import { validateStartupConditions } from "./lib/startup-checks";
import { applyMiddlewareChain } from "./middleware";
import { registerRoutes } from "./routes";

export interface ServerState {
    server?: Server<unknown>;
    shutdownInProgress: boolean;
    startTime: number;
}

const state: ServerState = {
    shutdownInProgress: false,
    startTime: Date.now(),
};

function phaseLog(phase: string, extra: Record<string, unknown> = {}): void {
    // Single emission path for startup events. Every line is structured JSON
    // so log aggregators / `jq` consumers see one record per startup phase.
    // eslint-disable-next-line no-console
    console.log(
        JSON.stringify({
            ts: new Date().toISOString(),
            phase,
            ...extra,
        }),
    );
}

export async function startServer(): Promise<Server<unknown>> {
    // Handle signals received between process start and the real
    // shutdown wiring. Removed in setupGracefulShutdown.
    setupShutdownPreBoot();
    phaseLog("server_starting");

    const config = await loadPortalConfig();
    phaseLog("config_loaded", {
        port: config.port,
        auth_mode: config.auth_mode,
    });

    await validateStartupConditions(config);
    await validateBindingConfig(config);
    const hostname = resolveBindHostname(config);

    const app = new Hono();
    applyMiddlewareChain(app, config);

    // SPEC-013-3-01: register all nine portal routes (incl. JSON /health).
    // The legacy inline /health handler is removed in favour of the JSON
    // shape documented in SPEC-013-3-01 §`/health` Handler.
    registerRoutes(app);
    app.notFound(notFound);

    const server = serve({
        port: config.port,
        hostname,
        fetch: app.fetch,
        error: (err: Error): Response => {
            phaseLog("server_fetch_error", { message: err.message });
            return new Response("Internal Server Error", { status: 500 });
        },
    });

    state.server = server;
    setupGracefulShutdown(server, state, config);

    phaseLog("server_listening", {
        hostname,
        port: config.port,
        startup_ms: Date.now() - state.startTime,
    });
    return server;
}

if (import.meta.main) {
    if (!process.env["CLAUDE_PLUGIN_ROOT"]) {
        process.env["CLAUDE_PLUGIN_ROOT"] = process.cwd();
    }
    startServer().catch((err: unknown) => {
        const e = err as Error & { code?: string };
        // eslint-disable-next-line no-console
        console.error(
            JSON.stringify({
                ts: new Date().toISOString(),
                phase: "startup_failed",
                message: e.message,
                code: e.code,
            }),
        );
        process.exit(1);
    });
}

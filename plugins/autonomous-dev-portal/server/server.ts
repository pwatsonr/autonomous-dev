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
import { serverError } from "./lib/error-handlers";
import { notFound } from "./lib/response-utils";
import {
    registerShutdownHook,
    setupGracefulShutdown,
    setupShutdownPreBoot,
} from "./lib/shutdown";
import { validateStartupConditions } from "./lib/startup-checks";
import { validateAuthConfig } from "./lib/validation";
import { enforceBindingWithLogging } from "./auth/security/binding-enforcer";
import { applyMiddlewareChain } from "./middleware";
import { registerRoutes } from "./routes";
import {
    InMemoryConfirmationStore,
    type ConfirmationRouteDeps,
} from "./routes/confirmation-routes";
import { TypedConfirmationService } from "./security/confirmation-tokens";
import { SSEEventBus } from "./sse/SSEEventBus";

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
    // SPEC-014-1-01 §Task 1.3 — auth-mode safety gate (loopback / OAuth /
    // TLS) runs before any network binding.
    validateAuthConfig(config);
    // SPEC-014-1-02 §Task 2.4 — defense-in-depth binding enforcer.
    // Throws BEFORE the listening socket is opened.
    enforceBindingWithLogging(config);
    await validateBindingConfig(config);
    const hostname = resolveBindHostname(config);

    const app = new Hono();
    applyMiddlewareChain(app, config);

    // SPEC-037-2-01 — construct the SSE bus + typed-CONFIRM service so the
    // previously-unmounted routes (`/portal/events`, the two confirmation
    // POSTs) come up in production. Heartbeat emission is owned by the bus
    // (its internal HeartbeatManager starts on construction).
    const sseBus = new SSEEventBus({
        logger: {
            info: (msg) => phaseLog("sse_info", { message: msg }),
            warn: (msg) => phaseLog("sse_warn", { message: msg }),
            error: (msg) => phaseLog("sse_error", { message: msg }),
        },
    });
    const confirmation: ConfirmationRouteDeps = {
        service: new TypedConfirmationService(),
        store: new InMemoryConfirmationStore(),
    };

    // SPEC-013-3-01: register all nine portal routes (incl. JSON /health).
    // The legacy inline /health handler is removed in favour of the JSON
    // shape documented in SPEC-013-3-01 §`/health` Handler.
    //
    // PLAN-037-2: SSE bus + confirmation are wired in production. The four
    // action-route groups (approvals/settings/agents/gate) remain at the
    // explicit 503 "wiring missing" path until their backing stores land
    // (daemon RPC / config writer / agent factory). The 503 envelope is the
    // documented operator signal — preferable to a silent 404.
    registerRoutes(app, {
        sseBus,
        confirmation,
        // SPEC-037-2-02 — daemon-status handler. Readers default to safe
        // values (0 spend, 0 approvals, false kill-switch) until real
        // backing stores are wired. heartbeatPath defaults to
        // ~/.autonomous-dev/heartbeat.json which exists for the running
        // daemon; status is classified from its mtime.
        daemonStatus: {
            readMtdSpend: async () => 0,
            readApprovalsCount: async () => 0,
            readKillSwitchEngaged: async () => false,
        },
    });

    // SPEC-037-2-01 FR-7 — close SSE connections gracefully on signal so
    // long-poll consumers see a `: shutdown` comment rather than a torn TCP
    // socket. Registered AFTER routes are wired but before the listener
    // opens — registerShutdownHook is idempotent w.r.t. registration order.
    registerShutdownHook(async () => {
        await sseBus.shutdown();
    });
    // SPEC-013-3-02: HTMX-aware 404 / 500. The error-boundary middleware
    // registered in applyMiddlewareChain catches PortalError-class errors
    // for API-style consumers (Accept: application/json); app.onError is
    // the last-line catch for anything that bubbles past it on HTML pages.
    app.notFound(notFound);
    app.onError(serverError);

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

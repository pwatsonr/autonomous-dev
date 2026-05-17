// SPEC-013-3-01 §`registerRoutes(app)` — single mount point for the
// portal HTTP routes. Order is purely organizational (none of the patterns
// overlap). Idempotency is not required (tests call once).
//
// SPEC-013-4-01 adds the static-asset mount at `/static/*` BEFORE the
// page routes so it short-circuits before any page handler runs. The
// rootDir is anchored to the plugin root so production deployments and
// in-process tests share one resolution.
//
// SPEC-014-1-04 §Task 4.8 adds the optional /auth/* routes (login,
// callback, logout). They are registered only when `options.authRoutes`
// is supplied — server.ts derives that from `auth_mode === 'oauth-pkce'`.
//
// PLAN-037-2 wires the previously-unmounted action routes:
//   - SSE event stream (events.ts) + typed-CONFIRM endpoints
//     (confirmation-routes.ts)  — SPEC-037-2-01
//   - GET /api/daemon-status                                — SPEC-037-2-02
//   - POST /api/approvals/:id/{approve,reject,bulk-approve} — SPEC-037-2-03
//   - POST /settings, /api/settings/allowlist,
//     /api/settings/notifications/test/{discord,slack,send} — SPEC-037-2-04
//   - POST /api/agents/:name/{promote,shadow,freeze} +
//     GET  /api/agents/:name/inspect                        — SPEC-037-2-05
//   - POST /repo/:repo/request/:id/gate/{approve,
//          request-changes, reject} + /api/requests/:id/action
//                                                           — SPEC-037-2-06
//
// Each action group has a `mountXyz()` helper that takes its own deps
// object. server.ts wires production deps; tests opt-in per group. When
// a dep is omitted, registerRoutes installs an explicit 503 stub so the
// gap is visible to operators (no silent 404s).

import type { Hono } from "hono";

import { staticAssets } from "../middleware/static-assets";
import type { SSEEventBus } from "../sse/SSEEventBus";
import {
    buildAgentActionRoutes,
    type AgentActionDeps,
} from "./agents-actions";
import {
    agentsApiHandler,
    agentsHandler,
    agentsInspectModalHandler,
} from "./agents";
import { approvalsHandler } from "./approvals";
import {
    buildApprovalsActionRoutes,
    type ApprovalsActionDeps,
} from "./approvals-actions";
import { auditHandler } from "./audit";
import type { AuthRouteDeps } from "./auth";
import { registerAuthRoutes } from "./auth";
import {
    registerConfirmationRoutes,
    type ConfirmationRouteDeps,
} from "./confirmation-routes";
import { costsHandler } from "./costs";
import {
    buildDaemonStatusHandler,
    type DaemonStatusDeps,
} from "./daemon-status";
import { dashboardHandler } from "./dashboard";
import { designSystemHandler } from "./design-system";
import { eventsRoute } from "./events";
import {
    buildGateAndRequestActionRoutes,
    type GateAndRequestActionDeps,
} from "./gate-and-request-actions";
import { healthHandler } from "./health";
import { buildKillSwitchRoutes } from "./kill-switch";
import { logsHandler } from "./logs";
import { opsHandler } from "./ops";
import { requestDetailHandler } from "./request-detail";
import { reposHandler } from "./repos";
import { requestsHandler } from "./requests";
import { settingsHandler } from "./settings";
import {
    buildSettingsActionRoutes,
    type SettingsActionDeps,
} from "./settings-actions";
import {
    buildStandardsActionRoutes,
    type StandardsActionDeps,
} from "./standards-actions";

export interface RegisterRoutesOptions {
    /**
     * Filesystem root for static assets. Defaults to `<cwd>/static`.
     * Tests may override to point at a fixture directory.
     */
    staticRootDir?: string;
    /**
     * SPEC-014-1-04 §Task 4.8 — when present, registers /auth/login,
     * /auth/callback, /auth/logout. server.ts wires this up only for
     * `auth_mode === 'oauth-pkce'`; localhost / tailscale builds
     * intentionally omit the routes so dead OAuth code paths are
     * unreachable.
     */
    authRoutes?: AuthRouteDeps;

    // -- PLAN-037-2 action surfaces ------------------------------------
    /**
     * SPEC-037-2-01 FR-1 — when present, mounts `GET /portal/events` via
     * the SSE bus. When omitted, that path returns 503 `sse-disabled`.
     */
    sseBus?: SSEEventBus;
    /**
     * SPEC-037-2-01 FR-3 — when present, mounts the two confirmation
     * endpoints; when omitted, both return 503 `confirmation-disabled`.
     */
    confirmation?: ConfirmationRouteDeps;
    /**
     * SPEC-037-2-02 — when present, mounts `GET /api/daemon-status`;
     * when omitted, that path returns 503 `daemon-status-disabled`.
     */
    daemonStatus?: DaemonStatusDeps;
    /**
     * SPEC-037-2-03 — when present, mounts the three approvals action
     * routes; when omitted, each returns 503 `approvals-actions-disabled`.
     */
    approvalsActions?: ApprovalsActionDeps;
    /**
     * SPEC-037-2-04 — when present, mounts the five settings action
     * routes; when omitted, each returns 503 `settings-actions-disabled`.
     */
    settingsActions?: SettingsActionDeps;
    /**
     * SPEC-037-2-05 — when present, mounts the four agent action routes;
     * when omitted, each returns 503 `agents-actions-disabled`.
     */
    agentsActions?: AgentActionDeps;
    /**
     * SPEC-037-2-06 — when present, mounts the gate-decision and generic
     * request-action routes; when omitted, each returns 503
     * `gate-actions-disabled`.
     */
    gateAndRequestActions?: GateAndRequestActionDeps;
    /**
     * BUG-15 fix — when present, mounts the standards action routes
     * (/api/standards/new, /api/standards/:id/edit); when omitted,
     * each returns 503 `standards-actions-disabled`.
     */
    standardsActions?: StandardsActionDeps;
}

function disabledHandler(error: string) {
    return (c: import("hono").Context): Response =>
        c.json({ error }, 503);
}

export function registerRoutes(
    app: Hono,
    options: RegisterRoutesOptions = {},
): void {
    const staticRootDir =
        options.staticRootDir ?? `${process.cwd()}/static`;

    app.get(
        "/static/*",
        staticAssets({ rootDir: staticRootDir, urlPrefix: "/static" }),
    );

    if (options.authRoutes !== undefined) {
        registerAuthRoutes(app, options.authRoutes);
    }

    // -----------------------------------------------------------------
    // SPEC-037-2-01 — SSE + confirmation endpoints.
    //
    // Mount BEFORE the page handlers so that the SSE stream is reachable
    // even when a page handler later in the chain errors out.
    // -----------------------------------------------------------------
    if (options.sseBus !== undefined) {
        app.route("/", eventsRoute(options.sseBus));
    } else {
        app.get("/portal/events", disabledHandler("sse-disabled"));
    }

    if (options.confirmation !== undefined) {
        registerConfirmationRoutes(app, options.confirmation);
    } else {
        app.post(
            "/api/security/confirmation/request",
            disabledHandler("confirmation-disabled"),
        );
        app.post(
            "/api/security/confirmation/validate",
            disabledHandler("confirmation-disabled"),
        );
    }

    // -----------------------------------------------------------------
    // SPEC-037-2-02 — daemon-status read-only endpoint.
    // -----------------------------------------------------------------
    if (options.daemonStatus !== undefined) {
        app.get(
            "/api/daemon-status",
            buildDaemonStatusHandler(options.daemonStatus),
        );
    } else {
        app.get(
            "/api/daemon-status",
            disabledHandler("daemon-status-disabled"),
        );
    }

    // -----------------------------------------------------------------
    // SPEC-037-2-03 — approvals action routes.
    // -----------------------------------------------------------------
    if (options.approvalsActions !== undefined) {
        app.route("/", buildApprovalsActionRoutes(options.approvalsActions));
    } else {
        app.post(
            "/api/approvals/:id/approve",
            disabledHandler("approvals-actions-disabled"),
        );
        app.post(
            "/api/approvals/:id/reject",
            disabledHandler("approvals-actions-disabled"),
        );
        app.post(
            "/api/approvals/bulk-approve",
            disabledHandler("approvals-actions-disabled"),
        );
    }

    // -----------------------------------------------------------------
    // SPEC-037-2-04 — settings action routes.
    //
    // The `POST /settings` route is dispatched by method, distinct from
    // the `GET /settings` page handler below (Hono matches both).
    // -----------------------------------------------------------------
    if (options.settingsActions !== undefined) {
        app.route("/", buildSettingsActionRoutes(options.settingsActions));
    } else {
        app.post(
            "/settings",
            disabledHandler("settings-actions-disabled"),
        );
        app.post(
            "/api/settings/allowlist",
            disabledHandler("settings-actions-disabled"),
        );
        app.post(
            "/api/settings/notifications",
            disabledHandler("settings-actions-disabled"),
        );
        for (const ch of ["discord", "slack", "send"] as const) {
            app.post(
                `/api/settings/notifications/test/${ch}`,
                disabledHandler("settings-actions-disabled"),
            );
        }
    }

    // -----------------------------------------------------------------
    // SPEC-037-2-05 — agent action routes.
    // -----------------------------------------------------------------
    if (options.agentsActions !== undefined) {
        app.route("/", buildAgentActionRoutes(options.agentsActions));
    } else {
        for (const verb of ["promote", "shadow", "freeze"] as const) {
            app.post(
                `/api/agents/:name/${verb}`,
                disabledHandler("agents-actions-disabled"),
            );
        }
        app.get(
            "/api/agents/:name/inspect",
            disabledHandler("agents-actions-disabled"),
        );
    }

    // -----------------------------------------------------------------
    // SPEC-037-2-06 — gate + request action routes.
    // -----------------------------------------------------------------
    if (options.gateAndRequestActions !== undefined) {
        app.route(
            "/",
            buildGateAndRequestActionRoutes(options.gateAndRequestActions),
        );
    } else {
        for (const verb of [
            "approve",
            "request-changes",
            "reject",
        ] as const) {
            app.post(
                `/repo/:repo/request/:id/gate/${verb}`,
                disabledHandler("gate-actions-disabled"),
            );
        }
        app.post(
            "/api/requests/:id/action",
            disabledHandler("gate-actions-disabled"),
        );
    }

    // -----------------------------------------------------------------
    // BUG-15 fix — standards action routes.
    // -----------------------------------------------------------------
    if (options.standardsActions !== undefined) {
        app.route("/", buildStandardsActionRoutes(options.standardsActions));
    } else {
        app.get(
            "/api/standards/new",
            disabledHandler("standards-actions-disabled"),
        );
        app.get(
            "/api/standards/:id/edit",
            disabledHandler("standards-actions-disabled"),
        );
    }

    // -----------------------------------------------------------------
    // PLAN-021 Phase 1A — Cypress test endpoint (debug-only).
    // -----------------------------------------------------------------
    if (process.env.NODE_ENV !== 'production') {
        app.post("/__test/reset", async (c) => {
            const cypressHeader = c.req.header("X-Cypress-Test");
            if (cypressHeader !== "1") {
                return c.json({ error: "forbidden" }, 403);
            }

            // Phase 1A stub — clears in-memory state and accepts fixtures
            // Phase 1B will implement full database reset functionality
            const body = await c.req.json().catch(() => ({}));

            // TODO: Clear in-memory state
            // TODO: Write any provided fixtures to disk

            return c.json({ success: true, message: "Test state reset (Phase 1A stub)" });
        });
    }

    // -----------------------------------------------------------------
    // GET page routes — order is purely organizational.
    // -----------------------------------------------------------------
    app.get("/", dashboardHandler);
    app.get("/repo/:repo/request/:id", requestDetailHandler);
    app.get("/approvals", approvalsHandler);
    app.get("/requests", requestsHandler);
    app.get("/settings", settingsHandler);
    app.get("/costs", costsHandler);
    app.get("/logs", logsHandler);
    app.get("/ops", opsHandler);
    app.get("/audit", auditHandler);
    app.get("/design-system", designSystemHandler);
    app.get("/health", healthHandler);

    // PLAN-038 TASK-005 — net-new surfaces. Initial empty-data scaffolding;
    // TASK-015 wires the real composition readers.
    app.get("/agents", agentsHandler);
    app.get("/repos", reposHandler);
    app.get("/api/agents", agentsApiHandler);
    // PLAN-038 polish — row click loads the inspect modal HTML fragment.
    app.get("/agents/:name/inspect-modal", agentsInspectModalHandler);

    // PLAN-038 TASK-001 — SVG favicon at the URL root (browsers default-request
    // /favicon.svg). Reads from the configured static root so it honors the
    // same `staticRootDir` option as the /static/* mount above.
    app.get("/favicon.svg", async (c) => {
        const file = Bun.file(`${staticRootDir}/favicon.svg`);
        if (!(await file.exists())) {
            return c.notFound();
        }
        return new Response(file, {
            headers: {
                "Content-Type": "image/svg+xml",
                "Cache-Control": "public, max-age=3600",
            },
        });
    });

    // SPEC-035-3 — kill-switch sub-router (mounts /ops/kill-switch* paths).
    app.route("/", buildKillSwitchRoutes());
}

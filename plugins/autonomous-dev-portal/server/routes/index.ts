// SPEC-013-3-01 §`registerRoutes(app)` — single mount point for all nine
// portal routes. Order is purely organizational (none of the patterns
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

import type { Hono } from "hono";

import { staticAssets } from "../middleware/static-assets";
import { approvalsHandler } from "./approvals";
import { auditHandler } from "./audit";
import type { AuthRouteDeps } from "./auth";
import { registerAuthRoutes } from "./auth";
import { costsHandler } from "./costs";
import { dashboardHandler } from "./dashboard";
import { healthHandler } from "./health";
import { logsHandler } from "./logs";
import { opsHandler } from "./ops";
import { requestDetailHandler } from "./request-detail";
import { settingsHandler } from "./settings";

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

    app.get("/", dashboardHandler);
    app.get("/repo/:repo/request/:id", requestDetailHandler);
    app.get("/approvals", approvalsHandler);
    app.get("/settings", settingsHandler);
    app.get("/costs", costsHandler);
    app.get("/logs", logsHandler);
    app.get("/ops", opsHandler);
    app.get("/audit", auditHandler);
    app.get("/health", healthHandler);
}

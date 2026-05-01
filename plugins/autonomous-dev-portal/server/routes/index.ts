// SPEC-013-3-01 §`registerRoutes(app)` — single mount point for all nine
// portal routes. Order is purely organizational (none of the patterns
// overlap). Idempotency is not required (tests call once).
//
// SPEC-013-4-01 adds the static-asset mount at `/static/*` BEFORE the
// page routes so it short-circuits before any page handler runs. The
// rootDir is anchored to the plugin root so production deployments and
// in-process tests share one resolution.

import type { Hono } from "hono";

import { staticAssets } from "../middleware/static-assets";
import { approvalsHandler } from "./approvals";
import { auditHandler } from "./audit";
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

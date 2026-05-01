// SPEC-013-3-01 §`registerRoutes(app)` — single mount point for all nine
// portal routes. Order is purely organizational (none of the patterns
// overlap). Idempotency is not required (tests call once).

import type { Hono } from "hono";

import { approvalsHandler } from "./approvals";
import { auditHandler } from "./audit";
import { costsHandler } from "./costs";
import { dashboardHandler } from "./dashboard";
import { healthHandler } from "./health";
import { logsHandler } from "./logs";
import { opsHandler } from "./ops";
import { requestDetailHandler } from "./request-detail";
import { settingsHandler } from "./settings";

export function registerRoutes(app: Hono): void {
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

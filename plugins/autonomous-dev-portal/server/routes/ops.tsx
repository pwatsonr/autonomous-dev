// SPEC-036-2-04..06 §Route — Ops (`GET /ops`).
// PLAN-038 TASK-017 — swapped from loadOpsStub() to the real
// readOpsHealth() composition reader. MCP probe, deploy events, and
// standards changes feed are empty by default (daemon does not track
// these); plugin chain is read live from `plugins/<name>/.claude-plugin/
// plugin.json`; recent log tails `~/.autonomous-dev/portal/portal.log`.

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { readOpsHealth } from "../wiring/ops-readers";
import type { OpsHealth } from "../types/render";

const MAX_LOG_RENDER = 200;

/** Trim the rendered log to the last `MAX_LOG_RENDER` entries. */
function trimRecentLog(h: OpsHealth): OpsHealth {
    if (!h.recentLog || h.recentLog.length <= MAX_LOG_RENDER) return h;
    return {
        ...h,
        recentLog: h.recentLog.slice(-MAX_LOG_RENDER),
    };
}

export const opsHandler = async (c: Context): Promise<Response> => {
    const raw = await readOpsHealth();
    const health = trimRecentLog(raw);
    const csrfToken = (c.get("csrfToken") as string | undefined) ?? "";
    return renderPage(c, "ops", { health, csrfToken });
};

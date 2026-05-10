// SPEC-036-2-04..06 §Route — Ops (`GET /ops`).
//
// Loads the ops stub, trims the recent log to last 200 server-side
// (SPEC-036-2-04 FR-7 — DOM-growth mitigation), and renders the v1.1
// Ops surface via the template dispatcher.

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { loadOpsStub } from "../stubs/ops";
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
    const raw = await loadOpsStub();
    const health = trimRecentLog(raw);
    const csrfToken = (c.get("csrfToken") as string | undefined) ?? "";
    return renderPage(c, "ops", { health, csrfToken });
};

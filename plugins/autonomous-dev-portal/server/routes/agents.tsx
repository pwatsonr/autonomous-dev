// PLAN-038 TASK-005 — `GET /agents` and `GET /api/agents` route handlers.
//
// Initial scaffolding: returns an empty AgentsPageData so the routes return
// 200 with the honest empty-state surface. TASK-015 will wire the real
// composition reader from `wiring/agents-readers.ts` (TASK-011) so the
// surface lists the canonical agent manifest with `frozen`/`shadowed`
// overlay from `~/.autonomous-dev/agent-states.json`.
//
// The rail-nav `Agents` link points here (TASK-006 fixed it from the
// `/settings#agents` hash that produced the 404 in TDD-037 §3.2).

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import type { AgentsPageData } from "../types/render";

/** PLAN-038 §empty-state honesty — readers return safe zeros until the
 *  composition layer is wired. The view renders honest empty-state copy. */
function emptyAgentsPageData(): AgentsPageData {
    return {
        kpis: { totalAgents: 0, frozenCount: 0, shadowCount: 0 },
        agents: [],
    };
}

/** `GET /agents` — Agents surface (HTML). */
export const agentsHandler = async (c: Context): Promise<Response> => {
    const data = emptyAgentsPageData();
    return renderPage(c, "agents", data);
};

/** `GET /api/agents` — same data as JSON. */
export const agentsApiHandler = async (c: Context): Promise<Response> => {
    const data = emptyAgentsPageData();
    return c.json(data.agents);
};

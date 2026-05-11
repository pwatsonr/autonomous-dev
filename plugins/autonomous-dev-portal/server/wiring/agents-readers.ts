// PLAN-038 TASK-011 — agents composition reader.
//
// Wraps the atomic `agent-states-reader` and emits the `AgentsPageData`
// view-input shape (KPIs + AgentRow[]). The KPIs are derived from the
// canonical list (manifest scan) + the lifecycle overlay.

import type { AgentsPageData } from "../types/render";

import {
    readAgentStates,
    type AgentStatesReaderOptions,
} from "./agent-states-reader";

export type AgentsReaderOptions = AgentStatesReaderOptions;

export async function readAgentsData(
    opts: AgentsReaderOptions = {},
): Promise<AgentsPageData> {
    const agents = await readAgentStates(opts);
    const frozenCount = agents.filter((a) => a.status === "frozen").length;
    const shadowCount = agents.filter((a) => a.status === "shadow").length;
    return {
        kpis: {
            totalAgents: agents.length,
            frozenCount,
            shadowCount,
        },
        agents,
    };
}

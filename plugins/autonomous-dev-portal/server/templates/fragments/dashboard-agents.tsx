// FR-026-14 — Agents-by-utilization mini grid (top 9).
//
// View-local fragment. Renders the `.agent-grid` (3-column, repeat(3,1fr))
// defined in app.css. Each `.agent-card` shows:
//   - phase chip (chip-phase + phase key class)
//   - agent id
//   - role label (mono, uppercase)
//   - utilization bar
//   - stats row: util% · runs · p50
// The "All agents →" link routes to /agents.

import type { FC } from "hono/jsx";
import type { AgentUtilRow } from "../../wiring/dashboard-readers";

export interface DashboardAgentsMiniProps {
    agents: AgentUtilRow[];
    totalAgents?: number;
}

/**
 * FR-026-14 — Top-9 agents by utilization.
 *
 * Renders the `.agent-grid` card as defined in the v3 design.
 * The utilization bar is a 2px horizontal bar (`.util-bar > span`)
 * whose width is the utilization percentage.
 */
export const DashboardAgentsMini: FC<DashboardAgentsMiniProps> = ({
    agents,
    totalAgents = 18,
}) => {
    const top9 = agents.slice(0, 9);
    return (
        <div class="card">
            <div class="card-h">
                <h3>Agents · top 9 by utilization</h3>
                <span class="meta">{totalAgents} total</span>
                <span class="spacer"></span>
                <a href="/agents" class="btn ghost sm">
                    All agents →
                </a>
            </div>
            <div class="card-b">
                <div class="agent-grid" role="list" aria-label="Agent utilization">
                    {top9.map((a) => (
                        <div class="agent-card" key={a.id} role="listitem">
                            <div class="top">
                                {/* font-size token applied via .agent-card .chip-phase in dashboard.css */}
                                <span
                                    class={`chip-phase ${a.phase}`}
                                    aria-label={`Phase: ${a.phase}`}
                                >
                                    {a.phase}
                                </span>
                                <span class="name">{a.id}</span>
                                <span class="role">{a.role}</span>
                            </div>
                            {/*
                              * Util bar: width driven by CSS custom property --util-pct.
                              * Setting a CSS variable via style= is the accepted
                              * CSP-safe pattern for dynamic numeric values.
                              */}
                            <div
                                class="util-bar"
                                role="progressbar"
                                aria-valuenow={a.util}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-label={`Utilization ${a.util}%`}
                            >
                                <span style={`--util-pct:${a.util}%`}></span>
                            </div>
                            <div class="stats">
                                <span>
                                    util <b>{a.util}%</b>
                                </span>
                                <span>
                                    runs <b>{a.runs}</b>
                                </span>
                                <span>
                                    p50 <b>{a.p50}</b>
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

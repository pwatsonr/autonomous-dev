// PLAN-038 TASK-005 — Agents surface view component.
//
// Renders the canonical agent list with state (frozen / shadow / baseline),
// version, and per-agent metrics. Until TASK-015 wires the real composition
// reader, route handlers pass `emptyAgentsPageData()` and this view renders
// the honest empty state: "No agents have been frozen or shadowed".
//
// Untracked fields (lastDispatchAt, runs30d, fpRate) render as `—` (em-dash)
// because the daemon's `agent-states.json` only persists `{frozen[], shadowed[]}`
// — the rich kit-screenshot metrics are not part of the daemon's writeset.

import type { FC } from "hono/jsx";

import type { AgentRow, RenderProps } from "../../types/render";

function fmtRuns(n: number | null | undefined): string {
    return typeof n === "number" ? String(n) : "—";
}

function fmtFpRate(rate: number | null | undefined): string {
    return typeof rate === "number" ? `${Math.round(rate * 100)}%` : "—";
}

function fmtLastDispatch(iso: string | null | undefined): string {
    if (typeof iso !== "string" || iso.length === 0) return "—";
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return "—";
    return new Date(ts).toISOString().slice(0, 10);
}

function statusToneClass(status: AgentRow["status"]): string {
    switch (status) {
        case "frozen":
            return "warn";
        case "shadow":
            return "info";
        case "promoted":
            return "ok";
        case "baseline":
        default:
            return "muted";
    }
}

export const AgentsView: FC<RenderProps["agents"]> = ({ kpis, agents }) => (
    <section class="agents-surface">
        <div class="page-head">
            <h1>Agents</h1>
        </div>

        <div class="kpi-strip">
            <div class="kpi">
                <div class="kpi-label">Total agents</div>
                <div class="kpi-num">{kpis.totalAgents}</div>
                <div class="kpi-sub">across plugins</div>
            </div>
            <div class="kpi">
                <div class="kpi-label">Frozen</div>
                <div class="kpi-num">{kpis.frozenCount}</div>
                <div class="kpi-sub">held at current version</div>
            </div>
            <div class="kpi">
                <div class="kpi-label">Shadow</div>
                <div class="kpi-num">{kpis.shadowCount}</div>
                <div class="kpi-sub">running in evaluation mode</div>
            </div>
        </div>

        {agents.length === 0 ? (
            <p class="empty">No agents have been frozen or shadowed.</p>
        ) : (
            <table class="tbl">
                <thead>
                    <tr>
                        <th>Agent</th>
                        <th>Version</th>
                        <th>Status</th>
                        <th>Mode</th>
                        <th>Last dispatch</th>
                        <th>Runs (30d)</th>
                        <th>FP rate</th>
                    </tr>
                </thead>
                <tbody>
                    {agents.map((a) => (
                        <tr>
                            <td class="agent-name">{a.name}</td>
                            <td class="mono">{a.version}</td>
                            <td>
                                <span
                                    class={`chip status ${statusToneClass(a.status)}`}
                                >
                                    {a.status.toUpperCase()}
                                </span>
                            </td>
                            <td>{a.mode}</td>
                            <td class="mono">{fmtLastDispatch(a.lastDispatchAt)}</td>
                            <td>{fmtRuns(a.runs30d)}</td>
                            <td>{fmtFpRate(a.fpRate)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        )}
    </section>
);

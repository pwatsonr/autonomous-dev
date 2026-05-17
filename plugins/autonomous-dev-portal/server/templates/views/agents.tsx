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

// Pre-computed hx-trigger value - using double quotes inside bracket expression
const AGENTS_POLLING_TRIGGER = 'every 30s [document.visibilityState === "visible"]';

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
    <section
        id="agents-body"
        class="agents-surface"
        hx-get="/agents"
        hx-trigger={AGENTS_POLLING_TRIGGER}
        hx-target="this"
        hx-swap="outerHTML"
        hx-select="#agents-body"
    >
        {/* PORTAL-AUDIT-2026-05-16: agents runtime data (last dispatch,
            runs/30d, FP rate) updates slowly; 30s poll is plenty. The
            row-click handler is a separate script and survives the
            re-render because the modal lives in #modal-slot (in the
            shell layout, outside this wrapper). */}
        <div class="page-head">
            <h1>Agents</h1>
        </div>

        {/* PLAN-038 polish — intro + lifecycle explanation. Operators
            new to the system need to know what BASELINE / SHADOW / FROZEN
            / PROMOTED mean before they decide what to do with a row. */}
        <div class="agents-intro">
            <p>
                Plugin agents run reviewers, executors, and analysts during
                request processing. Each agent has a lifecycle state:
            </p>
            <dl>
                <dt>baseline</dt>
                <dd>
                    The default. The agent runs at its declared version on
                    every matching request.
                </dd>
                <dt>shadow</dt>
                <dd>
                    Runs in parallel for evaluation but its output does not
                    affect gates or scoring. Use to evaluate a new agent or
                    a version bump without risk.
                </dd>
                <dt>frozen</dt>
                <dd>
                    Pinned at the current version — the daemon will not
                    auto-upgrade it. Use when a newer version regressed
                    behavior.
                </dd>
                <dt>promoted</dt>
                <dd>
                    A previously-shadow agent that has been promoted to
                    serve traffic. Reverts to baseline if rolled back.
                </dd>
            </dl>
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
                        // PLAN-038 polish — row click loads the inspect
                        // modal. The delegated click handler lives in
                        // static/js/agents-row-click.js (CSP disallows
                        // inline `onclick` attributes). The script reads
                        // `data-agent` to fetch the right modal fragment.
                        <tr
                            data-agent={a.name}
                            role="button"
                            tabindex={0}
                        >
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

        {/* Modal-slot lives in ShellLayout (shell.tsx) so it's available
            on every surface — do not duplicate the id here. */}
        <script src="/static/js/agents-row-click.js" defer></script>
    </section>
);

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

import { asset } from "../../lib/plugin-version";
import type { FC } from "hono/jsx";
import { Topbar } from "../../components/topbar";

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

/** One-line lifecycle definitions — chip tooltips + bottom reference. */
const STATUS_HELP: Record<string, string> = {
    baseline:
        "The default. Runs at its declared version on every matching request.",
    shadow:
        "Runs in parallel for evaluation only — output does not affect gates or scoring.",
    frozen:
        "Pinned at the current version — the daemon will not auto-upgrade it.",
    promoted:
        "A previously-shadow agent promoted to serve traffic. Reverts to baseline if rolled back.",
};

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
        <Topbar title="Agents" subTitle="lifecycle & manifest" />
        <div class="main-inner">

        {/* crawl p8 follow-up: the lifecycle glossary used to sit ABOVE
            the table (operator: "seems odd at the top") — definitions now
            live as tooltips on the status chips, with the full reference
            in a compact section below the table. */}

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
                                    title={STATUS_HELP[a.status]}
                                >
                                    {a.status.toUpperCase()}
                                </span>
                            </td>
                            {/* crawl p8: the old Mode column was hardcoded
                                "active" for every agent — a constant posing
                                as data. Status already carries lifecycle. */}
                            <td class="mono">{fmtLastDispatch(a.lastDispatchAt)}</td>
                            <td>{fmtRuns(a.runs30d)}</td>
                            <td>{fmtFpRate(a.fpRate)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        )}

        {/* Lifecycle reference — moved below the table (tooltips on the
            status chips carry the same definitions in context). */}
        <section class="sec">
            <div class="sec-head">
                <h2>Lifecycle reference</h2>
            </div>
            <div class="card">
                <dl class="kv agents-lifecycle-ref">
                    {Object.entries(STATUS_HELP).map(([k, v]) => (
                        <>
                            <dt class="mono">{k.toUpperCase()}</dt>
                            <dd>{v}</dd>
                        </>
                    ))}
                </dl>
            </div>
        </section>

        {/* Modal-slot lives in ShellLayout (shell.tsx) so it's available
            on every surface — do not duplicate the id here. */}
        <script src={asset("/static/js/agents-row-click.js")} defer></script>
        </div>
    </section>
);

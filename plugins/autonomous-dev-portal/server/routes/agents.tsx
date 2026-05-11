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
import { readAgentsData } from "../wiring/agents-readers";

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** `GET /agents` — Agents surface (HTML). PLAN-038 TASK-015 wires the
 *  real composition reader (was emptyAgentsPageData scaffolding in
 *  TASK-005). */
export const agentsHandler = async (c: Context): Promise<Response> => {
    const data = await readAgentsData();
    return renderPage(c, "agents", data);
};

/** `GET /api/agents` — same data as JSON. */
export const agentsApiHandler = async (c: Context): Promise<Response> => {
    const data = await readAgentsData();
    return c.json(data.agents);
};

/**
 * PLAN-038 polish — `GET /agents/:name/inspect-modal` returns an HTML
 * fragment for the inspect modal. The /agents row click loads this via
 * HTMX into `#modal-slot`.
 *
 * The modal shows agent metadata + action buttons (promote, shadow,
 * freeze, unshadow, unfreeze) wired to the existing POST endpoints.
 * Each action's button is disabled when the agent is already in that
 * state, and after a successful POST the response can hx-swap=outerHTML
 * into the modal to refresh the rendered state.
 */
export const agentsInspectModalHandler = async (
    c: Context,
): Promise<Response> => {
    const name = c.req.param("name");
    if (typeof name !== "string" || !NAME_RE.test(name)) {
        return c.html(
            <div class="modal-bg">
                <div class="modal">
                    <p>Invalid agent name.</p>
                </div>
            </div>,
            400,
        );
    }
    const data = await readAgentsData();
    const agent = data.agents.find((a) => a.name === name);
    if (agent === undefined) {
        return c.html(
            <div class="modal-bg" data-modal-backdrop>
                <div class="modal">
                    <h3>Agent not found</h3>
                    <p>
                        No agent named <code>{name}</code> in the manifest.
                    </p>
                    <div class="modal-actions">
                        <button
                            type="button"
                            class="btn"
                            onclick="document.getElementById('modal-slot').innerHTML=''"
                        >
                            Close
                        </button>
                    </div>
                </div>
            </div>,
            404,
        );
    }
    const isFrozen = agent.status === "frozen";
    const isShadow = agent.status === "shadow";
    const isBaseline = agent.status === "baseline";
    // Close-and-reload: dismissing the modal also refreshes the page so
    // the underlying agents table reflects any state change made via the
    // modal actions. Full reload is simple and reliable; the page is
    // fast (sub-30ms cold reader path per AC-3715).
    const close =
        "document.getElementById('modal-slot').innerHTML='';location.reload()";
    return c.html(
        <div
            class="modal-bg"
            data-modal-backdrop
            onclick={`if(event.target===this){${close}}`}
        >
            <div class="modal" role="dialog" aria-labelledby="inspect-modal-title">
                <h3 id="inspect-modal-title">
                    {agent.name}
                    <span class={`chip status ${isFrozen ? "warn" : isShadow ? "info" : "muted"}`} style="margin-left:8px;">
                        {agent.status.toUpperCase()}
                    </span>
                </h3>
                <dl class="stats-grid">
                    <dt>Version</dt>
                    <dd class="mono">{agent.version}</dd>
                    <dt>Mode</dt>
                    <dd>{agent.mode}</dd>
                    <dt>Last dispatch</dt>
                    <dd class="mono">{agent.lastDispatchAt ?? "—"}</dd>
                    <dt>Runs (30d)</dt>
                    <dd class="mono">
                        {typeof agent.runs30d === "number"
                            ? String(agent.runs30d)
                            : "—"}
                    </dd>
                    <dt>FP rate</dt>
                    <dd class="mono">
                        {typeof agent.fpRate === "number"
                            ? `${Math.round(agent.fpRate * 100)}%`
                            : "—"}
                    </dd>
                </dl>
                <p style="margin-top:14px;color:var(--fg-2);font-size:12px;">
                    Daemon does not currently track per-agent dispatch
                    history, run count, or false-positive rate. Those
                    fields render <code>—</code> until the daemon emits
                    them.
                </p>
                <div class="modal-actions">
                    {isShadow ? (
                        <button
                            type="button"
                            class="btn"
                            hx-post={`/api/agents/${agent.name}/unshadow`}
                            hx-swap="none"
                            hx-on={`htmx:afterRequest: if(event.detail.successful){htmx.ajax('GET','/agents/${agent.name}/inspect-modal','#modal-slot')}`}
                            title="Stop shadowing and return to baseline"
                        >
                            Unshadow
                        </button>
                    ) : (
                        <button
                            type="button"
                            class="btn"
                            disabled={isFrozen}
                            hx-post={`/api/agents/${agent.name}/shadow`}
                            hx-swap="none"
                            hx-on={`htmx:afterRequest: if(event.detail.successful){htmx.ajax('GET','/agents/${agent.name}/inspect-modal','#modal-slot')}`}
                            title="Run in parallel for evaluation only — output does not affect gates"
                        >
                            Shadow
                        </button>
                    )}
                    {isFrozen ? (
                        <button
                            type="button"
                            class="btn"
                            hx-post={`/api/agents/${agent.name}/unfreeze`}
                            hx-swap="none"
                            hx-on={`htmx:afterRequest: if(event.detail.successful){htmx.ajax('GET','/agents/${agent.name}/inspect-modal','#modal-slot')}`}
                            title="Allow auto-upgrade again"
                        >
                            Unfreeze
                        </button>
                    ) : (
                        <button
                            type="button"
                            class="btn destructive"
                            hx-post={`/api/agents/${agent.name}/freeze`}
                            hx-swap="none"
                            hx-on={`htmx:afterRequest: if(event.detail.successful){htmx.ajax('GET','/agents/${agent.name}/inspect-modal','#modal-slot')}`}
                            title="Pin at current version — daemon will not auto-upgrade"
                        >
                            Freeze
                        </button>
                    )}
                    <button
                        type="button"
                        class="btn primary"
                        disabled={isBaseline}
                        hx-post={`/api/agents/${agent.name}/promote?version=${agent.version}`}
                        hx-target="#modal-slot"
                        hx-swap="innerHTML"
                        title="Promote shadow agent to baseline traffic"
                    >
                        Promote
                    </button>
                    <button
                        type="button"
                        class="btn ghost"
                        onclick={close}
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>,
    );
};

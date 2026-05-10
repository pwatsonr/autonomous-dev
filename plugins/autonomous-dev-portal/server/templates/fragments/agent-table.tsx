// SPEC-036-4-07 §Agents tab — full-width table listing the 18 registered
// agents and one Inspect modal per agent. The modal is hoisted to a
// top-level `<main>` sibling of the panel sections (per SPEC-036-4-01
// AC-05) so `display:none` ancestors never block `showModal()`.

import type { FC } from "hono/jsx";

import { Btn, Chip } from "../../components/primitives";
import type { AgentRecord, AgentRunRef } from "../../types/render";

interface TableProps {
    agents: AgentRecord[];
}

const STATE_TONE: Record<AgentRecord["state"], "ok" | "warn" | "muted"> = {
    active: "ok",
    shadow: "warn",
    frozen: "muted",
};

function pct(n: number): string {
    return `${n}%`;
}

export const AgentTable: FC<TableProps> = ({ agents }) => {
    const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
    return (
        <table class="tbl" data-fragment="agent-table">
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Role</th>
                    <th>State</th>
                    <th>Approval</th>
                    <th>Precision</th>
                    <th>Recall</th>
                    <th>Version</th>
                    <th>Action</th>
                </tr>
            </thead>
            <tbody>
                {sorted.map((agent) => (
                    <tr data-agent={agent.name}>
                        <td class="mono">{agent.name}</td>
                        <td>
                            <Chip variant="status" tone="info">
                                {agent.role}
                            </Chip>
                        </td>
                        <td>
                            <Chip
                                variant="status"
                                tone={STATE_TONE[agent.state]}
                            >
                                {agent.state}
                            </Chip>
                        </td>
                        <td class="mono">{pct(agent.approvalPct)}</td>
                        <td class="mono">{pct(agent.precisionPct)}</td>
                        <td class="mono">{pct(agent.recallPct)}</td>
                        <td class="mono">{agent.version}</td>
                        <td>
                            <Btn
                                kind="ghost"
                                size="sm"
                                data-modal-open={`inspect-agent-modal-${agent.name}`}
                            >
                                Inspect
                            </Btn>
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
};

interface ModalProps {
    agent: AgentRecord;
}

const RUN_TONE: Record<AgentRunRef["status"], "ok" | "err" | "muted"> = {
    success: "ok",
    failed: "err",
    cancelled: "muted",
};

/**
 * SPEC-036-4-07 AC-03 — Inspect dialog. Three most-recent runs sorted
 * desc by `startedAt`; empty state when `recentRuns.length === 0`.
 *
 * SPEC-036-4-07 AC-07 — action buttons render `disabled` when the agent
 * is already in the target state (Promote disabled if active, etc.).
 */
export const AgentInspectModal: FC<ModalProps> = ({ agent }) => {
    const recent = [...agent.recentRuns]
        .sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1))
        .slice(0, 3);
    const id = `inspect-agent-modal-${agent.name}`;
    return (
        <dialog id={id} class="modal" aria-labelledby={`${id}-title`}>
            <form method="dialog" class="modal-content">
                <h3 id={`${id}-title`}>Inspect {agent.name}</h3>

                <dl class="stats-grid">
                    <dt>Approval</dt>
                    <dd class="mono">{pct(agent.approvalPct)}</dd>
                    <dt>Precision</dt>
                    <dd class="mono">{pct(agent.precisionPct)}</dd>
                    <dt>Recall</dt>
                    <dd class="mono">{pct(agent.recallPct)}</dd>
                    <dt>Version</dt>
                    <dd class="mono">{agent.version}</dd>
                    <dt>Last trained</dt>
                    <dd class="mono">{agent.lastTrainedAt}</dd>
                </dl>

                <h4>Recent runs</h4>
                {recent.length === 0 ? (
                    <p class="empty" data-empty="agent-runs">
                        No runs yet.
                    </p>
                ) : (
                    <table class="tbl">
                        <thead>
                            <tr>
                                <th>Started</th>
                                <th>Status</th>
                                <th>Duration</th>
                                <th>Cost</th>
                            </tr>
                        </thead>
                        <tbody>
                            {recent.map((run) => (
                                <tr>
                                    <td class="mono">{run.startedAt}</td>
                                    <td>
                                        <Chip
                                            variant="status"
                                            tone={RUN_TONE[run.status]}
                                        >
                                            {run.status}
                                        </Chip>
                                    </td>
                                    <td class="mono">
                                        {`${run.durationMs}ms`}
                                    </td>
                                    <td class="mono">
                                        {`$${run.cost.toFixed(2)}`}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}

                <div class="modal-actions">
                    <Btn
                        kind="primary"
                        disabled={agent.state === "active"}
                        hx-post={`/api/agents/${agent.name}/promote`}
                        data-confirm={`Promote ${agent.name} to active? This will route 100% of ${agent.role} traffic to this agent.`}
                    >
                        Promote
                    </Btn>
                    <Btn
                        kind="secondary"
                        disabled={agent.state === "shadow"}
                        hx-post={`/api/agents/${agent.name}/shadow`}
                        data-confirm={`Move ${agent.name} to shadow mode?`}
                    >
                        Shadow
                    </Btn>
                    <Btn
                        kind="destructive"
                        disabled={agent.state === "frozen"}
                        hx-post={`/api/agents/${agent.name}/freeze`}
                        data-confirm={`Freeze ${agent.name}? It will stop receiving traffic.`}
                    >
                        Freeze
                    </Btn>
                    <Btn kind="ghost" data-modal-close={id}>
                        Close
                    </Btn>
                </div>
            </form>
        </dialog>
    );
};

// SPEC-036-2-04..06 — Ops surface (PLAN-036-2 second surface).
//
// Composes the v1.1 ops surface in fixed order:
//   1. Page head            (Refresh + KillSwitch in head-actions)
//   2. KPI strip            (4 cards — daemon w/ live dot, MCP, plugin, std)
//   3. Plugin chain         (5-column visualization)
//   4. Heartbeat sparkline  (24h SVG + .dot.live)
//   5. ops-grid #1          (LiveLog | DeployEvents)
//   6. ops-grid #2          (MCP servers | recent standards changes)
//   7. Circuit breaker card

import type { FC } from "hono/jsx";

import { Btn, Card, Chip, Dot } from "../../components/primitives";
// PLAN-038 polish — KillSwitch removed from Ops head-actions (already in
// rail-ops bar). Import retained-as-comment for git-blame discoverability.
// import { KillSwitch } from "../../components/kill-switch";
import type { OpsHealth, RenderProps } from "../../types/render";

// Pre-computed hx-trigger value - using double quotes inside bracket expression
const OPS_POLLING_TRIGGER = 'every 10s [document.visibilityState === "visible"]';
import { EmptyState } from "../fragments/empty-state";
import { HeartbeatSparkline } from "../fragments/heartbeat-sparkline";
import { KpiStrip } from "../fragments/kpi-strip";
import type { KpiItem } from "../fragments/kpi-strip";
import { LiveLog } from "../fragments/live-log";
import { PluginChain } from "../fragments/plugin-chain";

export interface OpsViewProps {
    health: OpsHealth;
    /** SPEC-014-2-04 — per-request CSP token forwarded into KillSwitch. */
    csrfToken?: string;
}

/** Build the 4 KPI tiles for the Ops health strip. */
export function buildOpsKpis(h: OpsHealth): KpiItem[] {
    const isRunning = h.daemon.status === "running";
    const mcp = h.mcpServers ?? [];
    const mcpOk = mcp.filter((m) => m.status === "ok").length;
    const mcpWarn = mcp.filter((m) => m.status === "warn");
    const mcpDegraded = mcpWarn.length > 0
        ? `${mcpWarn[0]?.name ?? ""} degraded`
        : "all healthy";
    const chain = h.pluginChain ?? [];
    const totalPkgs = chain.reduce((s, c) => s + c.packages.length, 0);
    const reviewers = chain.find((c) => c.name === "REVIEWERS");
    const deploys = chain.find((c) => c.name === "DEPLOY");
    const variants = chain.find((c) => c.name === "VARIANTS");
    const chainSub = `${String(reviewers?.packages.length ?? 0)} reviewer · ${String(deploys?.packages.length ?? 0)} deploy · ${String(variants?.packages.length ?? 0)} variant`;
    const stdCount = h.standardsCount ?? 0;
    const immutable = h.immutableCount ?? 0;
    const uptime = h.uptime ?? "";
    const pidLabel = h.daemon.pid !== null
        ? `pid ${String(h.daemon.pid)}${uptime ? ` · ${uptime}` : ""}`
        : "—";

    return [
        {
            id: "kpi-daemon",
            sseChannel: "ops:health",
            label: "Loop daemon",
            value: isRunning ? "running" : "STOPPED",
            sub: pidLabel,
            tone: isRunning ? "ok" : "err",
        },
        {
            id: "kpi-mcp",
            sseChannel: "ops:health",
            label: "MCP servers",
            value: `${String(mcpOk)}/${String(mcp.length)}`,
            sub: mcpDegraded,
            tone: mcpWarn.length > 0 ? "warn" : "ok",
        },
        {
            id: "kpi-chain",
            sseChannel: "ops:health",
            label: "Plugin chain",
            value: String(totalPkgs),
            sub: chainSub,
        },
        {
            id: "kpi-standards",
            sseChannel: "ops:health",
            label: "Standards",
            value: String(stdCount),
            sub: `${String(immutable)} immutable`,
        },
    ];
}

/** Render the breaker card. Closed = ok; half-open = warn; open = err. */
const CircuitBreakerCard: FC<{ health: OpsHealth }> = ({ health }) => {
    const cb = health.circuitBreaker;
    if (!cb) {
        return <EmptyState noun="circuit breaker telemetry" />;
    }
    const tone =
        cb.state === "closed"
            ? "ok"
            : cb.state === "half-open"
              ? "warn"
              : "err";
    const labelMap: Record<typeof cb.state, string> = {
        closed: "CLOSED",
        "half-open": "HALF-OPEN",
        open: "OPEN",
    };
    return (
        <Card padding="md">
            <div class="cb-card">
                <div class="cb-head">
                    <h3>Circuit breaker</h3>
                    <Chip variant="status" tone={tone}>
                        {labelMap[cb.state]}
                    </Chip>
                </div>
                <dl class="kv mono">
                    <dt>Failures (window)</dt>
                    <dd>{String(cb.failureCount)}</dd>
                    <dt>State changed</dt>
                    <dd>{cb.changedAt ?? "—"}</dd>
                </dl>
            </div>
        </Card>
    );
};

const OpsHeadActions: FC<{ health: OpsHealth; csrfToken?: string }> = ({
    health,
    csrfToken,
}) => {
    // PLAN-038 polish — the rail-ops bar (bottom of left rail) already
    // carries the Kill switch button (see ShellLayout). Duplicating it
    // on the Ops surface adds visual noise without adding capability.
    void health;
    void csrfToken;
    return (
        <>
            <Btn
                hx-get="/ops"
                hx-target="#ops-body"
                hx-swap="outerHTML"
                hx-select="#ops-body"
            >
                Refresh
            </Btn>
        </>
    );
};

export const OpsView: FC<RenderProps["ops"] & { csrfToken?: string }> = ({
    health,
    csrfToken,
}) => {
    const offline = health.daemon.status !== "running";
    const kpis = buildOpsKpis(health);
    const heartbeat = health.heartbeat ?? [];
    const recentLog = health.recentLog ?? [];
    const deployEvents = health.deployEvents ?? [];
    const mcpServers = health.mcpServers ?? [];
    const standardsChanges = health.standardsChanges ?? [];
    const pluginChain = health.pluginChain ?? [];

    return (
        <div
            id="ops-body"
            hx-get="/ops"
            hx-trigger={OPS_POLLING_TRIGGER}
            hx-target="this"
            hx-swap="outerHTML"
            hx-select="#ops-body"
        >
            {/* PORTAL-AUDIT-2026-05-16: 10s polling. Heartbeat age,
                daemon status pill, plugin-chain state, and recent log
                events all tick. The reset-circuit-breaker form lives
                in the head-actions; clicking it is instant so the
                10s re-render won't disturb it. */}
            {/* Region 1: page head */}
            <div class="page-head">
                <h1>Operations</h1>
                <div class="head-actions">
                    <OpsHeadActions health={health} csrfToken={csrfToken} />
                </div>
            </div>

            {/* Region 2: KPI strip */}
            <KpiStrip items={kpis} />

            {/* Daemon status sub-region: heartbeat sparkline + live dot. */}
            <section
                class="sec daemon-status"
                id="daemon-status"
                data-sse="ops:health"
            >
                <div class="sec-head">
                    <h2>Heartbeat · last 24h</h2>
                    <span class="meta-mono dim">
                        {offline ? "offline" : "live"}
                    </span>
                </div>
                <HeartbeatSparkline
                    samples={heartbeat}
                    offline={offline}
                />
            </section>

            {/* Region 3: plugin chain */}
            <section class="sec">
                <div class="sec-head">
                    <h2>Plugin chain</h2>
                    <span class="meta-mono dim">
                        PRD-013 · resolution order
                    </span>
                </div>
                {pluginChain.length > 0 ? (
                    <PluginChain categories={pluginChain} />
                ) : (
                    <EmptyState noun="plugin chain data" />
                )}
            </section>

            {/* Region 4: ops-grid #1 — log + deploys */}
            <div class="ops-grid">
                <section class="sec">
                    <div class="sec-head">
                        <h2>Live log</h2>
                        <span class="meta-mono dim">
                            tail -f · last 50
                        </span>
                    </div>
                    <div data-sse="ops:log">
                        <LiveLog
                            entries={recentLog}
                            offline={offline}
                        />
                    </div>
                </section>

                <section class="sec" data-sse="ops:deploys">
                    <div class="sec-head">
                        <h2>Deploy events</h2>
                        <span class="meta-mono dim">
                            PRD-014 · last 24h
                        </span>
                    </div>
                    {deployEvents.length > 0 ? (
                        <table class="tbl tight deploy-events">
                            <thead>
                                <tr>
                                    <th>Time</th>
                                    <th>Backend</th>
                                    <th>Env</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {deployEvents.map((d) => (
                                    <tr>
                                        <td class="meta-mono dim">
                                            {d.time}
                                        </td>
                                        <td>
                                            <Chip
                                                variant="status"
                                                tone="info"
                                            >
                                                {d.backend}
                                            </Chip>
                                        </td>
                                        <td>{d.env}</td>
                                        <td>
                                            <Chip
                                                variant="status"
                                                tone={d.status}
                                            >
                                                {d.statusLabel}
                                            </Chip>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        <EmptyState noun="deploy events" />
                    )}
                </section>
            </div>

            {/* Region 5: ops-grid #2 — MCP + standards changes */}
            <div class="ops-grid">
                <section class="sec" data-sse="ops:mcp">
                    <div class="sec-head">
                        <h2>MCP servers</h2>
                    </div>
                    {mcpServers.length > 0 ? (
                        <table class="tbl tight mcp-servers">
                            <tbody>
                                {mcpServers.map((m) => (
                                    <tr>
                                        <td>{m.name}</td>
                                        <td>
                                            <Chip
                                                variant="status"
                                                tone={m.status}
                                            >
                                                {m.status === "ok"
                                                    ? "ok"
                                                    : m.status === "warn"
                                                      ? "degraded"
                                                      : "down"}
                                            </Chip>
                                        </td>
                                        <td class="meta-mono dim">
                                            {m.detail}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        <EmptyState noun="MCP server telemetry" />
                    )}
                </section>

                <section class="sec">
                    <div class="sec-head">
                        <h2>Recent standards changes</h2>
                        <span class="meta-mono dim">PRD-013</span>
                    </div>
                    {standardsChanges.length > 0 ? (
                        <div class="event-list">
                            {standardsChanges.map((e) => (
                                <div class="event-row">
                                    <div class="event-time meta-mono">
                                        {e.time}
                                    </div>
                                    <div>{e.text}</div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <EmptyState noun="standards changes" />
                    )}
                </section>
            </div>

            {/* Region 6: circuit breaker */}
            <section class="sec">
                <CircuitBreakerCard health={health} />
            </section>

            {/* Components dl kept as a compact secondary block — gives
                visual regression a stable anchor for parity with the
                legacy view, and consumers (e.g. /health) cross-reference
                the same shape. */}
            <section class="sec">
                <div class="sec-head">
                    <h2>Components</h2>
                </div>
                <dl class="kv mono components-list">
                    {Object.entries(health.components).map(
                        ([name, status]) => (
                            <>
                                <dt>{name}</dt>
                                <dd>
                                    <Dot
                                        tone={
                                            status === "ok"
                                                ? "ok"
                                                : status === "warn"
                                                  ? "warn"
                                                  : status === "err"
                                                    ? "err"
                                                    : "muted"
                                        }
                                    />
                                    <span>{status}</span>
                                </dd>
                            </>
                        ),
                    )}
                </dl>
            </section>
        </div>
    );
};

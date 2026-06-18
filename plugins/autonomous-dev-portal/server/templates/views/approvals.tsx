// FR-026-30 §Approvals view — v3 redesign.
//
// Layout:
//   1. <Topbar title="Approvals" subTitle="N pending" rightSlot=tabs+bulk />
//   2. .filter-strip — search + gate seg + spacer + oldest meta
//   3. .card .approvals-table — 6-column approval-row grid
//      columns: request | title | gate | reviewer-checks | waiting | actions
//   4. .approvals-lower-grid — preview card + gate-stats-7d card
//
// #504 fix (operator bug): the ACTIONS column was empty and the
// Approve/Reject/Inspect buttons rendered stranded BELOW the table. Root
// cause: the row was a <button> wrapping nested <button>/<a> elements —
// invalid HTML, so the parser hoisted the inner interactive elements out
// of the row. Fix:
//   - the row is now a <div> (no nested-interactive violation),
//   - Approve/Reject render per-row INSIDE the .approval-row-actions cell,
//   - the request id + title is a real <a> link to the REQ-XXXXXX detail
//     page (covers the old INSPECT button, which is dropped),
//   - the inline `onClick="event.stopPropagation()"` (dead under strict
//     CSP) is gone — no whole-row click handler remains to stop.
//
// #429 feature: the Pending/Approved/Rejected tabs and the "Gate stats ·
// 7d" card are now backed by REAL gate-decision history (the route reads
// wiring/gate-history-reader.ts over the gate-decisions store). Approved
// and Rejected tabs list decided gates; the stats card shows live counts
// + approve/reject rate. When nothing is decided yet the tabs/card render
// honest empty/zero states — no fabricated constants (#389 precedent).
//
// CSP-clean: no inline style="" (except the data-driven --bar-w custom
// property on the stats track); no inline onclick/hx-on; tokens only.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";
import type {
    ApprovalItem,
    ApprovalsTab,
    GateHistoryItem,
    GateStats7d,
} from "../../types/render";
import { Topbar } from "../../components/topbar";
import { ApprovalsKpiStrip } from "../fragments/approvals-kpi-strip";

// ---- View-local types -------------------------------------------------------

/**
 * Reviewer check-dot status. Corresponds to the `.cdot` CSS modifier on
 * `.approval-row .checks`.
 */
type CdotStatus = "pass" | "warn" | "fail" | "pending";

/**
 * Extended approval item that adds v3-specific reviewer check dots.
 * Declared locally so we do NOT widen `ApprovalItem` in types/render.ts.
 */
interface ApprovalsRowItem extends ApprovalItem {
    checks?: CdotStatus[];
}

// Pre-computed hx-trigger value
const APPROVALS_POLLING_TRIGGER =
    'every 10s [document.visibilityState === "visible"]';

// ---- StatRow sub-component --------------------------------------------------

interface StatRowProps {
    label: string;
    value: number;
    /** CSS token suffix for the bar fill modifier (`ok`/`info`/`err`/`warn`). */
    colorToken: string;
    pct: number;
}

const StatRow: FC<StatRowProps> = ({ label, value, colorToken, pct }) => (
    <div class="stat-row">
        <div class="stat-row-head">
            <span class="stat-row-label">{label}</span>
            <span class="spacer" />
            <span class="stat-row-value">{value}</span>
            <span class="stat-row-pct">{pct}%</span>
        </div>
        {/* Bar width is data-derived and cannot be a static token. Setting
            only a CSS custom property (not a layout/color style) on the track
            lets the CSS consume var(--bar-w); the CSP style-src restriction
            targets presentation properties, and a single custom-property
            assignment is the accepted server-driven-dimension pattern. */}
        <div
            class="stat-row-track"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${label}: ${pct}%`}
            style={`--bar-w:${pct}%`}
        >
            <div class={`stat-row-bar stat-row-bar--${colorToken}`} />
        </div>
    </div>
);

// ---- Tabs (#429) ------------------------------------------------------------
//
// Real Pending/Approved/Rejected tabs. Each is an HTMX-driven link that
// re-fetches the page body with `?tab=<id>` (and preserves the selected
// row). They are NO LONGER dead controls: the route reads gate-decision
// history so Approved/Rejected render actual decided gates, and Pending
// shows the live queue.

interface ApprovalsTabsProps {
    active: ApprovalsTab;
    pendingCount: number;
    approvedCount: number;
    rejectedCount: number;
}

const TAB_DEFS: { id: ApprovalsTab; label: string }[] = [
    { id: "pending", label: "Pending" },
    { id: "approved", label: "Approved" },
    { id: "rejected", label: "Rejected" },
];

const ApprovalsTabs: FC<ApprovalsTabsProps> = ({
    active,
    pendingCount,
    approvedCount,
    rejectedCount,
}) => {
    const countFor = (id: ApprovalsTab): number =>
        id === "pending"
            ? pendingCount
            : id === "approved"
              ? approvedCount
              : rejectedCount;
    return (
        <div class="approvals-tabs" role="tablist" aria-label="Approvals filter">
            {TAB_DEFS.map((t) => {
                const isActive = t.id === active;
                return (
                    <a
                        class={`approvals-tab${isActive ? " active" : ""}`}
                        role="tab"
                        aria-selected={isActive ? "true" : "false"}
                        href={`/approvals?tab=${t.id}`}
                        hx-get={`/approvals?tab=${t.id}`}
                        hx-target="#approvals-body"
                        hx-swap="outerHTML"
                        hx-select="#approvals-body"
                    >
                        {t.label}
                        <span class="approvals-tab-count">{countFor(t.id)}</span>
                    </a>
                );
            })}
        </div>
    );
};

// ---- Table header (pending) -------------------------------------------------

const ApprovalsTableHead: FC = () => (
    <div class="approvals-table-head">
        <span>Request</span>
        <span>Title</span>
        <span>Gate</span>
        <span>Reviewer checks</span>
        <span class="approvals-th-right">Waiting</span>
        <span class="approvals-th-right">Actions</span>
    </div>
);

// ---- Approval row (pending) -------------------------------------------------
//
// #504 fix: the row is a <div>, NOT a <button>. Nested interactive elements
// (the Approve/Reject buttons and the detail link) are valid inside a div
// but were invalid inside the old <button>, which is why the actions were
// hoisted out of the grid and stranded below the table. `data-gate-type`
// makes the row participate in the segmented filter (segmented-filter.js).

interface ApprovalRowProps {
    item: ApprovalsRowItem;
    selected: boolean;
}

const ApprovalRow: FC<ApprovalRowProps> = ({ item, selected }) => {
    const checks: CdotStatus[] = item.checks ?? [];
    const detailHref = `/repo/${item.repo}/request/${item.id}`;

    return (
        <div
            class={`approval-row${selected ? " selected" : ""}`}
            data-approval-id={item.id}
            data-gate-type={item.gateType}
        >
            {/* #504: request id is a real link to the detail page (covers
                the dropped INSPECT button). */}
            <a class="approval-row-id" href={detailHref}>
                {item.id}
            </a>
            <span class="approval-row-titlewrap">
                {/* #504: title is also a link to the same detail page. */}
                <a class="approval-row-title" href={detailHref}>
                    {item.summary}
                </a>
                <span class="approval-row-sub">{item.detail}</span>
            </span>
            <span>
                <span class={`chip-phase ${item.phase}`}>{item.phase}</span>
            </span>
            <span class="approval-row-checks" aria-label="Reviewer checks">
                {checks.map((c, i) => (
                    <span
                        class={`cdot cdot--${c}`}
                        title={c}
                        aria-label={`Reviewer ${i + 1}: ${c}`}
                    />
                ))}
            </span>
            <span class="approval-row-age">{item.waitedMin}m</span>
            {/* #504: per-row ACTIONS, rendered INSIDE the grid cell. */}
            <span class="approval-row-actions">
                <button
                    type="button"
                    class="btn xs ok-btn"
                    hx-post={`/api/approvals/${item.id}/approve`}
                    hx-include="#approvals-csrf"
                    hx-confirm="Approve this gate?"
                    hx-target={`[data-approval-id="${item.id}"]`}
                    hx-swap="outerHTML"
                    aria-label={`Approve ${item.id}`}
                >
                    Approve
                </button>
                <button
                    type="button"
                    class="btn xs destructive"
                    hx-post={`/api/approvals/${item.id}/reject`}
                    hx-include="#approvals-csrf"
                    hx-confirm="Reject this gate? This will block the pipeline."
                    hx-target={`[data-approval-id="${item.id}"]`}
                    hx-swap="outerHTML"
                    aria-label={`Reject ${item.id}`}
                >
                    Reject
                </button>
            </span>
        </div>
    );
};

// ---- History row (#429, approved/rejected tabs) -----------------------------

const decisionTone = (d: GateHistoryItem["decision"]): string =>
    d === "approved" ? "ok" : d === "rejected" ? "err" : "warn";

/** Format an ISO-8601 timestamp for the history table; "—" when absent. */
function fmtDecidedAt(iso: string | undefined): string {
    if (iso === undefined) return "—";
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "—";
    // Compact, locale-independent UTC stamp (YYYY-MM-DD HH:MM).
    return new Date(t).toISOString().slice(0, 16).replace("T", " ");
}

const HistoryTable: FC<{ items: GateHistoryItem[]; emptyNoun: string }> = ({
    items,
    emptyNoun,
}) => (
    <div class="card approvals-card" aria-label={`${emptyNoun} gates`}>
        <div class="approvals-history-head">
            <span>Request</span>
            <span>Repo</span>
            <span>Gate</span>
            <span>Decision</span>
            <span>By</span>
            <span class="approvals-th-right">Decided</span>
        </div>
        <div class="approvals-table-rows">
            {items.length === 0 ? (
                <div class="approvals-empty">No {emptyNoun} gates yet</div>
            ) : (
                items.map((h) => (
                    <div class="approvals-history-row">
                        <a
                            class="approval-row-id"
                            href={`/repo/${h.repo}/request/${h.id}`}
                        >
                            {h.id}
                        </a>
                        <span class="approval-row-sub">{h.repo}</span>
                        <span>
                            <span class={`chip-phase ${h.phase}`}>{h.phase}</span>
                        </span>
                        <span>
                            <span class={`chip ${decisionTone(h.decision)}`}>
                                {h.decision}
                            </span>
                        </span>
                        <span class="approval-row-sub">
                            {h.decidedBy ?? "—"}
                        </span>
                        <span class="approval-row-age">
                            {fmtDecidedAt(h.decidedAt)}
                        </span>
                    </div>
                ))
            )}
        </div>
    </div>
);

// ---- Preview card -----------------------------------------------------------

interface PreviewCardProps {
    selected: ApprovalsRowItem | undefined;
    onOpenPath: string;
}

const PreviewCard: FC<PreviewCardProps> = ({ selected, onOpenPath }) => (
    <div class="card">
        <div class="card-h">
            <h3>
                {selected !== undefined
                    ? `Selected · ${selected.id}`
                    : "No selection"}
            </h3>
            <span class="meta">reviewer verdicts</span>
            <span class="spacer" />
            {selected !== undefined ? (
                <a class="btn xs ghost" href={onOpenPath}>
                    Open full →
                </a>
            ) : null}
        </div>
        <div class="card-b">
            {selected !== undefined ? (
                <>
                    <p class="approvals-preview-label">
                        Reviewer verdicts · last 3
                    </p>
                    <div class="artifact approvals-preview-artifact">
                        <p>
                            <strong>Gate:</strong> {selected.phase} phase —
                            {selected.detail}
                        </p>
                        <p>
                            <strong>Repo:</strong> {selected.repo} ·{" "}
                            <strong>Waited:</strong> {selected.waitedMin} min ·{" "}
                            <strong>Cost:</strong> ${selected.cost.toFixed(2)}
                        </p>
                    </div>
                </>
            ) : (
                <p class="dim approvals-preview-empty">
                    Click a row to preview reviewer verdicts.
                </p>
            )}
        </div>
    </div>
);

// ---- Gate stats card (#429) -------------------------------------------------
//
// Now backed by the REAL 7-day gate-decision history (route reads
// gate-history-reader.ts). `null` (or absent) means the history reader
// produced nothing — render an honest empty card. A live stats object with
// total === 0 also renders the empty card (zero decided gates in window),
// never the old design-reference constants.

const GateStatsCard: FC<{ stats: GateStats7d | null | undefined }> = ({
    stats,
}) => {
    if (stats === null || stats === undefined || stats.total === 0) {
        return (
            <div class="card">
                <div class="card-h">
                    <h3>Gate stats · 7d</h3>
                </div>
                <p class="empty dim">
                    No gate history yet — stats appear once gate decisions
                    are recorded.
                </p>
            </div>
        );
    }

    const total = stats.total;
    const pct = (n: number) =>
        total > 0 ? Math.round((n / total) * 100) : 0;
    const ratePct = Math.round(stats.approveRate * 100);

    return (
        <div class="card">
            <div class="card-h">
                <h3>Gate stats · 7d</h3>
                <span class="spacer" />
                <span class="meta-mono dim">
                    {total} decided · {ratePct}% approved
                </span>
            </div>
            <div class="card-b approvals-stats-body">
                <StatRow
                    label="Approved"
                    value={stats.approved}
                    colorToken="ok"
                    pct={pct(stats.approved)}
                />
                <StatRow
                    label="Rejected"
                    value={stats.rejected}
                    colorToken="err"
                    pct={pct(stats.rejected)}
                />
                <StatRow
                    label="Re-spec'd"
                    value={stats.requestChanges}
                    colorToken="warn"
                    pct={pct(stats.requestChanges)}
                />
                <div class="approvals-stats-median">
                    <span>Approve rate ({stats.windowDays}d)</span>
                    <span class="approvals-stats-median-val">{ratePct}%</span>
                </div>
            </div>
        </div>
    );
};

// ---- Main view --------------------------------------------------------------

/**
 * FR-026-30 — Approvals v3 view.
 *
 * Renders the sticky Topbar (Pending/Approved/Rejected tabs + Bulk
 * approve), filter strip, the 6-column pending grid (with per-row actions,
 * #504), the decided-gate history tables for the Approved/Rejected tabs
 * (#429), the selected-row preview card, and the live 7-day gate-stats
 * card (#429).
 *
 * @param props - RenderProps["approvals"] from the route handler.
 */
export const ApprovalsView: FC<RenderProps["approvals"]> = ({
    items,
    costCapDailyUsd,
    selectedId: selectedIdProp,
    csrfToken,
    tab,
    history,
    gateStats,
}) => {
    const rows = items as ApprovalsRowItem[];
    const activeTab: ApprovalsTab = tab ?? "pending";
    const historyItems = history ?? [];

    // Poll URL: canonical "/approvals" on the default (pending) tab so the
    // auto-refresh contract matches the other surfaces; non-default tabs
    // carry ?tab=<tab> so the poll preserves the active history view.
    const pollUrl =
        activeTab === "pending" ? "/approvals" : `/approvals?tab=${activeTab}`;

    // History counts come from the (already-filtered) reader data; total
    // counts for the tab badges are derived from the supplied history.
    const approvedItems = historyItems.filter((h) => h.decision === "approved");
    const rejectedItems = historyItems.filter((h) => h.decision === "rejected");

    // Selected-row resolution for the preview card (pending tab only).
    const firstRow = rows[0];
    const selectedId =
        selectedIdProp !== undefined
            ? selectedIdProp
            : firstRow !== undefined
              ? firstRow.id
              : undefined;
    const selectedItem = rows.find((r) => r.id === selectedId);

    const topbarRight = (
        <>
            <ApprovalsTabs
                active={activeTab}
                pendingCount={rows.length}
                approvedCount={approvedItems.length}
                rejectedCount={rejectedItems.length}
            />
            <button
                type="button"
                class="btn primary sm bulk-approve"
                disabled={rows.length === 0}
                hx-post="/api/approvals/bulk-approve"
                hx-include="[data-segmented-filter='approvals'] .seg-btn.active, #approvals-csrf"
                hx-vals='js:{filter: document.querySelector("[data-segmented-filter=\"approvals\"] .seg-btn.active")?.dataset.filter}'
                hx-confirm="Approve every gate matching the current filter?"
                hx-target=".approvals-table-rows"
                hx-swap="innerHTML"
                title={
                    rows.length === 0
                        ? "No gates to approve"
                        : `Approve all ${rows.length} pending gates`
                }
            >
                Bulk approve
            </button>
        </>
    );

    return (
        <div
            id="approvals-body"
            data-filter-root
            hx-get={pollUrl}
            hx-trigger={APPROVALS_POLLING_TRIGGER}
            hx-target="this"
            hx-swap="outerHTML"
            hx-select="#approvals-body"
            hx-vals='js:{selected: document.querySelector("[data-approval-id].selected")?.dataset.approvalId ?? ""}'
        >
            {/* #391: CSRF token for the approve/reject/bulk actions. */}
            <input
                type="hidden"
                id="approvals-csrf"
                name="_csrf"
                value={csrfToken ?? ""}
            />
            <Topbar
                title="Approvals"
                subTitle={`${rows.length} pending`}
                rightSlot={topbarRight}
            />

            <div class="main-inner">
                {/* KPI strip: 3 cards (reviewer-chain / standards / cost-cap) */}
                <ApprovalsKpiStrip
                    items={items}
                    costCapDailyUsd={costCapDailyUsd}
                />

                {/* Filter strip (gate-type segmented filter; pending tab). */}
                <div class="filter-strip">
                    <input
                        type="search"
                        class="search"
                        placeholder="Filter by id, title, repo…"
                        aria-label="Filter approvals"
                    />
                    <div
                        class="seg"
                        data-segmented-filter="approvals"
                        role="group"
                        aria-label="Gate type filter"
                    >
                        <button
                            type="button"
                            class="seg-btn active"
                            data-filter="all"
                            aria-pressed="true"
                        >
                            All gates
                        </button>
                        <button
                            type="button"
                            class="seg-btn"
                            data-filter="reviewer-chain"
                            aria-pressed="false"
                        >
                            Review
                        </button>
                        <button
                            type="button"
                            class="seg-btn"
                            data-filter="deploy"
                            aria-pressed="false"
                        >
                            Deploy
                        </button>
                        <button
                            type="button"
                            class="seg-btn"
                            data-filter="spec"
                            aria-pressed="false"
                        >
                            Spec
                        </button>
                    </div>
                    <span class="spacer" />
                    <span class="meta-mono dim">
                        Oldest{" "}
                        {rows.length > 0
                            ? `${Math.max(...rows.map((r) => r.waitedMin))}m`
                            : "—"}
                    </span>
                </div>

                {/* Tab body: pending grid OR decided-gate history table. */}
                {activeTab === "pending" ? (
                    <div
                        class="card approvals-card"
                        aria-label="Pending approvals"
                    >
                        <ApprovalsTableHead />
                        <div class="approvals-table-rows">
                            {rows.length === 0 ? (
                                <div class="approvals-empty">
                                    No pending approvals
                                </div>
                            ) : (
                                rows.map((item) => (
                                    <ApprovalRow
                                        item={item}
                                        selected={item.id === selectedId}
                                    />
                                ))
                            )}
                        </div>
                    </div>
                ) : activeTab === "approved" ? (
                    <HistoryTable items={approvedItems} emptyNoun="approved" />
                ) : (
                    <HistoryTable items={rejectedItems} emptyNoun="rejected" />
                )}

                {/* Lower grid: preview card + gate stats */}
                <div class="approvals-lower-grid">
                    <PreviewCard
                        selected={selectedItem}
                        onOpenPath={
                            selectedItem !== undefined
                                ? `/repo/${selectedItem.repo}/request/${selectedItem.id}`
                                : "#"
                        }
                    />
                    <GateStatsCard stats={gateStats} />
                </div>
            </div>
        </div>
    );
};

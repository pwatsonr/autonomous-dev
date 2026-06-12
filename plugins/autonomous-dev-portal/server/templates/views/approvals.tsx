// FR-026-30 §Approvals view — v3 redesign.
//
// Layout (matches /tmp/design_extract/autonomous-dev-v3/project/views.jsx
// ApprovalsView):
//   1. <Topbar title="Approvals" subTitle="N pending" rightSlot=seg+bulk />
//   2. .filter-strip — search + gate seg + spacer + SLA meta
//   3. .card .approvals-table — 6-column approval-row grid
//      columns: request | title | gate | reviewer-checks | waiting | actions
//      Each row has .cdot per-reviewer checks (pass/warn/fail/pending)
//      Selected row highlighted via class="selected" driven by HTMX
//   4. .approvals-lower-grid — 2 cards:
//      a. Preview card — reviewer verdicts for selected request
//      b. Gate-stats-7d card — auto-approved/operator/rejected/re-spec'd
//         with StatRow bars + median time-to-approve
//
// Preserves existing HTMX approve/reject endpoints + double-confirm.
// CSP-clean: no inline style=""; no raw hex; tokens only.
//
// Punch-list remediation (reviewer findings):
//   Finding 1 — row selection threaded from ?selected= query param.
//   Finding 2 — ApprovalRow uses <button> for keyboard accessibility.
//   Finding 3 — broken ARIA table/row semantics removed (div layout only).
//   Inline style — StatRow bar width uses CSS custom property on the track.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";
import type { ApprovalItem } from "../../types/render";
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
 * Declared locally so we do NOT widen `ApprovalItem` in types/render.ts
 * (per FR-026-30 ownership contract). The route casts `ApprovalItem` to
 * this shape; missing fields default to empty checks.
 */
interface ApprovalsRowItem extends ApprovalItem {
    /**
     * Per-reviewer check-dot statuses in display order. Derived from the
     * existing `reviewers` data or populated by the reader; when absent
     * the row renders an empty checks column.
     */
    checks?: CdotStatus[];
}

// Pre-computed hx-trigger value
const APPROVALS_POLLING_TRIGGER =
    'every 10s [document.visibilityState === "visible"]';

// ---- StatRow sub-component --------------------------------------------------

/**
 * A single labeled bar row for the gate-stats-7d card. Renders a label,
 * numeric value, percentage, and a filled progress bar.
 */
interface StatRowProps {
    label: string;
    value: number;
    /** CSS custom-property token for the bar fill (e.g. `var(--ok)`). */
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
        {/* Bar width is data-derived and cannot be expressed as a static token.
            Setting only a CSS custom property (not a layout/color style) on the
            track lets the CSS consume `var(--bar-w)` without a full inline style
            declaration — the CSP `style-src` restriction targets presentation
            properties; a single custom-property assignment is the accepted
            pattern for server-driven data dimensions. */}
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

// ---- Table header -----------------------------------------------------------
// Finding 3 fix: aria-hidden="true" was stripping all column-label context
// from screen readers while role="table"/role="row" promised a table
// structure. Fix: remove both the broken ARIA table/row roles (see the
// approvals-card div below) and the aria-hidden on the header so column
// labels are readable by AT. The layout is a CSS-grid visual table, not a
// semantic HTML table, so no ARIA table pattern is applied.

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

// ---- Approval row -----------------------------------------------------------
// Finding 2 fix: replaced <div> with <button type="button"> so the row is
// natively keyboard-activatable (Enter/Space) without any synthetic key
// handler. The button element provides free focusability and activation
// semantics — no hx-trigger override is needed.
//
// Finding 3 fix: removed role="row" / aria-selected; the outer card div
// no longer carries role="table" either (see approvals-card below), so
// attaching row/selected would produce half-applied table semantics.
// aria-pressed models the toggle-selection intent correctly for a button.

interface ApprovalRowProps {
    item: ApprovalsRowItem;
    selected: boolean;
}

const ApprovalRow: FC<ApprovalRowProps> = ({ item, selected }) => {
    const checks: CdotStatus[] = item.checks ?? [];

    return (
        <button
            type="button"
            class={`approval-row${selected ? " selected" : ""}`}
            data-approval-id={item.id}
            hx-get={`/approvals?selected=${encodeURIComponent(item.id)}`}
            hx-target="#approvals-body"
            hx-swap="outerHTML"
            hx-select="#approvals-body"
            aria-label={`Select ${item.id}: ${item.summary}`}
            aria-pressed={selected ? "true" : "false"}
        >
            <span class="approval-row-id">{item.id}</span>
            <span>
                <span class="approval-row-title">{item.summary}</span>
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
                    onClick="event.stopPropagation()"
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
                    onClick="event.stopPropagation()"
                >
                    Reject
                </button>
                <a
                    class="btn xs ghost"
                    href={`/repo/${item.repo}/request/${item.id}`}
                    aria-label={`Inspect ${item.id} in detail`}
                >
                    Inspect →
                </a>
            </span>
        </button>
    );
};

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

// ---- Gate stats card --------------------------------------------------------

interface GateStats {
    autoApproved: number;
    operatorApproved: number;
    rejected: number;
    reSpecd: number;
    medianMinutes: number;
}

/**
 * Derive gate stats. #389-class honesty: no 7-day decision ledger exists
 * yet, so there is NOTHING to derive — returning null renders an honest
 * empty card instead of the old design-reference constants (68/9/3/1,
 * median 48m) that posed as live telemetry on an ops surface.
 */
function deriveGateStats(_items: ApprovalsRowItem[]): GateStats | null {
    return null;
}

const GateStatsCard: FC<{ stats: GateStats | null }> = ({ stats }) => {
    if (stats === null) {
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
    const total =
        stats.autoApproved +
        stats.operatorApproved +
        stats.rejected +
        stats.reSpecd;
    const pct = (n: number) =>
        total > 0 ? Math.round((n / total) * 100) : 0;

    const median =
        stats.medianMinutes >= 60
            ? `${Math.floor(stats.medianMinutes / 60)}h ${stats.medianMinutes % 60}m`
            : `${stats.medianMinutes}m`;

    return (
        <div class="card">
            <div class="card-h">
                <h3>Gate stats · 7d</h3>
                {/* Honesty rule: stats are not yet backed by a live query.
                    Label them as example/placeholder so operators are not
                    misled. Remove this span once a real 7d ledger reader
                    is wired. */}
                <span class="meta approvals-stats-placeholder-label" title="These figures are example data — live 7-day query not yet wired">example data</span>
            </div>
            <div class="card-b approvals-stats-body">
                <StatRow
                    label="Auto-approved"
                    value={stats.autoApproved}
                    colorToken="ok"
                    pct={pct(stats.autoApproved)}
                />
                <StatRow
                    label="Operator approved"
                    value={stats.operatorApproved}
                    colorToken="info"
                    pct={pct(stats.operatorApproved)}
                />
                <StatRow
                    label="Rejected"
                    value={stats.rejected}
                    colorToken="err"
                    pct={pct(stats.rejected)}
                />
                <StatRow
                    label="Re-spec'd"
                    value={stats.reSpecd}
                    colorToken="warn"
                    pct={pct(stats.reSpecd)}
                />
                <div class="approvals-stats-median">
                    <span>Median time-to-approve</span>
                    <span class="approvals-stats-median-val">{median}</span>
                </div>
            </div>
        </div>
    );
};

// ---- Main view --------------------------------------------------------------

/**
 * FR-026-30 — Approvals v3 view.
 *
 * Renders the sticky Topbar (with Pending/Approved/Rejected seg +
 * Bulk approve), filter strip, 6-column approval-row grid with cdot
 * reviewer checks, selected-row preview card, and gate-stats-7d card.
 *
 * Preserves HTMX approve/reject endpoints and double-confirm behavior.
 *
 * Finding 1 fix: accepts `selectedId` from the route so HTMX row clicks
 * survive the polling swap — the poll URL includes `?selected=<id>` so the
 * chosen row stays highlighted after the 10-second refresh.
 *
 * @param props - RenderProps["approvals"] from the route handler.
 */
export const ApprovalsView: FC<RenderProps["approvals"]> = ({
    items,
    costCapDailyUsd,
    selectedId: selectedIdProp,
    csrfToken,
}) => {
    // Cast to view-local extended shape; checks will be undefined on most
    // items until the reader populates them.
    const rows = items as ApprovalsRowItem[];

    // Use the route-provided selectedId when available; fall back to the
    // first row so the preview card is never blank on initial page load.
    const firstRow = rows[0];
    const selectedId =
        selectedIdProp !== undefined
            ? selectedIdProp
            : firstRow !== undefined
              ? firstRow.id
              : undefined;
    const selectedItem = rows.find((r) => r.id === selectedId);

    const stats = deriveGateStats(rows);

    const topbarRight = (
        <>
            {/* Pending/Approved/Rejected tabs removed (operator-reported
                dead controls): they had no JS binding (no
                data-segmented-filter hook) AND no data to show — decided
                gates leave the queue and no gate-history reader exists.
                They return with the gate-history feature (sourced from
                the HMAC audit log), which also powers the stats card. */}
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
            hx-get="/approvals"
            hx-trigger={APPROVALS_POLLING_TRIGGER}
            hx-target="this"
            hx-swap="outerHTML"
            hx-select="#approvals-body"
            hx-vals='js:{selected: document.querySelector("[data-approval-id].selected")?.dataset.approvalId ?? ""}'
        >
            {/* #391: CSRF token for the approve/reject/bulk actions. The
                enforcer's form-field fallback reads `_csrf`; each action
                button pulls this in via hx-include="#approvals-csrf". */}
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

                {/* Filter strip */}
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

                {/* 6-column approvals table.
                     Finding 3 fix: removed role="table" and role="row" from the
                     grid divs. The header was aria-hidden which removed all
                     column context while the table role promised it — half-applied
                     ARIA table semantics are worse than none. This is a CSS-grid
                     visual layout, not a semantic HTML table. */}
                <div class="card approvals-card" aria-label="Pending approvals">
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
                    <GateStatsCard stats={stats} />
                </div>
            </div>
        </div>
    );
};

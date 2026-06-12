// PLAN-Requests-Surface §Requests view — list every active request
// across the allowlisted repos.
//
// Page composition (mirrors Dashboard / Approvals shape):
//   1. <div class="page-head"> — title + Refresh + + New request
//   2. <KpiStrip> — 4 KPIs (active / in-gate / completed today / MTD)
//   3. <section class="sec"> — segmented filter + .tbl
//        - .sec-head: <h2>All requests · N</h2> + .seg (4 .seg-btn)
//        - <table class="tbl">: Request / Repo / Variant / Phase /
//                                Status / Cost / Age columns
//   4. Empty state (muted "No requests yet") when items is empty
//
// Filter behavior: the segmented filter reuses `segmented-filter.js`
// from Approvals (kit invariant — one filter implementation across the
// portal). The script targets `[data-gate-type]` rows; we tag each row
// with `data-gate-type="<filter-token>"` where the token mirrors the
// segmented-filter button value (`active`, `gate`, `done`). The
// attribute name is a kit holdover — the row IS a request, not a gate,
// but the script's lookup is a pure string match so reusing the
// attribute keeps the JS surface single-source.

import type { FC } from "hono/jsx";

import { Chip } from "../../components/primitives";
import { Topbar } from "../../components/topbar";
import type { PhaseName } from "../../components/primitives";
import type {
    DashboardRequest,
    RenderProps,
    RequestsAggregatesProp,
} from "../../types/render";
import { EmptyState } from "../fragments/empty-state";
import { KpiStrip } from "../fragments/kpi-strip";
import type { KpiItem } from "../fragments/kpi-strip";

// Pre-computed hx-trigger value - using double quotes inside bracket expression
const REQUESTS_POLLING_TRIGGER = 'every 10s [document.visibilityState === "visible"]';

/**
 * PLAN-Requests-Surface §HeadActions — exposed as a stand-alone export
 * so tests / fragments can mount it on `ShellLayout.headActions`
 * without re-importing the `Btn` primitive at the call site. Mirrors
 * the Dashboard "+ New request" pattern verbatim.
 */
export const RequestsHeadActions: FC = () => (
    <>
        <a href="/requests" class="btn">
            Refresh
        </a>
        <a
            href="https://github.com/pwatsonr/autonomous-dev#step-5-submit-your-first-request"
            class="btn primary"
            target="_blank"
            rel="noopener"
        >
            + New request
        </a>
    </>
);

/**
 * Build the four KPI items for the strip. Pure helper kept next to
 * the view so the labels/order stay in one place.
 */
export function buildRequestsKpiItems(
    items: DashboardRequest[],
    a: RequestsAggregatesProp,
): KpiItem[] {
    // Distinct repo count, derived from the items themselves rather
    // than a separate prop so the sub-line stays consistent even when
    // the dashboard stub adds / removes repos.
    const repoCount = new Set(items.map((r) => r.repo)).size;
    return [
        {
            label: "Active",
            value: a.activeCount,
            sub: `across ${repoCount} repo${repoCount === 1 ? "" : "s"}`,
        },
        {
            label: "In gate",
            value: a.inGateCount,
            sub: "awaiting approval",
        },
        {
            label: "Completed today",
            value: a.completedTodayCount,
            sub: "last 24h",
        },
        {
            label: "MTD spend",
            value: `$${a.totalCostMtdUsd.toFixed(2)}`,
            sub: "all requests",
        },
    ];
}

/**
 * Maps a request's lifecycle status to the segmented-filter token used
 * on `data-gate-type`. Kept in one place so the buttons, rows, and
 * filter logic agree.
 */
function filterTokenFor(r: DashboardRequest): "gate" | "done" | "active" {
    if (r.status === "gate") return "gate";
    // Terminal states (done/failed/cancelled) bucket under the
    // "Completed" filter; only queued/running are "active".
    if (
        r.status === "done" ||
        r.status === "failed" ||
        r.status === "cancelled"
    ) {
        return "done";
    }
    return "active";
}

/**
 * Compact human-readable age string ("3m", "2h", "4d") from an
 * ISO-8601 createdAt. Returns "—" when the timestamp is missing or
 * unparseable so the column never renders `NaN`.
 */
function ageLabel(createdAt: string | undefined, now: number): string {
    if (!createdAt) return "—";
    const t = Date.parse(createdAt);
    if (!Number.isFinite(t)) return "—";
    const ms = Math.max(0, now - t);
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
}

/**
 * Status-cell renderer for the requests table. UPPERCASE per R-10.
 * Covers the FULL lifecycle union — the old three-branch version mapped
 * failed/cancelled to a green RUNNING chip, so a page of dead requests
 * looked like a busy pipeline (visual crawl, page 2).
 */
const StatusCell: FC<{ r: DashboardRequest }> = ({ r }) => {
    if (r.status === "gate") {
        return (
            <Chip variant="status" tone="warn">
                GATE
            </Chip>
        );
    }
    if (r.status === "done") {
        return (
            <Chip variant="status" tone="muted">
                DONE
            </Chip>
        );
    }
    if (r.status === "failed") {
        return (
            <Chip variant="status" tone="err">
                FAILED
            </Chip>
        );
    }
    if (r.status === "cancelled") {
        return (
            <Chip variant="status" tone="muted">
                CANCELLED
            </Chip>
        );
    }
    if (r.status === "queued") {
        return (
            <Chip variant="status" tone="muted">
                QUEUED
            </Chip>
        );
    }
    return (
        <Chip variant="status" tone="ok">
            RUNNING
        </Chip>
    );
};

export interface RequestsViewProps {
    items: DashboardRequest[];
    aggregates: RequestsAggregatesProp;
    /** Injected by tests to pin the "Age" column. Defaults to
     *  `Date.now()` so production renders the live wall clock. */
    now?: number;
}

/**
 * PLAN-Requests-Surface §RequestsView — full page body.
 *
 * Composes the four regions documented in the file header. Empty-state
 * path: when `items.length === 0` the table is omitted entirely and a
 * single `EmptyState` row renders the muted "No requests yet" copy.
 */
export const RequestsView: FC<RenderProps["requests"]> = ({
    items,
    aggregates,
}) => {
    const now = Date.now();
    const kpiItems = buildRequestsKpiItems(items, aggregates);

    return (
        <div
            id="requests-body"
            hx-get="/requests"
            hx-trigger={REQUESTS_POLLING_TRIGGER}
            hx-target="this"
            hx-swap="outerHTML"
            hx-select="#requests-body"
        >
            {/* PORTAL-AUDIT-2026-05-16: polls every 10s so the requests
                table stays fresh while a pipeline is running. See the
                matching wrapper on the dashboard. */}
            {/* v3 Topbar (sticky frosted) — the old .page-head h1 was the
                pre-v3 shell generation (operator-reported mismatch). */}
            <Topbar
                title="Requests"
                subTitle={`${items.length} total`}
                rightSlot={<RequestsHeadActions />}
            />
            <div class="main-inner">
            <KpiStrip items={kpiItems} />

            <section class="sec requests">
                <div class="sec-head">
                    <h2>All requests · {items.length}</h2>
                    <div class="seg" data-segmented-filter="requests">
                        <button
                            type="button"
                            class="seg-btn active"
                            data-filter="all"
                            aria-pressed="true"
                        >
                            All
                        </button>
                        <button
                            type="button"
                            class="seg-btn"
                            data-filter="active"
                            aria-pressed="false"
                        >
                            Active
                        </button>
                        <button
                            type="button"
                            class="seg-btn"
                            data-filter="gate"
                            aria-pressed="false"
                        >
                            In gate
                        </button>
                        <button
                            type="button"
                            class="seg-btn"
                            data-filter="done"
                            aria-pressed="false"
                        >
                            Completed
                        </button>
                    </div>
                </div>
                {items.length === 0 ? (
                    <EmptyState noun="requests yet" />
                ) : (
                    <table class="tbl">
                        <thead>
                            <tr>
                                <th>Request</th>
                                <th>Repo</th>
                                <th>Variant</th>
                                <th>Phase</th>
                                <th>Status</th>
                                <th>Cost</th>
                                <th>Age</th>
                            </tr>
                        </thead>
                        <tbody>
                            {items.map((r) => (
                                <tr data-gate-type={filterTokenFor(r)}>
                                    <td>
                                        <a
                                            class="meta-mono"
                                            href={`/repo/${r.repo}/request/${r.id}`}
                                        >
                                            {r.id}
                                        </a>
                                    </td>
                                    <td>{r.repo}</td>
                                    <td>
                                        {/* No variant recorded → plain dash,
                                            not an empty capsule glyph. */}
                                        {(r.variantLabel ?? r.variant) ? (
                                            <Chip variant="status" tone="muted">
                                                {r.variantLabel ?? r.variant}
                                            </Chip>
                                        ) : (
                                            <span class="dim">—</span>
                                        )}
                                    </td>
                                    <td>
                                        <Chip
                                            variant="phase"
                                            tone={r.phase as PhaseName}
                                        />
                                    </td>
                                    <td>
                                        <StatusCell r={r} />
                                    </td>
                                    <td class="meta-mono">
                                        ${r.cost.toFixed(2)}
                                    </td>
                                    <td class="meta-mono">
                                        {ageLabel(r.createdAt, now)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>
            </div>
        </div>
    );
};

// SPEC-013-3-03 §Views — audit view component.
//
// SPEC-015-4-02 §Audit Page — when `page` is supplied (live mode), the
// view renders the HMAC-chained log with filters, integrity indicator,
// and pagination. Otherwise it falls back to the stub `rows` table.

import type { FC } from "hono/jsx";
import { Topbar } from "../../components/topbar";
import { asset } from "../../lib/plugin-version";

import type {
    AuditFiltersProp,
    AuditPageResultProp,
    RenderProps,
} from "../../types/render";
import { AuditRowFragment } from "../fragments/audit-row";

/** Local compact timestamp for table cells — "Jun 12 · 3:38:57 PM"
 *  (crawl p11 round 2: matches the logs page; the portal runs on the
 *  operator's machine so server-local == operator-local; the full UTC
 *  ISO survives on the <time datetime>/title attributes). */
function formatTimestampCompact(iso: string): string {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    const d = new Date(ts);
    const date = d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
    });
    const time = d.toLocaleTimeString("en-US", { hour12: true });
    return `${date} · ${time}`;
}

const integrityLabel: Record<AuditPageResultProp["integrityStatus"], string> = {
    verified: "Chain verified",
    warning: "Chain verified · with anomalies",
    error: "Chain integrity FAILED",
    unknown: "Chain integrity unknown",
    // Note: "FAILED" stays uppercase per design system status-badge rule.
};

/** Honest anomaly annotation (crawl p11): the live log carries a
 *  historical restart (early-version boot re-issued #10-11) — say so
 *  instead of rendering a page-wide "unknown". */
function integrityNote(
    detail?: import("../../types/audit-types").IntegrityDetail,
): string {
    if (detail === undefined) return "";
    const parts: string[] = [];
    if ((detail.chainRestarts ?? 0) > 0) {
        parts.push(
            `chain restarted ${String(detail.chainRestarts)}× (at #${String(detail.restartAtSequence ?? "?")}, early-version artifact — segments self-verify)`,
        );
    }
    if (detail.sequenceGaps > 0) {
        parts.push(
            `${String(detail.sequenceGaps)} sequence ${detail.sequenceGaps === 1 ? "anomaly" : "anomalies"}`,
        );
    }
    return parts.join(" · ");
}

interface IntegrityProps {
    status: AuditPageResultProp["integrityStatus"];
    detail?: AuditPageResultProp["integrityDetail"];
}

const IntegrityIndicator: FC<IntegrityProps> = ({ status, detail }) => (
    <span class={`integrity integrity--${status}`} title={integrityLabel[status]}>
        {integrityLabel[status]}
        {status === "error" && detail !== undefined && (
            <span class="integrity__detail">
                {" "}(first failing seq:{" "}
                {detail.firstFailingSequence !== undefined
                    ? String(detail.firstFailingSequence)
                    : "?"}
                )
            </span>
        )}
        {status === "warning" && detail !== undefined && (
            <span class="integrity__detail dim">
                {" "}— {integrityNote(detail)}
            </span>
        )}
    </span>
);

function buildQuery(
    page: number,
    filters: AuditFiltersProp,
): string {
    const params = new URLSearchParams();
    params.set("page", String(page));
    if (filters.operatorId !== undefined && filters.operatorId.length > 0) {
        params.set("operatorId", filters.operatorId);
    }
    if (filters.action !== undefined && filters.action.length > 0) {
        params.set("action", filters.action);
    }
    if (filters.startDate !== undefined) {
        params.set("startDate", filters.startDate.toISOString().slice(0, 10));
    }
    if (filters.endDate !== undefined) {
        params.set("endDate", filters.endDate.toISOString().slice(0, 10));
    }
    return params.toString();
}

interface PaginationProps {
    page: AuditPageResultProp;
    filters: AuditFiltersProp;
}

const Pagination: FC<PaginationProps> = ({ page, filters }) => {
    const totalPages = Math.max(1, Math.ceil(page.totalCount / page.pageSize));
    return (
        <nav class="audit-pagination" aria-label="Audit log pagination">
            {/* Crawl p11 round 6 — operator: "pagination doesn't match
                our look and feel". The prev/next links had NO css (raw
                browser blue underlines) and "Page X of Y" was unstyled.
                Now: muted mono indicator + kit ghost buttons, matching
                every other nav control on the site (e.g. dashboard's
                "All agents →"). Plain navigation — the page holds no
                live state (round 3: hx-get with no select ate the
                page). */}
            <span class="meta-mono dim">
                Page {String(page.currentPage)} of {String(totalPages)}
            </span>
            <span class="spacer"></span>
            {page.hasPrevious ? (
                <a
                    class="btn ghost sm"
                    href={`/audit?${buildQuery(page.currentPage - 1, filters)}`}
                >
                    ← Prev
                </a>
            ) : (
                <span class="btn ghost sm" aria-disabled="true">
                    ← Prev
                </span>
            )}
            {page.hasNext ? (
                <a
                    class="btn ghost sm"
                    href={`/audit?${buildQuery(page.currentPage + 1, filters)}`}
                >
                    Next →
                </a>
            ) : (
                <span class="btn ghost sm" aria-disabled="true">
                    Next →
                </span>
            )}
        </nav>
    );
};

interface FilterFormProps {
    filters: AuditFiltersProp;
}

const FilterForm: FC<FilterFormProps> = ({ filters }) => (
    <form class="audit-filters" method="get" action="/audit" hx-push-url="true">
        <label>
            Operator
            <input
                class="input"
                type="text"
                name="operatorId"
                value={filters.operatorId ?? ""}
                placeholder="alice"
            />
        </label>
        <label>
            Action
            <input
                class="input"
                type="text"
                name="action"
                value={filters.action ?? ""}
                placeholder="kill-switch"
            />
        </label>
        <label>
            From
            <input
                class="input"
                type="date"
                name="startDate"
                value={
                    filters.startDate !== undefined
                        ? filters.startDate.toISOString().slice(0, 10)
                        : ""
                }
            />
        </label>
        <label>
            To
            <input
                class="input"
                type="date"
                name="endDate"
                value={
                    filters.endDate !== undefined
                        ? filters.endDate.toISOString().slice(0, 10)
                        : ""
                }
            />
        </label>
        <button type="submit" class="btn primary sm">Apply filters</button>
    </form>
);

// #396: daemon-applied config changes happen outside the portal process,
// so they never enter the HMAC-chained portal audit log. Render them as a
// clearly-separate section (sourced from config-changes/applied/) instead
// of silently omitting config history from the audit surface.
const ConfigChangesSection: FC<{
    changes: NonNullable<RenderProps["audit"]["configChanges"]>;
}> = ({ changes }) => (
    <section class="sec audit-config-changes">
        <div class="sec-head">
            <h2>Config changes</h2>
            <span class="meta-mono dim">
                daemon-applied · outside the HMAC chain
            </span>
        </div>
        <div class="card">
        <table class="tbl audit-cc-table">
            <thead>
                <tr>
                    <th>Timestamp</th>
                    <th>Actor</th>
                    <th>Summary</th>
                    <th>Marker</th>
                </tr>
            </thead>
            <tbody>
                {changes.map((m) => (
                    <tr key={m.id}>
                        <td class="mono" title={m.ts}>
                            {formatTimestampCompact(m.ts)}
                        </td>
                        <td>{m.actor}</td>
                        <td>{m.summary}</td>
                        <td class="mono">{m.id.slice(0, 8)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
        </div>
    </section>
);

/** Audit tabs (crawl p11 round 4, operator request): the two datasets
 *  answer different questions — "what did the operator do?" (HMAC
 *  chain) vs "what did the daemon apply?" (marker archive) — and
 *  stacked they made the page feel endless. Counts stay visible on the
 *  labels so the second tab is never forgotten. Reuses the settings tab
 *  mechanics (settings-tabs.js, deep-linkable ?tab=). */
const AuditTabs: FC<{
    active: string;
    chainCount: number;
    configCount: number;
}> = ({ active, chainCount, configCount }) => (
    <nav
        class="seg seg-tabs"
        role="tablist"
        aria-label="Audit datasets"
        data-active-tab={active}
        data-default-tab="chain"
    >
        <button
            type="button"
            class={active === "chain" ? "seg-btn on" : "seg-btn"}
            data-tab="chain"
            role="tab"
            aria-selected={active === "chain" ? "true" : "false"}
        >
            Operator log · {String(chainCount)}
        </button>
        <button
            type="button"
            class={active === "config" ? "seg-btn on" : "seg-btn"}
            data-tab="config"
            role="tab"
            aria-selected={active === "config" ? "true" : "false"}
        >
            Config changes · {String(configCount)}
        </button>
    </nav>
);

export const AuditView: FC<RenderProps["audit"]> = ({ rows, page, filters, configChanges, activeTab }) => {
    const tab = activeTab === "config" ? "config" : "chain";
    const ccCount = configChanges?.length ?? 0;
    if (page === undefined) {
        return (
            <section class="audit">
                <Topbar title="Audit log" subTitle="HMAC-chained operator log" />
                <div class="main-inner">
                <table class="tbl audit-stub-table">
                    <thead>
                        <tr>
                            <th>Timestamp</th>
                            <th>Actor</th>
                            <th>Action</th>
                            <th>Target</th>
                            <th>Result</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <AuditRowFragment
                                ts={r.ts}
                                actor={r.actor}
                                action={r.action}
                                target={r.target}
                                result={r.result}
                            />
                        ))}
                    </tbody>
                </table>
                {configChanges !== undefined && configChanges.length > 0 && (
                    <ConfigChangesSection changes={configChanges} />
                )}
                </div>
            </section>
        );
    }

    const liveFilters: AuditFiltersProp = filters ?? {};
    return (
        <section class="audit">
            <Topbar title="Audit log" subTitle="HMAC-chained operator log" />
            <div class="main-inner">
            {ccCount > 0 ? (
                <AuditTabs
                    active={tab}
                    chainCount={page.totalCount}
                    configCount={ccCount}
                />
            ) : null}
            <section
                class="sec"
                data-tab-panel="chain"
                {...(tab !== "chain" ? { hidden: true } : {})}
            >
                <div class="sec-head">
                    <h2>Operator log</h2>
                    <div class="head-actions audit-status">
                        <IntegrityIndicator
                            status={page.integrityStatus}
                            detail={page.integrityDetail}
                        />
                        <span class="audit-totals">
                            {String(page.totalCount)} total entries
                        </span>
                    </div>
                </div>
                <div class="card">
                <FilterForm filters={liveFilters} />
                <table class="tbl audit-chain-table">
                    <thead>
                        <tr>
                            <th>Seq</th>
                            <th>Timestamp</th>
                            <th>Operator</th>
                            <th>Action</th>

                        </tr>
                    </thead>
                    <tbody>
                        {page.entries.map((entry) => (
                            <tr class="audit-row">
                                <td><code>{String(entry.sequence)}</code></td>
                                <td>
                                    <time datetime={entry.timestamp} class="mono">
                                        {formatTimestampCompact(entry.timestamp)}
                                    </time>
                                </td>
                                <td><code>{entry.operatorId}</code></td>
                                <td>{entry.action}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <Pagination page={page} filters={liveFilters} />
                </div>
            </section>
            {configChanges !== undefined && configChanges.length > 0 && (
                <div
                    data-tab-panel="config"
                    {...(tab !== "config" ? { hidden: true } : {})}
                >
                    <ConfigChangesSection changes={configChanges} />
                </div>
            )}
            <script
                src={asset("/static/js/settings-tabs.js")}
                type="module"
            ></script>
            </div>
        </section>
    );
};

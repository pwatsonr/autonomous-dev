// SPEC-013-3-03 §Views — audit view component.
//
// SPEC-015-4-02 §Audit Page — when `page` is supplied (live mode), the
// view renders the HMAC-chained log with filters, integrity indicator,
// and pagination. Otherwise it falls back to the stub `rows` table.

import type { FC } from "hono/jsx";
import { Topbar } from "../../components/topbar";

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
            {/* Crawl p11 round 3 — operator: "what is even going on".
                These links carried hx-get into #audit-content with NO
                hx-select: clicking Next injected the ENTIRE PAGE
                (Topbar, filters, everything) inside the table container.
                Plain navigation is bulletproof here — the page has no
                live state to preserve. */}
            {page.hasPrevious && (
                <a
                    class="audit-pagination__prev"
                    href={`/audit?${buildQuery(page.currentPage - 1, filters)}`}
                >
                    ← Previous
                </a>
            )}
            <span class="audit-pagination__current">
                Page {String(page.currentPage)} of {String(totalPages)}
            </span>
            {page.hasNext && (
                <a
                    class="audit-pagination__next"
                    href={`/audit?${buildQuery(page.currentPage + 1, filters)}`}
                >
                    Next →
                </a>
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

export const AuditView: FC<RenderProps["audit"]> = ({ rows, page, filters, configChanges }) => {
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
            <section class="sec">
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
            {/* Crawl p11: daemon-applied config changes moved BELOW the
                HMAC chain — they were pushing the page's primary content
                (the tamper-evident log) under the fold. */}
            {configChanges !== undefined && configChanges.length > 0 && (
                <ConfigChangesSection changes={configChanges} />
            )}
            </div>
        </section>
    );
};

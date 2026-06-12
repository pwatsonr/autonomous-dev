// SPEC-013-3-03 §Views — audit view component.
//
// SPEC-015-4-02 §Audit Page — when `page` is supplied (live mode), the
// view renders the HMAC-chained log with filters, integrity indicator,
// and pagination. Otherwise it falls back to the stub `rows` table.

import type { FC } from "hono/jsx";

import type {
    AuditFiltersProp,
    AuditPageResultProp,
    RenderProps,
} from "../../types/render";
import { AuditRowFragment } from "../fragments/audit-row";

/** Format an ISO-8601 timestamp as compact `YYYY-MM-DD HH:mm:ssZ` for
 *  table cells (TDD-034 §5.6 — table timestamps use compact ISO form). */
function formatTimestampCompact(iso: string): string {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

const integrityLabel: Record<AuditPageResultProp["integrityStatus"], string> = {
    verified: "Chain verified",
    warning: "Chain has gaps",
    error: "Chain integrity FAILED",
    unknown: "Chain integrity unknown",
    // Note: "FAILED" stays uppercase per design system status-badge rule.
};

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
            {page.hasPrevious && (
                <a
                    class="audit-pagination__prev"
                    hx-get={`/audit?${buildQuery(page.currentPage - 1, filters)}`}
                    hx-target="#audit-content"
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
                    hx-get={`/audit?${buildQuery(page.currentPage + 1, filters)}`}
                    hx-target="#audit-content"
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
                type="text"
                name="operatorId"
                value={filters.operatorId ?? ""}
                placeholder="alice"
            />
        </label>
        <label>
            Action
            <input
                type="text"
                name="action"
                value={filters.action ?? ""}
                placeholder="kill-switch"
            />
        </label>
        <label>
            From
            <input
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
                type="date"
                name="endDate"
                value={
                    filters.endDate !== undefined
                        ? filters.endDate.toISOString().slice(0, 10)
                        : ""
                }
            />
        </label>
        <button type="submit">Apply filters</button>
    </form>
);

// #396: daemon-applied config changes happen outside the portal process,
// so they never enter the HMAC-chained portal audit log. Render them as a
// clearly-separate section (sourced from config-changes/applied/) instead
// of silently omitting config history from the audit surface.
const ConfigChangesSection: FC<{
    changes: NonNullable<RenderProps["audit"]["configChanges"]>;
}> = ({ changes }) => (
    <div class="audit-config-changes">
        <h2>Config changes (daemon-applied)</h2>
        <p class="dim">
            Applied by the daemon from portal-submitted markers — recorded
            here from the marker archive, outside the HMAC chain below.
        </p>
        <table class="audit-table">
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
                        <td class="mono">{m.ts}</td>
                        <td>{m.actor}</td>
                        <td>{m.summary}</td>
                        <td class="mono">{m.id.slice(0, 8)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    </div>
);

export const AuditView: FC<RenderProps["audit"]> = ({ rows, page, filters, configChanges }) => {
    if (page === undefined) {
        return (
            <section class="audit">
                <h1>Audit log</h1>
                {configChanges !== undefined && configChanges.length > 0 && (
                    <ConfigChangesSection changes={configChanges} />
                )}
                <table class="audit-table">
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
            </section>
        );
    }

    const liveFilters: AuditFiltersProp = filters ?? {};
    return (
        <section class="audit">
            <h1>Audit log</h1>
            {configChanges !== undefined && configChanges.length > 0 && (
                <ConfigChangesSection changes={configChanges} />
            )}
            <FilterForm filters={liveFilters} />
            <div class="audit-status">
                <IntegrityIndicator
                    status={page.integrityStatus}
                    detail={page.integrityDetail}
                />
                <span class="audit-totals">
                    {String(page.totalCount)} total entries
                </span>
            </div>
            <div id="audit-content">
                <table class="audit-table">
                    <thead>
                        <tr>
                            <th>Sequence</th>
                            <th>Timestamp</th>
                            <th>Operator</th>
                            <th>Action</th>
                            <th>Outcome</th>
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
                                <td>
                                    {String(
                                        (entry.details as { outcome?: unknown })
                                            .outcome ?? "—",
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <Pagination page={page} filters={liveFilters} />
            </div>
        </section>
    );
};

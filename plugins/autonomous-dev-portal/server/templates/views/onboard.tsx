// ONBOARD Phase 3 (#594) — org/project/repo browser view.
//
// Lists the linked org's projects + repos with project/tag/search filters and
// pagination. Each repo row shows enrollment, blocked-by-question state, and
// memory-topic chips, plus a drill-in (HTMX) that loads the repo's scoped-memory
// topic summaries. Reads come from onboard-readers; nothing is fabricated —
// empty states are explicit. All interactivity is HTMX (no inline handlers).

import type { FC } from "hono/jsx";

import { Topbar } from "../../components/topbar";
import type { RenderProps, OnboardRepoRow, MemoryTopicProp } from "../../types/render";

function qs(filter: { project?: string; tag?: string; q?: string }, page?: number): string {
    const p = new URLSearchParams();
    if (filter.project) p.set("project", filter.project);
    if (filter.tag) p.set("tag", filter.tag);
    if (filter.q) p.set("q", filter.q);
    if (page !== undefined) p.set("page", String(page));
    const s = p.toString();
    return s ? `?${s}` : "";
}

const RepoRow: FC<{ r: OnboardRepoRow }> = ({ r }) => (
    <tr>
        <td class="repo-name">{r.id}</td>
        <td class="mono">{r.projectId ?? "—"}</td>
        <td>
            {Object.entries(r.tags).map(([k, v]) => (
                <span class="chip muted">
                    {k}={v}
                </span>
            ))}
        </td>
        <td>
            {r.enrolled ? (
                <span class="chip ok" title="enrolled in auto-improvement">enrolled</span>
            ) : (
                <span class="chip muted">not enrolled</span>
            )}
            {r.blocked && (
                <span class="chip warn" title="blocked on a pending question"> blocked</span>
            )}
        </td>
        <td>
            {r.topics.length === 0 ? (
                <span class="dim">no memory</span>
            ) : (
                r.topics.map((t) => <span class="chip"> {t}</span>)
            )}
        </td>
        <td>
            <button
                type="button"
                class="link-btn"
                hx-get={`/onboard/repo/${r.id}`}
                hx-target="#onboard-detail"
                hx-swap="innerHTML"
            >
                view memory
            </button>
        </td>
    </tr>
);

export const OnboardView: FC<RenderProps["onboard"]> = ({
    org,
    projects,
    repos,
    filter,
    page,
    totalRepos,
    totalPages,
    status,
}) => (
    <section id="onboard-body" class="onboard-surface">
        <Topbar title="Onboard" subTitle={org ? `org: ${org}` : "no org linked"} />
        <div class="main-inner">
            {org === null ? (
                <p class="empty">
                    No org linked yet. Run <code>autonomous-dev org link &lt;org&gt;</code> then{" "}
                    <code>autonomous-dev org ingest</code> to populate this view.
                </p>
            ) : (
                <>
                    <div class="kpi-strip">
                        <div class="kpi">
                            <div class="kpi-label">Repos</div>
                            <div class="kpi-num">{status.reposTotal}</div>
                            <div class="kpi-sub">{status.reposWithMemory} ingested</div>
                        </div>
                        <div class="kpi">
                            <div class="kpi-label">Projects</div>
                            <div class="kpi-num">{projects.length}</div>
                            <div class="kpi-sub">inferred / assigned</div>
                        </div>
                        <div class="kpi">
                            <div class="kpi-label">Enrolled</div>
                            <div class="kpi-num">{repos.filter((r) => r.enrolled).length}</div>
                            <div class="kpi-sub">on this page</div>
                        </div>
                        <div class="kpi">
                            <div class="kpi-label">Blocked</div>
                            <div class="kpi-num">{status.reposBlocked}</div>
                            <div class="kpi-sub">{status.questionsPending} questions pending</div>
                        </div>
                    </div>

                    <form
                        class="onboard-filters"
                        hx-get="/onboard"
                        hx-target="#onboard-body"
                        hx-select="#onboard-body"
                        hx-swap="outerHTML"
                        hx-push-url="true"
                    >
                        <select name="project" aria-label="filter by project">
                            <option value="" selected={!filter.project}>
                                all projects
                            </option>
                            {projects.map((p) => (
                                <option value={p.id} selected={filter.project === p.id}>
                                    {p.name} ({p.repoCount})
                                </option>
                            ))}
                        </select>
                        <input name="tag" placeholder="tag (k=v)" value={filter.tag ?? ""} aria-label="filter by tag" />
                        <input name="q" placeholder="search repo id" value={filter.q ?? ""} aria-label="search repo id" />
                        <button type="submit">Filter</button>
                    </form>

                    {repos.length === 0 ? (
                        <p class="empty">
                            {totalRepos === 0
                                ? "No repos match — clear the filters, or run org ingest if none are ingested yet."
                                : "No repos on this page."}
                        </p>
                    ) : (
                        <table class="tbl">
                            <thead>
                                <tr>
                                    <th>Repo</th>
                                    <th>Project</th>
                                    <th>Tags</th>
                                    <th>Enrollment</th>
                                    <th>Memory</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {repos.map((r) => (
                                    <RepoRow r={r} />
                                ))}
                            </tbody>
                        </table>
                    )}

                    <div class="pager">
                        {page > 1 && (
                            <a
                                class="pager-link"
                                href={`/onboard${qs(filter, page - 1)}`}
                                hx-get={`/onboard${qs(filter, page - 1)}`}
                                hx-target="#onboard-body"
                                hx-select="#onboard-body"
                                hx-swap="outerHTML"
                            >
                                ← prev
                            </a>
                        )}
                        <span class="pager-pos mono">
                            page {page} / {totalPages} · {totalRepos} repos
                        </span>
                        {page < totalPages && (
                            <a
                                class="pager-link"
                                href={`/onboard${qs(filter, page + 1)}`}
                                hx-get={`/onboard${qs(filter, page + 1)}`}
                                hx-target="#onboard-body"
                                hx-select="#onboard-body"
                                hx-swap="outerHTML"
                            >
                                next →
                            </a>
                        )}
                    </div>

                    <div id="onboard-detail" class="onboard-detail" />
                </>
            )}
        </div>
    </section>
);

/** Drill-in fragment: a repo's scoped-memory topic summaries (GET /onboard/repo/:repo). */
export const OnboardRepoMemoryPanel: FC<{ repoId: string; topics: MemoryTopicProp[] }> = ({ repoId, topics }) => (
    <div class="memory-panel">
        <h3 class="memory-panel-title mono">{repoId}</h3>
        {topics.length === 0 ? (
            <p class="dim">No scoped memory for this repo yet.</p>
        ) : (
            <ul class="memory-topics">
                {topics.map((t) => (
                    <li>
                        <span class="chip">{t.topic}</span> <span class="dim">{t.summary}</span>
                    </li>
                ))}
            </ul>
        )}
    </div>
);

// ONBOARD Phase 3 (#594) — live ingestion status view.
//
// Shows the ingestion-status aggregate + a per-repo progress list, refreshing
// every 5s via HTMX polling (the ingest CLI doesn't emit SSE yet; a true feed is
// a fast-follow). Reads are cached 5s so the poll is cheap. No fabricated data.

import type { FC } from "hono/jsx";

import { Topbar } from "../../components/topbar";
import type { RenderProps, OnboardIngestionRepoRow } from "../../types/render";

// Poll every 5s while the tab is visible (matches the repos surface idiom).
const INGESTION_POLL = 'every 5s [document.visibilityState === "visible"]';

const RepoStatus: FC<{ r: OnboardIngestionRepoRow }> = ({ r }) => (
    <tr>
        <td class="repo-name">{r.id}</td>
        <td class="mono">{r.projectId ?? "—"}</td>
        <td>
            {r.blocked ? (
                <span class="chip warn">blocked</span>
            ) : r.hasMemory ? (
                <span class="chip ok">ingested · {r.topicCount} topics</span>
            ) : (
                <span class="chip muted">pending</span>
            )}
        </td>
    </tr>
);

export const OnboardIngestionView: FC<RenderProps["onboard-ingestion"]> = ({ org, status, repos }) => {
    const pct = status.reposTotal > 0 ? Math.round((status.reposWithMemory / status.reposTotal) * 100) : 0;
    return (
        <section
            id="onboard-ingestion-body"
            class="onboard-ingestion-surface"
            hx-get="/onboard/ingestion"
            hx-trigger={INGESTION_POLL}
            hx-target="this"
            hx-swap="outerHTML"
            hx-select="#onboard-ingestion-body"
        >
            <Topbar title="Ingestion" subTitle={org ? `org: ${org} · live` : "no org linked"} />
            <div class="main-inner">
                {org === null ? (
                    <p class="empty">
                        No org linked. Run <code>autonomous-dev org link &lt;org&gt;</code> then{" "}
                        <code>autonomous-dev org ingest</code>.
                    </p>
                ) : (
                    <>
                        <div class="kpi-strip">
                            <div class="kpi">
                                <div class="kpi-label">
                                    <span class="dot live" /> Ingested
                                </div>
                                <div class="kpi-num">
                                    {status.reposWithMemory}/{status.reposTotal}
                                </div>
                                <div class="kpi-sub">{pct}% of repos have memory</div>
                            </div>
                            <div class="kpi">
                                <div class="kpi-label">Blocked</div>
                                <div class="kpi-num">{status.reposBlocked}</div>
                                <div class="kpi-sub">awaiting a question answer</div>
                            </div>
                            <div class="kpi">
                                <div class="kpi-label">Questions</div>
                                <div class="kpi-num">{status.questionsPending}</div>
                                <div class="kpi-sub">pending</div>
                            </div>
                            <div class="kpi">
                                <div class="kpi-label">Proposals</div>
                                <div class="kpi-num">{status.proposalsPending}</div>
                                <div class="kpi-sub">awaiting promotion</div>
                            </div>
                        </div>

                        {repos.length === 0 ? (
                            <p class="empty">No repos yet — run org ingest to populate.</p>
                        ) : (
                            <table class="tbl">
                                <thead>
                                    <tr>
                                        <th>Repo</th>
                                        <th>Project</th>
                                        <th>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {repos.map((r) => (
                                        <RepoStatus r={r} />
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </>
                )}
            </div>
        </section>
    );
};

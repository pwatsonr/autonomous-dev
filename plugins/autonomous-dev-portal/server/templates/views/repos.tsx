// PLAN-038 TASK-005 — Repos surface view component.
//
// Lists every repo in the allowlist with MTD spend, active count,
// last-activity, and a link to the per-repo dashboard. The dashboard
// "view all" affordance (which had no destination in TDD-037 §3.2)
// links here.
//
// Until TASK-015 wires the real composition reader, route handlers pass
// `emptyReposPageData()` and this view renders "No repositories in the
// allowlist — add one in Settings to get started".

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";

function fmtUsd(usd: number): string {
    return `$${usd.toFixed(2)}`;
}

function fmtRelative(iso: string | undefined): string {
    if (typeof iso !== "string" || iso.length === 0) return "—";
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return "—";
    const ageMs = Date.now() - ts;
    const ageMin = Math.floor(ageMs / 60_000);
    if (ageMin < 1) return "just now";
    if (ageMin < 60) return `${ageMin}m ago`;
    const ageHr = Math.floor(ageMin / 60);
    if (ageHr < 24) return `${ageHr}h ago`;
    const ageDay = Math.floor(ageHr / 24);
    return `${ageDay}d ago`;
}

export const ReposView: FC<RenderProps["repos"]> = ({ kpis, repos }) => (
    <section
        id="repos-body"
        class="repos-surface"
        hx-get="/repos"
        hx-trigger="every 10s [document.visibilityState === 'visible']"
        hx-target="this"
        hx-swap="outerHTML"
        hx-select="#repos-body"
    >
        {/* PORTAL-AUDIT-2026-05-16: 10s polling so per-repo activity
            counts and last-activity timestamps stay current. */}
        <div class="page-head">
            <h1>Repositories</h1>
        </div>

        <div class="kpi-strip">
            <div class="kpi">
                <div class="kpi-label">Total repos</div>
                <div class="kpi-num">{kpis.totalRepos}</div>
                <div class="kpi-sub">in allowlist</div>
            </div>
            <div class="kpi">
                <div class="kpi-label">Active</div>
                <div class="kpi-num">{kpis.activeRepos}</div>
                <div class="kpi-sub">with running requests</div>
            </div>
            <div class="kpi">
                <div class="kpi-label">Allowlist misses</div>
                <div class="kpi-num">{kpis.allowlistMisses}</div>
                <div class="kpi-sub">paths not resolvable</div>
            </div>
        </div>

        {repos.length === 0 ? (
            <p class="empty">
                No repositories in the allowlist — add one in{" "}
                <a href="/settings">Settings</a> to get started.
            </p>
        ) : (
            <table class="tbl">
                <thead>
                    <tr>
                        <th>Repo</th>
                        <th>Trust</th>
                        <th>Active</th>
                        <th>MTD spend</th>
                        <th>Last activity</th>
                    </tr>
                </thead>
                <tbody>
                    {repos.map((r) => (
                        <tr>
                            <td class="repo-name">{r.repo}</td>
                            <td class="mono">{r.trust ?? "—"}</td>
                            <td>{r.activeRequests}</td>
                            <td>{fmtUsd(r.monthlyCostUsd)}</td>
                            <td class="mono">{fmtRelative(r.lastActivity)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        )}
    </section>
);

// PLAN-038 TASK-005 — `GET /repos` route handler.
//
// Initial scaffolding: returns an empty ReposPageData so the route returns
// 200 with the honest empty-state surface. TASK-015 will wire the real
// composition reader from `wiring/repos-readers.ts` (TASK-011), which
// composes the portal-settings allowlist with per-repo aggregates from the
// request ledger.
//
// The dashboard "view all" affordance (which had no destination in
// TDD-037 §3.2) links here.

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import type { ReposPageData } from "../types/render";

function emptyReposPageData(): ReposPageData {
    return {
        kpis: { totalRepos: 0, activeRepos: 0, allowlistMisses: 0 },
        repos: [],
    };
}

export const reposHandler = async (c: Context): Promise<Response> => {
    const data = emptyReposPageData();
    return renderPage(c, "repos", data);
};

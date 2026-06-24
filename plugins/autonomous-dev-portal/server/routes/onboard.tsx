// ONBOARD Phase 3 (#594) — `GET /onboard` (browser) + `GET /onboard/repo/:repo`
// (memory drill-in fragment). Composes OnboardPageData from onboard-readers;
// filters + paginates server-side; honest empty states; no fabricated data.

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { OnboardRepoMemoryPanel } from "../templates/views/onboard";
import {
    readOnboardOwnership,
    readOnboardQuestions,
    readIngestionStatus,
    readRepoMemoryTopicNames,
    readRepoMemoryTopics,
} from "../wiring/onboard-readers";
import type { OnboardPageData, OnboardRepoRow, OnboardProjectRow } from "../types/render";

const PAGE_SIZE = 25;

export const onboardHandler = async (c: Context): Promise<Response> => {
    const own = await readOnboardOwnership();
    const questions = await readOnboardQuestions();
    const status = await readIngestionStatus();

    const project = c.req.query("project") || undefined;
    const tag = c.req.query("tag") || undefined;
    const q = (c.req.query("q") ?? "").trim().toLowerCase() || undefined;
    const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);

    const pending = new Set(questions.filter((x) => x.status === "pending").map((x) => x.repoId));

    let repos = own.repos;
    if (project !== undefined) repos = repos.filter((r) => r.projectId === project);
    if (tag !== undefined) {
        const eq = tag.indexOf("=");
        const k = eq >= 0 ? tag.slice(0, eq) : tag;
        const v = eq >= 0 ? tag.slice(eq + 1) : "";
        repos = repos.filter((r) => r.tags[k] === v);
    }
    if (q !== undefined) repos = repos.filter((r) => r.id.toLowerCase().includes(q));

    const totalRepos = repos.length;
    const totalPages = Math.max(1, Math.ceil(totalRepos / PAGE_SIZE));
    const clampedPage = Math.min(page, totalPages);
    const pageRepos = repos.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

    const repoRows: OnboardRepoRow[] = [];
    for (const r of pageRepos) {
        repoRows.push({
            id: r.id,
            projectId: r.projectId,
            tags: r.tags,
            enrolled: r.enrolled,
            blocked: pending.has(r.id),
            topics: await readRepoMemoryTopicNames(r.id),
        });
    }

    const projectRows: OnboardProjectRow[] = own.projects.map((p) => ({
        id: p.id,
        name: p.name,
        tags: p.tags,
        repoCount: own.repos.filter((r) => r.projectId === p.id).length,
    }));

    const csrfToken = c.get("csrfToken") as string | undefined;
    const data: OnboardPageData = {
        org: own.org,
        projects: projectRows,
        repos: repoRows,
        filter: {
            ...(project !== undefined ? { project } : {}),
            ...(tag !== undefined ? { tag } : {}),
            ...(q !== undefined ? { q } : {}),
        },
        page: clampedPage,
        pageSize: PAGE_SIZE,
        totalRepos,
        totalPages,
        status,
        ...(csrfToken ? { csrfToken } : {}),
    };
    return renderPage(c, "onboard", data);
};

/** GET /onboard/repo/:repo{.+} — the memory drill-in fragment (repo ids contain slashes). */
export const onboardRepoMemoryHandler = async (c: Context): Promise<Response> => {
    const repoId = c.req.param("repo");
    const topics = await readRepoMemoryTopics(repoId);
    return c.html(<OnboardRepoMemoryPanel repoId={repoId} topics={topics} />);
};

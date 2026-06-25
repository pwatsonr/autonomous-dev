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
    readIngestionRepoList,
    readRepoMemoryTopicNames,
    readRepoMemoryTopics,
    isSafeRepoId,
} from "../wiring/onboard-readers";
import type {
    OnboardPageData,
    OnboardRepoRow,
    OnboardProjectRow,
    OnboardIngestionPageData,
    OnboardQuestionsPageData,
} from "../types/render";

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

/** GET /onboard/ingestion — live ingestion status (aggregate + per-repo progress, polled). */
export const onboardIngestionHandler = async (c: Context): Promise<Response> => {
    const own = await readOnboardOwnership();
    const status = await readIngestionStatus();
    const list = await readIngestionRepoList();
    // sort: blocked → pending(no memory) → ingested, then by id.
    const rank = (r: { blocked: boolean; hasMemory: boolean }): number => (r.blocked ? 0 : r.hasMemory ? 2 : 1);
    const repos = [...list].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
    const data: OnboardIngestionPageData = { org: own.org, status, repos };
    return renderPage(c, "onboard-ingestion", data);
};

/** GET /onboard/questions — the blocking-question answer UI (pending + answered). */
export const onboardQuestionsHandler = async (c: Context): Promise<Response> => {
    const own = await readOnboardOwnership();
    const questions = await readOnboardQuestions();
    const pending = questions.filter((q) => q.status === "pending");
    const answered = questions.filter((q) => q.status === "answered");
    const csrfToken = c.get("csrfToken") as string | undefined;
    const data: OnboardQuestionsPageData = {
        org: own.org,
        pending,
        answered,
        ...(csrfToken ? { csrfToken } : {}),
    };
    return renderPage(c, "onboard-questions", data);
};

/** GET /onboard/repo/:repo{.+} — the memory drill-in fragment (repo ids contain slashes). */
export const onboardRepoMemoryHandler = async (c: Context): Promise<Response> => {
    const repoId = c.req.param("repo");
    // Defense in depth: the reader already returns [] for unsafe ids, but reject
    // them explicitly at the route so a traversal probe gets an honest 404 (not
    // an empty panel that looks like "this repo has no memory").
    if (typeof repoId !== "string" || !isSafeRepoId(repoId)) {
        return c.text("not found", 404);
    }
    const topics = await readRepoMemoryTopics(repoId);
    return c.html(<OnboardRepoMemoryPanel repoId={repoId} topics={topics} />);
};

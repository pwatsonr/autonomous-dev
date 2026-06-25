// ONBOARD Phase 3 (#594) — portal-side readers for the daemon plugin's ONBOARD
// state. The portal cannot import the daemon's `src` (cross-plugin boundary), so
// it re-pins the tiny read shapes here, tolerantly (unknown fields ignored, wrong
// types → safe default). Mirrors daemon-readers.ts:
//   - Never throws; any I/O / parse / schema error → safe default.
//   - 5s cache (own keys) so the rail/ingestion polls don't hit disk each tick.
//
// Sources (via state-paths, honoring the test-isolation env overrides):
//   ownership   userConfigPath() → `.ownership`        (org/projects/repos/enroll)
//   memory      ${state}/memory/repo/<id>/*.md          (topic summaries)
//   questions   ${state}/ingest/questions.json
//   proposals   ${state}/artifacts/proposals.json

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { readJsonOrNull } from "./atomic-json";
import {
    userConfigPath,
    onboardRepoMemoryDir,
    onboardQuestionsPath,
    onboardProposalsPath,
} from "./state-paths";
import { nowMs } from "../lib/clock";

const CACHE_TTL_MS = 5_000;

// ---------------------------------------------------------------------------
// Pinned (tolerant) read shapes
// ---------------------------------------------------------------------------

export interface OnboardProject {
    id: string;
    name: string;
    tags: Record<string, string>;
}

export interface OnboardRepo {
    id: string;
    projectId: string | null;
    tags: Record<string, string>;
    /** ENROLLED iff participate_in_auto_improvement === true (any other value = not enrolled). */
    enrolled: boolean;
}

export interface OnboardOwnership {
    org: string | null;
    projects: OnboardProject[];
    repos: OnboardRepo[];
}

export interface OnboardQuestion {
    id: string;
    repoId: string;
    question: string;
    options: string[];
    status: "pending" | "answered";
    answer?: string;
    /** options is a clean string[]; if false the UI renders it read-only (shape mismatch). */
    optionsValid: boolean;
}

export interface IngestionStatus {
    reposTotal: number;
    reposWithMemory: number;
    reposBlocked: number;
    questionsPending: number;
    proposalsPending: number;
}

export interface IngestionRepoRow {
    id: string;
    projectId: string | null;
    hasMemory: boolean;
    blocked: boolean;
    topicCount: number;
}

export interface MemoryTopic {
    topic: string;
    summary: string;
}

const EMPTY_OWNERSHIP: OnboardOwnership = { org: null, projects: [], repos: [] };

// ---------------------------------------------------------------------------
// 5s cache (own instance; a failure in one source never poisons another)
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

class ReaderCache {
    private readonly entries = new Map<string, CacheEntry<unknown>>();
    get<T>(key: string, now: number): T | undefined {
        const hit = this.entries.get(key);
        if (hit === undefined) return undefined;
        if (hit.expiresAt <= now) {
            this.entries.delete(key);
            return undefined;
        }
        return hit.value as T;
    }
    set<T>(key: string, value: T, now: number): void {
        this.entries.set(key, { value, expiresAt: now + CACHE_TTL_MS });
    }
    clear(): void {
        this.entries.clear();
    }
}

const cache = new ReaderCache();

/** Test-only: isolate cache state between cases. */
export function __resetOnboardReaderCacheForTests(): void {
    cache.clear();
}

/**
 * Invalidate all cached onboard reads. Production callers (the write routes)
 * invoke this after a successful answer/enrollment write so the next read —
 * the rail badge, a page refresh, the ingestion poll — reflects the new state
 * immediately instead of lagging up to the 5s TTL.
 */
export function invalidateOnboardReaderCache(): void {
    cache.clear();
}

// ---------------------------------------------------------------------------
// Tolerant coercion helpers
// ---------------------------------------------------------------------------

function asString(v: unknown): string | undefined {
    return typeof v === "string" ? v : undefined;
}

function asTags(v: unknown): Record<string, string> {
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string") out[k] = val;
    }
    return out;
}

// A repo id is safe to use as a path when it's a positive-allowlist match:
// org/repo-style, each slash-separated segment limited to [A-Za-z0-9._-] and
// never a bare "." or ".." (so the "." in the charset can't form traversal).
// Exported for a defense-in-depth guard at the drill-in route.
const SAFE_REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;
export function isSafeRepoId(id: string): boolean {
    if (id.length === 0) return false;
    return id
        .split("/")
        .every((s) => s !== "." && s !== ".." && SAFE_REPO_SEGMENT.test(s));
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** Ownership tree (org/projects/repos + enrollment). Never throws. */
export async function readOnboardOwnership(now: () => number = nowMs): Promise<OnboardOwnership> {
    const t = now();
    const cached = cache.get<OnboardOwnership>("ownership", t);
    if (cached !== undefined) return cached;

    let result: OnboardOwnership = EMPTY_OWNERSHIP;
    try {
        const manifest = await readJsonOrNull<{ ownership?: unknown }>(userConfigPath());
        const own = manifest?.ownership;
        if (own && typeof own === "object" && !Array.isArray(own)) {
            const o = own as Record<string, unknown>;
            const projects: OnboardProject[] = Array.isArray(o.projects)
                ? (o.projects as unknown[])
                      .map((p) => {
                          const po = (p ?? {}) as Record<string, unknown>;
                          const id = asString(po.id);
                          return id ? { id, name: asString(po.name) ?? id, tags: asTags(po.tags) } : undefined;
                      })
                      .filter((p): p is OnboardProject => p !== undefined)
                : [];
            const repos: OnboardRepo[] = Array.isArray(o.repos)
                ? (o.repos as unknown[])
                      .map((r) => {
                          const ro = (r ?? {}) as Record<string, unknown>;
                          const id = asString(ro.id);
                          return id
                              ? {
                                    id,
                                    projectId: asString(ro.projectId) ?? null,
                                    tags: asTags(ro.tags),
                                    enrolled: ro.participate_in_auto_improvement === true,
                                }
                              : undefined;
                      })
                      .filter((r): r is OnboardRepo => r !== undefined)
                : [];
            result = { org: asString(o.org) ?? null, projects, repos };
        }
    } catch {
        result = EMPTY_OWNERSHIP;
    }
    cache.set("ownership", result, t);
    return result;
}

/** Pending + answered questions. Never throws. */
export async function readOnboardQuestions(now: () => number = nowMs): Promise<OnboardQuestion[]> {
    const t = now();
    const cached = cache.get<OnboardQuestion[]>("questions", t);
    if (cached !== undefined) return cached;

    let result: OnboardQuestion[] = [];
    try {
        const raw = await readJsonOrNull<unknown[]>(onboardQuestionsPath());
        if (Array.isArray(raw)) {
            result = raw
                .map((q) => {
                    const qo = (q ?? {}) as Record<string, unknown>;
                    const id = asString(qo.id);
                    const repoId = asString(qo.repoId);
                    if (!id || !repoId) return undefined;
                    const optionsValid =
                        Array.isArray(qo.options) &&
                        qo.options.length > 0 &&
                        qo.options.every((x) => typeof x === "string");
                    return {
                        id,
                        repoId,
                        question: asString(qo.question) ?? "",
                        options: optionsValid ? (qo.options as string[]) : [],
                        status: qo.status === "answered" ? "answered" : "pending",
                        ...(asString(qo.answer) ? { answer: asString(qo.answer) } : {}),
                        optionsValid,
                    } as OnboardQuestion;
                })
                .filter((q): q is OnboardQuestion => q !== undefined);
        }
    } catch {
        result = [];
    }
    cache.set("questions", result, t);
    return result;
}

/** Count of human-actionable proposals (status meta_approved). Never throws. */
export async function readOnboardProposalsPending(now: () => number = nowMs): Promise<number> {
    const t = now();
    const cached = cache.get<number>("proposals-pending", t);
    if (cached !== undefined) return cached;

    let count = 0;
    try {
        const raw = await readJsonOrNull<unknown[]>(onboardProposalsPath());
        if (Array.isArray(raw)) {
            count = raw.filter((p) => (p as { status?: unknown } | null)?.status === "meta_approved").length;
        }
    } catch {
        count = 0;
    }
    cache.set("proposals-pending", count, t);
    return count;
}

/** Topic summaries (topic + first non-empty line) for a repo's scoped memory. Never throws. */
export async function readRepoMemoryTopics(repoId: string): Promise<MemoryTopic[]> {
    if (!isSafeRepoId(repoId)) return [];
    const dir = onboardRepoMemoryDir(repoId);
    let names: string[];
    try {
        names = (await fs.readdir(dir)).filter((n) => n.endsWith(".md")).sort();
    } catch {
        return [];
    }
    const topics: MemoryTopic[] = [];
    for (const name of names) {
        let summary = "";
        try {
            const text = await fs.readFile(join(dir, name), "utf8");
            summary = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0 && l !== "---") ?? "";
        } catch {
            summary = "";
        }
        topics.push({ topic: name.replace(/\.md$/, ""), summary: summary.slice(0, 200) });
    }
    return topics;
}

/** Topic NAMES for a repo's scoped memory (readdir only, no file reads — for list rows). */
export async function readRepoMemoryTopicNames(repoId: string): Promise<string[]> {
    if (!isSafeRepoId(repoId)) return [];
    try {
        return (await fs.readdir(onboardRepoMemoryDir(repoId)))
            .filter((n) => n.endsWith(".md"))
            .map((n) => n.replace(/\.md$/, ""))
            .sort();
    } catch {
        return [];
    }
}

/** True iff the repo has any scoped-memory doc. Cheap (readdir only). */
async function repoHasMemory(repoId: string): Promise<boolean> {
    if (!isSafeRepoId(repoId)) return false;
    try {
        return (await fs.readdir(onboardRepoMemoryDir(repoId))).some((n) => n.endsWith(".md"));
    } catch {
        return false;
    }
}

/** Aggregate ingestion status. The O(N) memory scan is cached 5s (H1). Never throws. */
export async function readIngestionStatus(now: () => number = nowMs): Promise<IngestionStatus> {
    const t = now();
    const cached = cache.get<IngestionStatus>("ingestion-status", t);
    if (cached !== undefined) return cached;

    const own = await readOnboardOwnership(now);
    const questions = await readOnboardQuestions(now);
    const proposalsPending = await readOnboardProposalsPending(now);

    const pendingRepos = new Set(questions.filter((q) => q.status === "pending").map((q) => q.repoId));
    let reposWithMemory = 0;
    for (const r of own.repos) {
        if (await repoHasMemory(r.id)) reposWithMemory++;
    }
    const status: IngestionStatus = {
        reposTotal: own.repos.length,
        reposWithMemory,
        reposBlocked: own.repos.filter((r) => pendingRepos.has(r.id)).length,
        questionsPending: questions.filter((q) => q.status === "pending").length,
        proposalsPending,
    };
    cache.set("ingestion-status", status, t);
    return status;
}

/** Per-repo ingestion progress (has-memory / blocked / topic count). Cached 5s. Never throws. */
export async function readIngestionRepoList(now: () => number = nowMs): Promise<IngestionRepoRow[]> {
    const t = now();
    const cached = cache.get<IngestionRepoRow[]>("ingestion-repos", t);
    if (cached !== undefined) return cached;

    const own = await readOnboardOwnership(now);
    const questions = await readOnboardQuestions(now);
    const pending = new Set(questions.filter((q) => q.status === "pending").map((q) => q.repoId));

    const rows: IngestionRepoRow[] = [];
    for (const r of own.repos) {
        const topics = await readRepoMemoryTopicNames(r.id);
        rows.push({
            id: r.id,
            projectId: r.projectId,
            hasMemory: topics.length > 0,
            blocked: pending.has(r.id),
            topicCount: topics.length,
        });
    }
    cache.set("ingestion-repos", rows, t);
    return rows;
}

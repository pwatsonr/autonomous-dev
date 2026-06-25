// ONBOARD Phase 3 (#594) — the FIRST portal write surface: answer a blocking
// question. The daemon owns `${state}/ingest/questions.json`; this writes a
// single answer back into it from the portal.
//
// Safety invariants (this is operator state — corruption blocks ingestion):
//   - Read the RAW array (not the coerced reader shape) so EVERY daemon-side
//     field on every question is preserved byte-for-byte; only the answered
//     entry's `status` + `answer` change.
//   - Validate the chosen option ∈ that question's own `options` (reject
//     otherwise) — a forged/stale form body can't inject an arbitrary answer.
//   - Refuse a shape-mismatched question (options not a clean string[]) or one
//     already answered — never silently clobber a recorded decision.
//   - Refuse to write if the file is unreadable/corrupt JSON (readJsonOrNull
//     throws on parse error) — do NOT overwrite a file we couldn't parse.
//   - atomicWriteJson (tmp + fsync + rename, 0600) — never a torn file.

import { atomicWriteJson, readJsonOrNull } from "./atomic-json";
import { onboardQuestionsPath, userConfigPath } from "./state-paths";

export type AnswerResult =
    | {
          ok: true;
          question: { id: string; repoId: string; question: string; answer: string };
      }
    | { ok: false; reason: "unknown" | "invalid-choice" | "not-answerable" | "io" };

function isCleanOptions(v: unknown): v is string[] {
    return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Record `choice` as the answer to question `id`. Returns a discriminated
 * result the route maps to status codes:
 *   unknown        → 404 (no such question / no questions file)
 *   invalid-choice → 422 (choice not one of the question's options)
 *   not-answerable → 422 (shape-mismatched options, or already answered)
 *   io             → 500 (unreadable/corrupt file, or write failed)
 */
export async function answerQuestion(
    id: string,
    choice: string,
): Promise<AnswerResult> {
    let raw: unknown;
    try {
        raw = await readJsonOrNull<unknown>(onboardQuestionsPath());
    } catch {
        // Corrupt/unparseable JSON — refuse to clobber. (ENOENT → null, handled below.)
        return { ok: false, reason: "io" };
    }
    if (!Array.isArray(raw)) {
        // No questions file yet, or not an array → the id can't exist.
        return { ok: false, reason: "unknown" };
    }

    const idx = raw.findIndex(
        (q) => (q as { id?: unknown } | null)?.id === id,
    );
    if (idx < 0) return { ok: false, reason: "unknown" };

    const entry = raw[idx] as Record<string, unknown>;
    if (!isCleanOptions(entry.options)) {
        return { ok: false, reason: "not-answerable" };
    }
    if (entry.status === "answered") {
        return { ok: false, reason: "not-answerable" };
    }
    if (!entry.options.includes(choice)) {
        return { ok: false, reason: "invalid-choice" };
    }

    // Mutate ONLY status + answer; preserve every other field on this entry and
    // on all the other questions (spread + slice, no rebuild from coerced shape).
    const updated = { ...entry, status: "answered", answer: choice };
    const next = raw.slice();
    next[idx] = updated;
    try {
        await atomicWriteJson(onboardQuestionsPath(), next);
    } catch {
        return { ok: false, reason: "io" };
    }

    return {
        ok: true,
        question: {
            id,
            repoId: typeof entry.repoId === "string" ? entry.repoId : "",
            question: typeof entry.question === "string" ? entry.question : "",
            answer: choice,
        },
    };
}

// ---------------------------------------------------------------------------
// Enrollment toggle — the SECOND write surface. This edits the OWNERSHIP
// MANIFEST itself (userConfigPath), the most sensitive operator state, so the
// refuse-to-clobber discipline is stricter than the question writer: we only
// ever write back a manifest we successfully read as a well-formed object, and
// we mutate exactly one repo's `participate_in_auto_improvement` flag — every
// other top-level key, every other repo/project, and every other field on the
// toggled repo is preserved by spread (never rebuilt from a narrowed shape).
// ---------------------------------------------------------------------------

export type EnrollResult =
    | {
          ok: true;
          repo: {
              id: string;
              projectId: string | null;
              tags: Record<string, string>;
              enrolled: boolean;
          };
      }
    | { ok: false; reason: "unknown" | "corrupt" | "io" };

function coerceTags(v: unknown): Record<string, string> {
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string") out[k] = val;
    }
    return out;
}

/**
 * Set repo `repoId`'s enrollment to `enrolled` in the ownership manifest.
 *   unknown → 404 (no manifest, or no such repo in ownership.repos)
 *   corrupt → 409 (manifest unreadable/malformed — refuse to clobber)
 *   io      → 500 (write failed)
 */
export async function setEnrollment(
    repoId: string,
    enrolled: boolean,
): Promise<EnrollResult> {
    let manifest: unknown;
    try {
        manifest = await readJsonOrNull<unknown>(userConfigPath());
    } catch {
        // Unparseable JSON — never overwrite a file we couldn't read.
        return { ok: false, reason: "corrupt" };
    }
    if (manifest === null) {
        // No manifest at all → the repo can't exist to be toggled.
        return { ok: false, reason: "unknown" };
    }
    if (typeof manifest !== "object" || Array.isArray(manifest)) {
        return { ok: false, reason: "corrupt" };
    }
    const m = manifest as Record<string, unknown>;
    const ownership = m.ownership;
    if (ownership === null || typeof ownership !== "object" || Array.isArray(ownership)) {
        return { ok: false, reason: "corrupt" };
    }
    const own = ownership as Record<string, unknown>;
    if (!Array.isArray(own.repos)) {
        return { ok: false, reason: "corrupt" };
    }
    const repos = own.repos as unknown[];
    const idx = repos.findIndex(
        (r) => (r as { id?: unknown } | null)?.id === repoId,
    );
    if (idx < 0) return { ok: false, reason: "unknown" };
    const repo = repos[idx] as Record<string, unknown>;

    // Mutate ONLY this repo's participate flag (set the boolean explicitly so an
    // opt-out is distinguishable from never-decided); preserve everything else.
    const updatedRepo = { ...repo, participate_in_auto_improvement: enrolled };
    const nextRepos = repos.slice();
    nextRepos[idx] = updatedRepo;
    const nextManifest = { ...m, ownership: { ...own, repos: nextRepos } };
    try {
        await atomicWriteJson(userConfigPath(), nextManifest);
    } catch {
        return { ok: false, reason: "io" };
    }

    return {
        ok: true,
        repo: {
            id: repoId,
            projectId: typeof repo.projectId === "string" ? repo.projectId : null,
            tags: coerceTags(repo.tags),
            enrolled,
        },
    };
}

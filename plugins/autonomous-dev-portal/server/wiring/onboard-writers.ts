// ONBOARD Phase 3 (#594) — portal write surfaces: answer a blocking question
// (questions.json) and toggle a repo's enrollment (the ownership manifest).
//
// Safety invariants (this is operator state — corruption blocks ingestion):
//   - Read the RAW shape (not the coerced reader shape) so EVERY daemon-side
//     field is preserved byte-for-byte; only the targeted field changes.
//   - Validate inputs against the file's own data (choice ∈ that question's
//     options; repo ∈ ownership) — a forged/stale form body can't inject.
//   - Refuse to write a file we couldn't read/parse, or whose shape is wrong
//     (never clobber corrupt operator state with a rebuilt-from-narrowed shape).
//   - atomicWriteJson (tmp + fsync + rename, 0600) — never a torn file.
//   - Serialize writes per file (withFileLock): the read-modify-write is not
//     atomic across read+write, so two concurrent POSTs could both read the
//     same baseline and the second's whole-file write would clobber the first's
//     change (lost update). Chaining each path's ops through one promise makes
//     every write see the prior write's result.

import { atomicWriteJson, readJsonOrNull } from "./atomic-json";
import { onboardQuestionsPath, userConfigPath } from "./state-paths";

// ---------------------------------------------------------------------------
// Per-file in-process write serializer.
// ---------------------------------------------------------------------------
const writeLocks = new Map<string, Promise<unknown>>();

function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = writeLocks.get(path) ?? Promise.resolve();
    // Run fn after prev settles regardless of prev's outcome.
    const run = prev.then(fn, fn);
    // Keep the chain alive but never let a rejection poison the lock.
    writeLocks.set(
        path,
        run.then(
            () => undefined,
            () => undefined,
        ),
    );
    return run;
}

export type AnswerResult =
    | {
          ok: true;
          question: { id: string; repoId: string; question: string; answer: string };
      }
    | {
          ok: false;
          reason: "unknown" | "invalid-choice" | "not-answerable" | "corrupt" | "io";
      };

/** A clean, non-empty list of string options. An empty list is NOT answerable. */
function isCleanOptions(v: unknown): v is string[] {
    return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string");
}

/**
 * Record `choice` as the answer to question `id`. Discriminated result the
 * route maps to status codes:
 *   unknown        → 404 (no questions file, or no such question id)
 *   corrupt        → 409 (file present but not a JSON array — refuse to clobber)
 *   invalid-choice → 422 (choice not one of the question's options)
 *   not-answerable → 422 (empty/shape-mismatched options, or already answered)
 *   io             → 500 (unreadable/corrupt JSON, or write failed)
 */
export async function answerQuestion(
    id: string,
    choice: string,
): Promise<AnswerResult> {
    return withFileLock(onboardQuestionsPath(), async () => {
        let raw: unknown;
        try {
            raw = await readJsonOrNull<unknown>(onboardQuestionsPath());
        } catch {
            // Unparseable JSON — refuse to clobber.
            return { ok: false, reason: "io" };
        }
        if (raw === null) {
            // No questions file yet → the id can't exist.
            return { ok: false, reason: "unknown" };
        }
        if (!Array.isArray(raw)) {
            // Present but not an array (hand-edited) → malformed, don't clobber.
            return { ok: false, reason: "corrupt" };
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

        // Mutate ONLY status + answer; preserve every other field on this entry
        // and on all other questions (spread + slice, no rebuild).
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
    });
}

// ---------------------------------------------------------------------------
// Enrollment toggle — the SECOND write surface. This edits the OWNERSHIP
// MANIFEST itself (userConfigPath), the most sensitive operator state, so the
// refuse-to-clobber discipline is stricter: we only ever write back a manifest
// we successfully read as a well-formed object, and we mutate exactly one
// repo's `participate_in_auto_improvement` flag — every other top-level key,
// every other repo/project, and every other field on the toggled repo is
// preserved by spread (never rebuilt from a narrowed shape).
// ---------------------------------------------------------------------------

export type EnrollResult =
    | {
          ok: true;
          /** false when the repo was already in the requested state (no write). */
          changed: boolean;
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
 *   unknown → 404 (no manifest, no ownership yet, or no such repo)
 *   corrupt → 409 (manifest unreadable/malformed shape — refuse to clobber)
 *   io      → 500 (write failed)
 * On success, `changed` is false when the flag already matched (no write done).
 */
export async function setEnrollment(
    repoId: string,
    enrolled: boolean,
): Promise<EnrollResult> {
    return withFileLock(userConfigPath(), async () => {
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
        if (ownership === undefined || ownership === null) {
            // Manifest exists but ownership not populated yet (e.g. fresh
            // install) → the repo doesn't exist, not a corruption.
            return { ok: false, reason: "unknown" };
        }
        if (typeof ownership !== "object" || Array.isArray(ownership)) {
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

        const okRepo = {
            id: repoId,
            projectId: typeof repo.projectId === "string" ? repo.projectId : null,
            tags: coerceTags(repo.tags),
            enrolled,
        };

        // Idempotent: if the flag already matches, skip the write (and let the
        // caller skip the audit/broadcast). `enrolled` here means
        // `participate_in_auto_improvement === true`.
        const current = repo.participate_in_auto_improvement === true;
        if (current === enrolled) {
            return { ok: true, changed: false, repo: okRepo };
        }

        // Mutate ONLY this repo's participate flag (set the boolean explicitly so
        // an opt-out is distinguishable from never-decided); preserve everything.
        const updatedRepo = { ...repo, participate_in_auto_improvement: enrolled };
        const nextRepos = repos.slice();
        nextRepos[idx] = updatedRepo;
        const nextManifest = { ...m, ownership: { ...own, repos: nextRepos } };
        try {
            await atomicWriteJson(userConfigPath(), nextManifest);
        } catch {
            return { ok: false, reason: "io" };
        }

        return { ok: true, changed: true, repo: okRepo };
    });
}

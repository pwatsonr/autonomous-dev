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
import { onboardQuestionsPath } from "./state-paths";

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

// ONBOARD Phase 3 (#594) — onboard WRITE routes (the first portal mutations).
//
//   POST /onboard/questions/:id/answer  → record an answer to a blocking question
//
// Mirrors the settings/approvals action-route shape: a deps-injected sub-router
// (audit / logger / broadcast) with no-op defaults so `registerRoutes(app)` in a
// test gets a working route without wiring. CSRF is enforced UPSTREAM by the
// global middleware (absent in registerRoutes, so route tests POST freely);
// production runs behind it. The chosen option is validated against the
// question's own options inside `answerQuestion` (defense in depth — the route
// only checks the field is present).

import { Hono } from "hono";
import type { Context } from "hono";

import type { ActionLogger, AuditAppender, SSEBroadcaster } from "./_action-deps";
import { noopActionLogger, noopBroadcaster, resolveActor } from "./_action-deps";
import {
    OnboardAnswerError,
    OnboardQuestionAnswered,
} from "../templates/views/onboard-questions";
import { RepoRow, OnboardRowError } from "../templates/views/onboard";
import { answerQuestion, setEnrollment } from "../wiring/onboard-writers";
import {
    readOnboardQuestions,
    readRepoMemoryTopicNames,
    invalidateOnboardReaderCache,
} from "../wiring/onboard-readers";
import type { OnboardRepoRow } from "../types/render";

export interface OnboardActionDeps {
    audit?: AuditAppender;
    logger?: ActionLogger;
    broadcast?: SSEBroadcaster;
}

/** Build the onboard action sub-router. Deps default to no-ops (tests). */
export function buildOnboardActionRoutes(deps: OnboardActionDeps = {}): Hono {
    const logger = deps.logger ?? noopActionLogger();
    const broadcast = deps.broadcast ?? noopBroadcaster();
    const router = new Hono();

    router.post("/onboard/questions/:id/answer", async (c) => {
        const id = c.req.param("id");
        let form: Record<string, unknown> = {};
        try {
            form = (await c.req.parseBody()) as Record<string, unknown>;
        } catch {
            return c.html(<OnboardAnswerError message="invalid form body" />, 422);
        }
        const choice = typeof form.choice === "string" ? form.choice : "";
        if (choice.length === 0) {
            return c.html(<OnboardAnswerError message="pick an option" />, 422);
        }

        const actor = resolveActor(c.get("auth"));
        const result = await answerQuestion(id, choice);
        if (!result.ok) {
            if (result.reason === "unknown") {
                return c.html(<OnboardAnswerError message="question not found" />, 404);
            }
            if (result.reason === "corrupt") {
                logger.error("onboard_answer_corrupt", { id });
                return c.html(
                    <OnboardAnswerError message="questions file is malformed — fix it in the daemon" />,
                    409,
                );
            }
            if (result.reason === "io") {
                logger.error("onboard_answer_io", { id });
                return c.html(<OnboardAnswerError message="write failed" />, 500);
            }
            const message =
                result.reason === "invalid-choice"
                    ? "not one of the options"
                    : "question is not answerable";
            return c.html(<OnboardAnswerError message={message} />, 422);
        }

        // Bust the read cache so the rail badge, a page refresh, and the
        // ingestion poll reflect the answer immediately (not after the 5s TTL).
        invalidateOnboardReaderCache();

        // Audit is fire-and-forget (keep the HTMX response tight); broadcast lets
        // the ingestion/rail surfaces refresh their pending count.
        if (deps.audit !== undefined) {
            void deps.audit.append({
                event: "onboard_question_answered",
                actor,
                question_id: id,
                repo: result.question.repoId,
                answer: result.question.answer,
            });
        }
        broadcast.publish("onboard_question_answered", {
            id,
            repoId: result.question.repoId,
        });

        return c.html(
            <OnboardQuestionAnswered
                id={result.question.id}
                repoId={result.question.repoId}
                question={result.question.question}
                answer={result.question.answer}
            />,
        );
    });

    // ------------------------------------------------------------------
    // POST /onboard/{enroll,unenroll} — toggle a repo's participation in
    // auto-improvement (writes the ownership manifest). The repo id rides in
    // the FORM BODY (via hx-vals), not the path: a greedy `:repo{.+}` param
    // can't be disambiguated from a trailing `/enroll` static segment.
    // Returns the re-rendered repo row (hx-swap outerHTML on `closest tr`).
    // ------------------------------------------------------------------
    const toggle = async (c: Context, enrolled: boolean): Promise<Response> => {
        let form: Record<string, unknown> = {};
        try {
            form = (await c.req.parseBody()) as Record<string, unknown>;
        } catch {
            return c.html(<OnboardRowError message="invalid form body" />, 422);
        }
        const repoId = typeof form.repo === "string" ? form.repo : "";
        if (repoId.length === 0) {
            return c.html(<OnboardRowError message="missing repo" />, 422);
        }
        const actor = resolveActor(c.get("auth"));
        const result = await setEnrollment(repoId, enrolled);
        if (!result.ok) {
            if (result.reason === "unknown") {
                return c.html(<OnboardRowError message="repo not found in ownership" />, 404);
            }
            if (result.reason === "corrupt") {
                logger.error("onboard_enroll_corrupt", { repo: repoId });
                return c.html(
                    <OnboardRowError message="ownership manifest is malformed — fix it in the daemon" />,
                    409,
                );
            }
            logger.error("onboard_enroll_io", { repo: repoId });
            return c.html(<OnboardRowError message="write failed" />, 500);
        }

        // A real state change busts the read cache (so the /onboard KPI strip
        // and rail reflect it immediately) and emits audit + broadcast. A no-op
        // toggle (already in the requested state) skips all three — it still
        // returns the correct row so the button re-renders consistently.
        if (result.changed) {
            invalidateOnboardReaderCache();
            if (deps.audit !== undefined) {
                void deps.audit.append({
                    event: enrolled ? "onboard_repo_enrolled" : "onboard_repo_unenrolled",
                    actor,
                    repo: repoId,
                });
            }
            broadcast.publish("onboard_enrollment_changed", { repoId, enrolled });
        }

        // Enrich the ownership-level repo with blocked + topics for the row
        // (these don't change on a toggle, so a cached read is fine).
        const questions = await readOnboardQuestions();
        const blocked = questions.some(
            (q) => q.status === "pending" && q.repoId === repoId,
        );
        const topics = await readRepoMemoryTopicNames(repoId);
        const row: OnboardRepoRow = { ...result.repo, blocked, topics };

        return c.html(<RepoRow r={row} />);
    };

    router.post("/onboard/enroll", (c) => toggle(c, true));
    router.post("/onboard/unenroll", (c) => toggle(c, false));

    return router;
}

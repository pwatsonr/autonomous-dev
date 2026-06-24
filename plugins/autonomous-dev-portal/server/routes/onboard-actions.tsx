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

import type { ActionLogger, AuditAppender, SSEBroadcaster } from "./_action-deps";
import { noopActionLogger, noopBroadcaster, resolveActor } from "./_action-deps";
import {
    OnboardAnswerError,
    OnboardQuestionAnswered,
} from "../templates/views/onboard-questions";
import { answerQuestion } from "../wiring/onboard-writers";

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

    return router;
}

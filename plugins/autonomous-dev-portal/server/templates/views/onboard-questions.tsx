// ONBOARD Phase 3 (#594) — blocking-question answer UI (the first WRITE surface).
//
// Each pending question is its OWN <form> (a form scopes the radio group, so
// `name="choice"` doesn't collide across questions) that hx-posts to
// /onboard/questions/:id/answer; htmx swaps the returned answered card in
// place. CSRF rides the global X-CSRF-Token header (csrf-htmx.js) AND a hidden
// `_csrf` field, matching the settings/approvals pattern. NO inline handlers
// (CSP). A question whose options aren't a clean string[] (optionsValid=false)
// renders read-only. Answered questions are listed collapsed below.

import type { FC } from "hono/jsx";

import { Topbar } from "../../components/topbar";
import type { RenderProps, OnboardQuestionProp } from "../../types/render";

/** A pending question's answer form (card). */
const AnswerForm: FC<{ q: OnboardQuestionProp; csrfToken: string }> = ({ q, csrfToken }) => (
    <form
        class="card onboard-q"
        id={`onboard-q-${q.id}`}
        hx-post={`/onboard/questions/${encodeURIComponent(q.id)}/answer`}
        hx-target={`#onboard-q-${q.id}`}
        hx-swap="outerHTML"
    >
        <input type="hidden" name="_csrf" value={csrfToken} />
        <div class="card-h">
            <span class="repo-name">{q.repoId}</span>
            <span class="meta">blocking ingestion</span>
        </div>
        <div class="card-b">
            <p class="onboard-q-text">{q.question}</p>
            {q.optionsValid ? (
                <>
                    <div class="field" role="radiogroup" aria-label="Answer options">
                        {q.options.map((opt) => (
                            <label>
                                <input type="radio" name="choice" value={opt} required={true} /> {opt}
                            </label>
                        ))}
                    </div>
                    <div class="form-actions">
                        <button type="submit" class="btn primary">
                            Answer
                        </button>
                    </div>
                </>
            ) : (
                <p class="onboard-q-text">
                    <span class="chip warn">shape mismatch</span> options aren't a list — resolve this question in the daemon.
                </p>
            )}
        </div>
    </form>
);

/** An answered question card (also the POST success fragment). No form. */
export const OnboardQuestionAnswered: FC<{
    id: string;
    repoId: string;
    question: string;
    answer: string;
}> = ({ id, repoId, question, answer }) => (
    <div class="card onboard-q answered" id={`onboard-q-${id}`}>
        <div class="card-h">
            <span class="repo-name">{repoId}</span>
            <span class="chip ok">answered</span>
        </div>
        <div class="card-b">
            <p class="onboard-q-text">{question}</p>
            <p class="mono">→ {answer.length > 0 ? answer : "—"}</p>
        </div>
    </div>
);

/** The small error fragment returned on a failed answer (toast picks up the status). */
export const OnboardAnswerError: FC<{ message: string }> = ({ message }) => (
    <div class="onboard-q-error">
        <span class="chip err">error</span> <span class="meta">{message}</span>
    </div>
);

export const OnboardQuestionsView: FC<RenderProps["onboard-questions"]> = ({ org, pending, answered, csrfToken }) => (
    <section id="onboard-questions-body" class="onboard-questions-surface">
        <Topbar title="Questions" subTitle={org ? `org: ${org}` : "no org linked"} />
        <div class="main-inner">
            {org === null ? (
                <p class="empty">
                    No org linked. Run <code>autonomous-dev org link &lt;org&gt;</code> then{" "}
                    <code>autonomous-dev org ingest</code>.
                </p>
            ) : (
                <>
                    <h3 class="section-title">Pending · {pending.length}</h3>
                    {pending.length === 0 ? (
                        <p class="empty">No blocking questions — ingestion isn't waiting on you.</p>
                    ) : (
                        <div class="onboard-q-list">
                            {pending.map((q) => (
                                <AnswerForm q={q} csrfToken={csrfToken ?? ""} />
                            ))}
                        </div>
                    )}
                    {answered.length > 0 && (
                        <>
                            <h3 class="section-title">Answered · {answered.length}</h3>
                            <div class="onboard-q-list">
                                {answered.map((q) => (
                                    <OnboardQuestionAnswered
                                        id={q.id}
                                        repoId={q.repoId}
                                        question={q.question}
                                        answer={q.answer ?? "—"}
                                    />
                                ))}
                            </div>
                        </>
                    )}
                </>
            )}
        </div>
    </section>
);

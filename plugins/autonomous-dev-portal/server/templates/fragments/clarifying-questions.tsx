// SPEC-015-2-01 §Clarifying Questions
//
// Render an aside above the gate action panel whenever the orchestrator has
// emitted an unresolved clarifying question (most-recent-unresolved entry
// from `state.phase_history`; selection lives in panel-context-builder.ts).
//
// The aside is its own role="region" so screen readers can navigate to the
// question independently of the action buttons. Options are optional; when
// present they render as a non-actionable list (operators answer in the
// comment textarea, NOT by selecting an option here — this fragment is
// intentionally read-only).

import type { FC } from "hono/jsx";

export interface ClarifyingQuestion {
    /** The orchestrator's question text (already sanitised upstream). */
    text: string;
    /** Optional answer hints; rendered as a list when present. */
    options?: string[];
    /** ISO-8601 timestamp the question was asked. */
    askedAt: string;
}

function formatTime(iso: string): string {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

export const ClarifyingQuestions: FC<ClarifyingQuestion> = ({
    text,
    options,
    askedAt,
}) => (
    <aside
        class="clarifying-questions"
        role="region"
        aria-label="Clarifying question from orchestrator"
    >
        <h4 class="clarifying-questions__title">
            Orchestrator needs clarification
        </h4>
        <p class="clarifying-questions__question question-text">{text}</p>
        {options && options.length > 0 ? (
            <ul class="clarifying-questions__options question-options">
                {options.map((opt) => (
                    <li>{opt}</li>
                ))}
            </ul>
        ) : null}
        <p class="clarifying-questions__meta">
            Asked at{" "}
            <time datetime={askedAt}>{formatTime(askedAt)}</time>
        </p>
    </aside>
);

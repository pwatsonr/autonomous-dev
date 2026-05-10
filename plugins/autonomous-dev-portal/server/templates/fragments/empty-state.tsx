// SPEC-036-1-06 §Empty-state fragment — shared "No {noun}" placeholder.
//
// Used across Dashboard regions when their data array is empty:
//   - 0 repos       → noun="repositories allowlisted"
//   - 0 requests    → noun="active requests"
//   - 0 hits        → noun="blocking hits"
// The Approval Queue Strip (SPEC-036-1-04) deliberately renders nothing
// when empty rather than calling EmptyState — so the section disappears
// entirely. Dashboard's other regions keep their section header so the
// operator still sees "Standards drift / 0 blocking hits MTD".

import type { FC } from "hono/jsx";

export interface EmptyStateProps {
    /** Sentence-case noun (no terminal period, no emoji per PRD-018 R-22). */
    noun: string;
    /** Optional muted secondary line; smaller; used for hints. */
    hint?: string;
}

/**
 * SPEC-036-1-06 §EmptyState
 *
 * Renders `<p class="muted empty-state">No {noun}</p>` and, when `hint`
 * is provided, a second `<p class="muted dim empty-state-hint">{hint}</p>`
 * below it. Returns a fragment so callers can drop it inline without
 * introducing a wrapping element of their own.
 */
export const EmptyState: FC<EmptyStateProps> = ({ noun, hint }) => (
    <>
        <p class="muted empty-state">No {noun}</p>
        {hint && <p class="muted dim empty-state-hint">{hint}</p>}
    </>
);

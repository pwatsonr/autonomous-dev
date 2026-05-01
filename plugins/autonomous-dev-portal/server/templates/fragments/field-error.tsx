// SPEC-015-2-02 §Field Error Fragment
//
// Inline alert rendered immediately below an offending input. The render
// short-circuits to nothing when `message` is empty/undefined, so call
// sites can unconditionally drop `<FieldError ... />` after every input
// without conditionals scattered through the form template.

import type { FC } from "hono/jsx";

interface Props {
    /** Dotted field path, e.g., "costCaps.daily". Surfaced via data-field. */
    field: string;
    /** Human-readable message; empty/undefined ⇒ no markup emitted. */
    message?: string;
}

export const FieldError: FC<Props> = ({ field, message }) => {
    if (!message) return <></>;
    return (
        <div class="field-error" role="alert" data-field={field}>
            <span class="error-icon" aria-hidden="true">
                !
            </span>
            <span class="error-text">{message}</span>
        </div>
    );
};

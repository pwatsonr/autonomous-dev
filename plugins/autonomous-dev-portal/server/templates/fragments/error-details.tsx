// SPEC-013-4-03 §Error Details Fragment.
//
// Collapsible technical details shown ONLY when the parent error context
// supplies a non-empty `details` string. In production, `details` is
// undefined → the fragment renders nothing and never leaks stack traces.
//
// Used in two places:
//   1. Inline inside <ErrorPage> when the dev-mode stack is available.
//   2. As the standalone HTMX-fragment response from app.onError() so
//      hx-target swaps a small piece in place of a full layout.

import type { FC } from "hono/jsx";

interface Props {
    details?: string;
    requestPath?: string;
}

export const ErrorDetails: FC<Props> = ({ details, requestPath }) => {
    // Production fast path: render nothing when no details to surface.
    if (details === undefined || details === "") return <></>;
    return (
        <details class="error-details">
            <summary>Technical Details</summary>
            <div class="error-details-content">
                {requestPath !== undefined && requestPath !== "" ? (
                    <p>
                        <strong>Request Path:</strong> <code>{requestPath}</code>
                    </p>
                ) : null}
                <pre>
                    <code>{details}</code>
                </pre>
            </div>
        </details>
    );
};

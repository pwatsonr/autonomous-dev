// SPEC-013-3-03 §Views — 500 view component.
// SPEC-013-4-03 §Files to Create/Modify: 500 view delegates to the
// unified ErrorPage. The body is still a constant client-safe message;
// `details` (stack trace) is intentionally omitted so this view is safe
// to call from contexts that lack a sanitization step.
//
// Callers that DO want a sanitized stack in development should call
// `<ErrorPage>` directly with a `buildErrorContext`-derived prop set.
//
// SPEC-034-2-05 — voice/copy sweep: when the caller passes an empty
// message, fall back to the canonical "Failed to load data" string
// (TDD-034 §5.6) so the user-facing copy stays consistent.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";
import { ErrorPage } from "../pages/error";

const DEFAULT_500_MESSAGE = "Failed to load data";

export const ServerErrorView: FC<RenderProps["500"]> = ({ message }) => {
    const safeMessage =
        typeof message === "string" && message.trim().length > 0
            ? message
            : DEFAULT_500_MESSAGE;
    return <ErrorPage statusCode={500} message={safeMessage} />;
};

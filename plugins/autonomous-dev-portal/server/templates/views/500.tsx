// SPEC-013-3-03 §Views — 500 view component.
// SPEC-013-4-03 §Files to Create/Modify: 500 view delegates to the
// unified ErrorPage. The body is still a constant client-safe message;
// `details` (stack trace) is intentionally omitted so this view is safe
// to call from contexts that lack a sanitization step.
//
// Callers that DO want a sanitized stack in development should call
// `<ErrorPage>` directly with a `buildErrorContext`-derived prop set.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";
import { ErrorPage } from "../pages/error";

export const ServerErrorView: FC<RenderProps["500"]> = ({ message }) => (
    <ErrorPage statusCode={500} message={message} />
);

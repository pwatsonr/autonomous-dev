// SPEC-013-3-03 §Views — 404 view component.
// SPEC-013-4-03 §Files to Create/Modify: 404 view delegates to the
// unified ErrorPage so navigation suggestions, ARIA contract, and icon
// rendering are consistent across every error code.
//
// The legacy `RenderProps["404"]` shape (with `path`) is preserved so
// existing handlers continue to call `renderPage(c, "404", { path })`.
// We synthesize an ErrorContext from those props on the way through.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";
import { STATUS_DEFAULT_MESSAGES } from "../../lib/error-context";
import { ErrorPage } from "../pages/error";

export const NotFoundView: FC<RenderProps["404"]> = ({ path }) => (
    <ErrorPage
        statusCode={404}
        message={STATUS_DEFAULT_MESSAGES[404]}
        requestPath={path}
    />
);

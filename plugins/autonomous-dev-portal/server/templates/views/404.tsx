// SPEC-013-3-03 §Views — 404 view component.
//
// Always includes the requested path so the user can see what was
// missing. The full-page rendering wraps this in BaseLayout (which
// includes Navigation), giving the user a way out.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";

export const NotFoundView: FC<RenderProps["404"]> = ({ path }) => (
    <section class="not-found">
        <h1>404 Not Found</h1>
        <p>
            No page matched <code>{path}</code>.
        </p>
        <p>
            <a href="/">Return to dashboard</a>
        </p>
    </section>
);

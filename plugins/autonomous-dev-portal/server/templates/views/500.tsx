// SPEC-013-3-03 §Views — 500 view component.
//
// Body is a constant message; details (err.message, stack) are kept on
// the server-side log only. See SPEC-013-3-02 §`serverError(err, c)`.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";

export const ServerErrorView: FC<RenderProps["500"]> = ({ message }) => (
    <section class="server-error">
        <h1>500 Server Error</h1>
        <p>{message}</p>
        <p>
            <a href="/">Return to dashboard</a>
        </p>
    </section>
);

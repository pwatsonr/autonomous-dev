// SPEC-013-3-03 §Views — logs view component.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";

export const LogsView: FC<RenderProps["logs"]> = ({ lines }) => (
    <section class="logs">
        <h1>Logs</h1>
        {lines.length === 0 ? (
            <p class="empty">No log entries.</p>
        ) : (
            <ul class="log-lines">
                {lines.map((l) => (
                    <li class={`log-line level-${l.level}`}>
                        <time datetime={l.ts}>{l.ts}</time>
                        <span class="level">{l.level}</span>
                        <span class="message">{l.message}</span>
                    </li>
                ))}
            </ul>
        )}
    </section>
);

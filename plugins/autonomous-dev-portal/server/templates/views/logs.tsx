// SPEC-013-3-03 §Views — logs view component.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";

/** Compact ISO format `YYYY-MM-DD HH:mm:ssZ` for log-line timestamps. */
function formatTimestampCompact(iso: string): string {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

export const LogsView: FC<RenderProps["logs"]> = ({ lines }) => (
    <section class="logs">
        <h1>Logs</h1>
        {lines.length === 0 ? (
            <p class="empty">No log entries.</p>
        ) : (
            <ul class="log-lines">
                {lines.map((l) => (
                    <li class={`log-line level-${l.level}`}>
                        <time datetime={l.ts} class="mono">
                            {formatTimestampCompact(l.ts)}
                        </time>
                        <code class={`level level-${l.level}`}>{l.level}</code>
                        <span class="message">{l.message}</span>
                    </li>
                ))}
            </ul>
        )}
    </section>
);

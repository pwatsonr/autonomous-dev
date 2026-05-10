// SPEC-013-3-03 §Fragment Components — AuditRow.
// SPEC-034-2-05 §Voice/copy sweep — timestamps render in compact ISO
// form (`YYYY-MM-DD HH:mm:ssZ`) per TDD-034 §5.6 table rules; result
// status word renders inside `<code>` so reviewers see it in mono.

import type { FC } from "hono/jsx";

import type { AuditRow as Row } from "../../types/render";

function formatTimestampCompact(iso: string): string {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

export const AuditRowFragment: FC<Row> = ({
    ts,
    actor,
    action,
    target,
    result,
}) => (
    <tr class={`audit-row result-${result}`}>
        <td>
            <time datetime={ts} class="mono">{formatTimestampCompact(ts)}</time>
        </td>
        <td><code>{actor}</code></td>
        <td>{action}</td>
        <td>{target}</td>
        <td class={`result result-${result}`}>
            <code>{result.toUpperCase()}</code>
        </td>
    </tr>
);

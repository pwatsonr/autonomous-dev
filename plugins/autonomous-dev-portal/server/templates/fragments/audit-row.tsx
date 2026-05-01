// SPEC-013-3-03 §Fragment Components — AuditRow.
//
// One row of the audit log table. Result class is `ok` or `fail`.

import type { FC } from "hono/jsx";

import type { AuditRow as Row } from "../../types/render";

export const AuditRowFragment: FC<Row> = ({
    ts,
    actor,
    action,
    target,
    result,
}) => (
    <tr class={`audit-row result-${result}`}>
        <td>
            <time datetime={ts}>{ts}</time>
        </td>
        <td>{actor}</td>
        <td>{action}</td>
        <td>{target}</td>
        <td class={`result result-${result}`}>{result}</td>
    </tr>
);

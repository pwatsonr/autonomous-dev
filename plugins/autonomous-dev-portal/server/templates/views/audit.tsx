// SPEC-013-3-03 §Views — audit view component.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";
import { AuditRowFragment } from "../fragments/audit-row";

export const AuditView: FC<RenderProps["audit"]> = ({ rows }) => (
    <section class="audit">
        <h1>Audit Log</h1>
        <table class="audit-table">
            <thead>
                <tr>
                    <th>Timestamp</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>Result</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((r) => (
                    <AuditRowFragment
                        ts={r.ts}
                        actor={r.actor}
                        action={r.action}
                        target={r.target}
                        result={r.result}
                    />
                ))}
            </tbody>
        </table>
    </section>
);

// SPEC-037-5-05 §Standards Severity Chips + Edit modal.
//
// Renders the Standards tab as a `.sec` with a sec-head action group
// (`+ Rule` opens the new-rule modal) and a table where each row carries
// `std-row sev-{severity}` for the left-border accents in `app.css:532-534`
// and an Edit button that HTMX-loads the per-rule modal.
//
// Severity chips switch from the legacy `chip muted sm` to the dedicated
// `chip sev-blocking|warn|advisory sm` classes already defined in
// `app.css:413-415`.

import type { FC } from "hono/jsx";

import type { SettingsData, StandardRule } from "../../types/render";

interface Props {
    data: SettingsData;
}

interface RowProps {
    rule: StandardRule;
}

const StandardRow: FC<RowProps> = ({ rule }) => (
    <tr class={`std-row sev-${rule.severity}`} data-rule={rule.id}>
        <td class="mono">{rule.id}</td>
        <td>
            <span class={`chip sev-${rule.severity} sm`}>
                {rule.severity}
            </span>
        </td>
        <td>
            {rule.desc}
            {rule.immutable ? " 🔒" : ""}
        </td>
        <td class="mono">{rule.applies}</td>
        <td class="mono">{rule.hits}</td>
        <td>
            <button
                type="button"
                class="btn sm"
                hx-get={`/api/standards/${rule.id}/edit`}
                hx-target="#modal-slot"
                hx-swap="innerHTML"
            >
                Edit
            </button>
        </td>
    </tr>
);

export const StandardsPanel: FC<Props> = ({ data }) => (
    <section class="sec" data-fragment="settings-standards">
        <div class="sec-head">
            <h2>Standards rules</h2>
            <div class="head-actions">
                <span class="meta-mono dim">PRD-013</span>
                <button
                    type="button"
                    class="btn sm primary"
                    hx-get="/api/standards/new"
                    hx-target="#modal-slot"
                    hx-swap="innerHTML"
                >
                    + Rule
                </button>
            </div>
        </div>
        <table class="tbl">
            <thead>
                <tr>
                    <th>ID</th>
                    <th>Severity</th>
                    <th>Description</th>
                    <th>Applies</th>
                    <th>Hits</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                {data.standards.map((rule) => (
                    <StandardRow rule={rule} />
                ))}
            </tbody>
        </table>
    </section>
);

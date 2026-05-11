// SPEC-037-7-02 §Standards-applied section.
//
// Rendered iff `request.flags.hasStandards === true` AND
// `request.standardsApplied.length > 0`. Mirrors the kit's `.std-list`
// of `.std-row.sev-{severity}` cards. Unknown severities defensively
// coerce to `"advisory"`.

import type { FC } from "hono/jsx";

import type { StandardsRule } from "../../types/render";

interface Props {
    rules: StandardsRule[];
}

type Severity = "blocking" | "warn" | "advisory";

const KNOWN_SEVERITIES: ReadonlySet<Severity> = new Set([
    "blocking",
    "warn",
    "advisory",
]);

function normalizeSeverity(value: string): Severity {
    return (KNOWN_SEVERITIES as ReadonlySet<string>).has(value)
        ? (value as Severity)
        : "advisory";
}

export const StandardsApplied: FC<Props> = ({ rules }) => {
    if (rules.length === 0) return null;
    return (
        <section class="sec standards-applied">
            <div class="sec-head">
                <h2>Standards applied</h2>
                <span class="meta-mono dim">{rules.length} rules</span>
            </div>
            <div class="std-list">
                {rules.map((rule) => {
                    const sev = normalizeSeverity(rule.severity);
                    const source = rule.immutable === true
                        ? `${rule.source} · 🔒`
                        : rule.source;
                    return (
                        <div class={`std-row sev-${sev}`}>
                            <div class="std-id meta-mono">{rule.id}</div>
                            <div class="std-desc">{rule.desc}</div>
                            <div class={`std-sev ${sev}`}>{sev}</div>
                            <div class="std-source">{source}</div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
};

// SPEC-036-4-03 §Per-repo overrides table — fragment isolated for
// snapshot testability.
//
// Columns: Repo, Override (`<select>`), Source (mono), Action (reset).
// Empty state renders when `overrides.length === 0`. Immutable rows
// (e.g. system policy) render the reset Btn as `disabled`.

import type { FC } from "hono/jsx";

import { Btn } from "../../components/primitives";
import type { TrustOverride } from "../../types/render";

interface Props {
    overrides: TrustOverride[];
    /** Drives the per-row override `<select>` options + datalist. Defaults
     *  to the repos already listed in `overrides`; the General-tab view
     *  passes the full allowlist so newly-added repos can be selected. */
    allowlist?: readonly string[];
}

const LEVELS = ["inherit", "L0", "L1", "L2", "L3"] as const;

function repoSlug(repo: string): string {
    return repo.replace(/[^a-zA-Z0-9]+/g, "-");
}

export const TrustOverridesTable: FC<Props> = ({ overrides }) => {
    if (overrides.length === 0) {
        return (
            <p class="empty" data-empty="trust-overrides">
                No overrides set.
            </p>
        );
    }
    return (
        <table class="tbl" data-fragment="trust-overrides-table">
            <thead>
                <tr>
                    <th>Repo</th>
                    <th>Override</th>
                    <th>Source</th>
                    <th>Action</th>
                </tr>
            </thead>
            <tbody>
                {overrides.map((row) => {
                    const slug = repoSlug(row.repo);
                    const selectId = `trust-override-${slug}`;
                    return (
                        <tr data-repo={row.repo}>
                            <td class="mono">{row.repo}</td>
                            <td>
                                <select
                                    id={selectId}
                                    name={selectId}
                                    class="input"
                                    disabled={row.immutable === true}
                                    data-trust-override
                                >
                                    {LEVELS.map((opt) => (
                                        <option
                                            value={opt}
                                            selected={row.level === opt}
                                        >
                                            {opt}
                                        </option>
                                    ))}
                                </select>
                            </td>
                            <td class="mono">{row.source}</td>
                            <td>
                                <Btn
                                    kind="ghost"
                                    size="sm"
                                    disabled={row.immutable === true}
                                    data-confirm={`Reset trust override for ${row.repo}?`}
                                    data-action="reset-trust-override"
                                    data-repo={row.repo}
                                >
                                    Reset
                                </Btn>
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
};

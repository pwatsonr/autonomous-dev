// SPEC-036-2-01 §FR-5 — phase-spend table fragment.
//
// Two-column table: phase chip, inline horizontal bar (visualizing pct),
// USD cost, percentage. Empty state replaces tbody with a single row
// whose `colSpan` covers the four columns.

import type { FC } from "hono/jsx";

import { Chip } from "../../components/primitives";
import type { PhaseName } from "../../components/primitives";
import type { PhaseSpend } from "../../types/render";
import { EmptyState } from "./empty-state";

export interface PhaseSpendTableProps {
    rows: PhaseSpend[];
}

export const PhaseSpendTable: FC<PhaseSpendTableProps> = ({ rows }) => (
    <table class="tbl tight phase-spend">
        <tbody>
            {rows.length === 0 ? (
                <EmptyState noun="phase spend" as="tr" colSpan={4} />
            ) : (
                rows.map((p) => {
                    const widthPct = Math.max(0, Math.min(100, p.pct * 2));
                    return (
                        <tr>
                            <td>
                                <Chip
                                    variant="phase"
                                    tone={p.phase as PhaseName}
                                />
                            </td>
                            <td class="bar-cell">
                                <div class="bar">
                                    <div
                                        class="bar-fill"
                                        style={`width: ${widthPct.toFixed(2)}%`}
                                    />
                                </div>
                            </td>
                            <td class="meta-mono num-r">
                                ${p.cost.toFixed(2)}
                            </td>
                            <td class="meta-mono num-r dim">
                                {String(p.pct)}%
                            </td>
                        </tr>
                    );
                })
            )}
        </tbody>
    </table>
);

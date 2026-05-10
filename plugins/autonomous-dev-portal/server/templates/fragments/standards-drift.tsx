// SPEC-036-1-05 §StandardsDriftSummary — v1.1 Dashboard region.
//
// Card rendered between the approval queue strip and the active
// requests table. Shows total blocking standards hits across the
// portfolio (header) plus a per-repo mini-table (`Repo` / `Hits` /
// `Max severity`).
//
// Data is server-side aggregated by SPEC-036-1-01 from `data.standards`
// and `data.requests`; this fragment is purely presentational. The
// route handler is responsible for sort (hitCount desc); the fragment
// does not re-sort. Empty data delegates to the shared EmptyState
// (SPEC-036-1-06) but the section header still renders so the
// operator sees "Standards drift / 0 blocking hits MTD".

import type { FC } from "hono/jsx";

import { Chip } from "../../components/primitives";
import type { StatusTone } from "../../components/primitives";
import type { StandardsDriftEntry } from "../../types/render";
import { EmptyState } from "./empty-state";

/**
 * Map a `StandardsDriftEntry.severityMax` to a Chip status tone.
 * SPEC-036-1-05 AC #5:
 *   blocking  -> err
 *   warn      -> warn
 *   advisory  -> info
 */
export const severityTone = (
    s: StandardsDriftEntry["severityMax"],
): StatusTone => (s === "blocking" ? "err" : s === "warn" ? "warn" : "info");

export interface StandardsDriftSummaryProps {
    /** Pre-sorted (hitCount desc) entries; one per repo with at least one hit. */
    drift: StandardsDriftEntry[];
    /** Total blocking hits MTD across the portfolio (shown in header). */
    totalBlockingHits: number;
}

export const StandardsDriftSummary: FC<StandardsDriftSummaryProps> = ({
    drift,
    totalBlockingHits,
}) => (
    <section id="standards-drift" class="sec standards-drift">
        <div class="sec-head">
            <h2>Standards drift</h2>
            <span class="meta-mono dim">
                {totalBlockingHits} blocking hits MTD
            </span>
        </div>
        {drift.length > 0 ? (
            <table class="tbl tight">
                <thead>
                    <tr>
                        <th>Repo</th>
                        <th>Hits</th>
                        <th>Max severity</th>
                    </tr>
                </thead>
                <tbody>
                    {drift.map((d) => (
                        <tr>
                            <td>{d.repo}</td>
                            <td class="meta-mono">{d.hitCount}</td>
                            <td>
                                <Chip
                                    variant="status"
                                    tone={severityTone(d.severityMax)}
                                >
                                    {d.severityMax}
                                </Chip>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        ) : (
            <EmptyState noun="blocking hits" />
        )}
    </section>
);

// SPEC-036-3-05 §Run history (v1.1) — past daemon iterations table.
//
// Always rendered. When `runs` is empty (or undefined) the body is replaced
// by an `EmptyState noun="prior runs"` row so the region remains visually
// anchored. When populated, rows are sorted by timestamp descending and
// capped at the last 50 entries (per PLAN-036-3 risk row).
//
// Columns (exact order): Run · Time · Phase · Outcome · Cost.

import type { FC } from "hono/jsx";

import { Chip } from "../../components/primitives";
import type { PhaseName, StatusTone } from "../../components/primitives";
import type { RequestRunRef } from "../../types/render";

interface Props {
    runs?: RequestRunRef[];
}

/** Map run outcome → status tone (TDD-036 §6.2 mapping). */
export function outcomeTone(
    o: "pass" | "fail" | "block",
): "ok" | "err" | "warn" {
    return o === "pass" ? "ok" : o === "fail" ? "err" : "warn";
}

/** Last-N + descending-by-timestamp sort. Pure for unit-testability. */
export function prepareRuns(
    runs: RequestRunRef[] | undefined,
    cap = 50,
): RequestRunRef[] {
    if (runs === undefined) return [];
    const sorted = [...runs].sort((a, b) => {
        // ISO-8601 lexicographic sort — descending.
        if (a.timestamp < b.timestamp) return 1;
        if (a.timestamp > b.timestamp) return -1;
        return 0;
    });
    return sorted.slice(0, cap);
}

const EmptyState: FC<{ noun: string }> = ({ noun }) => (
    <div class="empty-state">
        <p class="empty-state-msg">No {noun}.</p>
    </div>
);

export const RunHistory: FC<Props> = ({ runs }) => {
    const prepared = prepareRuns(runs);
    return (
        <section class="sec run-history">
            <div class="sec-head">
                <h2>Run history</h2>
                <span class="meta-mono dim">{prepared.length} runs</span>
            </div>
            {prepared.length === 0 ? (
                <EmptyState noun="prior runs" />
            ) : (
                <table class="tbl tight">
                    <thead>
                        <tr>
                            <th scope="col">Run</th>
                            <th scope="col">Time</th>
                            <th scope="col">Phase</th>
                            <th scope="col">Outcome</th>
                            <th scope="col">Cost</th>
                        </tr>
                    </thead>
                    <tbody>
                        {prepared.map((r) => (
                            <tr>
                                <td class="meta-mono">{r.runId}</td>
                                <td class="meta-mono dim">{r.timestamp}</td>
                                <td>
                                    <Chip
                                        variant="phase"
                                        tone={r.phase as PhaseName}
                                    />
                                </td>
                                <td>
                                    <Chip
                                        variant="status"
                                        tone={outcomeTone(r.outcome) as StatusTone}
                                    >
                                        {r.outcome}
                                    </Chip>
                                </td>
                                <td class="meta-mono">${r.cost.toFixed(2)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </section>
    );
};

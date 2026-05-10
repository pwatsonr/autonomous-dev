// SPEC-036-1-06 / SPEC-036-2-01..06 §EmptyState — uniform empty placeholder.
//
// Single-line, dim, mono-friendly placeholder rendered whenever a
// region has no data. The `noun` prop fills the canonical sentence
// "No {noun} yet." which keeps copy consistent across surfaces
// (PRD-018 R-22 voice/copy).
//
// `as` selects the wrapper element so the same fragment can render
// either as a `<div>` (default) or a `<tr><td colspan>` row inside a
// `.tbl`. The `colSpan` prop applies only when `as === "tr"`.

import type { FC } from "hono/jsx";

export interface EmptyStateProps {
    /** Subject of the sentence — e.g. "active requests", "log entries". */
    noun: string;
    /**
     * Custom message override. When set, replaces the default "No {noun}
     * yet." copy entirely. Used for surfaces with bespoke phrasing
     * (e.g. cost projection's "No spend yet this month").
     */
    message?: string;
    /** Wrapper element. Default `"div"`. */
    as?: "div" | "tr";
    /** When `as === "tr"`, the `<td>` colSpan. Default `1`. */
    colSpan?: number;
}

export const EmptyState: FC<EmptyStateProps> = ({
    noun,
    message,
    as = "div",
    colSpan = 1,
}) => {
    const text = message ?? `No ${noun} yet.`;
    if (as === "tr") {
        return (
            <tr class="empty-row">
                <td class="empty-cell meta-mono dim" colSpan={colSpan}>
                    {text}
                </td>
            </tr>
        );
    }
    return <div class="empty-state meta-mono dim">{text}</div>;
};

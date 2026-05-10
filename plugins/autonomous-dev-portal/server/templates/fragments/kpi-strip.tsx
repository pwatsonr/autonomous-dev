// SPEC-036-1-02 / SPEC-036-2-01 §KpiStrip — 4-card KPI strip.
//
// Renders a horizontal strip of 4 `.kpi` cards (label / value / sub-line).
// Each card may carry an optional `id` so SSE OOB swaps can target the
// individual card without a full strip re-render. Each card may also
// carry an optional tone (`ok` | `warn` | `err` | `info`) which colors
// the value via the `kpi-{tone}` class consumed by portal.css.
//
// Pure, props-only component. No state, no side effects.

import type { FC } from "hono/jsx";

export interface KpiItem {
    /** Top-row label (sentence case, kept short — e.g. "MTD spend"). */
    label: string;
    /** Big numeric value. May be a pre-formatted string. */
    value: string | number;
    /** Optional sub-line rendered below the value (mono, dim). */
    sub?: string;
    /** Optional tone — colors the value text via `kpi-{tone}` class. */
    tone?: "ok" | "warn" | "err" | "info";
    /** Optional DOM id for SSE OOB targeting (e.g. "kpi-mtd"). */
    id?: string;
    /** Optional `data-sse` channel name (e.g. "costs:kpis"). */
    sseChannel?: string;
}

export interface KpiStripProps {
    items: KpiItem[];
}

/**
 * SPEC-036-2-01 §FR-7 — when `sseChannel` is set on a card, the card
 * div emits `data-sse="{channel}"` so the SSE OOB pipeline can replace
 * the card's value/sub spans without touching the surrounding strip.
 */
export const KpiStrip: FC<KpiStripProps> = ({ items }) => (
    <div class="kpi-strip">
        {items.map((k) => {
            const valClass = k.tone ? `kpi-num kpi-${k.tone}` : "kpi-num";
            return (
                <div
                    class="kpi"
                    {...(k.id ? { id: k.id } : {})}
                    {...(k.sseChannel ? { "data-sse": k.sseChannel } : {})}
                >
                    <div class="kpi-label">{k.label}</div>
                    <div class={valClass}>{k.value}</div>
                    {k.sub !== undefined && (
                        <div class="kpi-sub">{k.sub}</div>
                    )}
                </div>
            );
        })}
    </div>
);

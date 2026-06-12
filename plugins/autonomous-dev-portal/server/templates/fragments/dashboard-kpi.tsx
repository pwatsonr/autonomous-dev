// FR-026-10 — Dashboard KPI strip with inline sparklines.
//
// View-local fragment: do NOT import from server/templates/fragments/kpi-strip.tsx.
// This variant enriches each tile with a server-rendered sparkline (reusing
// server/charts/sparkline.ts) and delta indicators (▲/▼ colored by direction).
//
// Four tiles (matching the v3 design):
//   1. In flight     — active request count + p0/p1/p2/p3 breakdown
//   2. Burn rate     — $/hr + MTD spend vs cap
//   3. Gate pass rate — percentage + pending review count
//   4. Approvals queue — count + oldest wait + SLA hint
//
// #389: sparkline points come only from real series (currently the daily
// cost ledger); tiles without a history source render no sparkline. The
// tile data itself is derived from the aggregates prop passed down from
// the route handler.

import type { FC } from "hono/jsx";
import { renderSparkline } from "../../charts/sparkline";

// Tone-to-hex map reusing design-token semantic colors so the SVG spark
// stroke matches the token (tokens are not available inside SVG attributes).
// These values must match the light/dark token values — we use the dark values
// as defaults since the portal defaults to dark theme.
const SPARK_COLORS: Record<string, string> = {
    info: "#88adcb",
    ok:   "#98c39a",
    warn: "#dfba6b",
    err:  "#d99891",
    brand: "#e89255",
};

function sparkColor(tone: keyof typeof SPARK_COLORS): string {
    return (SPARK_COLORS[tone] as string | undefined) ?? (SPARK_COLORS.brand as string);
}

export interface DashboardKpiTile {
    /** Eyebrow label (uppercase mono). */
    label: string;
    /** Primary numeric/text value. */
    value: string;
    /** Optional tone applied to the kpi-num (e.g. "kpi-ok" / "kpi-warn"). */
    valueTone?: "kpi-ok" | "kpi-warn" | "kpi-err";
    /** Optional unit rendered smaller after the value. */
    unit?: string;
    /** Sub-line content (rendered mono, small). */
    sub?: string;
    /** Delta label e.g. "▲ 3" or "▼ 12%". */
    delta?: string;
    /** Direction: "up" (ok-colored) | "down" (err-colored) | "neutral". */
    deltaDir?: "up" | "down" | "neutral";
    /** Additional sub segment after the delta. */
    subExtra?: string;
    /** SVG sparkline points (24 values). */
    sparkPoints: number[];
    /** Sparkline stroke tone. */
    sparkTone: "info" | "ok" | "warn" | "err" | "brand";
}

/** Map valueTone to a visible icon and a screen-reader label (WCAG 1.4.1). */
function toneIcon(tone: DashboardKpiTile["valueTone"]): { icon: string; label: string } | null {
    if (tone === "kpi-warn") return { icon: "⚠", label: "warning" };
    if (tone === "kpi-ok")   return { icon: "✓", label: "ok" };
    if (tone === "kpi-err")  return { icon: "✕", label: "error" };
    return null;
}

export interface DashboardKpiProps {
    tiles: DashboardKpiTile[];
}

/**
 * FR-026-10 — Dashboard KPI strip with sparklines.
 *
 * Renders 4 tiles in a `.kpi-strip` grid. Each tile has:
 *   - eyebrow label (mono uppercase)
 *   - 28px primary number
 *   - delta indicator (up/down colored)
 *   - sub-line
 *   - server-rendered sparkline (positioned top-right)
 */
export const DashboardKpiStrip: FC<DashboardKpiProps> = ({ tiles }) => (
    <div id="dashboard-kpi-strip" class="kpi-strip" role="region" aria-label="Key performance indicators">
        {tiles.map((tile) => {
            // #389: no history source → no sparkline (never a fabricated walk).
            const sparkSvg = tile.sparkPoints.length > 1
                ? renderSparkline(tile.sparkPoints, {
                      width: 84,
                      height: 28,
                      color: sparkColor(tile.sparkTone),
                      a11yLabel: `${tile.label} sparkline`,
                  })
                : "";
            const deltaClass =
                tile.deltaDir === "up"
                    ? "delta-up"
                    : tile.deltaDir === "down"
                    ? "delta-down"
                    : "dim";

            const tone = toneIcon(tile.valueTone);
            const toneHelpId = tone != null ? `kpi-tone-${tile.label.replace(/\s+/g, "-").toLowerCase()}` : undefined;

            return (
                <div class="kpi" role="group" aria-label={tile.label}>
                    {/* Sparkline positioned absolute top-right */}
                    <span
                        class="kpi-spark"
                        aria-hidden="true"
                        // Safe: renderSparkline returns a sanitized SVG string
                        // (no user data, no inline event handlers).
                        dangerouslySetInnerHTML={{ __html: sparkSvg }}
                    />
                    <div class="kpi-label">{tile.label}</div>
                    <div
                        class={`kpi-num${tile.valueTone != null ? ` ${tile.valueTone}` : ""}`}
                        aria-describedby={toneHelpId}
                    >
                        {/* Non-color signal icon for warn/ok tones (WCAG 1.4.1) */}
                        {tone != null ? (
                            <span class="kpi-tone-icon" aria-hidden="true">{tone.icon}</span>
                        ) : null}
                        {tile.value}
                        {tile.unit != null ? (
                            <span class="unit"> {tile.unit}</span>
                        ) : null}
                    </div>
                    {/* Hidden help text for aria-describedby */}
                    {tone != null ? (
                        <span id={toneHelpId} class="sr-only">{tone.label}</span>
                    ) : null}
                    <div class="kpi-sub">
                        {tile.delta != null ? (
                            <>
                                <span class={deltaClass}>{tile.delta}</span>
                                {tile.sub != null ? (
                                    <>
                                        <span class="dim">·</span>
                                        <span>{tile.sub}</span>
                                    </>
                                ) : null}
                            </>
                        ) : (
                            tile.sub != null ? <span>{tile.sub}</span> : null
                        )}
                        {tile.subExtra != null ? (
                            <>
                                <span class="dim">·</span>
                                <span>{tile.subExtra}</span>
                            </>
                        ) : null}
                    </div>
                </div>
            );
        })}
    </div>
);

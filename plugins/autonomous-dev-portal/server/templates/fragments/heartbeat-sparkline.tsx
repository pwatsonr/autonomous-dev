// SPEC-036-2-05 §HeartbeatSparkline — 24-hour daemon heartbeat sparkline.
//
// Server-rendered inline SVG. Each 5-minute bucket renders as a 1px-wide
// vertical bar; bar height encodes latency, bar fill encodes status. A
// `.dot.live` indicator sits adjacent and pulses while the daemon is
// healthy (R-15 canonical motion). When the daemon is stopped or there
// are no samples yet, the SVG body collapses to a single muted text
// label and the dot becomes static + muted.
//
// All token references resolve via `var(--*)`; no hex literals.

import type { FC } from "hono/jsx";

import { Dot } from "../../components/primitives";
import type { HeartbeatSample } from "../../types/render";

const VB_W = 200;
const VB_H = 32;
const MAX_LATENCY_MS = 500;

/** Map a sample status to a `var(--*)` color reference. */
function statusFill(status: HeartbeatSample["status"]): string {
    if (status === "ok") return "var(--brand)";
    if (status === "slow") return "var(--warn)";
    return "var(--err)";
}

/** Compute bar height in [2, 32]. */
function barHeight(latencyMs: number): number {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return 2;
    const raw = (latencyMs / MAX_LATENCY_MS) * VB_H;
    return Math.max(2, Math.min(VB_H, raw));
}

/** Tone for the leading Dot derived from the trailing sample. */
function dotTone(samples: HeartbeatSample[]): "ok" | "warn" | "err" {
    const last = samples[samples.length - 1];
    if (!last) return "ok";
    if (last.status === "miss") return "err";
    if (last.status === "slow") return "warn";
    return "ok";
}

export interface HeartbeatSparklineProps {
    samples: HeartbeatSample[];
    /** When true, force the empty-state rendering (daemon offline). */
    offline?: boolean;
}

export const HeartbeatSparkline: FC<HeartbeatSparklineProps> = ({
    samples,
    offline = false,
}) => {
    const empty = offline || samples.length === 0;

    if (empty) {
        return (
            <span class="heartbeat" id="heartbeat-sparkline">
                <Dot tone="muted" live={false} />
                <svg
                    class="heartbeat-svg"
                    viewBox={`0 0 ${String(VB_W)} ${String(VB_H)}`}
                    preserveAspectRatio="none"
                >
                    <text
                        x="100"
                        y="20"
                        text-anchor="middle"
                        fill="var(--fg-2)"
                        font-size="10"
                    >
                        No heartbeat yet
                    </text>
                </svg>
            </span>
        );
    }

    const n = samples.length;
    const slot = VB_W / n;
    const barW = Math.max(1, slot - 0.5);
    const tone = dotTone(samples);

    return (
        <span class="heartbeat" id="heartbeat-sparkline">
            <Dot tone={tone} live={true} />
            <svg
                class="heartbeat-svg"
                viewBox={`0 0 ${String(VB_W)} ${String(VB_H)}`}
                preserveAspectRatio="none"
            >
                {samples.map((s, i) => {
                    const h = barHeight(s.latencyMs);
                    const x = i * slot;
                    const y = VB_H - h;
                    return (
                        <rect
                            x={x.toFixed(2)}
                            y={y.toFixed(2)}
                            width={barW.toFixed(2)}
                            height={h.toFixed(2)}
                            fill={statusFill(s.status)}
                        />
                    );
                })}
            </svg>
        </span>
    );
};

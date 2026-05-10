// SPEC-035-1-03 §RailOpsBar — fixed-bottom global ops bar.
//
// Renders the operations summary block anchored to the bottom of the
// 220px left rail. Three lines of server-rendered state:
//   1. Daemon status   — pulse dot + label (RUNNING / STALE / DOWN / UNKNOWN)
//   2. MTD spend       — mono numeric, fixed to 2 decimals
//   3. Kill-switch     — HTMX-driven button (red-themed when engaged)
//
// All values are derived server-side and arrive as props; this component
// does NOT subscribe to SSE here — the parent fragment route is
// responsible for re-rendering when daemon/cost state changes (see
// existing readers `StateReader`, `HeartbeatReader`, `CostReader`).
//
// Status -> dot class mapping (deterministic per TDD-035 SS 6.3):
//   running -> dot live   (pulsing green)
//   stale   -> dot warn   (amber)
//   dead    -> dot err    (red)
//   unknown -> dot muted  (neutral)
//
// Note: the kill-switch button references `/ops/kill-switch-modal` via
// HTMX. The route handler that returns the modal markup is delivered by
// PLAN-035-3 — until then the button still renders correctly server-side
// and the HTMX swap target (`#modal-slot`) is reserved by ShellLayout.

import type { FC } from "hono/jsx";

import { icon } from "../lib/icons";

/** Daemon health states surfaced in the rail ops bar. */
export type DaemonStatus = "running" | "stale" | "dead" | "unknown";

export interface RailOpsBarProps {
    /** Current daemon status from `HeartbeatReader`. */
    daemonStatus: DaemonStatus;
    /** Whether the global kill-switch has been engaged. */
    killSwitchEngaged: boolean;
    /**
     * Month-to-date spend in USD from `CostReader`. Optional — when
     * omitted, the MTD line renders an em-dash placeholder.
     */
    mtdSpend?: number;
}

/**
 * Maps a daemon status to its `<span class="dot …">` modifier.
 * Determinism is part of the contract (AC-02): the same input always
 * produces the same class so the SSR snapshot is stable.
 */
function dotClassFor(status: DaemonStatus): string {
    switch (status) {
        case "running":
            return "dot live";
        case "stale":
            return "dot warn";
        case "dead":
            return "dot err";
        case "unknown":
        default:
            return "dot muted";
    }
}

/** Human-facing daemon-status label. Uppercased per TDD-035 SS 6.3. */
function labelFor(status: DaemonStatus): string {
    switch (status) {
        case "running":
            return "RUNNING";
        case "stale":
            return "STALE";
        case "dead":
            return "DOWN";
        case "unknown":
        default:
            return "UNKNOWN";
    }
}

/**
 * Formats a USD amount to a fixed two-decimal string with thousands
 * separators (e.g. `1843` -> `$1,843.00`). Uses `Intl.NumberFormat`
 * so locale-rules are correct without bringing in another dep.
 */
function formatMtd(amount: number): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(amount);
}

/**
 * SPEC-035-1-03 §RailOpsBar
 *
 * Fixed-bottom region of the rail. The parent `<aside class="rail">`
 * uses `display: flex; flex-direction: column` and `.rail-ops`
 * applies `margin-top: auto` to anchor this block to the rail floor.
 */
export const RailOpsBar: FC<RailOpsBarProps> = ({
    daemonStatus,
    killSwitchEngaged,
    mtdSpend,
}) => {
    const daemonDot = dotClassFor(daemonStatus);
    const daemonLabel = labelFor(daemonStatus);

    // TODO(TDD-018-C): when the daemon-side cost cap reading is wired,
    // flip MTD dot to `warn` once spend crosses 80% of the cap.
    const mtdValue = mtdSpend === undefined ? "—" : formatMtd(mtdSpend);
    const mtdDot = mtdSpend === undefined ? "dot muted" : "dot ok";

    // Kill-switch button: red-themed when engaged. We intentionally keep
    // the HTMX attributes on BOTH states — the modal flow handles the
    // armed/disarmed branching server-side (route handler in PLAN-035-3).
    const killClass = killSwitchEngaged ? "kbtn engaged" : "kbtn";
    const killLabel = killSwitchEngaged
        ? "Kill switch ENGAGED"
        : "Engage kill switch";
    const killAriaDisabled = killSwitchEngaged ? "true" : undefined;

    return (
        <div class="rail-ops">
            <div class="line">
                <span class={daemonDot}></span>
                <span class="lbl">Daemon</span>
                <span class="v mono">{daemonLabel}</span>
            </div>
            <div class="line">
                <span class={mtdDot}></span>
                <span class="lbl">MTD spend</span>
                <span class="v mono">{mtdValue}</span>
            </div>
            <button
                type="button"
                class={killClass}
                aria-disabled={killAriaDisabled}
                hx-get="/ops/kill-switch-modal?step=arm"
                hx-target="#modal-slot"
            >
                <span
                    class="kbtn-icon"
                    dangerouslySetInnerHTML={{
                        __html: icon("shield-alert", 14),
                    }}
                ></span>
                <span class="kbtn-lbl">{killLabel}</span>
            </button>
        </div>
    );
};

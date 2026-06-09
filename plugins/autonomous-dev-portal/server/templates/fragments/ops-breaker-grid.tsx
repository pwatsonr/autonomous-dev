// FR-026-31 — Per-service circuit-breaker grid for the v3 Ops view.
//
// Design spec: /tmp/design_extract/autonomous-dev-v3/project/views.jsx
// §OpsView — `.breaker-grid` block.
//
// The daemon does NOT expose per-service breaker state today; the
// shared `circuitBreaker` field on OpsHealth is a single aggregate.
// Per FR-026-31: "where a field is absent render an honest 'unavailable'
// rather than faking."
//
// Strategy: if `circuitBreaker` is present, render it in the first slot;
// the remaining services render as "unavailable" so the grid chrome still
// appears and communicates the intended shape to the operator.

import type { FC } from "hono/jsx";

import type { CircuitBreakerState } from "../../types/render";

/** A single breaker entry for rendering. */
export interface BreakerEntry {
    /** Service label (e.g. "code-executor"). */
    label: string;
    /**
     * State string: "OK" / "TRIPPED" / "unavailable".
     * "unavailable" renders with muted styling — honest empty state.
     */
    state: "OK" | "TRIPPED" | "unavailable";
    /** Consecutive-failure count, e.g. "0/5". Empty when unavailable. */
    count?: string;
}

export interface OpsBreakerGridProps {
    /** Aggregate circuit-breaker state from `readOpsHealth()`. */
    circuitBreaker?: CircuitBreakerState;
}

/**
 * FR-026-31 §circuit-breaker grid.
 *
 * Renders six service breaker tiles in a `3 × 2` grid.  The first tile
 * maps to the aggregate `circuitBreaker` from OpsHealth when available;
 * the rest are rendered as "unavailable" since the daemon does not expose
 * per-service state today.
 *
 * @param props - {@link OpsBreakerGridProps}
 * @returns The breaker-grid section JSX element.
 */
export const OpsBreakerGrid: FC<OpsBreakerGridProps> = ({
    circuitBreaker,
}) => {
    // Build the 6-service list from the design spec.
    // The first entry maps to the real aggregate CB when available.
    const daemonState =
        circuitBreaker === undefined
            ? "unavailable"
            : circuitBreaker.state === "open"
              ? "TRIPPED"
              : "OK";

    const daemonCount =
        circuitBreaker !== undefined
            ? `${String(circuitBreaker.failureCount)}/5`
            : undefined;

    const entries: BreakerEntry[] = [
        { label: "code-executor",   state: daemonState as BreakerEntry["state"], count: daemonCount },
        { label: "test-executor",   state: "unavailable" },
        { label: "deploy-executor", state: "unavailable" },
        { label: "cred-proxy",      state: "unavailable" },
        { label: "firewall",        state: "unavailable" },
        { label: "spec-author",     state: "unavailable" },
    ];

    const healthyCount = entries.filter((e) => e.state === "OK").length;
    const trippedCount = entries.filter((e) => e.state === "TRIPPED").length;
    const availableCount = entries.filter((e) => e.state !== "unavailable").length;

    const summaryLabel =
        trippedCount > 0
            ? `${String(trippedCount)} tripped`
            : availableCount > 0
              ? `${String(healthyCount)} healthy`
              : "production-intelligence unavailable";

    return (
        <section class="sec">
            <div class="sec-head">
                <h2>Circuit breakers</h2>
                <span class="head-actions">
                    <span class="meta-mono dim">{summaryLabel}</span>
                </span>
            </div>
            <div class="breaker-grid" role="list" aria-label="Per-service circuit breakers">
                {entries.map((b) => (
                    <div
                        class={`breaker${b.state === "TRIPPED" ? " tripped" : b.state === "unavailable" ? " unavail" : ""}`}
                        role="listitem"
                        key={b.label}
                    >
                        <span class="label">{b.label}</span>
                        <span class="state">
                            {b.state === "unavailable" ? "—" : b.state}
                        </span>
                        {b.state === "unavailable" ? (
                            <span class="dim">unavailable</span>
                        ) : (
                            <span class="dim">
                                consecutive fail {b.count ?? "0/5"}
                            </span>
                        )}
                    </div>
                ))}
            </div>
        </section>
    );
};

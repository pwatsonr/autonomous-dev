// #361 — deterministic-clock seam for visual regression.
//
// Every RENDER-PATH "now" read in the portal routes through here. With
// `AUTONOMOUS_DEV_NOW` set (ISO 8601 string or epoch-millis integer), the
// eight operator surfaces render byte-identically regardless of wall-clock
// time — the precondition for capturing stable pixel goldens (the visual
// spec spawns the server with a frozen clock + the kit-parity fixture
// state-dir). Unset (production) → the real system clock.
//
// Mirrors the `AUTONOMOUS_DEV_STATE_DIR` convention in state-paths.ts: a
// single env override, honored uniformly, defaulting to the real value.
//
// Scope: this is for *display* determinism only. Write-path timestamps
// (audit logs, action markers, token expiry) intentionally keep the real
// clock — freezing them would corrupt persisted history.

/**
 * Resolve "now" as epoch milliseconds, honoring `AUTONOMOUS_DEV_NOW`.
 *
 * The override may be epoch-millis (e.g. "1750507200000") or any string
 * `Date.parse` accepts (e.g. "2026-06-21T12:00:00Z"). An unparseable or
 * empty override falls back to the real clock so a typo can never wedge a
 * production render.
 */
export function nowMs(): number {
    const override = process.env["AUTONOMOUS_DEV_NOW"];
    if (override !== undefined && override.length > 0) {
        // Numeric epoch-millis first (so "1750507200000" is not mis-parsed).
        const asEpoch = Number(override);
        if (Number.isFinite(asEpoch)) return asEpoch;
        const asIso = Date.parse(override);
        if (!Number.isNaN(asIso)) return asIso;
    }
    return Date.now();
}

/** Resolve "now" as a Date, honoring `AUTONOMOUS_DEV_NOW` (see {@link nowMs}). */
export function nowDate(): Date {
    return new Date(nowMs());
}

/** Resolve "now" as an ISO 8601 string, honoring `AUTONOMOUS_DEV_NOW`. */
export function nowIso(): string {
    return new Date(nowMs()).toISOString();
}

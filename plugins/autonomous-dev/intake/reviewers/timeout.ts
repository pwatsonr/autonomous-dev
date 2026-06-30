/**
 * Single source of truth for reviewer-invocation timeout constants
 * and the trivial helpers around them. This module is a LEAF: it imports
 * NOTHING from the reviewer suite. Callers (chain-resolver, invoke-reviewer,
 * tests) may import it without risking a circular dependency.
 *
 * Range: [TIMEOUT_MIN, TIMEOUT_MAX]. Default: TIMEOUT_DEFAULT.
 * Behaviour intentionally preserved from REQ-000050: lenient
 * `Number.parseInt` (so `"500000ms"` -> 500000), NaN-guarded clamp,
 * silent fallback to TIMEOUT_DEFAULT on missing / unparseable input.
 *
 * @module intake/reviewers/timeout
 */

export const TIMEOUT_MIN = 30_000;
export const TIMEOUT_MAX = 3_600_000;
export const TIMEOUT_DEFAULT = 900_000;

/**
 * Parse an env-style integer string. Returns the int on success,
 * `undefined` when the input is empty / undefined / not a finite int.
 * Lenient: trailing non-digits (e.g. "500ms") are silently ignored.
 *
 * @param s - String to parse (e.g. from `process.env.REVIEWER_TIMEOUT_MS`).
 * @returns The parsed integer, or `undefined` if input is empty/invalid.
 */
export function parseTimeoutEnvInt(s: string | undefined): number | undefined {
  if (s === undefined || s === '') return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && Number.isInteger(n) ? n : undefined;
}

/**
 * Clamp a candidate to [TIMEOUT_MIN, TIMEOUT_MAX]. NaN / non-finite
 * inputs collapse to TIMEOUT_DEFAULT before clamping. Always returns
 * an integer; never throws.
 *
 * @param candidate - Raw candidate timeout in milliseconds.
 * @returns A finite integer in [TIMEOUT_MIN, TIMEOUT_MAX].
 */
export function clampTimeoutMs(candidate: number): number {
  const safe = Number.isFinite(candidate) ? Math.trunc(candidate) : TIMEOUT_DEFAULT;
  return Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, safe));
}

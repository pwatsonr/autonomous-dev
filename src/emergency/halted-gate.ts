/**
 * HALTED state gate middleware (SPEC-009-4-3, Task 5).
 *
 * Rejects all incoming pipeline requests when the system is in the HALTED
 * state. Enforces the invariant that no work proceeds until explicit human
 * re-enablement via KillSwitch.reenable().
 *
 * The gate is designed as a middleware check: call `checkAccess(requestId)`
 * before processing any incoming pipeline request. If the system is halted,
 * the gate returns a structured error containing the kill context (who
 * issued the kill, when, and in what mode).
 */

import type { KillSwitch } from "./kill-switch";
import type { KillMode } from "./types";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Result of a gate access check.
 *
 * Discriminated union:
 *   - `{ allowed: true }` -- request may proceed.
 *   - `{ allowed: false; error: HaltedError }` -- system is halted.
 */
export type GateCheckResult =
  | { allowed: true }
  | { allowed: false; error: HaltedError };

/**
 * Structured error returned when the system is halted.
 *
 * Contains the full kill context so callers can present a meaningful
 * rejection message without needing to query the kill switch separately.
 */
export interface HaltedError {
  code: "SYSTEM_HALTED";
  message: string;
  killedBy: string;
  killedAt: Date;
  killMode: KillMode;
}

// ---------------------------------------------------------------------------
// HaltedGate
// ---------------------------------------------------------------------------

/**
 * Middleware gate that prevents pipeline requests while the system is halted.
 *
 * Usage:
 *   const gate = new HaltedGate(killSwitch);
 *   const result = gate.checkAccess("req-42");
 *   if (!result.allowed) {
 *     throw new Error(result.error.message);
 *   }
 */
export class HaltedGate {
  constructor(private readonly killSwitch: KillSwitch) {}

  /**
   * Check whether a pipeline request is allowed to proceed.
   *
   * Algorithm:
   *   1. If the kill switch is NOT halted, return `{ allowed: true }`.
   *   2. Otherwise, retrieve the last kill result for context.
   *   3. Return `{ allowed: false }` with a SYSTEM_HALTED error containing
   *      the kill context (who, when, mode).
   *
   * @param requestId  The pipeline request attempting to proceed.
   * @returns Gate check result with kill context on rejection.
   */
  checkAccess(requestId: string): GateCheckResult {
    // Step 1: If system is not halted, allow
    if (!this.killSwitch.isHalted()) {
      return { allowed: true };
    }

    // Step 2: Retrieve kill context
    const lastKill = this.killSwitch.getLastKillResult();

    // Step 3: Build rejection with full kill context
    return {
      allowed: false,
      error: {
        code: "SYSTEM_HALTED",
        message: `System is halted. Kill issued by ${lastKill.issuedBy} at ${lastKill.issuedAt.toISOString()} (mode: ${lastKill.mode}). Re-enable required before processing new requests.`,
        killedBy: lastKill.issuedBy,
        killedAt: lastKill.issuedAt,
        killMode: lastKill.mode,
      },
    };
  }
}

/**
 * Emergency subsystem barrel exports (SPEC-009-4-4).
 *
 * Re-exports all public types, classes, and functions from the emergency
 * subsystem. Provides a `createKillSwitch` factory for convenience wiring.
 *
 * Usage:
 *   import { KillSwitch, AbortManager, HaltedGate } from './emergency';
 */

// ---------------------------------------------------------------------------
// Re-exports: shared types (from SPEC-009-4-1)
// ---------------------------------------------------------------------------

export * from "./types";

// ---------------------------------------------------------------------------
// Re-exports: AbortManager (from SPEC-009-4-1)
// ---------------------------------------------------------------------------

export { AbortManager } from "./abort-manager";

// ---------------------------------------------------------------------------
// Re-exports: StateSnapshotCapture (SPEC-009-4-2, Task 3)
// ---------------------------------------------------------------------------

export { StateSnapshotCapture, defaultFs } from "./state-snapshot";
export type { KillSnapshot, FileSystem } from "./state-snapshot";

// ---------------------------------------------------------------------------
// Re-exports: KillSwitch (SPEC-009-4-2, Task 4)
// ---------------------------------------------------------------------------

export { KillSwitch } from "./kill-switch";
export type {
  NotificationPayload,
  AbortManagerPort,
  AuditTrail,
  EscalationCanceller,
  Notifier,
} from "./kill-switch";

// ---------------------------------------------------------------------------
// Re-exports: HaltedGate (SPEC-009-4-3, Task 5)
// ---------------------------------------------------------------------------

export { HaltedGate } from "./halted-gate";
export type { GateCheckResult, HaltedError } from "./halted-gate";

// ---------------------------------------------------------------------------
// Re-exports: PauseResumeController (SPEC-009-4-3, Task 6)
// ---------------------------------------------------------------------------

export { PauseResumeController } from "./pause-resume";

// ---------------------------------------------------------------------------
// Re-exports: EmergencyConfigLoader (SPEC-009-4-3, Task 8)
// ---------------------------------------------------------------------------

export { EmergencyConfigLoader } from "./emergency-config";
export type {
  EmergencyConfig,
  RawEmergencyConfig,
  ConfigProvider,
  ConfigLogger,
} from "./emergency-config";

// ---------------------------------------------------------------------------
// Re-exports: StatePersistence (SPEC-009-4-4, Task 7)
// ---------------------------------------------------------------------------

export { StatePersistence } from "./state-persistence";
export type { PipelineState, StatePersistenceFs } from "./state-persistence";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

import { AbortManager } from "./abort-manager";
import { StateSnapshotCapture } from "./state-snapshot";
import { KillSwitch } from "./kill-switch";
import { HaltedGate } from "./halted-gate";
import type {
  AuditTrail,
  EscalationCanceller,
  Notifier,
} from "./kill-switch";

/**
 * Create a fully-wired KillSwitch with all dependencies injected.
 *
 * Returns the kill switch, the abort manager (for registering requests),
 * and the halted gate (for checking access).
 *
 * @param stateDir         Path to the `.autonomous-dev/state` directory.
 * @param escalationEngine Escalation engine for cancelling pending chains.
 * @param auditTrail       Audit trail for recording kill events.
 * @param notifier         Notification emitter for kill events.
 * @returns An object containing the wired killSwitch, abortManager, and haltedGate.
 */
export function createKillSwitch(
  stateDir: string,
  escalationEngine: EscalationCanceller,
  auditTrail: AuditTrail,
  notifier: Notifier,
): { killSwitch: KillSwitch; abortManager: AbortManager; haltedGate: HaltedGate } {
  const abortManager = new AbortManager();
  const snapshotCapture = new StateSnapshotCapture(stateDir);
  const killSwitch = new KillSwitch(
    abortManager,
    snapshotCapture,
    escalationEngine,
    auditTrail,
    notifier,
  );
  const haltedGate = new HaltedGate(killSwitch);

  return { killSwitch, abortManager, haltedGate };
}

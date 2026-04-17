/**
 * Unit tests for HaltedGate (SPEC-009-4-3, Task 5).
 *
 * Test cases from spec:
 *   1. Running: access allowed
 *   2. Halted: access denied with SYSTEM_HALTED error
 *   3. Error includes context (killedBy, killedAt, killMode)
 *   4. Re-enabled: access allowed again
 */

import { HaltedGate } from "../halted-gate";
import type { GateCheckResult, HaltedError } from "../halted-gate";
import { KillSwitch } from "../kill-switch";
import type {
  AbortManagerPort,
  AuditTrail,
  EscalationCanceller,
  Notifier,
  NotificationPayload,
} from "../kill-switch";
import type { AbortReason, KillResult, StateSnapshot } from "../types";
import type { StateSnapshotCapture } from "../state-snapshot";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockAbortManager(): AbortManagerPort {
  return {
    getActiveRequestIds: jest.fn(() => ["req-1", "req-2"]),
    abortAll: jest.fn(),
    abortRequest: jest.fn(),
    reset: jest.fn(),
  };
}

function createMockSnapshotCapture(): StateSnapshotCapture {
  const makeSnapshot = (requestId: string): StateSnapshot => ({
    requestId,
    pipelinePhase: "code_review",
    phaseStatus: "running",
    artifacts: [],
    pendingEscalationIds: [],
    trustLevel: 2,
  });

  return {
    captureAll: jest.fn((ids: string[]) => ids.map(makeSnapshot)),
    captureOne: jest.fn((id: string) => makeSnapshot(id)),
    persistKillSnapshot: jest.fn(async () => "/state/kill-snapshot.json"),
  } as unknown as StateSnapshotCapture;
}

function createMockEscalationEngine(): EscalationCanceller {
  return { cancelAllPending: jest.fn() };
}

function createMockAuditTrail(): AuditTrail {
  return { append: jest.fn(async () => {}) };
}

function createMockNotifier(): Notifier {
  return { emit: jest.fn() };
}

function createTestSetup() {
  const abortManager = createMockAbortManager();
  const snapshotCapture = createMockSnapshotCapture();
  const escalationEngine = createMockEscalationEngine();
  const auditTrail = createMockAuditTrail();
  const notifier = createMockNotifier();

  const killSwitch = new KillSwitch(
    abortManager,
    snapshotCapture,
    escalationEngine,
    auditTrail,
    notifier,
  );

  const gate = new HaltedGate(killSwitch);

  return { killSwitch, gate };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HaltedGate", () => {
  // -------------------------------------------------------------------------
  // Test 1: Running -- access allowed
  // -------------------------------------------------------------------------

  it("allows access when system is running", () => {
    const { gate } = createTestSetup();

    const result = gate.checkAccess("req-1");

    expect(result.allowed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: Halted -- access denied with SYSTEM_HALTED error
  // -------------------------------------------------------------------------

  it("denies access with SYSTEM_HALTED error when system is halted", async () => {
    const { killSwitch, gate } = createTestSetup();

    await killSwitch.kill("graceful", "admin@example.com");

    const result = gate.checkAccess("req-new");

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error.code).toBe("SYSTEM_HALTED");
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: Error includes context (killedBy, killedAt, killMode)
  // -------------------------------------------------------------------------

  it("includes kill context in SYSTEM_HALTED error", async () => {
    const { killSwitch, gate } = createTestSetup();

    await killSwitch.kill("hard", "security-bot");

    const result = gate.checkAccess("req-new");

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      const error: HaltedError = result.error;
      expect(error.code).toBe("SYSTEM_HALTED");
      expect(error.killedBy).toBe("security-bot");
      expect(error.killedAt).toBeInstanceOf(Date);
      expect(error.killMode).toBe("hard");
      expect(error.message).toContain("security-bot");
      expect(error.message).toContain("hard");
      expect(error.message).toContain("Re-enable required");
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: Re-enabled -- access allowed again
  // -------------------------------------------------------------------------

  it("allows access again after kill followed by reenable", async () => {
    const { killSwitch, gate } = createTestSetup();

    // Kill
    await killSwitch.kill("graceful", "admin");
    expect(gate.checkAccess("req-1").allowed).toBe(false);

    // Re-enable
    killSwitch.reenable("admin");

    // Access should be allowed again
    const result = gate.checkAccess("req-1");
    expect(result.allowed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Additional: error message format
  // -------------------------------------------------------------------------

  it("formats error message with kill details", async () => {
    const { killSwitch, gate } = createTestSetup();

    await killSwitch.kill("graceful", "ops-lead");

    const result = gate.checkAccess("req-42");

    if (!result.allowed) {
      expect(result.error.message).toMatch(
        /System is halted\. Kill issued by ops-lead at .+ \(mode: graceful\)\. Re-enable required before processing new requests\./,
      );
    }
  });
});

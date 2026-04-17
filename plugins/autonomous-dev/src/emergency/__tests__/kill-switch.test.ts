/**
 * Unit tests for KillSwitch (SPEC-009-4-2, Task 4).
 *
 * Test cases:
 *   6.  Graceful kill signals all requests with KILL_GRACEFUL.
 *   7.  Hard kill signals all requests with KILL_HARD.
 *   8.  State transitions to halted after kill.
 *   9.  Snapshot captured before abort (spy call ordering).
 *   10. Escalation chains cancelled during kill.
 *   11. Idempotent double kill.
 *   12. Cancel single request; global state still "running".
 *   13. Cancel emits audit event.
 *   14. Re-enable restores running; new registrations get non-aborted signals.
 *   15. Re-enable when not halted throws.
 *   16. Re-enable emits audit event.
 *   17. Notification emitted on kill with urgency "immediate".
 */

import { KillSwitch } from "../kill-switch";
import type {
  AbortManagerPort,
  AuditTrail,
  EscalationCanceller,
  Notifier,
  NotificationPayload,
} from "../kill-switch";
import type { AbortReason, KillMode, KillResult, StateSnapshot } from "../types";
import type { StateSnapshotCapture } from "../state-snapshot";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

interface CapturedEvent {
  event_type: string;
  payload: Record<string, unknown>;
}

function createMockAbortManager(): AbortManagerPort & {
  abortAllCalls: Array<{ reason: AbortReason }>;
  abortRequestCalls: Array<{ requestId: string; reason: AbortReason }>;
  resetCalls: number;
} {
  const abortAllCalls: Array<{ reason: AbortReason }> = [];
  const abortRequestCalls: Array<{ requestId: string; reason: AbortReason }> = [];
  let resetCalls = 0;

  return {
    abortAllCalls,
    abortRequestCalls,
    resetCalls,
    getActiveRequestIds: jest.fn(() => ["req-1", "req-2", "req-3"]),
    abortAll: jest.fn((reason: AbortReason) => {
      abortAllCalls.push({ reason });
    }),
    abortRequest: jest.fn((requestId: string, reason: AbortReason) => {
      abortRequestCalls.push({ requestId, reason });
    }),
    reset: jest.fn(() => {
      resetCalls++;
    }),
  };
}

function createMockSnapshotCapture(): StateSnapshotCapture & {
  captureAllSpy: jest.Mock;
  captureOneSpy: jest.Mock;
  persistSpy: jest.Mock;
} {
  const makeSnapshot = (requestId: string): StateSnapshot => ({
    requestId,
    pipelinePhase: "code_review",
    phaseStatus: "running",
    artifacts: ["src/feature.ts"],
    pendingEscalationIds: [],
    trustLevel: 2,
  });

  const captureAllSpy = jest.fn((ids: string[]) =>
    ids.map((id) => makeSnapshot(id)),
  );

  const captureOneSpy = jest.fn((id: string) => makeSnapshot(id));

  const persistSpy = jest.fn(async () => "/state/kill-snapshot-2026.json");

  return {
    captureAllSpy,
    captureOneSpy,
    persistSpy,
    captureAll: captureAllSpy,
    captureOne: captureOneSpy,
    persistKillSnapshot: persistSpy,
  } as unknown as StateSnapshotCapture & {
    captureAllSpy: jest.Mock;
    captureOneSpy: jest.Mock;
    persistSpy: jest.Mock;
  };
}

function createMockEscalationEngine(): EscalationCanceller & {
  cancelAllPendingSpy: jest.Mock;
} {
  const cancelAllPendingSpy = jest.fn();
  return {
    cancelAllPendingSpy,
    cancelAllPending: cancelAllPendingSpy,
  };
}

function createMockAuditTrail(): AuditTrail & {
  events: CapturedEvent[];
} {
  const events: CapturedEvent[] = [];
  return {
    events,
    append: jest.fn(async (event: CapturedEvent) => {
      events.push(event);
    }),
  };
}

function createMockNotifier(): Notifier & {
  payloads: NotificationPayload[];
} {
  const payloads: NotificationPayload[] = [];
  return {
    payloads,
    emit: jest.fn((payload: NotificationPayload) => {
      payloads.push(payload);
    }),
  };
}

function createKillSwitch() {
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

  return {
    killSwitch,
    abortManager,
    snapshotCapture,
    escalationEngine,
    auditTrail,
    notifier,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KillSwitch", () => {
  // -----------------------------------------------------------------------
  // Test 6: Graceful kill signals all requests
  // -----------------------------------------------------------------------

  it("sends KILL_GRACEFUL to all requests on graceful kill", async () => {
    const { killSwitch, abortManager } = createKillSwitch();

    await killSwitch.kill("graceful", "admin@example.com");

    expect(abortManager.abortAll).toHaveBeenCalledWith("KILL_GRACEFUL");
    expect(abortManager.abortAll).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Test 7: Hard kill signals all requests
  // -----------------------------------------------------------------------

  it("sends KILL_HARD to all requests on hard kill", async () => {
    const { killSwitch, abortManager } = createKillSwitch();

    await killSwitch.kill("hard", "admin@example.com");

    expect(abortManager.abortAll).toHaveBeenCalledWith("KILL_HARD");
    expect(abortManager.abortAll).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Test 8: State transitions to halted
  // -----------------------------------------------------------------------

  it("transitions state to halted after kill", async () => {
    const { killSwitch } = createKillSwitch();

    expect(killSwitch.getState()).toBe("running");
    expect(killSwitch.isHalted()).toBe(false);

    await killSwitch.kill("graceful", "admin");

    expect(killSwitch.getState()).toBe("halted");
    expect(killSwitch.isHalted()).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 9: Snapshot captured before abort (call ordering)
  // -----------------------------------------------------------------------

  it("captures snapshot BEFORE sending abort signal", async () => {
    const { killSwitch, snapshotCapture, abortManager } = createKillSwitch();

    const callOrder: string[] = [];
    snapshotCapture.captureAllSpy.mockImplementation((ids: string[]) => {
      callOrder.push("captureAll");
      return ids.map((id) => ({
        requestId: id,
        pipelinePhase: "code_review",
        phaseStatus: "running",
        artifacts: [],
        pendingEscalationIds: [],
        trustLevel: 2,
      }));
    });
    (abortManager.abortAll as jest.Mock).mockImplementation(() => {
      callOrder.push("abortAll");
    });

    await killSwitch.kill("graceful", "admin");

    expect(callOrder).toEqual(["captureAll", "abortAll"]);
  });

  // -----------------------------------------------------------------------
  // Test 10: Escalation chains cancelled
  // -----------------------------------------------------------------------

  it("cancels all pending escalation chains during kill", async () => {
    const { killSwitch, escalationEngine } = createKillSwitch();

    await killSwitch.kill("graceful", "admin");

    expect(escalationEngine.cancelAllPendingSpy).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Test 11: Idempotent double kill
  // -----------------------------------------------------------------------

  it("returns same result on second kill (idempotent)", async () => {
    const { killSwitch, auditTrail, abortManager } = createKillSwitch();

    const firstResult = await killSwitch.kill("graceful", "admin");
    const secondResult = await killSwitch.kill("hard", "other-admin");

    // Same result returned
    expect(secondResult).toBe(firstResult);

    // State still halted
    expect(killSwitch.getState()).toBe("halted");
    expect(killSwitch.isHalted()).toBe(true);

    // abortAll only called once (not on the second kill)
    expect(abortManager.abortAll).toHaveBeenCalledTimes(1);

    // kill_issued_duplicate audit event emitted
    const duplicateEvent = auditTrail.events.find(
      (e) => e.event_type === "kill_issued_duplicate",
    );
    expect(duplicateEvent).toBeDefined();
    expect(duplicateEvent!.payload.mode).toBe("hard");
    expect(duplicateEvent!.payload.issuedBy).toBe("other-admin");
  });

  // -----------------------------------------------------------------------
  // Test 12: Cancel single request; global state still "running"
  // -----------------------------------------------------------------------

  it("cancels a single request without changing global state", async () => {
    const { killSwitch, abortManager } = createKillSwitch();

    const result = await killSwitch.cancel("req-1", "admin");

    // Single request aborted
    expect(abortManager.abortRequest).toHaveBeenCalledWith("req-1", "CANCEL");
    expect(abortManager.abortRequest).toHaveBeenCalledTimes(1);

    // abortAll NOT called
    expect(abortManager.abortAll).not.toHaveBeenCalled();

    // Global state still running
    expect(killSwitch.getState()).toBe("running");
    expect(killSwitch.isHalted()).toBe(false);

    // Result contains expected fields
    expect(result.requestId).toBe("req-1");
    expect(result.cancelledBy).toBe("admin");
    expect(result.cancelledAt).toBeInstanceOf(Date);
    expect(result.snapshot.requestId).toBe("req-1");
  });

  // -----------------------------------------------------------------------
  // Test 13: Cancel emits audit event
  // -----------------------------------------------------------------------

  it("emits cancel_issued audit event on cancel", async () => {
    const { killSwitch, auditTrail } = createKillSwitch();

    await killSwitch.cancel("req-1", "admin@example.com");

    const cancelEvent = auditTrail.events.find(
      (e) => e.event_type === "cancel_issued",
    );
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent!.payload.requestId).toBe("req-1");
    expect(cancelEvent!.payload.issuedBy).toBe("admin@example.com");
  });

  // -----------------------------------------------------------------------
  // Test 14: Re-enable restores running
  // -----------------------------------------------------------------------

  it("restores running state after reenable", async () => {
    const { killSwitch, abortManager } = createKillSwitch();

    // Kill first
    await killSwitch.kill("graceful", "admin");
    expect(killSwitch.getState()).toBe("halted");

    // Re-enable
    killSwitch.reenable("admin");

    expect(killSwitch.getState()).toBe("running");
    expect(killSwitch.isHalted()).toBe(false);

    // AbortManager.reset() was called
    expect(abortManager.reset).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Test 15: Re-enable when not halted throws
  // -----------------------------------------------------------------------

  it("throws when reenable is called while system is running", () => {
    const { killSwitch } = createKillSwitch();

    expect(killSwitch.getState()).toBe("running");
    expect(() => killSwitch.reenable("admin")).toThrow(
      "Cannot re-enable: system is not halted",
    );
  });

  // -----------------------------------------------------------------------
  // Test 16: Re-enable emits audit event
  // -----------------------------------------------------------------------

  it("emits system_reenabled audit event on reenable", async () => {
    const { killSwitch, auditTrail } = createKillSwitch();

    await killSwitch.kill("graceful", "admin");
    killSwitch.reenable("admin@example.com");

    const reenabledEvent = auditTrail.events.find(
      (e) => e.event_type === "system_reenabled",
    );
    expect(reenabledEvent).toBeDefined();
    expect(reenabledEvent!.payload.issuedBy).toBe("admin@example.com");
  });

  // -----------------------------------------------------------------------
  // Test 17: Notification emitted on kill
  // -----------------------------------------------------------------------

  it("emits notification with urgency 'immediate' on kill", async () => {
    const { killSwitch, notifier } = createKillSwitch();

    await killSwitch.kill("graceful", "admin@example.com");

    expect(notifier.payloads).toHaveLength(1);
    const payload = notifier.payloads[0]!;
    expect(payload.type).toBe("kill_switch_activated");
    expect(payload.urgency).toBe("immediate");
    expect(payload.mode).toBe("graceful");
    expect(payload.issuedBy).toBe("admin@example.com");
    expect(payload.issuedAt).toBeInstanceOf(Date);
    expect(payload.totalActiveRequests).toBe(3);
  });

  // -----------------------------------------------------------------------
  // Additional: kill() result shape
  // -----------------------------------------------------------------------

  it("returns KillResult with correct shape", async () => {
    const { killSwitch } = createKillSwitch();

    const result = await killSwitch.kill("hard", "admin@example.com");

    expect(result.mode).toBe("hard");
    expect(result.issuedBy).toBe("admin@example.com");
    expect(result.issuedAt).toBeInstanceOf(Date);
    expect(result.haltedRequests).toHaveLength(3);
    expect(result.totalActiveRequests).toBe(3);
    expect(result.haltedRequests[0]!.requestId).toBe("req-1");
  });

  // -----------------------------------------------------------------------
  // Additional: kill() emits kill_issued audit event
  // -----------------------------------------------------------------------

  it("emits kill_issued audit event with snapshot path", async () => {
    const { killSwitch, auditTrail } = createKillSwitch();

    await killSwitch.kill("graceful", "admin");

    const killEvent = auditTrail.events.find(
      (e) => e.event_type === "kill_issued",
    );
    expect(killEvent).toBeDefined();
    expect(killEvent!.payload.mode).toBe("graceful");
    expect(killEvent!.payload.issuedBy).toBe("admin");
    expect(killEvent!.payload.snapshotPath).toBe("/state/kill-snapshot-2026.json");
    expect(killEvent!.payload.totalRequests).toBe(3);
  });

  // -----------------------------------------------------------------------
  // Additional: kill() persists snapshot before abort
  // -----------------------------------------------------------------------

  it("persists kill snapshot with correct parameters", async () => {
    const { killSwitch, snapshotCapture } = createKillSwitch();

    await killSwitch.kill("hard", "admin@example.com");

    expect(snapshotCapture.persistSpy).toHaveBeenCalledTimes(1);
    const [snapshots, mode, issuedBy] = snapshotCapture.persistSpy.mock.calls[0]!;
    expect(snapshots).toHaveLength(3);
    expect(mode).toBe("hard");
    expect(issuedBy).toBe("admin@example.com");
  });

  // -----------------------------------------------------------------------
  // Additional: After reenable, lastKill is cleared
  // -----------------------------------------------------------------------

  it("clears lastKill after reenable so next kill is fresh", async () => {
    const { killSwitch, abortManager } = createKillSwitch();

    const firstResult = await killSwitch.kill("graceful", "admin");
    killSwitch.reenable("admin");

    // Now kill again -- should NOT return the old result
    const secondResult = await killSwitch.kill("hard", "admin");

    expect(secondResult).not.toBe(firstResult);
    expect(secondResult.mode).toBe("hard");
    expect(abortManager.abortAll).toHaveBeenCalledTimes(2);
  });
});

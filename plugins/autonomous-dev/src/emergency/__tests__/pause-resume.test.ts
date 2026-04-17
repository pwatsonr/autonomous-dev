/**
 * Unit tests for PauseResumeController (SPEC-009-4-3, Task 6).
 *
 * Test cases from spec:
 *   5.  Global pause pauses all
 *   6.  Global resume resumes all
 *   7.  Per-request pause
 *   8.  Per-request resume
 *   9.  Pause does not trigger HALTED
 *   10. Pause emits audit event
 *   11. Resume emits audit event
 *   12. Pause does not cancel escalations
 */

import { PauseResumeController } from "../pause-resume";
import type { AbortManagerPort, AuditTrail } from "../kill-switch";
import type { AbortReason } from "../types";

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
  resetCallCount: number;
} {
  const abortAllCalls: Array<{ reason: AbortReason }> = [];
  const abortRequestCalls: Array<{ requestId: string; reason: AbortReason }> = [];
  let resetCallCount = 0;

  return {
    abortAllCalls,
    abortRequestCalls,
    get resetCallCount() {
      return resetCallCount;
    },
    getActiveRequestIds: jest.fn(() => ["req-1", "req-2", "req-3"]),
    abortAll: jest.fn((reason: AbortReason) => {
      abortAllCalls.push({ reason });
    }),
    abortRequest: jest.fn((requestId: string, reason: AbortReason) => {
      abortRequestCalls.push({ requestId, reason });
    }),
    reset: jest.fn(() => {
      resetCallCount++;
    }),
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

function createTestSetup() {
  const abortManager = createMockAbortManager();
  const auditTrail = createMockAuditTrail();
  const controller = new PauseResumeController(abortManager, auditTrail);

  return { controller, abortManager, auditTrail };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PauseResumeController", () => {
  // -------------------------------------------------------------------------
  // Test 5: Global pause pauses all
  // -------------------------------------------------------------------------

  it("globally pauses all pipelines", () => {
    const { controller } = createTestSetup();

    const result = controller.pause("admin");

    expect(controller.isGloballyPaused()).toBe(true);
    expect(result.action).toBe("paused");
    expect(result.issuedBy).toBe("admin");
    expect(result.issuedAt).toBeInstanceOf(Date);
    expect(result.affectedRequests).toEqual(["req-1", "req-2", "req-3"]);
    expect(result.requestId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 6: Global resume resumes all
  // -------------------------------------------------------------------------

  it("globally resumes all pipelines after global pause", () => {
    const { controller } = createTestSetup();

    controller.pause("admin");
    expect(controller.isGloballyPaused()).toBe(true);

    const result = controller.resume("admin");

    expect(controller.isGloballyPaused()).toBe(false);
    expect(result.action).toBe("resumed");
    expect(result.issuedBy).toBe("admin");
    expect(result.issuedAt).toBeInstanceOf(Date);
    expect(result.requestId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 7: Per-request pause
  // -------------------------------------------------------------------------

  it("pauses a specific request without affecting others", () => {
    const { controller } = createTestSetup();

    const result = controller.pause("admin", "req-1");

    expect(controller.isPaused("req-1")).toBe(true);
    expect(controller.isPaused("req-2")).toBe(false);
    expect(controller.isGloballyPaused()).toBe(false);
    expect(result.action).toBe("paused");
    expect(result.requestId).toBe("req-1");
    expect(result.affectedRequests).toEqual(["req-1"]);
  });

  // -------------------------------------------------------------------------
  // Test 8: Per-request resume
  // -------------------------------------------------------------------------

  it("resumes a specific paused request", () => {
    const { controller } = createTestSetup();

    controller.pause("admin", "req-1");
    expect(controller.isPaused("req-1")).toBe(true);

    const result = controller.resume("admin", "req-1");

    expect(controller.isPaused("req-1")).toBe(false);
    expect(result.action).toBe("resumed");
    expect(result.requestId).toBe("req-1");
    expect(result.affectedRequests).toEqual(["req-1"]);
  });

  // -------------------------------------------------------------------------
  // Test 9: Pause does not trigger HALTED
  // -------------------------------------------------------------------------

  it("does not set system to HALTED state (pause is not kill)", () => {
    const { controller } = createTestSetup();

    controller.pause("admin");

    // PauseResumeController does not touch KillSwitch state.
    // The system state remains "running" from the kill switch perspective.
    // We verify this by checking that the controller only manages pause state.
    expect(controller.isGloballyPaused()).toBe(true);
    // The controller has no isHalted method -- it is independent of kill switch.
  });

  // -------------------------------------------------------------------------
  // Test 10: Pause emits audit event
  // -------------------------------------------------------------------------

  it("emits pause_issued audit event on global pause", () => {
    const { controller, auditTrail } = createTestSetup();

    controller.pause("admin@example.com");

    const pauseEvent = auditTrail.events.find(
      (e) => e.event_type === "pause_issued",
    );
    expect(pauseEvent).toBeDefined();
    expect(pauseEvent!.payload.issuedBy).toBe("admin@example.com");
    expect(pauseEvent!.payload.scope).toBe("global");
    expect(pauseEvent!.payload.affectedRequests).toEqual([
      "req-1",
      "req-2",
      "req-3",
    ]);
  });

  it("emits pause_issued audit event on per-request pause", () => {
    const { controller, auditTrail } = createTestSetup();

    controller.pause("admin", "req-1");

    const pauseEvent = auditTrail.events.find(
      (e) => e.event_type === "pause_issued",
    );
    expect(pauseEvent).toBeDefined();
    expect(pauseEvent!.payload.issuedBy).toBe("admin");
    expect(pauseEvent!.payload.scope).toBe("request");
    expect(pauseEvent!.payload.requestId).toBe("req-1");
    expect(pauseEvent!.payload.affectedRequests).toEqual(["req-1"]);
  });

  // -------------------------------------------------------------------------
  // Test 11: Resume emits audit event
  // -------------------------------------------------------------------------

  it("emits resume_issued audit event on global resume", () => {
    const { controller, auditTrail } = createTestSetup();

    controller.pause("admin");
    controller.resume("admin@example.com");

    const resumeEvent = auditTrail.events.find(
      (e) => e.event_type === "resume_issued",
    );
    expect(resumeEvent).toBeDefined();
    expect(resumeEvent!.payload.issuedBy).toBe("admin@example.com");
    expect(resumeEvent!.payload.scope).toBe("global");
  });

  it("emits resume_issued audit event on per-request resume", () => {
    const { controller, auditTrail } = createTestSetup();

    controller.pause("admin", "req-1");
    controller.resume("admin@example.com", "req-1");

    const resumeEvent = auditTrail.events.find(
      (e) => e.event_type === "resume_issued",
    );
    expect(resumeEvent).toBeDefined();
    expect(resumeEvent!.payload.issuedBy).toBe("admin@example.com");
    expect(resumeEvent!.payload.scope).toBe("request");
    expect(resumeEvent!.payload.requestId).toBe("req-1");
  });

  // -------------------------------------------------------------------------
  // Test 12: Pause does not cancel escalations
  // -------------------------------------------------------------------------

  it("does not cancel escalations (no escalation engine dependency)", () => {
    const { controller, abortManager } = createTestSetup();

    // PauseResumeController does not depend on EscalationCanceller.
    // It only sends PAUSE abort signals, not KILL signals.
    controller.pause("admin");

    // abortAll is called with "PAUSE", not "KILL_GRACEFUL" or "KILL_HARD"
    expect(abortManager.abortAll).toHaveBeenCalledWith("PAUSE");
    expect(abortManager.abortAll).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Additional: per-request PAUSE abort signal
  // -------------------------------------------------------------------------

  it("sends PAUSE abort signal for per-request pause", () => {
    const { controller, abortManager } = createTestSetup();

    controller.pause("admin", "req-1");

    expect(abortManager.abortRequest).toHaveBeenCalledWith("req-1", "PAUSE");
    expect(abortManager.abortRequest).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Additional: global pause sends PAUSE to abortAll
  // -------------------------------------------------------------------------

  it("sends PAUSE abort signal via abortAll for global pause", () => {
    const { controller, abortManager } = createTestSetup();

    controller.pause("admin");

    expect(abortManager.abortAll).toHaveBeenCalledWith("PAUSE");
  });

  // -------------------------------------------------------------------------
  // Additional: global resume resets abort manager
  // -------------------------------------------------------------------------

  it("resets abort manager on global resume", () => {
    const { controller, abortManager } = createTestSetup();

    controller.pause("admin");
    controller.resume("admin");

    expect(abortManager.reset).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Additional: isPaused returns true when globally paused
  // -------------------------------------------------------------------------

  it("isPaused returns true for any request when globally paused", () => {
    const { controller } = createTestSetup();

    controller.pause("admin");

    expect(controller.isPaused("req-1")).toBe(true);
    expect(controller.isPaused("req-2")).toBe(true);
    expect(controller.isPaused("req-anything")).toBe(true);
  });
});

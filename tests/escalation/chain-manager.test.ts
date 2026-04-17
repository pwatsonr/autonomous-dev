import { EscalationChainManager } from "../../src/escalation/chain-manager";
import type { TimeoutBehaviorResult } from "../../src/escalation/chain-manager";
import type {
  AuditTrail,
  ChainState,
  DeliveryAdapter,
  EscalationMessage,
  EscalationUrgency,
  ResolvedRoute,
  RoutingTarget,
  Timer,
  TimerHandle,
} from "../../src/escalation/types";

// ---------------------------------------------------------------------------
// Mock timer
// ---------------------------------------------------------------------------

interface PendingTimer {
  id: number;
  callback: () => void;
  ms: number;
  cancelled: boolean;
}

/**
 * A deterministic mock timer that allows manual advancement.
 * Callbacks fire synchronously when `advance()` is called.
 */
function createMockTimer(): Timer & {
  pendingTimers: PendingTimer[];
  advance(ms: number): void;
  advanceAll(): void;
} {
  let nextId = 1;
  const pendingTimers: PendingTimer[] = [];
  let elapsed = 0;

  return {
    pendingTimers,

    setTimeout(callback: () => void, ms: number): TimerHandle {
      const timer: PendingTimer = {
        id: nextId++,
        callback,
        ms: elapsed + ms,
        cancelled: false,
      };
      pendingTimers.push(timer);
      return timer.id;
    },

    clearTimeout(handle: TimerHandle): void {
      const timer = pendingTimers.find((t) => t.id === handle);
      if (timer) {
        timer.cancelled = true;
      }
    },

    /**
     * Advance time by `ms` milliseconds and fire any timers whose
     * deadline has been reached (in order of deadline).
     */
    advance(ms: number): void {
      elapsed += ms;
      // Sort by deadline to fire in order
      const ready = pendingTimers
        .filter((t) => !t.cancelled && t.ms <= elapsed)
        .sort((a, b) => a.ms - b.ms);

      for (const timer of ready) {
        if (!timer.cancelled) {
          timer.cancelled = true; // Prevent double-fire
          timer.callback();
        }
      }
    },

    /** Fire all pending timers regardless of time. */
    advanceAll(): void {
      const maxMs = Math.max(...pendingTimers.filter((t) => !t.cancelled).map((t) => t.ms), 0);
      if (maxMs > elapsed) {
        this.advance(maxMs - elapsed + 1);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Mock delivery adapter
// ---------------------------------------------------------------------------

interface DeliveryCall {
  message: EscalationMessage;
  target: RoutingTarget;
}

function createMockDeliveryAdapter(): DeliveryAdapter & {
  calls: DeliveryCall[];
} {
  const calls: DeliveryCall[] = [];
  return {
    calls,
    deliver: jest.fn(async (message: EscalationMessage, target: RoutingTarget) => {
      calls.push({ message, target });
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock audit trail
// ---------------------------------------------------------------------------

interface AuditCall {
  event_type: string;
  payload: Record<string, unknown>;
}

function createMockAuditTrail(): AuditTrail & { events: AuditCall[] } {
  const events: AuditCall[] = [];
  return {
    events,
    append: jest.fn(async (event: AuditCall) => {
      events.push(event);
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRIMARY_TARGET: RoutingTarget = {
  target_id: "primary-team",
  display_name: "Primary Team",
  channel: "slack-primary",
};

const SECONDARY_TARGET: RoutingTarget = {
  target_id: "secondary-team",
  display_name: "Secondary Team",
  channel: "slack-secondary",
};

const TIMEOUT_MINUTES = 60;
const TIMEOUT_MS = TIMEOUT_MINUTES * 60 * 1000;

/** Build a minimal valid EscalationMessage. */
function makeEscalation(
  overrides: Partial<EscalationMessage> = {},
): EscalationMessage {
  return {
    schema_version: "v1",
    escalation_id: overrides.escalation_id ?? "esc-20260408-001",
    timestamp: "2026-04-08T12:00:00Z",
    request_id: overrides.request_id ?? "req-001",
    repository: "test-repo",
    pipeline_phase: "code_review",
    escalation_type: "technical",
    urgency: overrides.urgency ?? ("soon" as EscalationUrgency),
    summary: "Test escalation",
    failure_reason: "Test failure",
    options: [
      { option_id: "opt-1", label: "Fix", action: "fix" },
      { option_id: "opt-2", label: "Skip", action: "skip" },
    ],
    retry_count: 0,
    ...overrides,
  };
}

/** Build a ResolvedRoute with optional secondary. */
function makeRoute(
  overrides: Partial<ResolvedRoute> = {},
): ResolvedRoute {
  return {
    primary: PRIMARY_TARGET,
    secondary: undefined,
    timeoutMinutes: TIMEOUT_MINUTES,
    timeoutBehavior: "pause",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EscalationChainManager", () => {
  let timer: ReturnType<typeof createMockTimer>;
  let delivery: ReturnType<typeof createMockDeliveryAdapter>;
  let audit: ReturnType<typeof createMockAuditTrail>;
  let manager: EscalationChainManager;

  beforeEach(() => {
    timer = createMockTimer();
    delivery = createMockDeliveryAdapter();
    audit = createMockAuditTrail();
    manager = new EscalationChainManager(timer, delivery, audit);
  });

  // -------------------------------------------------------------------------
  // Test Case 7: Start chain dispatches to primary (AC 6)
  // -------------------------------------------------------------------------
  test("startChain dispatches to primary target via deliveryAdapter", () => {
    const escalation = makeEscalation();
    const route = makeRoute();

    const state = manager.startChain(escalation, route);

    // Delivery adapter called with message and primary target
    expect(delivery.calls).toHaveLength(1);
    expect(delivery.calls[0].message).toEqual(escalation);
    expect(delivery.calls[0].target).toEqual(PRIMARY_TARGET);

    // State reflects primary dispatched
    expect(state.status).toBe("primary_dispatched");
    expect(state.primaryTarget).toEqual(PRIMARY_TARGET);
    expect(state.escalationId).toBe("esc-20260408-001");
    expect(state.requestId).toBe("req-001");
  });

  // -------------------------------------------------------------------------
  // Test Case 8: Primary timeout triggers secondary dispatch (AC 7)
  // -------------------------------------------------------------------------
  test("primary timeout triggers secondary dispatch", () => {
    const escalation = makeEscalation();
    const route = makeRoute({ secondary: SECONDARY_TARGET });

    manager.startChain(escalation, route);

    // Advance timer past primary timeout
    timer.advance(TIMEOUT_MS);

    // Secondary should now be dispatched
    expect(delivery.calls).toHaveLength(2);
    expect(delivery.calls[1].target).toEqual(SECONDARY_TARGET);

    // State should reflect secondary dispatched
    const state = manager.getChainState("esc-20260408-001");
    expect(state).not.toBeNull();
    expect(state!.status).toBe("secondary_dispatched");
    expect(state!.secondaryDispatchedAt).toBeInstanceOf(Date);
  });

  // -------------------------------------------------------------------------
  // Test Case 9: Secondary timeout applies behavior (AC 8)
  // -------------------------------------------------------------------------
  test("secondary timeout applies timeout behavior", () => {
    const behaviorResults: TimeoutBehaviorResult[] = [];
    manager.onTimeoutBehavior = (result) => behaviorResults.push(result);

    const escalation = makeEscalation();
    const route = makeRoute({
      secondary: SECONDARY_TARGET,
      timeoutBehavior: "retry",
    });

    manager.startChain(escalation, route);

    // Advance past primary timeout -> secondary dispatched
    timer.advance(TIMEOUT_MS);
    expect(delivery.calls).toHaveLength(2);

    // Advance past secondary timeout -> behavior applied
    timer.advance(TIMEOUT_MS);

    const state = manager.getChainState("esc-20260408-001");
    expect(state).not.toBeNull();
    expect(state!.status).toBe("timeout_behavior_applied");

    // Behavior callback fired
    expect(behaviorResults).toHaveLength(1);
    expect(behaviorResults[0].behavior).toBe("retry");
    expect(behaviorResults[0].escalationId).toBe("esc-20260408-001");
  });

  // -------------------------------------------------------------------------
  // Test Case 10: No secondary: timeout applies behavior directly (AC 8)
  // -------------------------------------------------------------------------
  test("no secondary target: primary timeout applies behavior directly", () => {
    const behaviorResults: TimeoutBehaviorResult[] = [];
    manager.onTimeoutBehavior = (result) => behaviorResults.push(result);

    const escalation = makeEscalation();
    const route = makeRoute({
      secondary: undefined,
      timeoutBehavior: "cancel",
    });

    manager.startChain(escalation, route);

    // Advance past primary timeout -> behavior applied immediately
    timer.advance(TIMEOUT_MS);

    // No secondary dispatch -- only 1 delivery call (primary)
    expect(delivery.calls).toHaveLength(1);

    const state = manager.getChainState("esc-20260408-001");
    expect(state).not.toBeNull();
    expect(state!.status).toBe("timeout_behavior_applied");

    expect(behaviorResults).toHaveLength(1);
    expect(behaviorResults[0].behavior).toBe("cancel");
  });

  // -------------------------------------------------------------------------
  // Test Case 11: Cancel clears timer (AC 10)
  // -------------------------------------------------------------------------
  test("cancelChain prevents timeout callback from firing", () => {
    const behaviorResults: TimeoutBehaviorResult[] = [];
    manager.onTimeoutBehavior = (result) => behaviorResults.push(result);

    const escalation = makeEscalation();
    const route = makeRoute({ timeoutBehavior: "retry" });

    manager.startChain(escalation, route);

    // Cancel before timeout fires
    manager.cancelChain("esc-20260408-001");

    // Advance past timeout -- callback should NOT fire
    timer.advance(TIMEOUT_MS);

    const state = manager.getChainState("esc-20260408-001");
    expect(state).not.toBeNull();
    expect(state!.status).toBe("cancelled");

    // No behavior callback
    expect(behaviorResults).toHaveLength(0);

    // Only the initial primary dispatch
    expect(delivery.calls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Test Case 12: Cancel after resolution is no-op (AC 12)
  // -------------------------------------------------------------------------
  test("cancel after resolution is a no-op", () => {
    const escalation = makeEscalation();
    const route = makeRoute({
      secondary: undefined,
      timeoutBehavior: "pause",
    });

    manager.startChain(escalation, route);

    // Simulate timeout -> behavior applied (which sets status to timeout_behavior_applied)
    timer.advance(TIMEOUT_MS);

    const stateBefore = manager.getChainState("esc-20260408-001");
    expect(stateBefore!.status).toBe("timeout_behavior_applied");

    // Cancel should be no-op (timeout_behavior_applied is not cancelled/resolved,
    // but let's also test with a manually set resolved state)
    // First, verify that cancelling a chain whose status is not cancelled/resolved works
    manager.cancelChain("esc-20260408-001");

    // For the true "resolved" case, directly test with a second chain
    const escalation2 = makeEscalation({ escalation_id: "esc-20260408-002" });
    manager.startChain(escalation2, route);
    timer.advance(TIMEOUT_MS);

    // Cancel after timeout should not throw
    expect(() => manager.cancelChain("esc-20260408-002")).not.toThrow();

    // Cancel of a completely unknown chain is also a no-op
    expect(() => manager.cancelChain("nonexistent")).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Test Case 13: cancelAllPending cancels all (AC 11)
  // -------------------------------------------------------------------------
  test("cancelAllPending cancels all active chains", () => {
    const behaviorResults: TimeoutBehaviorResult[] = [];
    manager.onTimeoutBehavior = (result) => behaviorResults.push(result);

    // Start 3 chains
    const esc1 = makeEscalation({ escalation_id: "esc-20260408-001", request_id: "req-001" });
    const esc2 = makeEscalation({ escalation_id: "esc-20260408-002", request_id: "req-002" });
    const esc3 = makeEscalation({ escalation_id: "esc-20260408-003", request_id: "req-003" });

    const route = makeRoute({ timeoutBehavior: "retry" });

    manager.startChain(esc1, route);
    manager.startChain(esc2, route);
    manager.startChain(esc3, route);

    expect(delivery.calls).toHaveLength(3);

    // Cancel all
    manager.cancelAllPending();

    // Advance past timeout -- no callbacks should fire
    timer.advance(TIMEOUT_MS);

    expect(behaviorResults).toHaveLength(0);

    // All chains should be cancelled
    expect(manager.getChainState("esc-20260408-001")!.status).toBe("cancelled");
    expect(manager.getChainState("esc-20260408-002")!.status).toBe("cancelled");
    expect(manager.getChainState("esc-20260408-003")!.status).toBe("cancelled");
  });

  // -------------------------------------------------------------------------
  // Test Case 14: cancelAllPendingForRequest is scoped (AC 11)
  // -------------------------------------------------------------------------
  test("cancelAllPendingForRequest only cancels chains for the specified request", () => {
    const behaviorResults: TimeoutBehaviorResult[] = [];
    manager.onTimeoutBehavior = (result) => behaviorResults.push(result);

    // 2 chains for req-001, 1 chain for req-002
    const esc1 = makeEscalation({ escalation_id: "esc-20260408-001", request_id: "req-001" });
    const esc2 = makeEscalation({ escalation_id: "esc-20260408-002", request_id: "req-001" });
    const esc3 = makeEscalation({ escalation_id: "esc-20260408-003", request_id: "req-002" });

    const route = makeRoute({ timeoutBehavior: "retry" });

    manager.startChain(esc1, route);
    manager.startChain(esc2, route);
    manager.startChain(esc3, route);

    // Cancel only req-001's chains
    manager.cancelAllPendingForRequest("req-001");

    // req-001's chains are cancelled
    expect(manager.getChainState("esc-20260408-001")!.status).toBe("cancelled");
    expect(manager.getChainState("esc-20260408-002")!.status).toBe("cancelled");

    // req-002's chain is still active
    expect(manager.getChainState("esc-20260408-003")!.status).toBe("primary_dispatched");

    // Advance timeout -- only req-002's chain should fire
    timer.advance(TIMEOUT_MS);

    expect(behaviorResults).toHaveLength(1);
    expect(behaviorResults[0].escalationId).toBe("esc-20260408-003");
  });

  // -------------------------------------------------------------------------
  // Test Case 15: Skip rejected for non-informational (AC 9)
  // -------------------------------------------------------------------------
  test("skip timeout behavior rejected for non-informational urgency, falls back to pause", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const behaviorResults: TimeoutBehaviorResult[] = [];
    manager.onTimeoutBehavior = (result) => behaviorResults.push(result);

    const escalation = makeEscalation({ urgency: "soon" });
    const route = makeRoute({
      secondary: undefined,
      timeoutBehavior: "skip",
    });

    manager.startChain(escalation, route);

    // Advance past timeout
    timer.advance(TIMEOUT_MS);

    // Behavior should be "pause" (fallback from "skip")
    expect(behaviorResults).toHaveLength(1);
    expect(behaviorResults[0].behavior).toBe("pause");

    // Warning logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Timeout behavior "skip" is only allowed for "informational" urgency'),
    );

    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test Case 16: Skip allowed for informational (AC 9)
  // -------------------------------------------------------------------------
  test("skip timeout behavior allowed for informational urgency", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const behaviorResults: TimeoutBehaviorResult[] = [];
    manager.onTimeoutBehavior = (result) => behaviorResults.push(result);

    const escalation = makeEscalation({ urgency: "informational" });
    const route = makeRoute({
      secondary: undefined,
      timeoutBehavior: "skip",
    });

    manager.startChain(escalation, route);
    timer.advance(TIMEOUT_MS);

    // Behavior should be "skip" (allowed for informational)
    expect(behaviorResults).toHaveLength(1);
    expect(behaviorResults[0].behavior).toBe("skip");

    // No warning logged about "skip" fallback
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Timeout behavior "skip" is only allowed'),
    );

    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test Case 17: Audit: escalation_raised on start (AC 13)
  // -------------------------------------------------------------------------
  test("escalation_raised audit event emitted on startChain", () => {
    const escalation = makeEscalation({
      escalation_type: "infrastructure",
    });
    const route = makeRoute();

    manager.startChain(escalation, route);

    const raisedEvents = audit.events.filter(
      (e) => e.event_type === "escalation_raised",
    );
    expect(raisedEvents).toHaveLength(1);
    expect(raisedEvents[0].payload).toMatchObject({
      escalation_id: "esc-20260408-001",
      request_id: "req-001",
      escalation_type: "infrastructure",
      target: PRIMARY_TARGET.target_id,
    });
  });

  // -------------------------------------------------------------------------
  // Test Case 18: Audit: escalation_timeout on primary timeout (AC 13)
  // -------------------------------------------------------------------------
  test("escalation_timeout audit event on primary timeout includes target: primary", () => {
    const escalation = makeEscalation();
    const route = makeRoute({ secondary: SECONDARY_TARGET });

    manager.startChain(escalation, route);
    timer.advance(TIMEOUT_MS);

    const timeoutEvents = audit.events.filter(
      (e) => e.event_type === "escalation_timeout",
    );
    expect(timeoutEvents).toHaveLength(1);
    expect(timeoutEvents[0].payload).toMatchObject({
      escalation_id: "esc-20260408-001",
      target: "primary",
      chainedTo: "secondary",
    });
  });

  // -------------------------------------------------------------------------
  // Test Case 19: Audit: escalation_timeout on secondary timeout (AC 13)
  // -------------------------------------------------------------------------
  test("escalation_timeout audit event on secondary timeout includes target: secondary and behavior", () => {
    const escalation = makeEscalation();
    const route = makeRoute({
      secondary: SECONDARY_TARGET,
      timeoutBehavior: "retry",
    });

    manager.startChain(escalation, route);

    // Primary timeout -> secondary dispatched
    timer.advance(TIMEOUT_MS);

    // Secondary timeout -> behavior applied
    timer.advance(TIMEOUT_MS);

    const timeoutEvents = audit.events.filter(
      (e) => e.event_type === "escalation_timeout",
    );

    // Two timeout events: primary and secondary
    expect(timeoutEvents).toHaveLength(2);

    // First: primary timeout (chained to secondary)
    expect(timeoutEvents[0].payload).toMatchObject({
      target: "primary",
      chainedTo: "secondary",
    });

    // Second: secondary timeout (behavior applied)
    expect(timeoutEvents[1].payload).toMatchObject({
      target: "secondary",
      behavior: "retry",
    });
  });

  // -------------------------------------------------------------------------
  // Additional: getChainState returns null for unknown escalation
  // -------------------------------------------------------------------------
  test("getChainState returns null for unknown escalation ID", () => {
    const result = manager.getChainState("nonexistent");
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Additional: double-cancel is idempotent (AC 12)
  // -------------------------------------------------------------------------
  test("double cancel is idempotent -- no error on second cancel", () => {
    const escalation = makeEscalation();
    const route = makeRoute();

    manager.startChain(escalation, route);

    manager.cancelChain("esc-20260408-001");
    expect(manager.getChainState("esc-20260408-001")!.status).toBe("cancelled");

    // Second cancel should be a no-op
    expect(() => manager.cancelChain("esc-20260408-001")).not.toThrow();
    expect(manager.getChainState("esc-20260408-001")!.status).toBe("cancelled");
  });

  // -------------------------------------------------------------------------
  // Audit: no secondary, primary timeout includes behavior in payload
  // -------------------------------------------------------------------------
  test("primary timeout without secondary includes behavior in audit event", () => {
    const escalation = makeEscalation();
    const route = makeRoute({
      secondary: undefined,
      timeoutBehavior: "cancel",
    });

    manager.startChain(escalation, route);
    timer.advance(TIMEOUT_MS);

    const timeoutEvents = audit.events.filter(
      (e) => e.event_type === "escalation_timeout",
    );
    expect(timeoutEvents).toHaveLength(1);
    expect(timeoutEvents[0].payload).toMatchObject({
      target: "primary",
      behavior: "cancel",
    });
    // No "chainedTo" key when there is no secondary
    expect(timeoutEvents[0].payload).not.toHaveProperty("chainedTo");
  });
});

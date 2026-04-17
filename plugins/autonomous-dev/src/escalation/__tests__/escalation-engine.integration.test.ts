/**
 * Integration tests for EscalationEngine (SPEC-009-2-4, Task 10).
 *
 * These tests wire real implementations (no mocks) to verify end-to-end
 * escalation flows. Only the delivery adapter, audit trail, and timer are
 * test doubles (by necessity -- they are I/O boundaries).
 *
 * Scenarios:
 *   14. Quality escalation after 3 retries
 *   15. Escalation chain timeout to secondary
 *   16. Security escalation halts immediately
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EscalationEngine } from "../escalation-engine";
import { EscalationClassifier } from "../classifier";
import { EscalationFormatter, EscalationIdGenerator } from "../formatter";
import { RoutingEngine } from "../routing-engine";
import { EscalationChainManager } from "../chain-manager";
import type {
  AuditTrail,
  DeliveryAdapter,
  EscalationConfig,
  EscalationMessage,
  RoutingTarget,
  Timer,
  TimerHandle,
} from "../types";
import type { FailureContext } from "../classifier";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

interface MockTimer extends Timer {
  advance(ms: number): void;
}

function createMockTimer(): MockTimer {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  const timings = new Map<number, number>();
  let currentTime = 0;

  return {
    setTimeout(callback: () => void, ms: number): TimerHandle {
      const id = nextId++;
      callbacks.set(id, callback);
      timings.set(id, currentTime + ms);
      return id;
    },
    clearTimeout(handle: TimerHandle): void {
      callbacks.delete(handle as number);
      timings.delete(handle as number);
    },
    advance(ms: number): void {
      currentTime += ms;
      // Fire all elapsed timers in order
      for (const [id, fireAt] of Array.from(timings.entries()).sort((a, b) => a[1] - b[1])) {
        if (fireAt <= currentTime && callbacks.has(id)) {
          const cb = callbacks.get(id)!;
          callbacks.delete(id);
          timings.delete(id);
          cb();
        }
      }
    },
  };
}

interface CapturedEvent {
  event_type: string;
  payload: Record<string, unknown>;
}

function createMockAuditTrail(): AuditTrail & { events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  return {
    events,
    append: jest.fn(async (event) => {
      events.push(event as CapturedEvent);
    }),
  };
}

function createMockDeliveryAdapter(): DeliveryAdapter & {
  deliveries: Array<{ message: EscalationMessage; target: RoutingTarget }>;
} {
  const deliveries: Array<{ message: EscalationMessage; target: RoutingTarget }> = [];
  return {
    deliveries,
    deliver: jest.fn(async (message, target) => {
      deliveries.push({ message, target });
    }),
  };
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const PRIMARY_TARGET: RoutingTarget = {
  target_id: "primary-reviewer",
  display_name: "Primary Reviewer",
  channel: "slack",
};

const SECONDARY_TARGET: RoutingTarget = {
  target_id: "escalation-manager",
  display_name: "Escalation Manager",
  channel: "email",
};

const SECURITY_TARGET: RoutingTarget = {
  target_id: "security-team",
  display_name: "Security Team",
  channel: "pagerduty",
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "esc-int-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createEngine(
  config: EscalationConfig,
  timer: MockTimer,
  delivery: DeliveryAdapter,
  audit: AuditTrail,
): EscalationEngine {
  const classifier = new EscalationClassifier();
  const statePath = path.join(tmpDir, "escalation-counter.json");
  const idGen = new EscalationIdGenerator(statePath, () => "20260408");
  const formatter = new EscalationFormatter(idGen, config.verbosity);
  const routingEngine = new RoutingEngine(config);
  const chainManager = new EscalationChainManager(timer, delivery, audit);

  return new EscalationEngine(
    classifier,
    formatter,
    routingEngine,
    chainManager,
    audit,
  );
}

// ---------------------------------------------------------------------------
// Integration Scenario 14: Quality escalation after 3 retries
// ---------------------------------------------------------------------------

describe("Integration: Quality escalation after 3 retries", () => {
  test("classifies as quality, formats, routes, starts chain, emits audit", () => {
    const timer = createMockTimer();
    const delivery = createMockDeliveryAdapter();
    const audit = createMockAuditTrail();

    const config: EscalationConfig = {
      routing: {
        mode: "default",
        default_target: PRIMARY_TARGET,
      },
      verbosity: "standard",
      retry_budget: 3,
    };

    const engine = createEngine(config, timer, delivery, audit);

    const failureContext: FailureContext = {
      pipelinePhase: "code_review",
      errorType: "review_gate_failed",
      errorMessage: "Code review failed: insufficient test coverage",
      retryCount: 3,
      maxRetries: 3,
    };

    const result = engine.raise(failureContext, {
      requestId: "req-100",
      repository: "my-app",
      pipelinePhase: "code_review",
      retryCount: 3,
    });

    // Verify classification
    expect(result.message.escalation_type).toBe("quality");
    expect(result.message.urgency).toBe("soon");

    // Verify formatting
    expect(result.message.schema_version).toBe("v1");
    expect(result.message.escalation_id).toMatch(/^esc-20260408-\d{3,}$/);
    expect(result.message.request_id).toBe("req-100");
    expect(result.message.repository).toBe("my-app");
    expect(result.message.summary).toContain("quality");
    expect(result.message.options.length).toBeGreaterThanOrEqual(2);

    // Verify routing: dispatched to configured target
    expect(delivery.deliveries).toHaveLength(1);
    expect(delivery.deliveries[0].target.target_id).toBe("primary-reviewer");

    // Verify pipeline behavior
    expect(result.pipelineBehavior).toBe("pause_at_boundary");

    // Verify audit: escalation_raised
    const raisedEvents = audit.events.filter(
      (e) => e.event_type === "escalation_raised",
    );
    expect(raisedEvents).toHaveLength(1);
    expect(raisedEvents[0].payload.escalation_type).toBe("quality");
    expect(raisedEvents[0].payload.target).toBe("primary-reviewer");
  });
});

// ---------------------------------------------------------------------------
// Integration Scenario 15: Escalation chain timeout to secondary
// ---------------------------------------------------------------------------

describe("Integration: Escalation chain timeout to secondary", () => {
  test("primary timeout dispatches to secondary, secondary timeout applies behavior", () => {
    const timer = createMockTimer();
    const delivery = createMockDeliveryAdapter();
    const audit = createMockAuditTrail();

    const config: EscalationConfig = {
      routing: {
        mode: "advanced",
        default_target: PRIMARY_TARGET,
        advanced: {
          quality: {
            primary: PRIMARY_TARGET,
            secondary: SECONDARY_TARGET,
            timeout_minutes: 30,
            timeout_behavior: "pause",
          },
        } as any,
      },
      verbosity: "standard",
      retry_budget: 3,
    };

    const engine = createEngine(config, timer, delivery, audit);

    const result = engine.raise(
      {
        pipelinePhase: "code_review",
        errorType: "review_gate_failed",
        errorMessage: "Quality gate failed",
        retryCount: 3,
        maxRetries: 3,
      },
      {
        requestId: "req-200",
        repository: "my-app",
        pipelinePhase: "code_review",
        retryCount: 3,
      },
    );

    // Initial dispatch to primary
    expect(delivery.deliveries).toHaveLength(1);
    expect(delivery.deliveries[0].target.target_id).toBe("primary-reviewer");

    // Advance past primary timeout (30 minutes)
    timer.advance(30 * 60 * 1000);

    // Secondary should be dispatched
    expect(delivery.deliveries).toHaveLength(2);
    expect(delivery.deliveries[1].target.target_id).toBe("escalation-manager");

    // Verify primary timeout audit event
    const timeoutEvents = audit.events.filter(
      (e) => e.event_type === "escalation_timeout",
    );
    expect(timeoutEvents.length).toBeGreaterThanOrEqual(1);
    expect(timeoutEvents[0].payload.target).toBe("primary");
    expect(timeoutEvents[0].payload.chainedTo).toBe("secondary");

    // Advance past secondary timeout
    timer.advance(30 * 60 * 1000);

    // Verify secondary timeout audit event
    const allTimeouts = audit.events.filter(
      (e) => e.event_type === "escalation_timeout",
    );
    expect(allTimeouts).toHaveLength(2);
    expect(allTimeouts[1].payload.target).toBe("secondary");
    expect(allTimeouts[1].payload.behavior).toBe("pause");

    // Verify full audit trail: escalation_raised, timeout (primary), timeout (secondary)
    const allEvents = audit.events.map((e) => e.event_type);
    expect(allEvents).toContain("escalation_raised");
    expect(allEvents.filter((e) => e === "escalation_timeout")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Integration Scenario 16: Security escalation halts immediately
// ---------------------------------------------------------------------------

describe("Integration: Security escalation halts immediately", () => {
  test("security escalation: immediate urgency, halt behavior, forced pause timeout", () => {
    const timer = createMockTimer();
    const delivery = createMockDeliveryAdapter();
    const audit = createMockAuditTrail();

    const config: EscalationConfig = {
      routing: {
        mode: "advanced",
        default_target: PRIMARY_TARGET,
        advanced: {
          security: {
            primary: SECURITY_TARGET,
            secondary: SECONDARY_TARGET,
            timeout_minutes: 10,
            timeout_behavior: "cancel", // Should be overridden to "pause"
          },
        } as any,
      },
      verbosity: "verbose",
      retry_budget: 1,
    };

    const engine = createEngine(config, timer, delivery, audit);

    const result = engine.raise(
      {
        pipelinePhase: "security_review",
        errorType: "security_scan_failed",
        errorMessage: "Critical vulnerability detected in dependency",
        retryCount: 0,
        maxRetries: 1,
        securityFindings: [{ severity: "critical", count: 3 }],
      },
      {
        requestId: "req-300",
        repository: "critical-service",
        pipelinePhase: "security_review",
        retryCount: 0,
      },
    );

    // Verify classification
    expect(result.message.escalation_type).toBe("security");
    expect(result.message.urgency).toBe("immediate");

    // Verify pipeline behavior: halt_immediately
    expect(result.pipelineBehavior).toBe("halt_immediately");

    // Verify routing: dispatched to security team
    expect(delivery.deliveries).toHaveLength(1);
    expect(delivery.deliveries[0].target.target_id).toBe("security-team");

    // Verify chain timeout behavior is "pause" (immutable security invariant)
    // Let primary timeout fire to confirm behavior
    timer.advance(10 * 60 * 1000);

    // Secondary dispatched
    expect(delivery.deliveries).toHaveLength(2);
    expect(delivery.deliveries[1].target.target_id).toBe("escalation-manager");

    // Let secondary timeout fire
    timer.advance(10 * 60 * 1000);

    // The timeout behavior should be "pause" (forced from "cancel")
    const secondaryTimeouts = audit.events.filter(
      (e) =>
        e.event_type === "escalation_timeout" &&
        e.payload.target === "secondary",
    );
    expect(secondaryTimeouts).toHaveLength(1);
    expect(secondaryTimeouts[0].payload.behavior).toBe("pause");

    // Verify audit trail includes escalation_raised
    const raisedEvents = audit.events.filter(
      (e) => e.event_type === "escalation_raised",
    );
    expect(raisedEvents).toHaveLength(1);
    expect(raisedEvents[0].payload.urgency).toBe("immediate");
  });

  test("security escalation uses pause timeout regardless of config", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    const timer = createMockTimer();
    const delivery = createMockDeliveryAdapter();
    const audit = createMockAuditTrail();

    const config: EscalationConfig = {
      routing: {
        mode: "advanced",
        default_target: PRIMARY_TARGET,
        advanced: {
          security: {
            primary: SECURITY_TARGET,
            timeout_minutes: 5,
            timeout_behavior: "skip", // Should be forced to "pause"
          },
        } as any,
      },
      verbosity: "standard",
      retry_budget: 1,
    };

    const engine = createEngine(config, timer, delivery, audit);

    engine.raise(
      {
        pipelinePhase: "build",
        errorType: "security_scan",
        errorMessage: "High severity finding",
        retryCount: 0,
        maxRetries: 1,
        securityFindings: [{ severity: "high", count: 1 }],
      },
      {
        requestId: "req-301",
        repository: "my-service",
        pipelinePhase: "build",
        retryCount: 0,
      },
    );

    // Let timeout fire (no secondary)
    timer.advance(5 * 60 * 1000);

    // Verify behavior is "pause", not "skip"
    const timeoutEvents = audit.events.filter(
      (e) => e.event_type === "escalation_timeout",
    );
    expect(timeoutEvents).toHaveLength(1);
    expect(timeoutEvents[0].payload.behavior).toBe("pause");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Security escalation timeout behavior forced"),
    );

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Integration: Re-escalation linking
// ---------------------------------------------------------------------------

describe("Integration: Re-escalation linking", () => {
  test("previousEscalationId is preserved through the full pipeline", () => {
    const timer = createMockTimer();
    const delivery = createMockDeliveryAdapter();
    const audit = createMockAuditTrail();

    const config: EscalationConfig = {
      routing: {
        mode: "default",
        default_target: PRIMARY_TARGET,
      },
      verbosity: "standard",
      retry_budget: 3,
    };

    const engine = createEngine(config, timer, delivery, audit);

    // First escalation
    const first = engine.raise(
      {
        pipelinePhase: "implementation",
        errorType: "build_failed",
        errorMessage: "Compilation error",
        retryCount: 3,
        maxRetries: 3,
      },
      {
        requestId: "req-400",
        repository: "my-app",
        pipelinePhase: "implementation",
        retryCount: 3,
      },
    );

    // Second escalation linking to first
    const second = engine.raise(
      {
        pipelinePhase: "implementation",
        errorType: "build_failed",
        errorMessage: "Still failing after guidance",
        retryCount: 3,
        maxRetries: 3,
      },
      {
        requestId: "req-400",
        repository: "my-app",
        pipelinePhase: "implementation",
        retryCount: 3,
        previousEscalationId: first.message.escalation_id,
      },
    );

    expect(second.message.previous_escalation_id).toBe(first.message.escalation_id);
  });
});

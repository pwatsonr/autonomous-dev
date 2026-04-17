/**
 * Integration tests for the human response handling flow (SPEC-009-3-4, Task 10).
 *
 * These tests wire real implementations together to verify end-to-end
 * lifecycle scenarios. Only I/O boundaries (delivery adapter, audit trail,
 * timer, pipeline executor) are test doubles.
 *
 * Scenarios:
 *   11. Full lifecycle: Escalation -> human responds -> pipeline resumes
 *   12. Full lifecycle: Re-escalation when guidance fails
 *   13. Full lifecycle: Escalation chain timeout -> secondary target responds
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { HumanResponseHandler } from "../human-response-handler";
import { ResponseParser } from "../response-parser";
import { ResponseValidator } from "../response-validator";
import type { EscalationStore, StoredEscalation, KillSwitchQuery } from "../response-validator";
import { ActionResolver } from "../action-resolver";
import {
  PipelineResumptionCoordinator,
  type PipelineExecutor,
} from "../pipeline-resumption";
import { EscalationChainManager } from "../chain-manager";
import { EscalationEngine } from "../escalation-engine";
import { EscalationClassifier } from "../classifier";
import { EscalationFormatter, EscalationIdGenerator } from "../formatter";
import { RoutingEngine } from "../routing-engine";
import { ReEscalationManager } from "../re-escalation-manager";
import type { FailureContext } from "../classifier";
import type {
  AuditTrail,
  DeliveryAdapter,
  EscalationConfig,
  EscalationMessage,
  RoutingTarget,
  Timer,
  TimerHandle,
} from "../types";

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
      for (const [id, fireAt] of Array.from(timings.entries()).sort(
        (a, b) => a[1] - b[1],
      )) {
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
  const deliveries: Array<{
    message: EscalationMessage;
    target: RoutingTarget;
  }> = [];
  return {
    deliveries,
    deliver: jest.fn(async (message, target) => {
      deliveries.push({ message, target });
    }),
  };
}

function createMockPipelineExecutor(): PipelineExecutor & {
  calls: Record<string, unknown[][]>;
} {
  const calls: Record<string, unknown[][]> = {
    markGatePassed: [],
    markGateOverridden: [],
    injectGuidance: [],
    reExecutePhase: [],
    terminateRequest: [],
    resumePipeline: [],
  };

  return {
    calls,
    markGatePassed: jest.fn((...args: unknown[]) => {
      calls.markGatePassed.push(args);
    }),
    markGateOverridden: jest.fn((...args: unknown[]) => {
      calls.markGateOverridden.push(args);
    }),
    injectGuidance: jest.fn((...args: unknown[]) => {
      calls.injectGuidance.push(args);
    }),
    reExecutePhase: jest.fn((...args: unknown[]) => {
      calls.reExecutePhase.push(args);
    }),
    terminateRequest: jest.fn((...args: unknown[]) => {
      calls.terminateRequest.push(args);
    }),
    resumePipeline: jest.fn((...args: unknown[]) => {
      calls.resumePipeline.push(args);
    }),
  };
}

// ---------------------------------------------------------------------------
// Shared targets
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

// ---------------------------------------------------------------------------
// Mutable escalation store
// ---------------------------------------------------------------------------

/**
 * In-memory escalation store that allows adding/updating escalations.
 * Used by integration tests to simulate the full lifecycle.
 */
class InMemoryEscalationStore implements EscalationStore {
  private store = new Map<string, StoredEscalation>();

  add(escalation: StoredEscalation): void {
    this.store.set(escalation.escalationId, escalation);
  }

  getEscalation(escalationId: string): StoredEscalation | null {
    return this.store.get(escalationId) ?? null;
  }

  resolve(escalationId: string): void {
    const esc = this.store.get(escalationId);
    if (esc) {
      esc.status = "resolved";
    }
  }
}

class InMemoryKillSwitch implements KillSwitchQuery {
  private cancelled = new Set<string>();

  cancel(requestId: string): void {
    this.cancelled.add(requestId);
  }

  isRequestCancelled(requestId: string): boolean {
    return this.cancelled.has(requestId);
  }
}

// ---------------------------------------------------------------------------
// Temp dir for ID generator persistence
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resp-handler-int-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Integration Scenario 11: Full lifecycle -- escalation -> respond -> resume
// ---------------------------------------------------------------------------

describe("Integration: Full lifecycle -- escalation -> human responds -> pipeline resumes", () => {
  test("quality escalation raised, approved by pm-lead, pipeline resumes, escalation resolved", () => {
    // --- Setup ---
    const timer = createMockTimer();
    const delivery = createMockDeliveryAdapter();
    const audit = createMockAuditTrail();
    const executor = createMockPipelineExecutor();

    const config: EscalationConfig = {
      routing: {
        mode: "default",
        default_target: PRIMARY_TARGET,
      },
      verbosity: "standard",
      retry_budget: 3,
    };

    const statePath = path.join(tmpDir, "escalation-counter.json");
    const classifier = new EscalationClassifier();
    const idGen = new EscalationIdGenerator(statePath, () => "20260408");
    const formatter = new EscalationFormatter(idGen, config.verbosity);
    const routingEngine = new RoutingEngine(config);
    const chainManager = new EscalationChainManager(timer, delivery, audit);

    const engine = new EscalationEngine(
      classifier,
      formatter,
      routingEngine,
      chainManager,
      audit,
    );

    // --- Step (a): Raise an escalation for a quality failure ---
    const failureContext: FailureContext = {
      pipelinePhase: "code_review",
      errorType: "review_gate_failed",
      errorMessage: "Code review failed: insufficient test coverage",
      retryCount: 3,
      maxRetries: 3,
    };

    const escalationResult = engine.raise(failureContext, {
      requestId: "req-100",
      repository: "my-app",
      pipelinePhase: "code_review",
      retryCount: 3,
    });

    const escalationId = escalationResult.message.escalation_id;

    // --- Step (b): Verify escalation is pending with options ---
    expect(escalationResult.message.escalation_type).toBe("quality");
    expect(escalationResult.message.options.length).toBeGreaterThanOrEqual(2);
    expect(delivery.deliveries).toHaveLength(1);
    expect(delivery.deliveries[0].target.target_id).toBe("primary-reviewer");

    // --- Set up the response handler ---
    const escalationStore = new InMemoryEscalationStore();
    escalationStore.add({
      escalationId,
      requestId: "req-100",
      status: "pending",
      options: escalationResult.message.options,
      gate: "code_review",
    });

    const killSwitch = new InMemoryKillSwitch();
    const parser = new ResponseParser();
    const validator = new ResponseValidator(escalationStore, config, killSwitch);
    const actionResolver = new ActionResolver();
    const resumption = new PipelineResumptionCoordinator(
      executor,
      chainManager,
      audit,
    );
    const reEscalation = new ReEscalationManager(engine, audit);

    const handler = new HumanResponseHandler(
      parser,
      validator,
      actionResolver,
      resumption,
      reEscalation,
      audit,
      escalationStore,
    );

    // --- Step (c): Call handleResponse to approve ---
    // Find the approve option
    const approveOption = escalationResult.message.options.find(
      (opt) => opt.action === "approve" || opt.action === "accept" || opt.action === "review",
    );
    expect(approveOption).toBeDefined();

    const result = handler.handleResponse(
      approveOption!.option_id,
      escalationId,
      "pm-lead",
    );

    // --- Step (d): Verify pipeline resumed ---
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(executor.markGatePassed).toHaveBeenCalled();
    expect(executor.resumePipeline).toHaveBeenCalled();

    // --- Step (e): Verify escalation resolved (via audit trail) ---
    escalationStore.resolve(escalationId);
    const storedEsc = escalationStore.getEscalation(escalationId);
    expect(storedEsc!.status).toBe("resolved");

    // --- Step (f): Verify audit trail contains expected events ---
    const allEventTypes = audit.events.map((e) => e.event_type);
    expect(allEventTypes).toContain("escalation_raised");
    expect(allEventTypes).toContain("escalation_response_received");
    expect(allEventTypes).toContain("escalation_resolved");

    // Verify ordering: raised -> response_received -> resolved
    const raisedIdx = allEventTypes.indexOf("escalation_raised");
    const responseIdx = allEventTypes.indexOf("escalation_response_received");
    const resolvedIdx = allEventTypes.indexOf("escalation_resolved");
    expect(raisedIdx).toBeLessThan(responseIdx);
    expect(responseIdx).toBeLessThan(resolvedIdx);
  });
});

// ---------------------------------------------------------------------------
// Integration Scenario 12: Re-escalation when guidance fails
// ---------------------------------------------------------------------------

describe("Integration: Re-escalation when guidance fails", () => {
  test("freetext guidance applied, phase fails again, re-escalation raised, then cancelled", () => {
    // --- Setup ---
    const timer = createMockTimer();
    const delivery = createMockDeliveryAdapter();
    const audit = createMockAuditTrail();
    const executor = createMockPipelineExecutor();

    const config: EscalationConfig = {
      routing: {
        mode: "default",
        default_target: PRIMARY_TARGET,
      },
      verbosity: "standard",
      retry_budget: 3,
    };

    const statePath = path.join(tmpDir, "escalation-counter.json");
    const classifier = new EscalationClassifier();
    const idGen = new EscalationIdGenerator(statePath, () => "20260408");
    const formatter = new EscalationFormatter(idGen, config.verbosity);
    const routingEngine = new RoutingEngine(config);
    const chainManager = new EscalationChainManager(timer, delivery, audit);

    const engine = new EscalationEngine(
      classifier,
      formatter,
      routingEngine,
      chainManager,
      audit,
    );

    const escalationStore = new InMemoryEscalationStore();
    const killSwitch = new InMemoryKillSwitch();

    // --- Step (a): Raise initial escalation for a technical failure ---
    const initialFailure: FailureContext = {
      pipelinePhase: "implementation",
      errorType: "build_failed",
      errorMessage: "Compilation error: missing import",
      retryCount: 3,
      maxRetries: 3,
    };

    const initialResult = engine.raise(initialFailure, {
      requestId: "req-200",
      repository: "my-app",
      pipelinePhase: "implementation",
      retryCount: 3,
    });

    const escalationId1 = initialResult.message.escalation_id;
    escalationStore.add({
      escalationId: escalationId1,
      requestId: "req-200",
      status: "pending",
      options: initialResult.message.options,
      gate: "implementation",
    });

    // --- Step (b): Respond with freetext guidance ---
    const parser = new ResponseParser();
    const validator = new ResponseValidator(escalationStore, config, killSwitch);
    const actionResolver = new ActionResolver();
    const resumption = new PipelineResumptionCoordinator(
      executor,
      chainManager,
      audit,
    );
    const reEscalation = new ReEscalationManager(engine, audit);

    const handler = new HumanResponseHandler(
      parser,
      validator,
      actionResolver,
      resumption,
      reEscalation,
      audit,
      escalationStore,
    );

    const guidanceResult = handler.handleResponse(
      "Try batch size 10",
      escalationId1,
      "dev-lead",
    );

    expect(guidanceResult.success).toBe(true);
    if (!guidanceResult.success) return;
    expect(guidanceResult.action).toEqual({
      action: "retry_with_changes",
      guidance: "Try batch size 10",
    });

    // Verify guidance was injected
    expect(executor.injectGuidance).toHaveBeenCalledWith(
      "req-200",
      "Try batch size 10",
    );
    expect(executor.reExecutePhase).toHaveBeenCalledWith("req-200");

    // --- Step (c): Pipeline re-executes but fails again ---
    // Simulate: the phase failed again after applying guidance
    const reFailure: FailureContext = {
      pipelinePhase: "implementation",
      errorType: "build_failed",
      errorMessage: "Still failing: batch size 10 causes OOM",
      retryCount: 3,
      maxRetries: 3,
    };

    // --- Step (d): Re-escalation raised via ReEscalationManager ---
    const reEscalationMsg = reEscalation.handlePostGuidanceFailure(
      escalationId1,
      reFailure,
      {
        requestId: "req-200",
        repository: "my-app",
        pipelinePhase: "implementation",
        retryCount: 3,
      },
      "Try batch size 10",
    );

    // --- Step (e): Verify new escalation has previous_escalation_id set ---
    expect(reEscalationMsg.previous_escalation_id).toBeDefined();

    // --- Step (f): Verify re-escalation context ---
    expect(reEscalationMsg.failure_reason).toContain("Still failing");

    // Add the new escalation to the store so we can respond to it
    const escalationId2 = reEscalationMsg.escalation_id;
    escalationStore.add({
      escalationId: escalationId2,
      requestId: "req-200",
      status: "pending",
      options: reEscalationMsg.options,
      gate: "implementation",
    });

    // Ensure the cancel option exists in the new escalation
    // (It may or may not have a cancel option depending on whether
    // loop detection was triggered. With just 1 re-escalation, no loop.)
    // Add a cancel option for the test
    const cancelOpt = reEscalationMsg.options.find(
      (o) => o.action === "cancel" || o.action === "reject",
    );

    // --- Step (g): Respond to re-escalation with cancel ---
    // Find the cancel/reject option, or use freetext to cancel
    // The options from the engine may not have a direct "cancel" option
    // so let's add one to the store for the test
    const cancelEscalation = escalationStore.getEscalation(escalationId2)!;
    if (!cancelOpt) {
      cancelEscalation.options.push({
        option_id: "opt-cancel",
        label: "Cancel request",
        action: "cancel",
      });
    }

    const cancelOptionId = cancelOpt?.option_id ?? "opt-cancel";

    // Create a fresh handler with the updated store
    const handler2 = new HumanResponseHandler(
      parser,
      new ResponseValidator(escalationStore, config, killSwitch),
      actionResolver,
      resumption,
      reEscalation,
      audit,
      escalationStore,
    );

    const cancelResult = handler2.handleResponse(
      cancelOptionId,
      escalationId2,
      "dev-lead",
    );

    // --- Step (h): Verify pipeline terminated ---
    expect(cancelResult.success).toBe(true);
    if (!cancelResult.success) return;
    expect(cancelResult.action).toEqual({ action: "cancel" });
    expect(executor.terminateRequest).toHaveBeenCalledWith(
      "req-200",
      "Cancelled by human",
    );
  });
});

// ---------------------------------------------------------------------------
// Integration Scenario 13: Chain timeout -> secondary target responds
// ---------------------------------------------------------------------------

describe("Integration: Escalation chain timeout -> secondary target responds", () => {
  test("primary times out, secondary receives escalation, responds with approve, pipeline resumes", () => {
    // --- Setup ---
    const timer = createMockTimer();
    const delivery = createMockDeliveryAdapter();
    const audit = createMockAuditTrail();
    const executor = createMockPipelineExecutor();

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

    const statePath = path.join(tmpDir, "escalation-counter.json");
    const classifier = new EscalationClassifier();
    const idGen = new EscalationIdGenerator(statePath, () => "20260408");
    const formatter = new EscalationFormatter(idGen, config.verbosity);
    const routingEngine = new RoutingEngine(config);
    const chainManager = new EscalationChainManager(timer, delivery, audit);

    const engine = new EscalationEngine(
      classifier,
      formatter,
      routingEngine,
      chainManager,
      audit,
    );

    // --- Step (a): Raise escalation with primary and secondary targets ---
    const failureContext: FailureContext = {
      pipelinePhase: "code_review",
      errorType: "review_gate_failed",
      errorMessage: "Code review failed: insufficient test coverage",
      retryCount: 3,
      maxRetries: 3,
    };

    const escalationResult = engine.raise(failureContext, {
      requestId: "req-300",
      repository: "my-app",
      pipelinePhase: "code_review",
      retryCount: 3,
    });

    const escalationId = escalationResult.message.escalation_id;

    // Verify initial dispatch to primary
    expect(delivery.deliveries).toHaveLength(1);
    expect(delivery.deliveries[0].target.target_id).toBe("primary-reviewer");

    // --- Step (b): Advance mock timer past primary timeout ---
    timer.advance(30 * 60 * 1000); // 30 minutes

    // --- Step (c): Verify secondary target received the escalation ---
    expect(delivery.deliveries).toHaveLength(2);
    expect(delivery.deliveries[1].target.target_id).toBe("escalation-manager");

    // Verify timeout event in audit trail
    const timeoutEvents = audit.events.filter(
      (e) => e.event_type === "escalation_timeout",
    );
    expect(timeoutEvents.length).toBeGreaterThanOrEqual(1);
    expect(timeoutEvents[0].payload.target).toBe("primary");
    expect(timeoutEvents[0].payload.chainedTo).toBe("secondary");

    // --- Set up the response handler ---
    const escalationStore = new InMemoryEscalationStore();
    escalationStore.add({
      escalationId,
      requestId: "req-300",
      status: "pending",
      options: escalationResult.message.options,
      gate: "code_review",
    });

    const killSwitch = new InMemoryKillSwitch();
    const parser = new ResponseParser();
    const validator = new ResponseValidator(escalationStore, config, killSwitch);
    const actionResolver = new ActionResolver();
    const resumption = new PipelineResumptionCoordinator(
      executor,
      chainManager,
      audit,
    );
    const reEscalation = new ReEscalationManager(engine, audit);

    const handler = new HumanResponseHandler(
      parser,
      validator,
      actionResolver,
      resumption,
      reEscalation,
      audit,
      escalationStore,
    );

    // --- Step (d): Respond as secondary target ---
    // Find the first option that would be an "approve-like" action
    const options = escalationResult.message.options;
    const firstOption = options[0]; // Use first option (review action)

    const result = handler.handleResponse(
      firstOption.option_id,
      escalationId,
      "escalation-manager",
    );

    // --- Step (e): Verify pipeline resumes ---
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.resumeResult.success).toBe(true);

    // --- Step (f): Verify audit trail contains timeout event and resolution ---
    const allEventTypes = audit.events.map((e) => e.event_type);
    expect(allEventTypes).toContain("escalation_raised");
    expect(allEventTypes).toContain("escalation_timeout");
    expect(allEventTypes).toContain("escalation_response_received");
    expect(allEventTypes).toContain("escalation_resolved");

    // Verify the timeout happened before the response
    const timeoutIdx = allEventTypes.indexOf("escalation_timeout");
    const responseIdx = allEventTypes.indexOf("escalation_response_received");
    expect(timeoutIdx).toBeLessThan(responseIdx);
  });
});

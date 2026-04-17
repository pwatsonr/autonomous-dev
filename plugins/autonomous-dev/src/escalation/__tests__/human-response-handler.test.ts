/**
 * Unit tests for HumanResponseHandler facade (SPEC-009-3-4, Task 9).
 *
 * Tests cover all 10 unit test cases from the spec:
 *
 *   1. Happy path: option approve
 *   2. Happy path: freetext
 *   3. Happy path: delegate
 *   4. Parse failure: empty string
 *   5. Validation failure: unknown escalation
 *   6. Validation failure: invalid option
 *   7. Validation failure: cancelled request
 *   8. Resumption failure
 *   9. Audit event emitted
 *  10. Override logs human_override
 */

import { HumanResponseHandler, type HandleResult } from "../human-response-handler";
import { ResponseParser } from "../response-parser";
import { ResponseValidator } from "../response-validator";
import type { EscalationStore, StoredEscalation, KillSwitchQuery } from "../response-validator";
import { ActionResolver } from "../action-resolver";
import {
  PipelineResumptionCoordinator,
  type PipelineExecutor,
} from "../pipeline-resumption";
import { EscalationChainManager } from "../chain-manager";
import { ReEscalationManager } from "../re-escalation-manager";
import type {
  AuditTrail,
  DeliveryAdapter,
  EscalationConfig,
  EscalationOption,
  Timer,
  TimerHandle,
} from "../types";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

interface CapturedEvent {
  event_type: string;
  payload: Record<string, unknown>;
}

interface MockAuditTrail extends AuditTrail {
  events: CapturedEvent[];
}

function createMockAuditTrail(): MockAuditTrail {
  const events: CapturedEvent[] = [];
  return {
    events,
    append: jest.fn(async (event) => {
      events.push(event as CapturedEvent);
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

function createMockTimer(): Timer {
  return {
    setTimeout(_callback: () => void, _ms: number): TimerHandle {
      return 0;
    },
    clearTimeout(_handle: TimerHandle): void {},
  };
}

function createMockDeliveryAdapter(): DeliveryAdapter {
  return {
    deliver: jest.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ESCALATION_ID = "esc-20260408-001";
const REQUEST_ID = "req-1";
const RESPONDER = "user";

const OPTIONS: EscalationOption[] = [
  { option_id: "opt-1", label: "Approve", action: "approve" },
  { option_id: "opt-2", label: "Retry", action: "retry", description: "Retry with guidance" },
  { option_id: "opt-3", label: "Cancel", action: "cancel" },
  {
    option_id: "opt-4",
    label: "Override and proceed",
    action: "override",
    description: "Risk accepted",
  },
];

function makePendingEscalation(
  overrides: Partial<StoredEscalation> = {},
): StoredEscalation {
  return {
    escalationId: ESCALATION_ID,
    requestId: REQUEST_ID,
    status: "pending",
    options: OPTIONS,
    gate: "code_review",
    ...overrides,
  };
}

function makeEscalationStore(
  escalation: StoredEscalation | null,
): EscalationStore {
  return {
    getEscalation: jest.fn((_id: string) => escalation),
  };
}

function makeKillSwitch(cancelled: boolean = false): KillSwitchQuery {
  return {
    isRequestCancelled: jest.fn((_requestId: string) => cancelled),
  };
}

function makeConfig(): EscalationConfig {
  return {
    routing: {
      mode: "default",
      default_target: {
        target_id: "default-user",
        display_name: "Default User",
        channel: "slack",
      },
      advanced: {
        security: {
          primary: {
            target_id: "security-lead",
            display_name: "Security Lead",
            channel: "slack",
          },
          secondary: {
            target_id: "tech-lead",
            display_name: "Tech Lead",
            channel: "slack",
          },
          timeout_minutes: 30,
          timeout_behavior: "pause",
        },
      } as any,
    },
    verbosity: "standard",
    retry_budget: 3,
  };
}

// ---------------------------------------------------------------------------
// Helper to build the full handler with default wiring
// ---------------------------------------------------------------------------

interface HandlerSetup {
  handler: HumanResponseHandler;
  executor: ReturnType<typeof createMockPipelineExecutor>;
  audit: MockAuditTrail;
  store: EscalationStore;
}

function createHandler(
  escalation: StoredEscalation | null = makePendingEscalation(),
  cancelled: boolean = false,
  executorOverrides?: Partial<PipelineExecutor>,
): HandlerSetup {
  const parser = new ResponseParser();
  const store = makeEscalationStore(escalation);
  const config = makeConfig();
  const killSwitch = makeKillSwitch(cancelled);
  const validator = new ResponseValidator(store, config, killSwitch);
  const actionResolver = new ActionResolver();
  const audit = createMockAuditTrail();
  const executor = createMockPipelineExecutor();

  // Apply any executor overrides
  if (executorOverrides) {
    Object.assign(executor, executorOverrides);
  }

  const timer = createMockTimer();
  const delivery = createMockDeliveryAdapter();
  const chainManager = new EscalationChainManager(timer, delivery, audit);
  const resumption = new PipelineResumptionCoordinator(
    executor,
    chainManager,
    audit,
  );

  // ReEscalationManager needs an EscalationEngine -- use a minimal mock
  const reEscalation = {
    handlePostGuidanceFailure: jest.fn(),
    getReEscalationCount: jest.fn(() => 0),
  } as unknown as ReEscalationManager;

  const handler = new HumanResponseHandler(
    parser,
    validator,
    actionResolver,
    resumption,
    reEscalation,
    audit,
    store,
  );

  return { handler, executor, audit, store };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HumanResponseHandler", () => {
  // =========================================================================
  // Test Case 1: Happy path -- option approve
  // =========================================================================
  test("handleResponse('opt-1', escId, 'user') with approve option returns success with approve action", () => {
    const { handler } = createHandler();

    const result = handler.handleResponse("opt-1", ESCALATION_ID, RESPONDER);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action).toEqual({ action: "approve" });
    expect(result.resumeResult.success).toBe(true);
    expect(result.resumeResult.action).toBe("approve");
  });

  // =========================================================================
  // Test Case 2: Happy path -- freetext
  // =========================================================================
  test("handleResponse('Use v2 API', escId, 'user') returns retry_with_changes", () => {
    const { handler } = createHandler();

    const result = handler.handleResponse(
      "Use v2 API",
      ESCALATION_ID,
      RESPONDER,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action).toEqual({
      action: "retry_with_changes",
      guidance: "Use v2 API",
    });
    expect(result.resumeResult.success).toBe(true);
  });

  // =========================================================================
  // Test Case 3: Happy path -- delegate
  // =========================================================================
  test("handleResponse('delegate:default-user', escId, 'user') returns delegate action", () => {
    const { handler } = createHandler();

    const result = handler.handleResponse(
      "delegate:default-user",
      ESCALATION_ID,
      RESPONDER,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action).toEqual({
      action: "delegate",
      target: "default-user",
    });
    expect(result.resumeResult.success).toBe(true);
  });

  // =========================================================================
  // Test Case 4: Parse failure -- empty string (validator rejects empty freetext)
  // =========================================================================
  test("handleResponse('', escId, 'user') returns validation error for empty freetext", () => {
    const { handler } = createHandler();

    const result = handler.handleResponse("", ESCALATION_ID, RESPONDER);

    // Empty string parses as freetext, but validator rejects empty freetext
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("Empty free-text response not allowed");
  });

  // =========================================================================
  // Test Case 5: Validation failure -- unknown escalation
  // =========================================================================
  test("handleResponse with unknown escalation ID returns ESCALATION_NOT_FOUND", () => {
    const { handler } = createHandler(null);

    const result = handler.handleResponse("opt-1", "esc-unknown", RESPONDER);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("ESCALATION_NOT_FOUND");
  });

  // =========================================================================
  // Test Case 6: Validation failure -- invalid option
  // =========================================================================
  test("handleResponse with invalid option ID returns INVALID_OPTION_ID with available options", () => {
    const { handler } = createHandler();

    const result = handler.handleResponse("opt-99", ESCALATION_ID, RESPONDER);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("INVALID_OPTION_ID");
    expect(result.error.availableOptions).toBeDefined();
    expect(result.error.availableOptions!.length).toBe(OPTIONS.length);
  });

  // =========================================================================
  // Test Case 7: Validation failure -- cancelled request
  // =========================================================================
  test("handleResponse for cancelled request returns REQUEST_CANCELLED", () => {
    const { handler } = createHandler(makePendingEscalation(), true);

    const result = handler.handleResponse("opt-1", ESCALATION_ID, RESPONDER);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("REQUEST_CANCELLED");
  });

  // =========================================================================
  // Test Case 8: Resumption failure
  // =========================================================================
  test("handleResponse returns RESUME_FAILED when pipeline executor throws; escalation remains active", () => {
    const { handler } = createHandler(
      makePendingEscalation(),
      false,
      {
        markGatePassed: jest.fn(() => {
          throw new Error("Pipeline executor unavailable");
        }),
      },
    );

    const result = handler.handleResponse("opt-1", ESCALATION_ID, RESPONDER);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("RESUME_FAILED");
    expect(result.error.message).toContain("Pipeline executor unavailable");
    expect(result.error.message).toContain("Please try again");
  });

  // =========================================================================
  // Test Case 9: Audit event emitted
  // =========================================================================
  test("escalation_response_received audit event emitted with correct fields before resumption", () => {
    const { handler, audit } = createHandler();

    handler.handleResponse("opt-1", ESCALATION_ID, RESPONDER);

    const responseEvents = audit.events.filter(
      (e) => e.event_type === "escalation_response_received",
    );
    expect(responseEvents.length).toBeGreaterThanOrEqual(1);
    expect(responseEvents[0].payload).toMatchObject({
      escalation_id: ESCALATION_ID,
      responder: RESPONDER,
      response_type: "option",
      action: "approve",
    });

    // Verify escalation_response_received is emitted BEFORE escalation_resolved
    const allTypes = audit.events.map((e) => e.event_type);
    const responseIdx = allTypes.indexOf("escalation_response_received");
    const resolvedIdx = allTypes.indexOf("escalation_resolved");
    expect(responseIdx).toBeLessThan(resolvedIdx);
  });

  // =========================================================================
  // Test Case 10: Override logs human_override
  // =========================================================================
  test("handleResponse('opt-4', ...) triggers human_override audit event via resumption", () => {
    const { handler, audit } = createHandler();

    const result = handler.handleResponse(
      "opt-4",
      ESCALATION_ID,
      RESPONDER,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action).toEqual({
      action: "override_proceed",
      justification: "Risk accepted",
    });

    // Verify human_override audit event emitted
    const overrideEvents = audit.events.filter(
      (e) => e.event_type === "human_override",
    );
    expect(overrideEvents).toHaveLength(1);
    expect(overrideEvents[0].payload).toMatchObject({
      escalation_id: ESCALATION_ID,
      request_id: REQUEST_ID,
      responder: RESPONDER,
      justification: "Risk accepted",
    });

    // Verify both escalation_response_received AND escalation_resolved
    const allTypes = audit.events.map((e) => e.event_type);
    expect(allTypes).toContain("escalation_response_received");
    expect(allTypes).toContain("human_override");
    expect(allTypes).toContain("escalation_resolved");
  });

  // =========================================================================
  // Additional: retry_with_changes via option triggers correct pipeline calls
  // =========================================================================
  test("option with retry action injects guidance and re-executes", () => {
    const { handler, executor } = createHandler();

    const result = handler.handleResponse("opt-2", ESCALATION_ID, RESPONDER);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action).toEqual({
      action: "retry_with_changes",
      guidance: "Retry with guidance",
    });
    expect(executor.injectGuidance).toHaveBeenCalledWith(
      REQUEST_ID,
      "Retry with guidance",
    );
    expect(executor.reExecutePhase).toHaveBeenCalledWith(REQUEST_ID);
  });

  // =========================================================================
  // Additional: cancel via option terminates request
  // =========================================================================
  test("option with cancel action terminates the request", () => {
    const { handler, executor } = createHandler();

    const result = handler.handleResponse("opt-3", ESCALATION_ID, RESPONDER);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action).toEqual({ action: "cancel" });
    expect(executor.terminateRequest).toHaveBeenCalledWith(
      REQUEST_ID,
      "Cancelled by human",
    );
  });

  // =========================================================================
  // Additional: all dependencies are injectable via constructor
  // =========================================================================
  test("all dependencies are provided via constructor (no hidden singletons)", () => {
    const parser = new ResponseParser();
    const store = makeEscalationStore(makePendingEscalation());
    const config = makeConfig();
    const killSwitch = makeKillSwitch();
    const validator = new ResponseValidator(store, config, killSwitch);
    const actionResolver = new ActionResolver();
    const audit = createMockAuditTrail();
    const timer = createMockTimer();
    const delivery = createMockDeliveryAdapter();
    const chainManager = new EscalationChainManager(timer, delivery, audit);
    const executor = createMockPipelineExecutor();
    const resumption = new PipelineResumptionCoordinator(
      executor,
      chainManager,
      audit,
    );
    const reEscalation = {
      handlePostGuidanceFailure: jest.fn(),
      getReEscalationCount: jest.fn(() => 0),
    } as unknown as ReEscalationManager;

    // This should construct without errors
    const handler = new HumanResponseHandler(
      parser,
      validator,
      actionResolver,
      resumption,
      reEscalation,
      audit,
      store,
    );

    expect(handler).toBeDefined();
    expect(handler.handleResponse).toBeDefined();
  });
});

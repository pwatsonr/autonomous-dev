/**
 * Unit tests for ResponseValidator (SPEC-009-3-1, Task 3).
 *
 * Verifies all 6 validation checks in their defined order:
 *   1. Escalation exists
 *   2. Escalation is pending
 *   3. Request not cancelled via kill switch
 *   4. Option ID is valid
 *   5. Delegate target is known
 *   6. Freetext is non-empty
 */

import { ResponseValidator } from "../response-validator";
import type { EscalationStore, StoredEscalation, KillSwitchQuery } from "../response-validator";
import type { EscalationConfig, EscalationOption } from "../types";
import type { EscalationResponse } from "../response-types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ESCALATION_ID = "esc-20260101-001";
const REQUEST_ID = "req-001";
const RESPONDER = "test-user";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const OPTIONS: EscalationOption[] = [
  { option_id: "opt-1", label: "Approve", action: "approve" },
  { option_id: "opt-2", label: "Retry", action: "retry" },
  { option_id: "opt-3", label: "Cancel", action: "cancel" },
];

function makePendingEscalation(overrides: Partial<StoredEscalation> = {}): StoredEscalation {
  return {
    escalationId: ESCALATION_ID,
    requestId: REQUEST_ID,
    status: "pending",
    options: OPTIONS,
    ...overrides,
  };
}

function makeOptionResponse(optionId: string): EscalationResponse {
  return {
    escalation_id: ESCALATION_ID,
    responder: RESPONDER,
    timestamp: TIMESTAMP,
    response_type: "option",
    option_id: optionId,
  };
}

function makeDelegateResponse(target: string): EscalationResponse {
  return {
    escalation_id: ESCALATION_ID,
    responder: RESPONDER,
    timestamp: TIMESTAMP,
    response_type: "delegate",
    delegate_target: target,
  };
}

function makeFreetextResponse(text: string): EscalationResponse {
  return {
    escalation_id: ESCALATION_ID,
    responder: RESPONDER,
    timestamp: TIMESTAMP,
    response_type: "freetext",
    freetext: text,
  };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeStore(escalation: StoredEscalation | null): EscalationStore {
  return {
    getEscalation: (_id: string) => escalation,
  };
}

function makeKillSwitch(cancelled: boolean): KillSwitchQuery {
  return {
    isRequestCancelled: (_requestId: string) => cancelled,
  };
}

function makeConfig(knownTargetIds: string[] = ["default-user", "security-lead", "tech-lead"]): EscalationConfig {
  return {
    routing: {
      mode: "default",
      default_target: {
        target_id: knownTargetIds[0] || "default-user",
        display_name: "Default User",
        channel: "slack",
      },
      advanced: knownTargetIds.length > 1
        ? {
            security: {
              primary: {
                target_id: knownTargetIds[1] || "security-lead",
                display_name: "Security Lead",
                channel: "slack",
              },
              secondary: knownTargetIds[2]
                ? {
                    target_id: knownTargetIds[2],
                    display_name: knownTargetIds[2],
                    channel: "slack",
                  }
                : undefined,
              timeout_minutes: 30,
              timeout_behavior: "pause",
            },
          } as any
        : undefined,
    },
    verbosity: "standard",
    retry_budget: 3,
  };
}

function makeValidator(
  escalation: StoredEscalation | null = makePendingEscalation(),
  cancelled: boolean = false,
  knownTargetIds?: string[],
): ResponseValidator {
  return new ResponseValidator(
    makeStore(escalation),
    makeConfig(knownTargetIds),
    makeKillSwitch(cancelled),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ResponseValidator", () => {
  // =========================================================================
  // Test Case 11: Unknown escalation
  // =========================================================================
  test("returns ESCALATION_NOT_FOUND for unknown escalation ID", () => {
    const validator = makeValidator(null);
    const result = validator.validate(makeOptionResponse("opt-1"));

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error.code).toBe("ESCALATION_NOT_FOUND");
  });

  // =========================================================================
  // Test Case 12: Already resolved escalation
  // =========================================================================
  test("returns ESCALATION_ALREADY_RESOLVED for resolved escalation", () => {
    const validator = makeValidator(makePendingEscalation({ status: "resolved" }));
    const result = validator.validate(makeOptionResponse("opt-1"));

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error.code).toBe("ESCALATION_ALREADY_RESOLVED");
  });

  // =========================================================================
  // Test Case 13: Cancelled escalation
  // =========================================================================
  test("returns ESCALATION_ALREADY_RESOLVED for cancelled escalation", () => {
    const validator = makeValidator(makePendingEscalation({ status: "cancelled" }));
    const result = validator.validate(makeOptionResponse("opt-1"));

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error.code).toBe("ESCALATION_ALREADY_RESOLVED");
  });

  // =========================================================================
  // Test Case 14: Request cancelled by kill switch
  // =========================================================================
  test("returns REQUEST_CANCELLED when kill switch has cancelled the request", () => {
    const validator = makeValidator(makePendingEscalation(), /* cancelled */ true);
    const result = validator.validate(makeOptionResponse("opt-1"));

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error.code).toBe("REQUEST_CANCELLED");
  });

  // =========================================================================
  // Test Case 15: Invalid option ID
  // =========================================================================
  test("returns INVALID_OPTION_ID with availableOptions when option ID not found", () => {
    const validator = makeValidator();
    const result = validator.validate(makeOptionResponse("opt-99"));

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error.code).toBe("INVALID_OPTION_ID");
    expect(result.error.availableOptions).toEqual(OPTIONS);
  });

  // =========================================================================
  // Test Case 16: Valid option ID
  // =========================================================================
  test("passes validation for valid option ID", () => {
    const validator = makeValidator();
    const result = validator.validate(makeOptionResponse("opt-1"));

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.response.option_id).toBe("opt-1");
  });

  // =========================================================================
  // Test Case 17: Unknown delegate target
  // =========================================================================
  test("returns UNKNOWN_DELEGATE_TARGET with knownTargets when target unknown", () => {
    const validator = makeValidator();
    const result = validator.validate(makeDelegateResponse("unknown-person"));

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error.code).toBe("UNKNOWN_DELEGATE_TARGET");
    expect(result.error.knownTargets).toBeDefined();
    expect(result.error.knownTargets!.length).toBeGreaterThan(0);
  });

  // =========================================================================
  // Test Case 18: Valid delegate target
  // =========================================================================
  test("passes validation for known delegate target", () => {
    const validator = makeValidator();
    const result = validator.validate(makeDelegateResponse("security-lead"));

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.response.delegate_target).toBe("security-lead");
  });

  // =========================================================================
  // Test Case 19: Empty freetext rejected
  // =========================================================================
  test("rejects empty freetext response", () => {
    const validator = makeValidator();
    const result = validator.validate(makeFreetextResponse(""));

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error.code).toBe("INVALID_OPTION_ID");
    expect(result.error.message).toBe("Empty free-text response not allowed");
  });

  // =========================================================================
  // Test Case 20: Valid freetext passes
  // =========================================================================
  test("passes validation for non-empty freetext", () => {
    const validator = makeValidator();
    const result = validator.validate(makeFreetextResponse("Please retry with a smaller batch size"));

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.response.freetext).toBe("Please retry with a smaller batch size");
  });

  // =========================================================================
  // Additional: Validation order (first failure short-circuits)
  // =========================================================================
  test("check order: ESCALATION_NOT_FOUND takes priority over REQUEST_CANCELLED", () => {
    // Even though kill switch is active, not-found should be the first error
    const validator = new ResponseValidator(
      makeStore(null),
      makeConfig(),
      makeKillSwitch(true),
    );
    const result = validator.validate(makeOptionResponse("opt-1"));

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error.code).toBe("ESCALATION_NOT_FOUND");
  });

  test("check order: ESCALATION_ALREADY_RESOLVED takes priority over REQUEST_CANCELLED", () => {
    const validator = new ResponseValidator(
      makeStore(makePendingEscalation({ status: "resolved" })),
      makeConfig(),
      makeKillSwitch(true),
    );
    const result = validator.validate(makeOptionResponse("opt-1"));

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error.code).toBe("ESCALATION_ALREADY_RESOLVED");
  });

  test("whitespace-only freetext is rejected", () => {
    const validator = makeValidator();
    const result = validator.validate(makeFreetextResponse("   "));

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error.code).toBe("INVALID_OPTION_ID");
    expect(result.error.message).toBe("Empty free-text response not allowed");
  });

  test("default target is included in known targets for delegation", () => {
    const validator = makeValidator(
      makePendingEscalation(),
      false,
      ["default-user"],
    );
    const result = validator.validate(makeDelegateResponse("default-user"));

    expect(result.valid).toBe(true);
  });
});

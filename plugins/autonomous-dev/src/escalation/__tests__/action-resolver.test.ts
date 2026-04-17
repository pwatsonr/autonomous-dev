/**
 * Unit tests for ActionResolver (SPEC-009-3-2, Task 4).
 *
 * Tests cover all 9 test cases from the spec:
 *
 *   1. Option approve -> approve action
 *   2. Option retry -> retry_with_changes
 *   3. Option cancel -> cancel action
 *   4. Option reject -> cancel action
 *   5. Option override -> override_proceed
 *   6. Option override with no description -> default justification
 *   7. Freetext -> retry_with_changes
 *   8. Delegate -> delegate action
 *   9. Option approve_with_conditions -> retry_with_changes
 */

import { ActionResolver } from "../action-resolver";
import type { EscalationResponse } from "../response-types";
import type { StoredEscalation } from "../response-validator";
import type { EscalationOption } from "../types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEscalation(
  options: EscalationOption[],
  overrides: Partial<StoredEscalation> = {},
): StoredEscalation {
  return {
    escalationId: "esc-20260408-001",
    requestId: "req-1",
    status: "pending",
    options,
    gate: "code_review",
    ...overrides,
  };
}

function makeResponse(
  overrides: Partial<EscalationResponse>,
): EscalationResponse {
  return {
    escalation_id: "esc-20260408-001",
    responder: "user-1",
    timestamp: new Date().toISOString(),
    response_type: "option",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ActionResolver", () => {
  const resolver = new ActionResolver();

  // =========================================================================
  // Test Case 1: Option approve -> approve action
  // =========================================================================
  test("option with action 'approve' resolves to { action: 'approve' }", () => {
    const escalation = makeEscalation([
      { option_id: "opt-1", label: "Approve", action: "approve" },
      { option_id: "opt-2", label: "Cancel", action: "cancel" },
    ]);
    const response = makeResponse({
      response_type: "option",
      option_id: "opt-1",
    });

    const result = resolver.resolve(response, escalation);

    expect(result).toEqual({ action: "approve" });
  });

  // =========================================================================
  // Test Case 2: Option retry -> retry_with_changes
  // =========================================================================
  test("option with action 'retry' resolves to retry_with_changes with guidance", () => {
    const escalation = makeEscalation([
      {
        option_id: "opt-1",
        label: "Retry",
        action: "retry",
        description: "Use smaller batches",
      },
      { option_id: "opt-2", label: "Cancel", action: "cancel" },
    ]);
    const response = makeResponse({
      response_type: "option",
      option_id: "opt-1",
    });

    const result = resolver.resolve(response, escalation);

    expect(result).toEqual({
      action: "retry_with_changes",
      guidance: "Use smaller batches",
    });
  });

  // =========================================================================
  // Test Case 3: Option cancel -> cancel action
  // =========================================================================
  test("option with action 'cancel' resolves to { action: 'cancel' }", () => {
    const escalation = makeEscalation([
      { option_id: "opt-1", label: "Approve", action: "approve" },
      { option_id: "opt-2", label: "Cancel", action: "cancel" },
    ]);
    const response = makeResponse({
      response_type: "option",
      option_id: "opt-2",
    });

    const result = resolver.resolve(response, escalation);

    expect(result).toEqual({ action: "cancel" });
  });

  // =========================================================================
  // Test Case 4: Option reject -> cancel action
  // =========================================================================
  test("option with action 'reject' also resolves to { action: 'cancel' }", () => {
    const escalation = makeEscalation([
      { option_id: "opt-1", label: "Reject", action: "reject" },
      { option_id: "opt-2", label: "Approve", action: "approve" },
    ]);
    const response = makeResponse({
      response_type: "option",
      option_id: "opt-1",
    });

    const result = resolver.resolve(response, escalation);

    expect(result).toEqual({ action: "cancel" });
  });

  // =========================================================================
  // Test Case 5: Option override -> override_proceed
  // =========================================================================
  test("option with action 'override' resolves to override_proceed with justification", () => {
    const escalation = makeEscalation([
      {
        option_id: "opt-1",
        label: "Override",
        action: "override",
        description: "Risk accepted",
      },
      { option_id: "opt-2", label: "Cancel", action: "cancel" },
    ]);
    const response = makeResponse({
      response_type: "option",
      option_id: "opt-1",
    });

    const result = resolver.resolve(response, escalation);

    expect(result).toEqual({
      action: "override_proceed",
      justification: "Risk accepted",
    });
  });

  // =========================================================================
  // Test Case 6: Option override with no description -> default justification
  // =========================================================================
  test("option override with no description defaults justification to 'No justification provided'", () => {
    const escalation = makeEscalation([
      { option_id: "opt-1", label: "Override", action: "override" },
      { option_id: "opt-2", label: "Cancel", action: "cancel" },
    ]);
    const response = makeResponse({
      response_type: "option",
      option_id: "opt-1",
    });

    const result = resolver.resolve(response, escalation);

    expect(result).toEqual({
      action: "override_proceed",
      justification: "No justification provided",
    });
  });

  // =========================================================================
  // Test Case 7: Freetext -> retry_with_changes
  // =========================================================================
  test("freetext response resolves to retry_with_changes with guidance", () => {
    const escalation = makeEscalation([
      { option_id: "opt-1", label: "Approve", action: "approve" },
      { option_id: "opt-2", label: "Cancel", action: "cancel" },
    ]);
    const response = makeResponse({
      response_type: "freetext",
      freetext: "Try using the v2 API instead",
    });

    const result = resolver.resolve(response, escalation);

    expect(result).toEqual({
      action: "retry_with_changes",
      guidance: "Try using the v2 API instead",
    });
  });

  // =========================================================================
  // Test Case 8: Delegate -> delegate action
  // =========================================================================
  test("delegate response resolves to delegate with target", () => {
    const escalation = makeEscalation([
      { option_id: "opt-1", label: "Approve", action: "approve" },
      { option_id: "opt-2", label: "Cancel", action: "cancel" },
    ]);
    const response = makeResponse({
      response_type: "delegate",
      delegate_target: "security-lead",
    });

    const result = resolver.resolve(response, escalation);

    expect(result).toEqual({
      action: "delegate",
      target: "security-lead",
    });
  });

  // =========================================================================
  // Test Case 9: Option approve_with_conditions -> retry_with_changes
  // =========================================================================
  test("option with action 'approve_with_conditions' resolves to retry_with_changes", () => {
    const escalation = makeEscalation([
      {
        option_id: "opt-1",
        label: "Approve with conditions",
        action: "approve_with_conditions",
        description: "Add error handling before merging",
      },
      { option_id: "opt-2", label: "Cancel", action: "cancel" },
    ]);
    const response = makeResponse({
      response_type: "option",
      option_id: "opt-1",
    });

    const result = resolver.resolve(response, escalation);

    expect(result).toEqual({
      action: "retry_with_changes",
      guidance: "Add error handling before merging",
    });
  });

  // =========================================================================
  // Additional: option retry_with_changes maps same as retry
  // =========================================================================
  test("option with action 'retry_with_changes' resolves same as 'retry'", () => {
    const escalation = makeEscalation([
      {
        option_id: "opt-1",
        label: "Retry with changes",
        action: "retry_with_changes",
        description: "Increase timeout",
      },
      { option_id: "opt-2", label: "Cancel", action: "cancel" },
    ]);
    const response = makeResponse({
      response_type: "option",
      option_id: "opt-1",
    });

    const result = resolver.resolve(response, escalation);

    expect(result).toEqual({
      action: "retry_with_changes",
      guidance: "Increase timeout",
    });
  });

  // =========================================================================
  // Additional: throws on missing option after validation
  // =========================================================================
  test("throws if option_id not found in escalation options", () => {
    const escalation = makeEscalation([
      { option_id: "opt-1", label: "Approve", action: "approve" },
    ]);
    const response = makeResponse({
      response_type: "option",
      option_id: "opt-99",
    });

    expect(() => resolver.resolve(response, escalation)).toThrow(
      /Option "opt-99" not found/,
    );
  });

  // =========================================================================
  // Additional: retry option with no description uses empty guidance
  // =========================================================================
  test("retry option with no description uses empty string as guidance", () => {
    const escalation = makeEscalation([
      { option_id: "opt-1", label: "Retry", action: "retry" },
      { option_id: "opt-2", label: "Cancel", action: "cancel" },
    ]);
    const response = makeResponse({
      response_type: "option",
      option_id: "opt-1",
    });

    const result = resolver.resolve(response, escalation);

    expect(result).toEqual({
      action: "retry_with_changes",
      guidance: "",
    });
  });
});

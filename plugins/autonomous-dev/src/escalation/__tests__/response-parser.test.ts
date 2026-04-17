/**
 * Unit tests for ResponseParser (SPEC-009-3-1, Task 2).
 *
 * Verifies the three parsing patterns (option, delegate, freetext),
 * case insensitivity, edge cases, and the never-throw guarantee.
 */

import { ResponseParser } from "../response-parser";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ESCALATION_ID = "esc-20260101-001";
const RESPONDER = "test-user";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ResponseParser", () => {
  let parser: ResponseParser;

  beforeEach(() => {
    parser = new ResponseParser();
  });

  // =========================================================================
  // Test Case 1: Option -- "opt-1"
  // =========================================================================
  test("parses 'opt-1' as option response with option_id 'opt-1'", () => {
    const result = parser.parse("opt-1", ESCALATION_ID, RESPONDER);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.response.response_type).toBe("option");
    expect(result.response.option_id).toBe("opt-1");
    expect(result.response.escalation_id).toBe(ESCALATION_ID);
    expect(result.response.responder).toBe(RESPONDER);
    expect(result.response.timestamp).toBeDefined();
  });

  // =========================================================================
  // Test Case 2: Option -- "OPT-3" (case insensitive)
  // =========================================================================
  test("parses 'OPT-3' as option response with option_id 'opt-3' (case insensitive)", () => {
    const result = parser.parse("OPT-3", ESCALATION_ID, RESPONDER);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.response.response_type).toBe("option");
    expect(result.response.option_id).toBe("opt-3");
  });

  // =========================================================================
  // Test Case 3: Option -- "opt-42" (multi-digit)
  // =========================================================================
  test("parses 'opt-42' as option response with multi-digit option ID", () => {
    const result = parser.parse("opt-42", ESCALATION_ID, RESPONDER);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.response.response_type).toBe("option");
    expect(result.response.option_id).toBe("opt-42");
  });

  // =========================================================================
  // Test Case 4: Delegate -- "delegate:security-lead"
  // =========================================================================
  test("parses 'delegate:security-lead' as delegate response", () => {
    const result = parser.parse("delegate:security-lead", ESCALATION_ID, RESPONDER);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.response.response_type).toBe("delegate");
    expect(result.response.delegate_target).toBe("security-lead");
  });

  // =========================================================================
  // Test Case 5: Delegate -- "DELEGATE: tech-lead " (case insensitive, trimmed)
  // =========================================================================
  test("parses 'DELEGATE: tech-lead ' as delegate with trimmed target (case insensitive)", () => {
    const result = parser.parse("DELEGATE: tech-lead ", ESCALATION_ID, RESPONDER);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.response.response_type).toBe("delegate");
    expect(result.response.delegate_target).toBe("tech-lead");
  });

  // =========================================================================
  // Test Case 6: Freetext -- normal sentence
  // =========================================================================
  test("parses normal sentence as freetext response", () => {
    const input = "Please retry with a smaller batch size";
    const result = parser.parse(input, ESCALATION_ID, RESPONDER);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.response.response_type).toBe("freetext");
    expect(result.response.freetext).toBe("Please retry with a smaller batch size");
  });

  // =========================================================================
  // Test Case 7: Freetext -- empty string
  // =========================================================================
  test("parses empty string as freetext with empty freetext value", () => {
    const result = parser.parse("", ESCALATION_ID, RESPONDER);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.response.response_type).toBe("freetext");
    expect(result.response.freetext).toBe("");
  });

  // =========================================================================
  // Test Case 8: Freetext -- "opt-abc" (not valid option pattern)
  // =========================================================================
  test("parses 'opt-abc' as freetext (no digit after opt-)", () => {
    const result = parser.parse("opt-abc", ESCALATION_ID, RESPONDER);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.response.response_type).toBe("freetext");
    expect(result.response.freetext).toBe("opt-abc");
  });

  // =========================================================================
  // Test Case 9: Freetext -- "delegate" (no colon)
  // =========================================================================
  test("parses 'delegate' without colon as freetext", () => {
    const result = parser.parse("delegate", ESCALATION_ID, RESPONDER);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.response.response_type).toBe("freetext");
    expect(result.response.freetext).toBe("delegate");
  });

  // =========================================================================
  // Test Case 10: Parser never throws
  // =========================================================================
  test("never throws on null input", () => {
    expect(() => {
      parser.parse(null as unknown as string, ESCALATION_ID, RESPONDER);
    }).not.toThrow();

    const result = parser.parse(null as unknown as string, ESCALATION_ID, RESPONDER);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.response.response_type).toBe("freetext");
    expect(result.response.freetext).toBe("");
  });

  test("never throws on undefined input", () => {
    expect(() => {
      parser.parse(undefined as unknown as string, ESCALATION_ID, RESPONDER);
    }).not.toThrow();

    const result = parser.parse(undefined as unknown as string, ESCALATION_ID, RESPONDER);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.response.response_type).toBe("freetext");
    expect(result.response.freetext).toBe("");
  });

  test("never throws on random binary-like input", () => {
    const binaryInput = String.fromCharCode(0, 1, 2, 255, 128, 64);
    expect(() => {
      parser.parse(binaryInput, ESCALATION_ID, RESPONDER);
    }).not.toThrow();

    const result = parser.parse(binaryInput, ESCALATION_ID, RESPONDER);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.response.response_type).toBe("freetext");
  });

  // =========================================================================
  // Additional edge cases
  // =========================================================================
  test("timestamp is valid ISO 8601", () => {
    const result = parser.parse("opt-1", ESCALATION_ID, RESPONDER);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const date = new Date(result.response.timestamp);
    expect(date.toISOString()).toBe(result.response.timestamp);
  });

  test("option with leading/trailing spaces is treated as freetext", () => {
    const result = parser.parse(" opt-1 ", ESCALATION_ID, RESPONDER);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // The regex requires the full string to match, spaces make it freetext
    expect(result.response.response_type).toBe("freetext");
  });

  test("delegate with empty target after colon is still delegate", () => {
    // "delegate: " -- after trim, target is empty string
    // But the regex captures " " which trims to ""
    const result = parser.parse("delegate: ", ESCALATION_ID, RESPONDER);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.response.response_type).toBe("delegate");
    expect(result.response.delegate_target).toBe("");
  });
});

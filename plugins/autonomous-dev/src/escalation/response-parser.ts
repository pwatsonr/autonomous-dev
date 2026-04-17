/**
 * Response Parser for the escalation subsystem (SPEC-009-3-1, Task 2).
 *
 * Converts raw human input strings into typed EscalationResponse objects.
 * Recognizes three input formats, evaluated in order:
 *
 *   1. Option pattern:   /^opt-\d+$/i       -> response_type "option"
 *   2. Delegate pattern: /^delegate:(.+)$/i  -> response_type "delegate"
 *   3. Free-text:        everything else     -> response_type "freetext"
 *
 * The parser NEVER throws exceptions. Empty or null-like input is treated
 * as freetext with an empty string (the validator handles rejection).
 */

import type { EscalationResponse, ParseResult } from "./response-types";

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Matches option selection: "opt-1", "OPT-42", etc. */
const OPTION_PATTERN = /^opt-\d+$/i;

/** Matches delegation: "delegate:security-lead", "DELEGATE: tech-lead ", etc. */
const DELEGATE_PATTERN = /^delegate:(.+)$/i;

// ---------------------------------------------------------------------------
// ResponseParser
// ---------------------------------------------------------------------------

/**
 * Parses raw human input into a typed EscalationResponse.
 *
 * This class is stateless and safe to share across concurrent calls.
 */
export class ResponseParser {
  /**
   * Parse raw human input into a typed response.
   *
   * @param rawInput      The raw input string from the human.
   * @param escalationId  The escalation this response is for.
   * @param responder     Who provided the response (user ID or name).
   * @returns A ParseResult that is always successful (the parser never fails).
   */
  parse(rawInput: string, escalationId: string, responder: string): ParseResult {
    // Coerce null/undefined to empty string -- parser never throws
    const input = rawInput == null ? "" : String(rawInput);
    const timestamp = new Date().toISOString();

    // 1. Option pattern: /^opt-\d+$/i
    if (OPTION_PATTERN.test(input)) {
      return {
        success: true,
        response: {
          escalation_id: escalationId,
          responder,
          timestamp,
          response_type: "option",
          option_id: input.toLowerCase(),
        },
      };
    }

    // 2. Delegate pattern: /^delegate:(.+)$/i
    const delegateMatch = DELEGATE_PATTERN.exec(input);
    if (delegateMatch) {
      return {
        success: true,
        response: {
          escalation_id: escalationId,
          responder,
          timestamp,
          response_type: "delegate",
          delegate_target: delegateMatch[1].trim(),
        },
      };
    }

    // 3. Free-text: everything else (including empty string)
    return {
      success: true,
      response: {
        escalation_id: escalationId,
        responder,
        timestamp,
        response_type: "freetext",
        freetext: input.trim(),
      },
    };
  }
}

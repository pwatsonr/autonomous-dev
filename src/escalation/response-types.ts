/**
 * Response types for the escalation subsystem (SPEC-009-3-1).
 *
 * Defines the type system for human responses to escalations, including:
 * - Response formats (option selection, delegation, free-text)
 * - Resolved actions (discriminated union with 5 members)
 * - Validation error types with contextual help
 * - Re-escalation chain context
 * - Parse and validation result types
 */

import type { EscalationOption } from "./types";

// ---------------------------------------------------------------------------
// Core response type union
// ---------------------------------------------------------------------------

/** The three response formats a human can provide. */
export type ResponseType = "option" | "freetext" | "delegate";

// ---------------------------------------------------------------------------
// EscalationResponse
// ---------------------------------------------------------------------------

/** A typed human response to an escalation. */
export interface EscalationResponse {
  /** The escalation this responds to. */
  escalation_id: string;

  /** Who responded (user ID or name). */
  responder: string;

  /** When the response was received (ISO 8601). */
  timestamp: string;

  /** Which response format was detected. */
  response_type: ResponseType;

  /** Present when response_type === "option". */
  option_id?: string;

  /** Present when response_type === "freetext". */
  freetext?: string;

  /** Present when response_type === "delegate". */
  delegate_target?: string;
}

// ---------------------------------------------------------------------------
// ResolvedAction (discriminated union -- exactly 5 members)
// ---------------------------------------------------------------------------

/** The concrete action the pipeline should take after a human response. */
export type ResolvedAction =
  | { action: "approve" }
  | { action: "retry_with_changes"; guidance: string }
  | { action: "cancel" }
  | { action: "override_proceed"; justification: string }
  | { action: "delegate"; target: string };

// ---------------------------------------------------------------------------
// ResponseValidationError
// ---------------------------------------------------------------------------

/** Error returned when a response cannot be validated or acted upon. */
export interface ResponseValidationError {
  code:
    | "ESCALATION_NOT_FOUND"
    | "ESCALATION_ALREADY_RESOLVED"
    | "INVALID_OPTION_ID"
    | "UNKNOWN_DELEGATE_TARGET"
    | "REQUEST_CANCELLED"
    | "RESUME_FAILED";
  message: string;

  /** Included for INVALID_OPTION_ID to show valid choices. */
  availableOptions?: EscalationOption[];

  /** Included for UNKNOWN_DELEGATE_TARGET to show valid targets. */
  knownTargets?: string[];
}

// ---------------------------------------------------------------------------
// ReEscalationContext
// ---------------------------------------------------------------------------

/** Tracks the chain of re-escalations for a single failure. */
export interface ReEscalationContext {
  /** The original escalation that started the chain. */
  originalEscalationId: string;

  /** Full chain of escalation IDs (oldest to newest). */
  previousEscalationIds: string[];

  /** Number of re-escalations that have occurred. */
  reEscalationCount: number;

  /** The guidance from the last human response that was applied. */
  lastGuidanceApplied: string;

  /** Why the previous attempt failed after applying guidance. */
  lastFailureReason: string;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Result of parsing raw human input into a typed response. */
export type ParseResult =
  | { success: true; response: EscalationResponse }
  | { success: false; error: ResponseValidationError };

/** Result of validating a parsed response for actionability. */
export type ValidationResult =
  | { valid: true; response: EscalationResponse }
  | { valid: false; error: ResponseValidationError };

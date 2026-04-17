/**
 * Audit event type system (SPEC-009-5-1, Task 1).
 *
 * Defines all 17 audit event types from TDD Section 3.4.1, the core
 * AuditEvent interface, and supporting payload/verification types.
 *
 * This is the type foundation for the entire audit trail subsystem --
 * every audit component imports from here.
 */

// ---------------------------------------------------------------------------
// Audit event type union (17 event types)
// ---------------------------------------------------------------------------

export type AuditEventType =
  // Trust events
  | "trust_level_change_requested"
  | "trust_level_changed"
  | "trust_level_change_superseded"
  | "trust_upgrade_confirmed"
  | "trust_upgrade_rejected"
  | "gate_decision"
  | "security_override_rejected"
  // Escalation events
  | "escalation_raised"
  | "escalation_timeout"
  | "escalation_resolved"
  | "escalation_response_received"
  | "human_override"
  | "re_escalation_loop_detected"
  // Kill switch events
  | "kill_issued"
  | "cancel_issued"
  | "system_reenabled"
  // Decision events
  | "autonomous_decision";

// ---------------------------------------------------------------------------
// Core audit event interface
// ---------------------------------------------------------------------------

export interface AuditEvent {
  event_id: string;                   // UUID v4
  event_type: AuditEventType;
  timestamp: string;                  // ISO 8601 with millisecond precision
  request_id: string;                 // Associated request (or "system" for global events)
  repository: string;                 // Repository context (or "system")
  pipeline_phase: string;             // Current pipeline phase (or "n/a")
  agent: string;                      // Agent that produced the event
  payload: Record<string, unknown>;   // Event-specific data
  hash: string;                       // SHA-256 hash chain (empty in Phase 1/2)
  prev_hash: string;                  // Previous event hash (empty in Phase 1/2)
}

// ---------------------------------------------------------------------------
// Event-specific payload types
// ---------------------------------------------------------------------------

export interface AutonomousDecisionPayload {
  decision: string;                   // What was decided
  alternatives: string[];             // Other options considered
  confidence: number;                 // 0.0 - 1.0
  rationale: string;                  // Why this decision
  context: Record<string, unknown>;   // Supporting data
}

// ---------------------------------------------------------------------------
// Verification types (used by hash-verifier, SPEC-009-5-2)
// ---------------------------------------------------------------------------

export interface VerificationResult {
  valid: boolean;
  totalEvents: number;
  errors: IntegrityError[];
  chainHeadHash: string;
}

export interface IntegrityError {
  lineNumber: number;
  eventId: string;
  errorType: "hash_mismatch" | "prev_hash_mismatch" | "missing_event" | "reorder_detected";
  expected: string;
  actual: string;
  message: string;
}

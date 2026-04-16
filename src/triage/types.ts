/**
 * Type definitions for the file-based triage processor (SPEC-007-4-2).
 *
 * Defines the triage decision interface, processing result, audit log
 * entry shape, and observation frontmatter contract.
 */

// ---------------------------------------------------------------------------
// Triage decision values
// ---------------------------------------------------------------------------

export const VALID_TRIAGE_DECISIONS = [
  'promote',
  'dismiss',
  'defer',
  'investigate',
] as const;

export type TriageDecisionValue = (typeof VALID_TRIAGE_DECISIONS)[number];

// ---------------------------------------------------------------------------
// Triage status values
// ---------------------------------------------------------------------------

export const TRIAGE_STATUSES = [
  'pending',
  'promoted',
  'dismissed',
  'deferred',
  'investigating',
] as const;

export type TriageStatus = (typeof TRIAGE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Observation frontmatter (triage-relevant fields)
// ---------------------------------------------------------------------------

/**
 * The subset of observation YAML frontmatter that the triage processor
 * reads and writes. The full observation document may contain additional
 * fields managed by other subsystems.
 */
export interface ObservationFrontmatter {
  id: string;
  service: string;
  fingerprint: string;
  triage_status: TriageStatus | string;
  triage_decision: TriageDecisionValue | string | null;
  triage_by: string | null;
  triage_at: string | null;
  triage_reason: string | null;
  defer_until: string | null;
  linked_prd: string | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Triage decision (validated, ready for dispatch)
// ---------------------------------------------------------------------------

export interface TriageDecision {
  observation_id: string;
  file_path: string;
  decision: TriageDecisionValue;
  triage_by: string;
  triage_at: string;
  triage_reason: string;
  defer_until?: string;
}

// ---------------------------------------------------------------------------
// Triage error
// ---------------------------------------------------------------------------

export interface TriageError {
  file: string;
  error: string;
}

// ---------------------------------------------------------------------------
// Triage processing result
// ---------------------------------------------------------------------------

export interface TriageProcessingResult {
  processed: TriageDecision[];
  errors: TriageError[];
  deferred_returned: string[];
}

// ---------------------------------------------------------------------------
// Triage audit log entry
// ---------------------------------------------------------------------------

export interface TriageAuditEntry {
  observation_id: string;
  action: TriageDecisionValue | 'deferred_return';
  actor: string;
  timestamp: string;
  reason: string;
  generated_prd: string | null;
  auto_promoted: boolean;
}

// ---------------------------------------------------------------------------
// Triage audit logger interface
// ---------------------------------------------------------------------------

/**
 * Append-only audit logger for triage actions.
 * Writes JSONL to `.autonomous-dev/logs/intelligence/triage-audit.jsonl`.
 */
export interface TriageAuditLogger {
  log(entry: TriageAuditEntry): void;
  logError(observationId: string, message: string): void;
  getEntries(): ReadonlyArray<TriageAuditEntry>;
  flush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Investigation request
// ---------------------------------------------------------------------------

export interface InvestigationRequest {
  observation_id: string;
  service: string;
  error_class: string;
  requested_at: string;
  requested_by: string;
}

// ---------------------------------------------------------------------------
// Frontmatter validation result
// ---------------------------------------------------------------------------

export interface ObservationValidationResult {
  valid: boolean;
  frontmatter: ObservationFrontmatter | null;
  body: string;
  rawContent: string;
  errors: string[];
}

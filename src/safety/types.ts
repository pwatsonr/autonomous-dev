/**
 * Core type definitions for the Data Safety Pipeline.
 *
 * Defines interfaces for pattern definitions, redaction records, and
 * scrub stage results used by the PII scrubber (Stage 1) and secret
 * detector (Stage 2).
 *
 * Based on SPEC-007-2-1 and TDD sections 3.4.2, 3.4.3.
 */

// ---------------------------------------------------------------------------
// Redaction record
// ---------------------------------------------------------------------------

/**
 * A single redaction event produced when a pattern matches input text.
 *
 * Captures the semantic type, position, and original length so that
 * downstream stages can reason about what was removed without seeing
 * the original value.
 */
export interface Redaction {
  /** The semantic type that was redacted (e.g. 'email', 'phone', 'secret'). */
  type: string;

  /** Zero-based character offset where the match started in the original text. */
  position: number;

  /** Character length of the original matched value. */
  original_length: number;

  /** The pattern name that triggered this redaction. */
  patternName?: string;
}

// ---------------------------------------------------------------------------
// Pattern definition
// ---------------------------------------------------------------------------

/**
 * A deterministic regex-based pattern used to detect and replace
 * sensitive data in text.
 */
export interface PatternDefinition {
  /** Human-readable name for the pattern (e.g. 'email', 'aws_access_key'). */
  name: string;

  /** Semantic type used in the replacement token (e.g. 'email' -> [REDACTED:email]). */
  type: string;

  /** The regex used to detect matches. Must have the global flag set. */
  regex: RegExp;

  /**
   * Static replacement string. For patterns that need dynamic replacement
   * (e.g. env vars that preserve the key name), use `replaceFunc` instead.
   */
  replacement: string;

  /**
   * Optional context-awareness constraint. When present, the pattern only
   * applies when the match is associated with one of the listed field names.
   */
  contextRequired?: {
    fieldNames: string[];
  };

  /**
   * Optional false-positive checker. Returns `true` if the match is a
   * false positive and should NOT be redacted.
   *
   * @param match  The matched substring.
   * @param context  The full input text (for surrounding-context inspection).
   * @returns `true` if the match is a false positive (skip redaction).
   */
  falsePositiveCheck?: (match: string, context: string) => boolean;

  /**
   * Optional dynamic replacement function. When provided, this function
   * is called instead of using the static `replacement` string.
   *
   * @param match  The matched substring.
   * @returns The replacement string.
   */
  replaceFunc?: (match: string) => string;
}

// ---------------------------------------------------------------------------
// Scrub stage result
// ---------------------------------------------------------------------------

/**
 * The output of a single scrub stage (PII or secret detection).
 */
export interface ScrubStageResult {
  /** The scrubbed text with all matched patterns replaced. */
  text: string;

  /** Ordered list of redactions that were applied. */
  redactions: Redaction[];

  /** Total number of redactions applied in this stage. */
  redactionCount: number;
}

// ---------------------------------------------------------------------------
// Pipeline result (full scrub output)
// ---------------------------------------------------------------------------

/**
 * The output of the full scrubbing pipeline (`scrub()` function).
 *
 * Extends stage results with validation status, failure tracking,
 * and processing time.
 */
export interface ScrubResult {
  /** The fully scrubbed text after all stages and validation. */
  text: string;

  /** Total number of redactions across all stages. */
  redaction_count: number;

  /** Ordered list of all redactions applied. */
  redactions: Redaction[];

  /** Whether post-scrub validation found no residuals. */
  validation_passed: boolean;

  /** Fields replaced with [SCRUB_FAILED:...] due to persistent residuals. */
  scrub_failed_fields: string[];

  /** Wall-clock time in milliseconds for the entire scrub operation. */
  processing_time_ms: number;
}

// ---------------------------------------------------------------------------
// Pipeline configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the data safety pipeline.
 */
export interface DataSafetyConfig {
  /** PII patterns: built-in 11 + any custom patterns from config. */
  pii_patterns: PatternDefinition[];

  /** Secret patterns: built-in 15 + env var + high-entropy + any custom. */
  secret_patterns: PatternDefinition[];

  /** Maximum time allowed for scrubbing before timeout (ms). Default 30_000. */
  timeout_ms: number;
}

// ---------------------------------------------------------------------------
// Scrub context
// ---------------------------------------------------------------------------

/**
 * Context passed to the `scrub()` function identifying the invocation.
 */
export interface ScrubContext {
  /** Optional field name for the data being scrubbed. */
  fieldName?: string;

  /** Unique identifier for this pipeline run. */
  runId: string;

  /** Service that produced the data (e.g. "api-gateway"). */
  service: string;

  /** Data source (e.g. "opensearch", "prometheus", "grafana"). */
  source: string;

  /** Number of lines in the input text. */
  lineCount: number;
}

// ---------------------------------------------------------------------------
// Audit log entry
// ---------------------------------------------------------------------------

/**
 * A single audit log entry written for every `scrub()` invocation.
 *
 * Matches the JSON format from TDD section 3.4.5.
 */
export interface ScrubAuditEntry {
  /** Unique run identifier. */
  run_id: string;

  /** Service that produced the data. */
  service: string;

  /** Data source. */
  source: string;

  /** Number of lines processed. */
  lines_processed: number;

  /** Per-type redaction counts (e.g. { email: 12, ip: 34 }). */
  redactions: Record<string, number>;

  /** Wall-clock processing time in milliseconds. */
  processing_time_ms: number;

  /** Whether post-scrub validation passed. */
  validation_passed: boolean;

  /** Fields that were replaced with [SCRUB_FAILED:...]. */
  scrub_failed_fields: string[];

  /** ISO 8601 timestamp of when the scrub completed. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Pattern match (used by residual detection)
// ---------------------------------------------------------------------------

/**
 * A pattern match found during residual detection.
 */
export interface PatternMatch {
  /** Name of the pattern that matched. */
  pattern: string;

  /** Zero-based character offset of the match. */
  position: number;

  /** Character length of the matched value. */
  value_length: number;
}

// ---------------------------------------------------------------------------
// Audit logger interface
// ---------------------------------------------------------------------------

/**
 * Interface for an audit log backend that can append JSON entries.
 */
export interface AuditLogger {
  /** Append a JSON-serializable entry to the audit log. */
  appendJson(entry: ScrubAuditEntry): void;

  /** Log an error message. */
  error(message: string): void;
}

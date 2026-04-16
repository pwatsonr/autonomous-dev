/**
 * Scrub Pipeline — Pipeline orchestrator and batch scrubbing wrapper.
 *
 * Implements SPEC-007-2-2 Tasks 3, 4, 6:
 *  - Task 3: Pipeline orchestrator (PII -> secrets -> validation)
 *  - Task 4: Post-scrub validation (defense-in-depth residual detection)
 *  - Task 6: Scrub failure handling (malformed regex, timeout, residuals)
 *
 * Also provides the batch `scrubCollectedData()` wrapper from SPEC-007-2-3
 * Task 7 for processing all MCP data source text fields.
 *
 * The `scrub()` function is the single entry point for all downstream
 * consumers. No raw production text may bypass it.
 *
 * Pipeline order: PII patterns -> Secret patterns -> High-entropy ->
 *                 Post-scrub validation -> Audit log
 */

import { PII_PATTERNS } from './pii-scrubber';
import { SECRET_PATTERNS, ENV_VAR_PATTERN } from './secret-detector';
import { detectHighEntropySecrets } from './entropy';
import type {
  DataSafetyConfig,
  PatternDefinition,
  PatternMatch,
  Redaction,
  ScrubContext,
  ScrubResult,
} from './types';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the scrubbing pipeline exceeds the configured timeout.
 */
export class ScrubTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScrubTimeoutError';
  }
}

// ---------------------------------------------------------------------------
// Configuration builder
// ---------------------------------------------------------------------------

/**
 * Build a `DataSafetyConfig` from the built-in patterns plus optional
 * custom patterns.
 *
 * Custom patterns are appended to the built-in list, never replacing it.
 *
 * @param customPiiPatterns     Additional PII patterns from config.
 * @param customSecretPatterns  Additional secret patterns from config.
 * @param timeoutMs             Timeout in milliseconds (default 30_000).
 */
export function buildSafetyConfig(
  customPiiPatterns: PatternDefinition[] = [],
  customSecretPatterns: PatternDefinition[] = [],
  timeoutMs: number = 30_000,
): DataSafetyConfig {
  return {
    pii_patterns: [...PII_PATTERNS, ...customPiiPatterns],
    secret_patterns: [...SECRET_PATTERNS, ENV_VAR_PATTERN, ...customSecretPatterns],
    timeout_ms: timeoutMs,
  };
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

/**
 * Returns a promise that rejects after the given number of milliseconds.
 */
function rejectAfter(ms: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new ScrubTimeoutError(`Scrubbing exceeded ${ms}ms`)),
      ms,
    );
  });
}

// ---------------------------------------------------------------------------
// Malformed pattern logger
// ---------------------------------------------------------------------------

/**
 * Internal log of malformed pattern warnings for observability and testing.
 */
const malformedPatternWarnings: Array<{
  patternName: string;
  error: unknown;
}> = [];

function logMalformedPattern(patternName: string, error: unknown): void {
  malformedPatternWarnings.push({ patternName, error });
}

/**
 * Get all recorded malformed pattern warnings (for testing/observability).
 */
export function getMalformedPatternWarnings(): Array<{
  patternName: string;
  error: unknown;
}> {
  return [...malformedPatternWarnings];
}

/**
 * Clear all recorded malformed pattern warnings (for testing).
 */
export function clearMalformedPatternWarnings(): void {
  malformedPatternWarnings.length = 0;
}

// ---------------------------------------------------------------------------
// Core scrub engine (Task 3)
// ---------------------------------------------------------------------------

/**
 * Perform the two-stage scrub without timeout wrapping.
 *
 * Stage 1: PII patterns (ordered).
 * Stage 2: Secret patterns (ordered), then high-entropy detection.
 *
 * Each pattern is applied via `new RegExp()` to get a fresh regex instance,
 * catching malformed patterns gracefully.
 *
 * @param text     The raw input text.
 * @param config   The safety configuration with all patterns.
 * @param context  Invocation context (fieldName used for SCRUB_FAILED).
 * @returns  A `ScrubResult` (validation_passed and processing_time_ms set by caller).
 */
export function performScrub(
  text: string,
  config: DataSafetyConfig,
  context: { fieldName?: string },
): ScrubResult {
  let result = text;
  const redactions: Redaction[] = [];

  // Stage 1: PII patterns (ordered)
  for (const pattern of config.pii_patterns) {
    try {
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(result)) !== null) {
        // False-positive check
        if (
          pattern.falsePositiveCheck &&
          pattern.falsePositiveCheck(match[0], result)
        ) {
          continue;
        }

        const replacement = pattern.replaceFunc
          ? pattern.replaceFunc(match[0])
          : pattern.replacement;

        redactions.push({
          type: pattern.type,
          position: match.index,
          original_length: match[0].length,
          patternName: pattern.name,
        });

        result =
          result.slice(0, match.index) +
          replacement +
          result.slice(match.index + match[0].length);
        regex.lastIndex = match.index + replacement.length;
      }
    } catch (e) {
      // Malformed pattern handling (Task 6)
      logMalformedPattern(pattern.name, e);
      continue; // Skip, do not crash
    }
  }

  // Stage 2: Secret patterns (ordered)
  for (const pattern of config.secret_patterns) {
    try {
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(result)) !== null) {
        // False-positive check
        if (
          pattern.falsePositiveCheck &&
          pattern.falsePositiveCheck(match[0], result)
        ) {
          continue;
        }

        const replacement = pattern.replaceFunc
          ? pattern.replaceFunc(match[0])
          : pattern.replacement;

        redactions.push({
          type: pattern.type,
          position: match.index,
          original_length: match[0].length,
          patternName: pattern.name,
        });

        result =
          result.slice(0, match.index) +
          replacement +
          result.slice(match.index + match[0].length);
        regex.lastIndex = match.index + replacement.length;
      }
    } catch (e) {
      logMalformedPattern(pattern.name, e);
      continue;
    }
  }

  // Stage 2b: High-entropy detection (runs after explicit patterns)
  const entropyRedactions = detectHighEntropySecrets(result);
  if (entropyRedactions.length > 0) {
    // Process in reverse order to preserve position indices
    const sortedRedactions = [...entropyRedactions].sort(
      (a, b) => b.position - a.position,
    );

    for (const redaction of sortedRedactions) {
      const before = result.substring(0, redaction.position);
      const after = result.substring(
        redaction.position + redaction.original_length,
      );

      // Preserve the key= prefix and only replace the value
      const matchedText = result.substring(
        redaction.position,
        redaction.position + redaction.original_length,
      );
      const separatorIdx = matchedText.search(/[=:]/);
      if (separatorIdx !== -1) {
        const keyPart = matchedText.substring(0, separatorIdx + 1);
        result = `${before}${keyPart}[SECRET_REDACTED]${after}`;
      } else {
        result = `${before}[SECRET_REDACTED]${after}`;
      }
    }

    redactions.push(...entropyRedactions);
  }

  return {
    text: result,
    redaction_count: redactions.length,
    redactions,
    validation_passed: true, // Updated by post-scrub validation
    scrub_failed_fields: [],
    processing_time_ms: 0, // Set by caller
  };
}

// ---------------------------------------------------------------------------
// Residual detection (Task 4)
// ---------------------------------------------------------------------------

/**
 * Run all PII + secret patterns against text to find residuals that
 * should have been caught by the initial scrub.
 *
 * Matches that are already replacement tokens ([REDACTED:...],
 * [SECRET_REDACTED], [SCRUB_FAILED:...]) are skipped.
 */
export function detectResiduals(
  text: string,
  config: DataSafetyConfig,
): PatternMatch[] {
  const matches: PatternMatch[] = [];

  for (const pattern of [...config.pii_patterns, ...config.secret_patterns]) {
    try {
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        // Skip matches that are already replacement tokens
        if (
          match[0].startsWith('[REDACTED:') ||
          match[0].startsWith('[SECRET_REDACTED]') ||
          match[0].startsWith('[SCRUB_FAILED:')
        ) {
          continue;
        }

        // Skip false positives
        if (
          pattern.falsePositiveCheck &&
          pattern.falsePositiveCheck(match[0], text)
        ) {
          continue;
        }

        matches.push({
          pattern: pattern.name,
          position: match.index,
          value_length: match[0].length,
        });
      }
    } catch {
      // Malformed pattern — skip during residual detection too
      continue;
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Post-scrub validation (Task 4)
// ---------------------------------------------------------------------------

/**
 * Defense-in-depth: after the initial scrub, run the full pattern list
 * again. If residuals are found, re-scrub. If they still persist,
 * replace the entire field with `[SCRUB_FAILED:field_name]`.
 *
 * @param scrubResult  The result of the initial scrub.
 * @param config       The safety configuration.
 * @param fieldName    The field name for SCRUB_FAILED replacement.
 * @returns  The validated (and possibly re-scrubbed) result.
 */
export function postScrubValidation(
  scrubResult: ScrubResult,
  config: DataSafetyConfig,
  fieldName: string,
): ScrubResult {
  // Pass 1: Check for residuals
  const residuals = detectResiduals(scrubResult.text, config);

  if (residuals.length === 0) {
    scrubResult.validation_passed = true;
    return scrubResult;
  }

  // Pass 2: Re-scrub residuals
  const reScrubbed = performScrub(scrubResult.text, config, { fieldName });
  const residualsAfterReScrub = detectResiduals(reScrubbed.text, config);

  if (residualsAfterReScrub.length === 0) {
    reScrubbed.validation_passed = true;
    reScrubbed.redaction_count += scrubResult.redaction_count;
    reScrubbed.redactions = [
      ...scrubResult.redactions,
      ...reScrubbed.redactions,
    ];
    return reScrubbed;
  }

  // Pass 3: Nuclear option -- replace entire field
  return {
    text: `[SCRUB_FAILED:${fieldName}]`,
    redaction_count: scrubResult.redaction_count + reScrubbed.redaction_count,
    redactions: [...scrubResult.redactions, ...reScrubbed.redactions],
    validation_passed: false,
    scrub_failed_fields: [fieldName],
    processing_time_ms: scrubResult.processing_time_ms,
  };
}

// ---------------------------------------------------------------------------
// Public API: scrub() (Tasks 3 + 6)
// ---------------------------------------------------------------------------

/**
 * The single entry point for all data scrubbing.
 *
 * Applies the two-stage pipeline (PII -> secrets), runs post-scrub
 * validation, and handles all three failure modes:
 *  1. Malformed custom regex: caught, logged, skipped (Warning)
 *  2. Timeout >30s: data discarded, returns [SCRUB_FAILED:timeout] (Error)
 *  3. Residual detection: re-scrub, then nuclear [SCRUB_FAILED:field] (Error)
 *
 * @param text     The raw input text to scrub.
 * @param config   The safety configuration.
 * @param context  Invocation context for audit logging.
 * @returns  A `ScrubResult` with cleaned text and metadata.
 */
export async function scrub(
  text: string,
  config: DataSafetyConfig,
  context: ScrubContext,
): Promise<ScrubResult> {
  const start = performance.now();

  try {
    // Timeout wrapper
    const result = await Promise.race([
      Promise.resolve(performScrub(text, config, context)),
      rejectAfter(config.timeout_ms),
    ]);

    // Post-scrub validation
    const fieldName = context.fieldName || 'unknown';
    const validated = postScrubValidation(result, config, fieldName);

    validated.processing_time_ms = performance.now() - start;
    return validated;
  } catch (error) {
    if (error instanceof ScrubTimeoutError) {
      // Return a safe empty result -- NEVER forward unscrubbed text
      return {
        text: '[SCRUB_FAILED:timeout]',
        redaction_count: 0,
        redactions: [],
        validation_passed: false,
        scrub_failed_fields: ['*'],
        processing_time_ms: config.timeout_ms,
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Data source result types (from SPEC-007-2-3, Task 7)
// ---------------------------------------------------------------------------

/**
 * A single hit from an OpenSearch query.
 */
export interface OpenSearchHit {
  message: string;
  stack_trace?: string;
  [key: string]: unknown;
}

/**
 * Result from a single OpenSearch query.
 */
export interface OpenSearchResult {
  hits: OpenSearchHit[];
  [key: string]: unknown;
}

/**
 * A Prometheus query result with optional string labels.
 */
export interface PrometheusResult {
  labels?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * A single Grafana alert result.
 */
export interface GrafanaAlertResult {
  [key: string]: unknown;
}

/**
 * A single Grafana annotation.
 */
export interface GrafanaAnnotation {
  text: string;
  [key: string]: unknown;
}

/**
 * Container for Grafana annotation query results.
 */
export interface GrafanaAnnotationResult {
  annotations: GrafanaAnnotation[];
}

// ---------------------------------------------------------------------------
// Collected / Scrubbed data interfaces
// ---------------------------------------------------------------------------

/**
 * Raw data collected from all MCP sources for a single service.
 */
export interface CollectedData {
  prometheus: PrometheusResult[];
  opensearch: OpenSearchResult[];
  grafana: {
    alerts: GrafanaAlertResult;
    annotations: GrafanaAnnotationResult;
  };
}

/**
 * A scrubbed OpenSearch hit (same shape, but text fields have been scrubbed).
 */
export type ScrubbedOpenSearchHit = OpenSearchHit;

/**
 * A scrubbed OpenSearch result (same shape, scrubbed hits).
 */
export type ScrubbedOpenSearchResult = OpenSearchResult;

/**
 * A scrubbed Grafana annotation (same shape, text field scrubbed).
 */
export type ScrubbedAnnotation = GrafanaAnnotation;

/**
 * Container for scrubbed Grafana annotation results.
 */
export type ScrubbedAnnotationResult = GrafanaAnnotationResult;

/**
 * Lightweight audit entry for batch scrubbing (SPEC-007-2-3 format).
 */
export interface BatchScrubAuditEntry {
  runId: string;
  service: string;
  source: string;
  fieldName: string;
  redactionCount: number;
  timestamp: string;
}

/**
 * Scrubbed data with audit trail.
 */
export interface ScrubbedData {
  prometheus: PrometheusResult[];
  opensearch: ScrubbedOpenSearchResult[];
  grafana: {
    alerts: GrafanaAlertResult;
    annotations: ScrubbedAnnotationResult;
  };
  scrubAuditEntries: BatchScrubAuditEntry[];
}

// ---------------------------------------------------------------------------
// Batch scrubbing: scrubCollectedData() (SPEC-007-2-3, Task 7)
// ---------------------------------------------------------------------------

/**
 * Scrub all text fields from all MCP data sources in a single batch.
 *
 * This is the main entry point called unconditionally by the observation
 * runner between data collection and analysis. There is NO bypass flag.
 *
 * If scrubbing fails for any individual field (timeout or persistent
 * error), the affected field is replaced with `[SCRUB_FAILED:...]` --
 * raw text is NEVER passed through.
 *
 * @param rawData   Raw data collected from all MCP sources.
 * @param config    Data safety configuration with pattern definitions.
 * @param context   Run and service context for audit logging.
 * @returns  Scrubbed data with audit trail.
 */
export async function scrubCollectedData(
  rawData: CollectedData,
  config: DataSafetyConfig,
  context: { runId: string; service: string },
): Promise<ScrubbedData> {
  const auditEntries: BatchScrubAuditEntry[] = [];

  // -------------------------------------------------------------------------
  // OpenSearch: scrub message, stack_trace, and any user_id fields
  // -------------------------------------------------------------------------
  const scrubbedOpenSearch = await Promise.all(
    rawData.opensearch.map(async (result) => {
      const scrubbedHits = await Promise.all(
        result.hits.map(async (hit) => {
          const msgResult = await scrub(hit.message, config, {
            fieldName: 'message',
            runId: context.runId,
            service: context.service,
            source: 'opensearch',
            lineCount: hit.message.split('\n').length,
          });
          auditEntries.push({
            runId: context.runId,
            service: context.service,
            source: 'opensearch',
            fieldName: 'message',
            redactionCount: msgResult.redaction_count,
            timestamp: new Date().toISOString(),
          });

          const stackResult = hit.stack_trace
            ? await scrub(hit.stack_trace, config, {
                fieldName: 'stack_trace',
                runId: context.runId,
                service: context.service,
                source: 'opensearch',
                lineCount: hit.stack_trace.split('\n').length,
              })
            : null;
          if (stackResult) {
            auditEntries.push({
              runId: context.runId,
              service: context.service,
              source: 'opensearch',
              fieldName: 'stack_trace',
              redactionCount: stackResult.redaction_count,
              timestamp: new Date().toISOString(),
            });
          }

          return {
            ...hit,
            message: msgResult.text,
            stack_trace: stackResult?.text ?? hit.stack_trace,
          };
        }),
      );
      return { ...result, hits: scrubbedHits };
    }),
  );

  // -------------------------------------------------------------------------
  // Prometheus: scrub any string labels that could contain PII
  // -------------------------------------------------------------------------
  const scrubbedPrometheus = await Promise.all(
    rawData.prometheus.map(async (result) => {
      if (result.labels) {
        const scrubbedLabels: Record<string, string> = {};
        for (const [key, value] of Object.entries(result.labels)) {
          const scrubbed = await scrub(value, config, {
            fieldName: `label:${key}`,
            runId: context.runId,
            service: context.service,
            source: 'prometheus',
            lineCount: 1,
          });
          scrubbedLabels[key] = scrubbed.text;
          auditEntries.push({
            runId: context.runId,
            service: context.service,
            source: 'prometheus',
            fieldName: `label:${key}`,
            redactionCount: scrubbed.redaction_count,
            timestamp: new Date().toISOString(),
          });
        }
        return { ...result, labels: scrubbedLabels };
      }
      return result;
    }),
  );

  // -------------------------------------------------------------------------
  // Grafana: scrub annotation text fields
  // -------------------------------------------------------------------------
  const scrubbedAnnotations = await Promise.all(
    rawData.grafana.annotations.annotations.map(async (ann) => {
      const scrubbed = await scrub(ann.text, config, {
        fieldName: 'annotation_text',
        runId: context.runId,
        service: context.service,
        source: 'grafana',
        lineCount: ann.text.split('\n').length,
      });
      auditEntries.push({
        runId: context.runId,
        service: context.service,
        source: 'grafana',
        fieldName: 'annotation_text',
        redactionCount: scrubbed.redaction_count,
        timestamp: new Date().toISOString(),
      });
      return { ...ann, text: scrubbed.text };
    }),
  );

  return {
    prometheus: scrubbedPrometheus,
    opensearch: scrubbedOpenSearch,
    grafana: {
      alerts: rawData.grafana.alerts,
      annotations: { annotations: scrubbedAnnotations },
    },
    scrubAuditEntries: auditEntries,
  };
}

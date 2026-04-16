/**
 * Zod-based YAML frontmatter schema validation for observation reports
 * (SPEC-007-4-1, Task 3).
 *
 * Validates all required fields, correct types, and valid enum values
 * on both read and write paths. On write, validation failure throws a
 * `SchemaValidationError` with a clear violation list. On read, failures
 * return `{ valid: false, errors: [...] }` without throwing.
 */

import { z } from 'zod';
import * as yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Custom error class
// ---------------------------------------------------------------------------

/**
 * Thrown when frontmatter validation fails on the write path.
 * Contains a human-readable list of all schema violations.
 */
export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

// ---------------------------------------------------------------------------
// Observation frontmatter Zod schema
// ---------------------------------------------------------------------------

/**
 * Valid observation types matching CandidateObservation.type.
 */
const ObservationTypeSchema = z.enum(['error', 'anomaly', 'trend', 'adoption']);

/**
 * Valid severity levels.
 */
const SeveritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);

/**
 * Valid triage statuses.
 */
const TriageStatusSchema = z.enum([
  'pending',
  'cooldown',
  'investigating',
  'promoted',
  'dismissed',
  'deferred',
]);

/**
 * Valid triage decisions (nullable -- null when untriaged).
 */
const TriageDecisionSchema = z.enum([
  'promote',
  'dismiss',
  'defer',
  'investigate',
]).nullable();

/**
 * Data source status per the adapters/types.ts definition.
 */
const DataSourceStatusSchema = z.enum([
  'available',
  'degraded',
  'unreachable',
  'not_configured',
]);

/**
 * Data sources sub-object in frontmatter.
 */
const DataSourcesSchema = z.object({
  prometheus: DataSourceStatusSchema,
  grafana: DataSourceStatusSchema,
  opensearch: DataSourceStatusSchema,
  sentry: DataSourceStatusSchema,
});

/**
 * Full observation report frontmatter schema (TDD section 4.1).
 */
export const ObservationFrontmatterSchema = z.object({
  id: z.string().regex(
    /^OBS-\d{8}-\d{6}-[a-f0-9]{4}$/,
    'id must match format OBS-YYYYMMDD-HHMMSS-<hex4>',
  ),
  timestamp: z.string().datetime({ message: 'timestamp must be ISO 8601' }),
  service: z.string().min(1, 'service must not be empty'),
  repo: z.string().min(1, 'repo must not be empty'),
  type: ObservationTypeSchema,
  severity: SeveritySchema,
  confidence: z.number().min(0).max(1),
  triage_status: TriageStatusSchema,
  triage_decision: TriageDecisionSchema,
  triage_by: z.string().nullable(),
  triage_at: z.string().datetime().nullable(),
  triage_reason: z.string().nullable(),
  defer_until: z.string().datetime().nullable(),
  cooldown_active: z.boolean(),
  linked_prd: z.string().nullable(),
  linked_deployment: z.string().nullable(),
  effectiveness: z.number().nullable(),
  effectiveness_detail: z.string().nullable(),
  observation_run_id: z.string().min(1, 'observation_run_id must not be empty'),
  tokens_consumed: z.number().int().nonnegative(),
  fingerprint: z.string().min(1, 'fingerprint must not be empty'),
  occurrence_count: z.number().int().positive(),
  data_sources: DataSourcesSchema,
  related_observations: z.array(z.string()),
  oscillation_warning: z.boolean(),
});

export type ObservationFrontmatter = z.infer<typeof ObservationFrontmatterSchema>;

// ---------------------------------------------------------------------------
// Validation on write (throws)
// ---------------------------------------------------------------------------

/**
 * Validates frontmatter on the write path.
 *
 * @param frontmatter  The frontmatter object to validate.
 * @throws SchemaValidationError with a list of violations.
 */
export function validateOnWrite(frontmatter: object): void {
  const result = ObservationFrontmatterSchema.safeParse(frontmatter);
  if (!result.success) {
    throw new SchemaValidationError(
      `Observation report validation failed:\n${result.error.issues.map(
        (i) => `  - ${i.path.join('.')}: ${i.message}`,
      ).join('\n')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Validation on read (returns result)
// ---------------------------------------------------------------------------

/**
 * Result of reading and validating an observation file.
 */
export interface ReadValidationResult {
  valid: boolean;
  errors: string[];
  frontmatter?: ObservationFrontmatter;
}

/**
 * Validates an observation file on the read path.
 *
 * Parses the YAML frontmatter from the file content and validates it
 * against the schema. Does NOT throw on invalid input; instead returns
 * a result object with `valid: false` and a list of error strings.
 *
 * @param content  The full file content (YAML frontmatter + Markdown body).
 * @returns Validation result with parsed frontmatter when valid.
 */
export function validateOnRead(content: string): ReadValidationResult {
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    return { valid: false, errors: ['Failed to parse YAML frontmatter'] };
  }
  const result = ObservationFrontmatterSchema.safeParse(parsed);
  if (result.success) {
    return { valid: true, errors: [], frontmatter: result.data };
  }
  return {
    valid: false,
    errors: result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    ),
  };
}

// ---------------------------------------------------------------------------
// YAML frontmatter parser
// ---------------------------------------------------------------------------

/**
 * Extracts and parses the YAML frontmatter block from a Markdown file.
 *
 * Expects the file to start with `---\n...\n---`.
 *
 * @param content  The full file content.
 * @returns Parsed object or null if parsing fails.
 */
export function parseFrontmatter(content: string): object | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    const parsed = yaml.load(match[1]);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as object;
    }
    return null;
  } catch {
    return null;
  }
}

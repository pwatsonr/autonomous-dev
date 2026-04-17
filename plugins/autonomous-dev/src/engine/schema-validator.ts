/**
 * YAML frontmatter schema validation for observation files
 * (SPEC-007-3-6, Task 15 -- Failure 3).
 *
 * Validates observation frontmatter against the full schema from
 * TDD section 4.1. Invalid observations are rejected and logged,
 * never written to disk.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Data source status enum
// ---------------------------------------------------------------------------

const DataSourceStatusSchema = z.enum([
  'available',
  'degraded',
  'unreachable',
  'not_configured',
]);

// ---------------------------------------------------------------------------
// Observation frontmatter schema
// ---------------------------------------------------------------------------

/**
 * Complete Zod schema for observation YAML frontmatter.
 *
 * Validates all required fields and their types/enums per TDD section 4.1.
 */
export const ObservationFrontmatterSchema = z.object({
  id: z.string().regex(/^OBS-\d{8}-\d{6}-[a-f0-9]{4}$/),
  timestamp: z.string().datetime(),
  service: z.string().min(1),
  repo: z.string().min(1),
  type: z.enum(['error', 'anomaly', 'trend', 'adoption']),
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  confidence: z.number().min(0).max(1),
  triage_status: z.enum([
    'pending',
    'promoted',
    'dismissed',
    'deferred',
    'investigating',
    'cooldown',
  ]),
  triage_decision: z
    .enum(['promote', 'dismiss', 'defer', 'investigate'])
    .nullable(),
  triage_by: z.string().nullable(),
  triage_at: z.string().datetime().nullable(),
  triage_reason: z.string().nullable(),
  defer_until: z.string().nullable(),
  cooldown_active: z.boolean(),
  linked_prd: z.string().nullable(),
  linked_deployment: z.string().nullable(),
  effectiveness: z
    .enum(['improved', 'unchanged', 'degraded', 'pending'])
    .nullable(),
  effectiveness_detail: z
    .object({
      pre_fix_avg: z.number().nullable(),
      post_fix_avg: z.number().nullable(),
      improvement_pct: z.number().nullable(),
      measured_window: z.string().nullable(),
    })
    .nullable()
    .optional(),
  observation_run_id: z.string(),
  tokens_consumed: z.number().int(),
  fingerprint: z.string(),
  occurrence_count: z.number().int().min(1),
  data_sources: z.object({
    prometheus: DataSourceStatusSchema,
    grafana: DataSourceStatusSchema,
    opensearch: DataSourceStatusSchema,
    sentry: DataSourceStatusSchema,
  }),
  related_observations: z.array(z.string()),
  oscillation_warning: z.boolean(),
});

/**
 * TypeScript type inferred from the validation schema.
 */
export type ObservationFrontmatter = z.infer<
  typeof ObservationFrontmatterSchema
>;

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

/**
 * Result of validating observation frontmatter.
 */
export interface ValidationResult {
  /** True when the frontmatter passes all validation checks. */
  valid: boolean;
  /** Array of human-readable validation error messages (empty when valid). */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Validation function
// ---------------------------------------------------------------------------

/**
 * Validates an observation frontmatter object against the full schema.
 *
 * Invalid observations are rejected and logged, never written to disk.
 * The validation error messages include the field path and issue description.
 *
 * @param frontmatter  The raw frontmatter object to validate
 * @returns            Validation result with field-level error messages
 */
export function validateObservation(frontmatter: unknown): ValidationResult {
  const result = ObservationFrontmatterSchema.safeParse(frontmatter);
  if (result.success) {
    return { valid: true, errors: [] };
  }
  return {
    valid: false,
    errors: result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    ),
  };
}

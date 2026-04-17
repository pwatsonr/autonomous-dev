/**
 * Unit tests for observation schema validation (SPEC-007-3-6, Task 15).
 *
 * Test case IDs: TC-3-6-07 through TC-3-6-10, TC-3-6-15.
 */

import {
  validateObservation,
  ObservationFrontmatterSchema,
} from '../../src/engine/schema-validator';
import type { ObservationFrontmatter } from '../../src/engine/schema-validator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a fully valid observation frontmatter object.
 * All fields are set to valid values matching the schema.
 */
function buildValidFrontmatter(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'OBS-20260408-143022-a1b2',
    timestamp: '2026-04-08T14:30:22Z',
    service: 'api-gateway',
    repo: 'org/api-gateway',
    type: 'error',
    severity: 'P1',
    confidence: 0.85,
    triage_status: 'pending',
    triage_decision: null,
    triage_by: null,
    triage_at: null,
    triage_reason: null,
    defer_until: null,
    cooldown_active: false,
    linked_prd: null,
    linked_deployment: null,
    effectiveness: null,
    effectiveness_detail: null,
    observation_run_id: 'run-20260408-143000',
    tokens_consumed: 15000,
    fingerprint: 'a'.repeat(64),
    occurrence_count: 1,
    data_sources: {
      prometheus: 'available',
      grafana: 'available',
      opensearch: 'available',
      sentry: 'not_configured',
    },
    related_observations: [],
    oscillation_warning: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TC-3-6-07: Schema valid
// ---------------------------------------------------------------------------

describe('validateObservation - valid inputs', () => {
  it('TC-3-6-07: returns valid=true when all fields have correct types and enums', () => {
    const frontmatter = buildValidFrontmatter();
    const result = validateObservation(frontmatter);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts all valid severity values', () => {
    for (const severity of ['P0', 'P1', 'P2', 'P3']) {
      const result = validateObservation(buildValidFrontmatter({ severity }));
      expect(result.valid).toBe(true);
    }
  });

  it('accepts all valid observation types', () => {
    for (const type of ['error', 'anomaly', 'trend', 'adoption']) {
      const result = validateObservation(buildValidFrontmatter({ type }));
      expect(result.valid).toBe(true);
    }
  });

  it('accepts all valid triage_status values', () => {
    for (const status of ['pending', 'promoted', 'dismissed', 'deferred', 'investigating', 'cooldown']) {
      const result = validateObservation(buildValidFrontmatter({ triage_status: status }));
      expect(result.valid).toBe(true);
    }
  });

  it('accepts all valid triage_decision values', () => {
    for (const decision of ['promote', 'dismiss', 'defer', 'investigate', null]) {
      const result = validateObservation(buildValidFrontmatter({ triage_decision: decision }));
      expect(result.valid).toBe(true);
    }
  });

  it('accepts all valid effectiveness values', () => {
    for (const eff of ['improved', 'unchanged', 'degraded', 'pending', null]) {
      const result = validateObservation(buildValidFrontmatter({ effectiveness: eff }));
      expect(result.valid).toBe(true);
    }
  });

  it('accepts all valid data_source status values', () => {
    for (const status of ['available', 'degraded', 'unreachable', 'not_configured']) {
      const result = validateObservation(
        buildValidFrontmatter({
          data_sources: {
            prometheus: status,
            grafana: status,
            opensearch: status,
            sentry: status,
          },
        }),
      );
      expect(result.valid).toBe(true);
    }
  });

  it('accepts confidence at boundary values 0 and 1', () => {
    expect(validateObservation(buildValidFrontmatter({ confidence: 0 })).valid).toBe(true);
    expect(validateObservation(buildValidFrontmatter({ confidence: 1 })).valid).toBe(true);
    expect(validateObservation(buildValidFrontmatter({ confidence: 0.5 })).valid).toBe(true);
  });

  it('accepts effectiveness_detail as null or undefined', () => {
    expect(
      validateObservation(buildValidFrontmatter({ effectiveness_detail: null })).valid,
    ).toBe(true);
    const withoutDetail = buildValidFrontmatter();
    delete withoutDetail.effectiveness_detail;
    expect(validateObservation(withoutDetail).valid).toBe(true);
  });

  it('accepts effectiveness_detail with valid fields', () => {
    const result = validateObservation(
      buildValidFrontmatter({
        effectiveness_detail: {
          pre_fix_avg: 12.5,
          post_fix_avg: 3.2,
          improvement_pct: 74.4,
          measured_window: '7d',
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('accepts effectiveness_detail with null inner fields', () => {
    const result = validateObservation(
      buildValidFrontmatter({
        effectiveness_detail: {
          pre_fix_avg: null,
          post_fix_avg: null,
          improvement_pct: null,
          measured_window: null,
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('accepts non-empty related_observations array', () => {
    const result = validateObservation(
      buildValidFrontmatter({
        related_observations: ['OBS-20260407-120000-c3d4', 'OBS-20260406-080000-e5f6'],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('accepts triage_at as valid datetime string', () => {
    const result = validateObservation(
      buildValidFrontmatter({
        triage_at: '2026-04-08T16:00:00Z',
        triage_by: 'engineer@example.com',
        triage_decision: 'promote',
        triage_reason: 'Confirmed production issue',
      }),
    );
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TC-3-6-08: Invalid id format
// ---------------------------------------------------------------------------

describe('validateObservation - invalid id format', () => {
  it('TC-3-6-08: rejects invalid id format "BAD-FORMAT"', () => {
    const result = validateObservation(buildValidFrontmatter({ id: 'BAD-FORMAT' }));

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('id'))).toBe(true);
  });

  it('rejects id missing hex suffix', () => {
    const result = validateObservation(
      buildValidFrontmatter({ id: 'OBS-20260408-143022' }),
    );
    expect(result.valid).toBe(false);
  });

  it('rejects id with uppercase hex', () => {
    const result = validateObservation(
      buildValidFrontmatter({ id: 'OBS-20260408-143022-A1B2' }),
    );
    expect(result.valid).toBe(false);
  });

  it('rejects id with wrong prefix', () => {
    const result = validateObservation(
      buildValidFrontmatter({ id: 'ERR-20260408-143022-a1b2' }),
    );
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TC-3-6-09: Invalid severity
// ---------------------------------------------------------------------------

describe('validateObservation - invalid severity', () => {
  it('TC-3-6-09: rejects severity "P5"', () => {
    const result = validateObservation(buildValidFrontmatter({ severity: 'P5' }));

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('severity'))).toBe(true);
  });

  it('rejects severity "critical"', () => {
    const result = validateObservation(buildValidFrontmatter({ severity: 'critical' }));
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TC-3-6-10: Missing required field
// ---------------------------------------------------------------------------

describe('validateObservation - missing required fields', () => {
  it('TC-3-6-10: rejects when service field is missing', () => {
    const frontmatter = buildValidFrontmatter();
    delete frontmatter.service;

    const result = validateObservation(frontmatter);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects empty service string', () => {
    const result = validateObservation(buildValidFrontmatter({ service: '' }));
    expect(result.valid).toBe(false);
  });

  it('rejects when id is missing', () => {
    const frontmatter = buildValidFrontmatter();
    delete frontmatter.id;

    const result = validateObservation(frontmatter);
    expect(result.valid).toBe(false);
  });

  it('rejects when timestamp is missing', () => {
    const frontmatter = buildValidFrontmatter();
    delete frontmatter.timestamp;

    const result = validateObservation(frontmatter);
    expect(result.valid).toBe(false);
  });

  it('rejects when repo is missing', () => {
    const frontmatter = buildValidFrontmatter();
    delete frontmatter.repo;

    const result = validateObservation(frontmatter);
    expect(result.valid).toBe(false);
  });

  it('rejects when type is missing', () => {
    const frontmatter = buildValidFrontmatter();
    delete frontmatter.type;

    const result = validateObservation(frontmatter);
    expect(result.valid).toBe(false);
  });

  it('rejects when fingerprint is missing', () => {
    const frontmatter = buildValidFrontmatter();
    delete frontmatter.fingerprint;

    const result = validateObservation(frontmatter);
    expect(result.valid).toBe(false);
  });

  it('rejects when data_sources is missing', () => {
    const frontmatter = buildValidFrontmatter();
    delete frontmatter.data_sources;

    const result = validateObservation(frontmatter);
    expect(result.valid).toBe(false);
  });

  it('rejects when oscillation_warning is missing', () => {
    const frontmatter = buildValidFrontmatter();
    delete frontmatter.oscillation_warning;

    const result = validateObservation(frontmatter);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Type validation
// ---------------------------------------------------------------------------

describe('validateObservation - type mismatches', () => {
  it('rejects confidence > 1', () => {
    const result = validateObservation(buildValidFrontmatter({ confidence: 1.5 }));
    expect(result.valid).toBe(false);
  });

  it('rejects confidence < 0', () => {
    const result = validateObservation(buildValidFrontmatter({ confidence: -0.1 }));
    expect(result.valid).toBe(false);
  });

  it('rejects non-integer tokens_consumed', () => {
    const result = validateObservation(buildValidFrontmatter({ tokens_consumed: 15000.5 }));
    expect(result.valid).toBe(false);
  });

  it('rejects non-integer occurrence_count', () => {
    const result = validateObservation(buildValidFrontmatter({ occurrence_count: 1.5 }));
    expect(result.valid).toBe(false);
  });

  it('rejects occurrence_count < 1', () => {
    const result = validateObservation(buildValidFrontmatter({ occurrence_count: 0 }));
    expect(result.valid).toBe(false);
  });

  it('rejects invalid type enum value', () => {
    const result = validateObservation(buildValidFrontmatter({ type: 'warning' }));
    expect(result.valid).toBe(false);
  });

  it('rejects invalid triage_status enum value', () => {
    const result = validateObservation(buildValidFrontmatter({ triage_status: 'active' }));
    expect(result.valid).toBe(false);
  });

  it('rejects invalid data_source status', () => {
    const result = validateObservation(
      buildValidFrontmatter({
        data_sources: {
          prometheus: 'available',
          grafana: 'available',
          opensearch: 'offline', // invalid
          sentry: 'not_configured',
        },
      }),
    );
    expect(result.valid).toBe(false);
  });

  it('rejects cooldown_active as string instead of boolean', () => {
    const result = validateObservation(buildValidFrontmatter({ cooldown_active: 'false' }));
    expect(result.valid).toBe(false);
  });

  it('rejects oscillation_warning as string instead of boolean', () => {
    const result = validateObservation(buildValidFrontmatter({ oscillation_warning: 'true' }));
    expect(result.valid).toBe(false);
  });

  it('rejects invalid timestamp format', () => {
    const result = validateObservation(buildValidFrontmatter({ timestamp: 'not-a-date' }));
    expect(result.valid).toBe(false);
  });

  it('rejects related_observations as non-array', () => {
    const result = validateObservation(buildValidFrontmatter({ related_observations: 'OBS-123' }));
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TC-3-6-15: Cooldown prerequisite
// ---------------------------------------------------------------------------

describe('validateObservation - cooldown fields', () => {
  it('TC-3-6-15: accepts cooldown_active=true with cooldown triage_status', () => {
    const result = validateObservation(
      buildValidFrontmatter({
        cooldown_active: true,
        triage_status: 'cooldown',
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('TC-3-6-15: accepts cooldown_active=false with pending status', () => {
    const result = validateObservation(
      buildValidFrontmatter({
        cooldown_active: false,
        triage_status: 'pending',
      }),
    );
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error message quality
// ---------------------------------------------------------------------------

describe('validateObservation - error messages', () => {
  it('includes field path in error message', () => {
    const result = validateObservation(buildValidFrontmatter({ severity: 'INVALID' }));

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('severity');
  });

  it('reports multiple errors for multiple invalid fields', () => {
    const result = validateObservation(
      buildValidFrontmatter({
        severity: 'P5',
        type: 'warning',
        confidence: 2.0,
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('validates completely empty object', () => {
    const result = validateObservation({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('validates null input', () => {
    const result = validateObservation(null);
    expect(result.valid).toBe(false);
  });

  it('validates undefined input', () => {
    const result = validateObservation(undefined);
    expect(result.valid).toBe(false);
  });
});

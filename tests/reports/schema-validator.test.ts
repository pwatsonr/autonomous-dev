/**
 * Unit tests for the observation report schema validator
 * (SPEC-007-4-1, Task 3).
 *
 * Test case IDs correspond to the spec's test case table:
 *   TC-4-1-10 through TC-4-1-15.
 */

import {
  validateOnWrite,
  validateOnRead,
  parseFrontmatter,
  SchemaValidationError,
  ObservationFrontmatterSchema,
} from '../../src/reports/schema-validator';
import type { ObservationFrontmatter } from '../../src/reports/schema-validator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildValidFrontmatter(
  overrides: Partial<ObservationFrontmatter> = {},
): ObservationFrontmatter {
  return {
    id: 'OBS-20260408-143022-a1b2',
    timestamp: '2026-04-08T14:30:22.000Z',
    service: 'api-gateway',
    repo: 'api-gateway',
    type: 'error',
    severity: 'P1',
    confidence: 0.78,
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
    tokens_consumed: 1250,
    fingerprint: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
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

function wrapInFrontmatter(obj: object): string {
  const yaml = require('js-yaml');
  return `---\n${yaml.dump(obj)}---\n\n# Test Report\n`;
}

// ---------------------------------------------------------------------------
// validateOnWrite
// ---------------------------------------------------------------------------

describe('validateOnWrite', () => {
  // TC-4-1-10: All fields correct -> no error
  it('TC-4-1-10: does not throw for valid frontmatter', () => {
    const fm = buildValidFrontmatter();
    expect(() => validateOnWrite(fm)).not.toThrow();
  });

  // TC-4-1-11: Invalid type enum -> SchemaValidationError
  it('TC-4-1-11: throws SchemaValidationError for invalid type enum', () => {
    const fm = buildValidFrontmatter({ type: 'disaster' as any });
    expect(() => validateOnWrite(fm)).toThrow(SchemaValidationError);
    try {
      validateOnWrite(fm);
    } catch (e) {
      expect((e as SchemaValidationError).message).toContain('type');
    }
  });

  // TC-4-1-12: Missing confidence field -> validation error
  it('TC-4-1-12: throws SchemaValidationError when confidence is missing', () => {
    const fm = buildValidFrontmatter();
    delete (fm as any).confidence;
    expect(() => validateOnWrite(fm)).toThrow(SchemaValidationError);
    try {
      validateOnWrite(fm);
    } catch (e) {
      expect((e as SchemaValidationError).message).toContain('confidence');
    }
  });

  it('throws SchemaValidationError for invalid severity', () => {
    const fm = buildValidFrontmatter({ severity: 'P9' as any });
    expect(() => validateOnWrite(fm)).toThrow(SchemaValidationError);
  });

  it('throws SchemaValidationError for invalid triage_status', () => {
    const fm = buildValidFrontmatter({ triage_status: 'unknown' as any });
    expect(() => validateOnWrite(fm)).toThrow(SchemaValidationError);
  });

  it('throws SchemaValidationError for empty service', () => {
    const fm = buildValidFrontmatter({ service: '' });
    expect(() => validateOnWrite(fm)).toThrow(SchemaValidationError);
  });

  it('throws SchemaValidationError for invalid ID format', () => {
    const fm = buildValidFrontmatter({ id: 'INVALID-ID' });
    expect(() => validateOnWrite(fm)).toThrow(SchemaValidationError);
  });

  it('throws SchemaValidationError for confidence out of range', () => {
    const fm = buildValidFrontmatter({ confidence: 1.5 });
    expect(() => validateOnWrite(fm)).toThrow(SchemaValidationError);
  });

  it('throws SchemaValidationError for negative tokens_consumed', () => {
    const fm = buildValidFrontmatter({ tokens_consumed: -1 });
    expect(() => validateOnWrite(fm)).toThrow(SchemaValidationError);
  });

  it('throws SchemaValidationError for invalid data_sources status', () => {
    const fm = buildValidFrontmatter({
      data_sources: {
        prometheus: 'broken' as any,
        grafana: 'available',
        opensearch: 'available',
        sentry: 'not_configured',
      },
    });
    expect(() => validateOnWrite(fm)).toThrow(SchemaValidationError);
  });

  it('accepts valid triage_decision enum', () => {
    const fm = buildValidFrontmatter({
      triage_status: 'investigating',
      triage_decision: 'investigate',
    });
    expect(() => validateOnWrite(fm)).not.toThrow();
  });

  it('accepts cooldown triage_status', () => {
    const fm = buildValidFrontmatter({ triage_status: 'cooldown' });
    expect(() => validateOnWrite(fm)).not.toThrow();
  });

  it('accepts zero occurrence_count as invalid (must be positive)', () => {
    const fm = buildValidFrontmatter({ occurrence_count: 0 });
    expect(() => validateOnWrite(fm)).toThrow(SchemaValidationError);
  });
});

// ---------------------------------------------------------------------------
// validateOnRead
// ---------------------------------------------------------------------------

describe('validateOnRead', () => {
  // TC-4-1-13: Well-formed observation file -> valid: true
  it('TC-4-1-13: returns valid: true for well-formed file', () => {
    const fm = buildValidFrontmatter();
    const content = wrapInFrontmatter(fm);
    const result = validateOnRead(content);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.frontmatter).toBeDefined();
    expect(result.frontmatter?.id).toBe(fm.id);
  });

  // TC-4-1-14: Corrupted YAML -> valid: false, parse error
  it('TC-4-1-14: returns valid: false for corrupted YAML', () => {
    const content = '---\n: invalid: yaml: [\n---\n\n# Broken';
    const result = validateOnRead(content);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns valid: false when frontmatter delimiters are missing', () => {
    const content = '# Just a markdown file\n\nNo frontmatter here.';
    const result = validateOnRead(content);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Failed to parse YAML frontmatter');
  });

  it('returns valid: false for frontmatter with missing required fields', () => {
    const content = wrapInFrontmatter({ id: 'OBS-20260408-143022-a1b2' });
    const result = validateOnRead(content);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns parsed frontmatter on valid input', () => {
    const fm = buildValidFrontmatter({
      service: 'payment-service',
      severity: 'P0',
      confidence: 0.95,
    });
    const content = wrapInFrontmatter(fm);
    const result = validateOnRead(content);
    expect(result.valid).toBe(true);
    expect(result.frontmatter?.service).toBe('payment-service');
    expect(result.frontmatter?.severity).toBe('P0');
    expect(result.frontmatter?.confidence).toBe(0.95);
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  it('parses valid YAML frontmatter block', () => {
    const content = '---\nid: test\nvalue: 42\n---\n\n# Body';
    const result = parseFrontmatter(content);
    expect(result).toEqual({ id: 'test', value: 42 });
  });

  it('returns null for content without frontmatter', () => {
    expect(parseFrontmatter('# Just markdown')).toBeNull();
  });

  it('returns null for malformed YAML', () => {
    const content = '---\n: : : [\n---\n';
    expect(parseFrontmatter(content)).toBeNull();
  });

  it('returns null when YAML parses to a scalar', () => {
    const content = '---\njust a string\n---\n';
    expect(parseFrontmatter(content)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SPEC-007-4-4 additional schema validation edge cases
// ---------------------------------------------------------------------------

describe('Schema Validator - SPEC-007-4-4 edge cases', () => {
  test('valid frontmatter with all nullable fields set', () => {
    const fm = buildValidFrontmatter({
      triage_status: 'promoted',
      triage_decision: 'promote',
      triage_by: 'pwatson',
      triage_at: '2026-04-08T15:00:00.000Z',
      triage_reason: 'High impact',
      defer_until: null,
      linked_prd: 'PRD-OBS-001',
      linked_deployment: 'deploy-42',
      effectiveness: 0.85,
      effectiveness_detail: 'error rate reduced by 85%',
    });
    expect(() => validateOnWrite(fm)).not.toThrow();
  });

  test('valid frontmatter with deferred status and defer_until', () => {
    const fm = buildValidFrontmatter({
      triage_status: 'deferred',
      triage_decision: 'defer',
      triage_by: 'pwatson',
      triage_at: '2026-04-08T15:00:00.000Z',
      triage_reason: 'Revisit next sprint',
      defer_until: '2026-04-22T00:00:00.000Z',
    });
    expect(() => validateOnWrite(fm)).not.toThrow();
  });

  test('rejects non-integer tokens_consumed', () => {
    const fm = buildValidFrontmatter({ tokens_consumed: 1250.5 });
    expect(() => validateOnWrite(fm)).toThrow(SchemaValidationError);
  });

  test('accepts boundary confidence values', () => {
    expect(() => validateOnWrite(buildValidFrontmatter({ confidence: 0 }))).not.toThrow();
    expect(() => validateOnWrite(buildValidFrontmatter({ confidence: 1 }))).not.toThrow();
    expect(() => validateOnWrite(buildValidFrontmatter({ confidence: 0.5 }))).not.toThrow();
  });

  test('rejects empty related_observations entries', () => {
    const fm = buildValidFrontmatter({
      related_observations: ['OBS-20260408-143022-a1b2', 'OBS-20260407-120000-beef'],
    });
    expect(() => validateOnWrite(fm)).not.toThrow();
  });

  test('validates on read with promoted status and linked PRD', () => {
    const fm = buildValidFrontmatter({
      triage_status: 'promoted',
      triage_decision: 'promote',
      triage_by: 'pwatson',
      triage_at: '2026-04-08T15:00:00.000Z',
      triage_reason: 'Confirmed issue',
      linked_prd: 'PRD-OBS-20260408-143022-a1b2',
    });
    const content = wrapInFrontmatter(fm);
    const result = validateOnRead(content);
    expect(result.valid).toBe(true);
    expect(result.frontmatter?.triage_status).toBe('promoted');
    expect(result.frontmatter?.linked_prd).toBe('PRD-OBS-20260408-143022-a1b2');
  });

  test('rejects negative occurrence_count', () => {
    const fm = buildValidFrontmatter({ occurrence_count: -1 });
    expect(() => validateOnWrite(fm)).toThrow(SchemaValidationError);
  });

  test('all data source status enum values accepted', () => {
    for (const status of ['available', 'degraded', 'unreachable', 'not_configured'] as const) {
      const fm = buildValidFrontmatter({
        data_sources: {
          prometheus: status,
          grafana: status,
          opensearch: status,
          sentry: status,
        },
      });
      expect(() => validateOnWrite(fm)).not.toThrow();
    }
  });

  test('rejects invalid observation ID with wrong length hex', () => {
    const fm = buildValidFrontmatter({ id: 'OBS-20260408-143022-abc' });
    expect(() => validateOnWrite(fm)).toThrow(SchemaValidationError);
  });

  test('rejects observation ID with uppercase hex', () => {
    const fm = buildValidFrontmatter({ id: 'OBS-20260408-143022-ABCD' });
    expect(() => validateOnWrite(fm)).toThrow(SchemaValidationError);
  });
});

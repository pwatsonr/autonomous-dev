import type {
  AuditEventType,
  AuditEvent,
  AutonomousDecisionPayload,
  VerificationResult,
  IntegrityError,
} from '../../src/audit/types';

// ---------------------------------------------------------------------------
// AuditEventType — all 17 event types
// ---------------------------------------------------------------------------

describe('AuditEventType', () => {
  const ALL_EVENT_TYPES: AuditEventType[] = [
    // Trust events (7)
    'trust_level_change_requested',
    'trust_level_changed',
    'trust_level_change_superseded',
    'trust_upgrade_confirmed',
    'trust_upgrade_rejected',
    'gate_decision',
    'security_override_rejected',
    // Escalation events (6)
    'escalation_raised',
    'escalation_timeout',
    'escalation_resolved',
    'escalation_response_received',
    'human_override',
    're_escalation_loop_detected',
    // Kill switch events (3)
    'kill_issued',
    'cancel_issued',
    'system_reenabled',
    // Decision events (1)
    'autonomous_decision',
  ];

  it('enumerates all 17 event types', () => {
    expect(ALL_EVENT_TYPES).toHaveLength(17);
  });

  it('all event types are assignable to AuditEventType', () => {
    // TypeScript compile-time check: if this file compiles, all values are valid.
    // Runtime assertion: each value is a non-empty string.
    for (const eventType of ALL_EVENT_TYPES) {
      expect(typeof eventType).toBe('string');
      expect(eventType.length).toBeGreaterThan(0);
    }
  });

  it('event types are unique', () => {
    const unique = new Set(ALL_EVENT_TYPES);
    expect(unique.size).toBe(ALL_EVENT_TYPES.length);
  });
});

// ---------------------------------------------------------------------------
// AuditEvent interface
// ---------------------------------------------------------------------------

describe('AuditEvent', () => {
  it('includes all required fields', () => {
    const event: AuditEvent = {
      event_id: '550e8400-e29b-41d4-a716-446655440000',
      event_type: 'trust_level_changed',
      timestamp: '2026-04-08T12:00:00.000Z',
      request_id: 'req-123',
      repository: 'my-repo',
      pipeline_phase: 'review',
      agent: 'trust-manager',
      payload: { from: 'low', to: 'medium' },
      hash: '',
      prev_hash: '',
    };

    expect(event.event_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(event.event_type).toBe('trust_level_changed');
    expect(event.timestamp).toBe('2026-04-08T12:00:00.000Z');
    expect(event.request_id).toBe('req-123');
    expect(event.repository).toBe('my-repo');
    expect(event.pipeline_phase).toBe('review');
    expect(event.agent).toBe('trust-manager');
    expect(event.payload).toEqual({ from: 'low', to: 'medium' });
    expect(event.hash).toBe('');
    expect(event.prev_hash).toBe('');
  });

  it('supports system-level events with default values', () => {
    const event: AuditEvent = {
      event_id: '550e8400-e29b-41d4-a716-446655440001',
      event_type: 'kill_issued',
      timestamp: '2026-04-08T12:00:00.123Z',
      request_id: 'system',
      repository: 'system',
      pipeline_phase: 'n/a',
      agent: 'kill-switch',
      payload: { reason: 'manual shutdown' },
      hash: '',
      prev_hash: '',
    };

    expect(event.request_id).toBe('system');
    expect(event.repository).toBe('system');
    expect(event.pipeline_phase).toBe('n/a');
  });
});

// ---------------------------------------------------------------------------
// AutonomousDecisionPayload
// ---------------------------------------------------------------------------

describe('AutonomousDecisionPayload', () => {
  it('includes decision, alternatives, confidence, rationale, context', () => {
    const payload: AutonomousDecisionPayload = {
      decision: 'Use strategy A',
      alternatives: ['Strategy B', 'Strategy C'],
      confidence: 0.85,
      rationale: 'Strategy A has the highest success rate in similar contexts',
      context: { past_runs: 42, success_rate: 0.92 },
    };

    expect(payload.decision).toBe('Use strategy A');
    expect(payload.alternatives).toEqual(['Strategy B', 'Strategy C']);
    expect(payload.confidence).toBe(0.85);
    expect(payload.rationale).toContain('highest success rate');
    expect(payload.context).toHaveProperty('past_runs');
  });

  it('confidence must be between 0.0 and 1.0 (convention)', () => {
    const payload: AutonomousDecisionPayload = {
      decision: 'test',
      alternatives: [],
      confidence: 0.0,
      rationale: 'test',
      context: {},
    };
    expect(payload.confidence).toBeGreaterThanOrEqual(0.0);
    expect(payload.confidence).toBeLessThanOrEqual(1.0);
  });
});

// ---------------------------------------------------------------------------
// VerificationResult and IntegrityError
// ---------------------------------------------------------------------------

describe('VerificationResult', () => {
  it('represents a valid verification with no errors', () => {
    const result: VerificationResult = {
      valid: true,
      totalEvents: 100,
      errors: [],
      chainHeadHash: 'abc123def456',
    };

    expect(result.valid).toBe(true);
    expect(result.totalEvents).toBe(100);
    expect(result.errors).toHaveLength(0);
    expect(result.chainHeadHash).toBe('abc123def456');
  });

  it('represents an invalid verification with errors', () => {
    const error: IntegrityError = {
      lineNumber: 42,
      eventId: 'evt-123',
      errorType: 'hash_mismatch',
      expected: 'aaa',
      actual: 'bbb',
      message: 'Hash mismatch at line 42',
    };

    const result: VerificationResult = {
      valid: false,
      totalEvents: 100,
      errors: [error],
      chainHeadHash: '',
    };

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].errorType).toBe('hash_mismatch');
  });
});

describe('IntegrityError', () => {
  it('supports all four error types', () => {
    const errorTypes: IntegrityError['errorType'][] = [
      'hash_mismatch',
      'prev_hash_mismatch',
      'missing_event',
      'reorder_detected',
    ];

    for (const errorType of errorTypes) {
      const error: IntegrityError = {
        lineNumber: 1,
        eventId: 'evt-1',
        errorType,
        expected: 'x',
        actual: 'y',
        message: `${errorType} detected`,
      };
      expect(error.errorType).toBe(errorType);
    }
  });
});

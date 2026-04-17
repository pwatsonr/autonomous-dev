/**
 * Tests for TypedEventBus and event types.
 *
 * Covers spec test cases 1-6:
 *   1. Event bus subscribe and emit
 *   2. Event bus type discrimination
 *   3. Event bus unsubscribe
 *   4. Event bus error isolation
 *   5. Event bus multiple subscribers
 *   6. Event bus removeAllListeners
 */

import { TypedEventBus } from '../../../intake/events/event_bus';
import type { IntakeEvent, PipelineEvent } from '../../../intake/events/event_types';
import type { RequestEntity } from '../../../intake/db/repository';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal request entity for testing. */
function makeRequest(overrides: Partial<RequestEntity> = {}): RequestEntity {
  return {
    request_id: 'REQ-000001',
    title: 'Test request',
    description: 'A test request',
    raw_input: 'test raw input',
    priority: 'normal',
    target_repo: null,
    status: 'queued',
    current_phase: 'intake',
    phase_progress: null,
    requester_id: 'user-1',
    source_channel: 'discord',
    notification_config: '{}',
    deadline: null,
    related_tickets: '[]',
    technical_constraints: null,
    acceptance_criteria: null,
    blocker: null,
    promotion_count: 0,
    last_promoted_at: null,
    paused_at_phase: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Collects error log calls for verification. */
function createMockLogger() {
  const errors: Array<{ message: string; context?: Record<string, unknown> }> = [];
  return {
    logger: {
      error: (message: string, context?: Record<string, unknown>) => {
        errors.push({ message, context });
      },
      warn: () => {},
      info: () => {},
    },
    errors,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TypedEventBus', () => {
  // --------------------------------------------------------------------------
  // Test Case 1: Event bus subscribe and emit
  // --------------------------------------------------------------------------
  test('subscribe to intake channel and emit request_submitted event', async () => {
    const bus = new TypedEventBus();
    const received: IntakeEvent[] = [];

    bus.subscribe('intake', (event) => {
      received.push(event);
    });

    const request = makeRequest();
    const event: IntakeEvent = {
      type: 'request_submitted',
      requestId: 'REQ-000001',
      request,
    };

    await bus.emit('intake', event);

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('request_submitted');
    expect(received[0]).toEqual(event);
  });

  // --------------------------------------------------------------------------
  // Test Case 2: Event bus type discrimination
  // --------------------------------------------------------------------------
  test('emitted event preserves type discriminant for pattern matching', async () => {
    const bus = new TypedEventBus();
    const received: IntakeEvent[] = [];

    bus.subscribe('intake', (event) => {
      received.push(event);
    });

    const event: IntakeEvent = {
      type: 'request_paused',
      requestId: 'REQ-000001',
    };

    await bus.emit('intake', event);

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('request_paused');

    // Verify discriminated union narrowing works at runtime
    const evt = received[0];
    if (evt.type === 'request_paused') {
      expect(evt.requestId).toBe('REQ-000001');
    } else {
      fail('Event type should be request_paused');
    }
  });

  test('pipeline events are correctly typed on the pipeline channel', async () => {
    const bus = new TypedEventBus();
    const received: PipelineEvent[] = [];

    bus.subscribe('pipeline', (event) => {
      received.push(event);
    });

    const event: PipelineEvent = {
      type: 'request_completed',
      requestId: 'REQ-000002',
      artifacts: {
        codePr: 'https://github.com/owner/repo/pull/42',
        branch: 'feature/test',
      },
    };

    await bus.emit('pipeline', event);

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('request_completed');
    if (received[0].type === 'request_completed') {
      expect(received[0].artifacts.codePr).toBe('https://github.com/owner/repo/pull/42');
      expect(received[0].artifacts.branch).toBe('feature/test');
    }
  });

  // --------------------------------------------------------------------------
  // Test Case 3: Event bus unsubscribe
  // --------------------------------------------------------------------------
  test('unsubscribe function prevents handler from receiving subsequent events', async () => {
    const bus = new TypedEventBus();
    const received: IntakeEvent[] = [];

    const unsub = bus.subscribe('intake', (event) => {
      received.push(event);
    });

    // First emit: handler should be called.
    await bus.emit('intake', {
      type: 'request_paused',
      requestId: 'REQ-000001',
    });
    expect(received).toHaveLength(1);

    // Unsubscribe.
    unsub();

    // Second emit: handler should NOT be called.
    await bus.emit('intake', {
      type: 'request_paused',
      requestId: 'REQ-000002',
    });
    expect(received).toHaveLength(1); // Still 1, not 2.
  });

  // --------------------------------------------------------------------------
  // Test Case 4: Event bus error isolation
  // --------------------------------------------------------------------------
  test('sync handler error does not crash the bus or prevent subsequent events', async () => {
    const { logger, errors } = createMockLogger();
    const bus = new TypedEventBus(logger);
    const received: IntakeEvent[] = [];

    // First handler throws.
    bus.subscribe('intake', () => {
      throw new Error('Handler exploded');
    });

    // Second handler should still work.
    bus.subscribe('intake', (event) => {
      received.push(event);
    });

    await bus.emit('intake', {
      type: 'request_paused',
      requestId: 'REQ-000001',
    });

    // The throwing handler's error was logged.
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toBe('Sync event handler error');

    // The second handler was still called.
    expect(received).toHaveLength(1);

    // Subsequent events still fire.
    await bus.emit('intake', {
      type: 'request_paused',
      requestId: 'REQ-000002',
    });
    expect(received).toHaveLength(2);
  });

  test('async handler rejection does not crash the bus', async () => {
    const { logger, errors } = createMockLogger();
    const bus = new TypedEventBus(logger);

    bus.subscribe('intake', async () => {
      throw new Error('Async handler exploded');
    });

    // Should not throw.
    await bus.emit('intake', {
      type: 'request_paused',
      requestId: 'REQ-000001',
    });

    // Give the microtask queue a tick for the async catch to fire.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toBe('Async event handler error');
  });

  // --------------------------------------------------------------------------
  // Test Case 5: Event bus multiple subscribers
  // --------------------------------------------------------------------------
  test('all three subscribers on the same channel receive the event', async () => {
    const bus = new TypedEventBus();
    const calls: number[] = [];

    bus.subscribe('intake', () => { calls.push(1); });
    bus.subscribe('intake', () => { calls.push(2); });
    bus.subscribe('intake', () => { calls.push(3); });

    await bus.emit('intake', {
      type: 'request_paused',
      requestId: 'REQ-000001',
    });

    expect(calls).toEqual([1, 2, 3]);
  });

  // --------------------------------------------------------------------------
  // Test Case 6: Event bus removeAllListeners
  // --------------------------------------------------------------------------
  test('removeAllListeners prevents all handlers from receiving events', async () => {
    const bus = new TypedEventBus();
    const intakeCalls: IntakeEvent[] = [];
    const pipelineCalls: PipelineEvent[] = [];

    bus.subscribe('intake', (e) => { intakeCalls.push(e); });
    bus.subscribe('intake', (e) => { intakeCalls.push(e); });
    bus.subscribe('pipeline', (e) => { pipelineCalls.push(e); });

    bus.removeAllListeners();

    await bus.emit('intake', {
      type: 'request_paused',
      requestId: 'REQ-000001',
    });
    await bus.emit('pipeline', {
      type: 'request_failed',
      requestId: 'REQ-000001',
      error: 'test error',
    });

    expect(intakeCalls).toHaveLength(0);
    expect(pipelineCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Type compilation tests (ensuring all IntakeEvent and PipelineEvent
// variants are constructible)
// ---------------------------------------------------------------------------

describe('IntakeEvent discriminated union', () => {
  test('covers all 8 event types', () => {
    const events: IntakeEvent[] = [
      { type: 'request_submitted', requestId: 'REQ-1', request: makeRequest() },
      { type: 'request_cancelled', requestId: 'REQ-1', cleanupRequested: true },
      { type: 'request_paused', requestId: 'REQ-1' },
      { type: 'request_resumed', requestId: 'REQ-1', resumeAtPhase: 'implementation' },
      { type: 'priority_changed', requestId: 'REQ-1', oldPriority: 'low', newPriority: 'high' },
      { type: 'feedback_received', requestId: 'REQ-1', userId: 'u1', content: 'Looks good' },
      { type: 'kill_all', initiatedBy: 'admin', timestamp: new Date() },
      {
        type: 'human_response',
        requestId: 'REQ-1',
        messageId: 'msg-1',
        response: { responderId: 'u1', content: 'yes', timestamp: new Date() },
      },
    ];

    expect(events).toHaveLength(8);

    // Verify each type discriminant is unique.
    const types = events.map((e) => e.type);
    expect(new Set(types).size).toBe(8);
  });
});

describe('PipelineEvent discriminated union', () => {
  test('covers all 5 event types', () => {
    const events: PipelineEvent[] = [
      {
        type: 'phase_transition',
        requestId: 'REQ-1',
        fromPhase: 'prd',
        toPhase: 'tdd',
        timestamp: new Date(),
        metadata: { progress: { current: 1, total: 3 } },
      },
      { type: 'blocker_detected', requestId: 'REQ-1', description: 'Tests failing' },
      {
        type: 'human_input_needed',
        requestId: 'REQ-1',
        prompt: {
          promptType: 'clarifying_question',
          requestId: 'REQ-1',
          content: 'Which API?',
          timeoutSeconds: 300,
        },
      },
      {
        type: 'request_completed',
        requestId: 'REQ-1',
        artifacts: { codePr: 'https://github.com/o/r/pull/1', branch: 'feat/x' },
      },
      { type: 'request_failed', requestId: 'REQ-1', error: 'Build failed' },
    ];

    expect(events).toHaveLength(5);

    const types = events.map((e) => e.type);
    expect(new Set(types).size).toBe(5);
  });
});

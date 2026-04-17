import { PipelineEventEmitter, PipelineEventType, EventBusListener } from '../../../src/pipeline/flow/event-emitter';
import { AuditLogger, PipelineEvent } from '../../../src/pipeline/storage/audit-logger';
import { DirectoryManager } from '../../../src/pipeline/storage/directory-manager';

/**
 * All 25 event types defined in the spec.
 */
const ALL_EVENT_TYPES: PipelineEventType[] = [
  'pipeline_created',
  'pipeline_paused',
  'pipeline_resumed',
  'pipeline_cancelled',
  'pipeline_completed',
  'pipeline_failed',
  'priority_changed',
  'document_created',
  'document_submitted_for_review',
  'review_completed',
  'document_approved',
  'document_revision_requested',
  'document_rejected',
  'revision_submitted',
  'document_cancelled',
  'document_marked_stale',
  'document_re_approved',
  'version_created',
  'rollback_executed',
  'quality_regression_detected',
  'decomposition_requested',
  'decomposition_completed',
  'cascade_initiated',
  'cascade_resolved',
  'human_escalation',
];

describe('event-emitter', () => {
  let mockAuditLogger: jest.Mocked<AuditLogger>;
  let emitter: PipelineEventEmitter;

  beforeEach(() => {
    // Create a mock AuditLogger
    const dm = new DirectoryManager('/tmp/unused');
    mockAuditLogger = new AuditLogger(dm) as jest.Mocked<AuditLogger>;

    // Mock appendEvent to return a properly structured PipelineEvent
    mockAuditLogger.appendEvent = jest.fn().mockImplementation(
      async (
        pipelineId: string,
        eventType: string,
        details: Record<string, unknown>,
        actorId: string,
        documentId?: string,
      ): Promise<PipelineEvent> => ({
        eventId: 'evt-mock-001',
        pipelineId,
        timestamp: new Date().toISOString(),
        eventType,
        documentId,
        details,
        actorId,
        previousHash: 'mock-hash',
      }),
    );

    emitter = new PipelineEventEmitter(mockAuditLogger);
  });

  it('emit writes event to audit log', async () => {
    await emitter.emit('PIPE-001', 'pipeline_created', { reason: 'test' }, 'user-1');

    expect(mockAuditLogger.appendEvent).toHaveBeenCalledWith(
      'PIPE-001',
      'pipeline_created',
      { reason: 'test' },
      'user-1',
      undefined,
    );
  });

  it('emit dispatches to registered listeners', async () => {
    const receivedEvents: PipelineEvent[] = [];
    const listener: EventBusListener = {
      onEvent: (event) => { receivedEvents.push(event); },
    };

    emitter.addListener(listener);
    await emitter.emit('PIPE-001', 'pipeline_paused', { by: 'admin' }, 'admin-1');

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].eventType).toBe('pipeline_paused');
    expect(receivedEvents[0].pipelineId).toBe('PIPE-001');
  });

  it('emit includes eventId, pipelineId, timestamp, eventType, actorId', async () => {
    const event = await emitter.emit('PIPE-001', 'document_created', {}, 'agent-1');

    expect(event.eventId).toBeDefined();
    expect(event.pipelineId).toBe('PIPE-001');
    expect(event.timestamp).toBeDefined();
    expect(event.eventType).toBe('document_created');
    expect(event.actorId).toBe('agent-1');
  });

  it('emit includes documentId when provided', async () => {
    const event = await emitter.emit(
      'PIPE-001',
      'document_approved',
      { score: 95 },
      'reviewer-1',
      'PRD-001',
    );

    expect(event.documentId).toBe('PRD-001');
    expect(mockAuditLogger.appendEvent).toHaveBeenCalledWith(
      'PIPE-001',
      'document_approved',
      { score: 95 },
      'reviewer-1',
      'PRD-001',
    );
  });

  it('listener error does not prevent other listeners from receiving event', async () => {
    const received: string[] = [];

    const failingListener: EventBusListener = {
      onEvent: () => { throw new Error('listener failure'); },
    };

    const successListener: EventBusListener = {
      onEvent: (event) => { received.push(event.eventType); },
    };

    emitter.addListener(failingListener);
    emitter.addListener(successListener);

    // Should not throw despite the failing listener
    await emitter.emit('PIPE-001', 'pipeline_resumed', {}, 'user-1');

    expect(received).toEqual(['pipeline_resumed']);
  });

  it('listener async error does not prevent other listeners from receiving event', async () => {
    const received: string[] = [];

    const failingListener: EventBusListener = {
      onEvent: async () => { throw new Error('async listener failure'); },
    };

    const successListener: EventBusListener = {
      onEvent: (event) => { received.push(event.eventType); },
    };

    emitter.addListener(failingListener);
    emitter.addListener(successListener);

    await emitter.emit('PIPE-001', 'cascade_initiated', {}, 'system');

    expect(received).toEqual(['cascade_initiated']);
  });

  describe('addListener/removeListener', () => {
    it('addListener registers a listener', async () => {
      const events: PipelineEvent[] = [];
      const listener: EventBusListener = {
        onEvent: (event) => { events.push(event); },
      };

      emitter.addListener(listener);
      await emitter.emit('PIPE-001', 'pipeline_created', {}, 'user-1');

      expect(events).toHaveLength(1);
    });

    it('removeListener unregisters a listener', async () => {
      const events: PipelineEvent[] = [];
      const listener: EventBusListener = {
        onEvent: (event) => { events.push(event); },
      };

      emitter.addListener(listener);
      emitter.removeListener(listener);
      await emitter.emit('PIPE-001', 'pipeline_created', {}, 'user-1');

      expect(events).toHaveLength(0);
    });

    it('removeListener on non-existent listener is a no-op', () => {
      const listener: EventBusListener = {
        onEvent: () => {},
      };

      // Should not throw
      expect(() => emitter.removeListener(listener)).not.toThrow();
    });

    it('multiple listeners all receive events', async () => {
      const received1: string[] = [];
      const received2: string[] = [];

      emitter.addListener({ onEvent: (e) => { received1.push(e.eventType); } });
      emitter.addListener({ onEvent: (e) => { received2.push(e.eventType); } });

      await emitter.emit('PIPE-001', 'human_escalation', {}, 'system');

      expect(received1).toEqual(['human_escalation']);
      expect(received2).toEqual(['human_escalation']);
    });
  });

  it('PipelineEventType has 25 values', () => {
    // Verify we have exactly 25 distinct event types
    const uniqueTypes = new Set(ALL_EVENT_TYPES);
    expect(uniqueTypes.size).toBe(25);
    expect(ALL_EVENT_TYPES).toHaveLength(25);
  });

  it('all 25 event types can be emitted', async () => {
    const emittedTypes: string[] = [];
    emitter.addListener({
      onEvent: (event) => { emittedTypes.push(event.eventType); },
    });

    for (const eventType of ALL_EVENT_TYPES) {
      await emitter.emit('PIPE-001', eventType, {}, 'test-actor');
    }

    expect(emittedTypes).toHaveLength(25);
    expect(new Set(emittedTypes).size).toBe(25);
  });
});

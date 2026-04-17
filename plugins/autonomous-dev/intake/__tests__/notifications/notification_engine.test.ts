/**
 * Unit tests for NotificationEngine (SPEC-008-5-01, Tasks 1-4).
 *
 * Covers all 17 test cases from the spec:
 * 1.  Verbosity: silent -> no adapter sendMessage call
 * 2.  Verbosity: summary + phase transition -> sendMessage called
 * 3.  Verbosity: summary + sub-step event -> sendMessage NOT called
 * 4.  Verbosity: verbose + sub-step -> sendMessage called
 * 5.  Verbosity: default (no verbosity set) -> behaves as summary
 * 6.  Routing: single route to discord channel X
 * 7.  Routing: multiple routes to discord and slack
 * 8.  Routing: cross-channel (claude_app -> discord)
 * 9.  Routing: phase filter skips non-matching events
 * 10. Routing: default fallback to source channel
 * 11. Retry: success on second attempt
 * 12. Retry: max retries exhausted
 * 13. Retry: non-retryable failure
 * 14. Retry: backoff timing
 * 15. Deduplication: same payload hash skipped
 * 16. Missing adapter: warning logged, no crash
 * 17. Activity log: correct fields after delivery
 *
 * @module notification_engine.test
 */

import type { RequestEntity, NotificationDelivery, ActivityLogEntry } from '../../db/repository';
import type {
  ChannelType,
  IntakeAdapter,
  AdapterHandle,
  MessageTarget,
  FormattedMessage,
  StructuredPrompt,
  UserResponse,
  TimeoutExpired,
  DeliveryReceipt,
  VerbosityLevel,
} from '../../adapters/adapter_interface';
import type {
  PhaseTransitionEvent,
  NotificationFormatter,
} from '../../notifications/formatters/cli_formatter';
import {
  NotificationEngine,
  type NotificationLogger,
} from '../../notifications/notification_engine';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a minimal RequestEntity for testing. */
function makeRequest(overrides: Partial<RequestEntity> = {}): RequestEntity {
  return {
    request_id: 'REQ-000042',
    title: 'Build user auth with OAuth2',
    description: 'Implement full OAuth2 authentication flow',
    raw_input: 'Build user auth with OAuth2',
    priority: 'high',
    target_repo: 'owner/repo',
    status: 'active',
    current_phase: 'tdd_generation',
    phase_progress: JSON.stringify({ current: 3, total: 8 }),
    requester_id: 'user-1',
    source_channel: 'claude_app',
    notification_config: JSON.stringify({ verbosity: 'summary', routes: [] }),
    deadline: null,
    related_tickets: '[]',
    technical_constraints: null,
    acceptance_criteria: null,
    blocker: null,
    promotion_count: 0,
    last_promoted_at: null,
    paused_at_phase: null,
    created_at: new Date(Date.now() - 8_040_000).toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a phase transition event. */
function makePhaseTransitionEvent(overrides: Partial<PhaseTransitionEvent> = {}): PhaseTransitionEvent {
  return {
    requestId: 'REQ-000042',
    fromPhase: 'prd_review',
    toPhase: 'tdd_generation',
    timestamp: new Date(),
    metadata: {},
    ...overrides,
  };
}

/** Create a mock IntakeAdapter. */
function makeMockAdapter(channelType: ChannelType): IntakeAdapter & { sendMessageCalls: Array<{ target: MessageTarget; payload: FormattedMessage }> } {
  const calls: Array<{ target: MessageTarget; payload: FormattedMessage }> = [];
  return {
    channelType,
    sendMessageCalls: calls,
    async start(): Promise<AdapterHandle> {
      return { dispose: async () => {} };
    },
    async sendMessage(target: MessageTarget, payload: FormattedMessage): Promise<DeliveryReceipt> {
      calls.push({ target, payload });
      return { success: true, platformMessageId: 'msg-123' };
    },
    async promptUser(_target: MessageTarget, _prompt: StructuredPrompt): Promise<UserResponse | TimeoutExpired> {
      return { kind: 'timeout', requestId: '', promptedAt: new Date(), expiredAt: new Date() };
    },
    async shutdown(): Promise<void> {},
  };
}

/** Create a mock NotificationFormatter. */
function makeMockFormatter(channelType: ChannelType): NotificationFormatter & { formatCalls: number } {
  const tracker = { formatCalls: 0 };
  return {
    get formatCalls() { return tracker.formatCalls; },
    formatStatusCard(_request: RequestEntity): FormattedMessage {
      return { channelType, payload: 'status-card', fallbackText: 'status-card' };
    },
    formatPhaseTransition(_request: RequestEntity, _event: PhaseTransitionEvent): FormattedMessage {
      tracker.formatCalls++;
      return { channelType, payload: 'phase-transition', fallbackText: 'phase-transition' };
    },
    formatDigest(): FormattedMessage {
      return { channelType, payload: 'digest', fallbackText: 'digest' };
    },
    formatError(): FormattedMessage {
      return { channelType, payload: 'error', fallbackText: 'error' };
    },
  };
}

/** Create a mock Repository. */
function makeMockDb(request?: RequestEntity) {
  const activityLogs: ActivityLogEntry[] = [];
  const deliveries: NotificationDelivery[] = [];

  return {
    activityLogs,
    deliveries,
    getRequest(_requestId: string): RequestEntity | null {
      return request ?? null;
    },
    insertActivityLog(entry: ActivityLogEntry): void {
      activityLogs.push(entry);
    },
    insertDelivery(delivery: NotificationDelivery): number {
      const id = deliveries.length + 1;
      deliveries.push({ ...delivery, delivery_id: id });
      return id;
    },
    updateDeliveryStatus(deliveryId: number, status: string, error?: string): void {
      const d = deliveries.find(d => d.delivery_id === deliveryId);
      if (d) {
        d.status = status as 'pending' | 'delivered' | 'failed';
        d.attempts = (d.attempts ?? 0) + 1;
        if (error) d.last_error = error;
        if (status === 'delivered') d.delivered_at = new Date().toISOString();
      }
    },
    findDuplicateDelivery(_requestId: string, _payloadHash: string): NotificationDelivery | null {
      return null;
    },
  };
}

/** Create a mock logger that collects warnings. */
function makeMockLogger(): NotificationLogger & { warnings: Array<{ message: string; context?: Record<string, unknown> }> } {
  const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
  return {
    warnings,
    error(_message: string, _context?: Record<string, unknown>) {},
    warn(message: string, context?: Record<string, unknown>) {
      warnings.push({ message, context });
    },
    info(_message: string, _context?: Record<string, unknown>) {},
    debug(_message: string, _context?: Record<string, unknown>) {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotificationEngine (SPEC-008-5-01)', () => {
  // =========================================================================
  // Task 2: Verbosity filtering tests
  // =========================================================================

  describe('Task 2: Verbosity filtering', () => {
    // Test 1: silent verbosity -> no adapter sendMessage call
    test('silent verbosity produces zero notifications', async () => {
      const request = makeRequest({
        notification_config: JSON.stringify({ verbosity: 'silent', routes: [] }),
      });
      const db = makeMockDb(request);
      const discordAdapter = makeMockAdapter('discord');
      const discordFormatter = makeMockFormatter('discord');

      const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
      const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);

      const engine = new NotificationEngine(db as any, adapters, formatters);
      const event = makePhaseTransitionEvent();

      await engine.onPhaseTransition(event);

      expect(discordAdapter.sendMessageCalls.length).toBe(0);
    });

    // Test 2: summary verbosity + phase transition -> sendMessage called
    test('summary verbosity notifies on phase transitions', async () => {
      const request = makeRequest({
        source_channel: 'discord',
        notification_config: JSON.stringify({ verbosity: 'summary', routes: [] }),
      });
      const db = makeMockDb(request);
      const discordAdapter = makeMockAdapter('discord');
      const discordFormatter = makeMockFormatter('discord');

      const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
      const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);

      const engine = new NotificationEngine(db as any, adapters, formatters);
      const event = makePhaseTransitionEvent();

      await engine.onPhaseTransition(event);

      expect(discordAdapter.sendMessageCalls.length).toBe(1);
    });

    // Test 3: summary verbosity + sub-step event -> sendMessage NOT called
    test('summary verbosity does not notify on sub-step events', () => {
      const engine = new NotificationEngine(makeMockDb() as any, new Map(), new Map());
      const subStepEvent = { type: 'sub_step_progress' };

      expect(engine.shouldNotify('summary', subStepEvent)).toBe(false);
    });

    // Test 4: verbose verbosity + sub-step -> sendMessage called
    test('verbose verbosity notifies on sub-step events', () => {
      const engine = new NotificationEngine(makeMockDb() as any, new Map(), new Map());
      const subStepEvent = { type: 'sub_step_progress' };

      expect(engine.shouldNotify('verbose', subStepEvent)).toBe(true);
    });

    // Test 5: no verbosity set -> behaves as summary
    test('default verbosity (no config) behaves as summary', async () => {
      const request = makeRequest({
        source_channel: 'discord',
        notification_config: '{}', // no verbosity set
      });
      const db = makeMockDb(request);
      const discordAdapter = makeMockAdapter('discord');
      const discordFormatter = makeMockFormatter('discord');

      const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
      const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);

      const engine = new NotificationEngine(db as any, adapters, formatters);
      const event = makePhaseTransitionEvent();

      await engine.onPhaseTransition(event);

      // Phase transitions are summary-level -> should be sent
      expect(discordAdapter.sendMessageCalls.length).toBe(1);
    });

    test('shouldNotify returns true for phase_transition at summary level', () => {
      const engine = new NotificationEngine(makeMockDb() as any, new Map(), new Map());
      expect(engine.shouldNotify('summary', { type: 'phase_transition' })).toBe(true);
    });

    test('shouldNotify returns true for request_completed at summary level', () => {
      const engine = new NotificationEngine(makeMockDb() as any, new Map(), new Map());
      expect(engine.shouldNotify('summary', { type: 'request_completed' })).toBe(true);
    });

    test('shouldNotify returns true for request_failed at summary level', () => {
      const engine = new NotificationEngine(makeMockDb() as any, new Map(), new Map());
      expect(engine.shouldNotify('summary', { type: 'request_failed' })).toBe(true);
    });

    test('shouldNotify returns true for blocker_detected at summary level', () => {
      const engine = new NotificationEngine(makeMockDb() as any, new Map(), new Map());
      expect(engine.shouldNotify('summary', { type: 'blocker_detected' })).toBe(true);
    });

    test('debug verbosity notifies on everything', () => {
      const engine = new NotificationEngine(makeMockDb() as any, new Map(), new Map());
      expect(engine.shouldNotify('debug', { type: 'sub_step_progress' })).toBe(true);
      expect(engine.shouldNotify('debug', { type: 'agent_reasoning' })).toBe(true);
      expect(engine.shouldNotify('debug', { type: 'phase_transition' })).toBe(true);
    });
  });

  // =========================================================================
  // Task 3: Notification routing tests
  // =========================================================================

  describe('Task 3: Notification routing', () => {
    // Test 6: single route to discord channel X
    test('single route routes to specified discord channel', async () => {
      const request = makeRequest({
        source_channel: 'claude_app',
        notification_config: JSON.stringify({
          verbosity: 'summary',
          routes: [{ channelType: 'discord', platformChannelId: 'channel-X' }],
        }),
      });
      const db = makeMockDb(request);
      const discordAdapter = makeMockAdapter('discord');
      const discordFormatter = makeMockFormatter('discord');

      const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
      const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);

      const engine = new NotificationEngine(db as any, adapters, formatters);
      const event = makePhaseTransitionEvent();

      await engine.onPhaseTransition(event);

      expect(discordAdapter.sendMessageCalls.length).toBe(1);
      expect(discordAdapter.sendMessageCalls[0].target.platformChannelId).toBe('channel-X');
    });

    // Test 7: multiple routes to discord and slack
    test('multiple routes notify all specified channels', async () => {
      const request = makeRequest({
        source_channel: 'claude_app',
        notification_config: JSON.stringify({
          verbosity: 'summary',
          routes: [
            { channelType: 'discord', platformChannelId: 'discord-ch' },
            { channelType: 'slack', platformChannelId: 'slack-ch' },
          ],
        }),
      });
      const db = makeMockDb(request);
      const discordAdapter = makeMockAdapter('discord');
      const slackAdapter = makeMockAdapter('slack');
      const discordFormatter = makeMockFormatter('discord');
      const slackFormatter = makeMockFormatter('slack');

      const adapters = new Map<ChannelType, IntakeAdapter>([
        ['discord', discordAdapter],
        ['slack', slackAdapter],
      ]);
      const formatters = new Map<ChannelType, NotificationFormatter>([
        ['discord', discordFormatter],
        ['slack', slackFormatter],
      ]);

      const engine = new NotificationEngine(db as any, adapters, formatters);
      const event = makePhaseTransitionEvent();

      await engine.onPhaseTransition(event);

      expect(discordAdapter.sendMessageCalls.length).toBe(1);
      expect(slackAdapter.sendMessageCalls.length).toBe(1);
    });

    // Test 8: cross-channel routing (claude_app source -> discord route)
    test('cross-channel routing: claude_app request routes to discord', async () => {
      const request = makeRequest({
        source_channel: 'claude_app',
        notification_config: JSON.stringify({
          verbosity: 'summary',
          routes: [{ channelType: 'discord', platformChannelId: 'discord-ch' }],
        }),
      });
      const db = makeMockDb(request);
      const claudeAdapter = makeMockAdapter('claude_app');
      const discordAdapter = makeMockAdapter('discord');
      const claudeFormatter = makeMockFormatter('claude_app');
      const discordFormatter = makeMockFormatter('discord');

      const adapters = new Map<ChannelType, IntakeAdapter>([
        ['claude_app', claudeAdapter],
        ['discord', discordAdapter],
      ]);
      const formatters = new Map<ChannelType, NotificationFormatter>([
        ['claude_app', claudeFormatter],
        ['discord', discordFormatter],
      ]);

      const engine = new NotificationEngine(db as any, adapters, formatters);
      const event = makePhaseTransitionEvent();

      await engine.onPhaseTransition(event);

      // Discord adapter should be called, NOT claude adapter
      expect(discordAdapter.sendMessageCalls.length).toBe(1);
      expect(claudeAdapter.sendMessageCalls.length).toBe(0);
    });

    // Test 9: phase filter skips non-matching events
    test('route with events filter skips non-matching phases', async () => {
      const request = makeRequest({
        source_channel: 'claude_app',
        notification_config: JSON.stringify({
          verbosity: 'summary',
          routes: [{ channelType: 'discord', platformChannelId: 'ch-1', events: ['execution'] }],
        }),
      });
      const db = makeMockDb(request);
      const discordAdapter = makeMockAdapter('discord');
      const discordFormatter = makeMockFormatter('discord');

      const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
      const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);

      const engine = new NotificationEngine(db as any, adapters, formatters);
      // Event transitions to tdd_review, but the route only wants 'execution'
      const event = makePhaseTransitionEvent({ toPhase: 'tdd_review' });

      await engine.onPhaseTransition(event);

      expect(discordAdapter.sendMessageCalls.length).toBe(0);
    });

    test('route with events filter allows matching phases', async () => {
      const request = makeRequest({
        source_channel: 'claude_app',
        notification_config: JSON.stringify({
          verbosity: 'summary',
          routes: [{ channelType: 'discord', platformChannelId: 'ch-1', events: ['execution'] }],
        }),
      });
      const db = makeMockDb(request);
      const discordAdapter = makeMockAdapter('discord');
      const discordFormatter = makeMockFormatter('discord');

      const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
      const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);

      const engine = new NotificationEngine(db as any, adapters, formatters);
      const event = makePhaseTransitionEvent({ toPhase: 'execution' });

      await engine.onPhaseTransition(event);

      expect(discordAdapter.sendMessageCalls.length).toBe(1);
    });

    // Test 10: default fallback to source channel
    test('no routes configured -> notification sent to source channel', async () => {
      const request = makeRequest({
        source_channel: 'slack',
        notification_config: JSON.stringify({ verbosity: 'summary', routes: [] }),
      });
      const db = makeMockDb(request);
      const slackAdapter = makeMockAdapter('slack');
      const slackFormatter = makeMockFormatter('slack');

      const adapters = new Map<ChannelType, IntakeAdapter>([['slack', slackAdapter]]);
      const formatters = new Map<ChannelType, NotificationFormatter>([['slack', slackFormatter]]);

      const engine = new NotificationEngine(db as any, adapters, formatters);
      const event = makePhaseTransitionEvent();

      await engine.onPhaseTransition(event);

      expect(slackAdapter.sendMessageCalls.length).toBe(1);
      expect(slackAdapter.sendMessageCalls[0].target.channelType).toBe('slack');
    });
  });

  // =========================================================================
  // Task 4: Delivery with retry tests
  // =========================================================================

  describe('Task 4: Delivery with retry', () => {
    // Test 11: success on second attempt
    test('retryable failure on first attempt, success on second -> delivered', async () => {
      const request = makeRequest({
        source_channel: 'discord',
        notification_config: JSON.stringify({ verbosity: 'summary', routes: [] }),
      });
      const db = makeMockDb(request);
      const discordAdapter = makeMockAdapter('discord');
      const discordFormatter = makeMockFormatter('discord');

      let callCount = 0;
      discordAdapter.sendMessage = async (target: MessageTarget, payload: FormattedMessage): Promise<DeliveryReceipt> => {
        discordAdapter.sendMessageCalls.push({ target, payload });
        callCount++;
        if (callCount === 1) {
          return { success: false, retryable: true, error: 'Temporary failure' };
        }
        return { success: true, platformMessageId: 'msg-456' };
      };

      const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
      const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);

      const engine = new NotificationEngine(db as any, adapters, formatters);
      const message: FormattedMessage = { channelType: 'discord', payload: 'test', fallbackText: 'test' };
      const target: MessageTarget = { channelType: 'discord', platformChannelId: 'ch-1' };

      await engine.deliverWithRetry(discordAdapter, target, message, 'REQ-000042', 3);

      expect(callCount).toBe(2);
      expect(db.deliveries[0].status).toBe('delivered');
    });

    // Test 12: max retries exhausted
    test('all retries fail -> delivery status is failed with activity log entry', async () => {
      const request = makeRequest();
      const db = makeMockDb(request);
      const discordAdapter = makeMockAdapter('discord');

      let callCount = 0;
      discordAdapter.sendMessage = async (target: MessageTarget, payload: FormattedMessage): Promise<DeliveryReceipt> => {
        discordAdapter.sendMessageCalls.push({ target, payload });
        callCount++;
        return { success: false, retryable: true, error: 'Service unavailable' };
      };

      const engine = new NotificationEngine(db as any, new Map(), new Map());
      const message: FormattedMessage = { channelType: 'discord', payload: 'test', fallbackText: 'test' };
      const target: MessageTarget = { channelType: 'discord', platformChannelId: 'ch-1' };

      await engine.deliverWithRetry(discordAdapter, target, message, 'REQ-000042', 3);

      // 1 initial + 3 retries = 4 attempts total
      expect(callCount).toBe(4);
      expect(db.deliveries[0].status).toBe('failed');
    }, 30_000);

    // Test 13: non-retryable failure -> immediately failed, no retry
    test('non-retryable failure -> single call, delivery status failed', async () => {
      const request = makeRequest();
      const db = makeMockDb(request);
      const discordAdapter = makeMockAdapter('discord');

      let callCount = 0;
      discordAdapter.sendMessage = async (target: MessageTarget, payload: FormattedMessage): Promise<DeliveryReceipt> => {
        discordAdapter.sendMessageCalls.push({ target, payload });
        callCount++;
        return { success: false, retryable: false, error: 'Channel not found' };
      };

      const engine = new NotificationEngine(db as any, new Map(), new Map());
      const message: FormattedMessage = { channelType: 'discord', payload: 'test', fallbackText: 'test' };
      const target: MessageTarget = { channelType: 'discord', platformChannelId: 'ch-1' };

      await engine.deliverWithRetry(discordAdapter, target, message, 'REQ-000042', 3);

      expect(callCount).toBe(1);
      expect(db.deliveries[0].status).toBe('failed');
      // Activity log should record the failure
      expect(db.activityLogs.some(l => l.event === 'notification_failed')).toBe(true);
    });

    // Test 14: backoff timing
    test('retry delays follow exponential backoff (1s, 2s, 4s)', async () => {
      const request = makeRequest();
      const db = makeMockDb(request);
      const discordAdapter = makeMockAdapter('discord');

      const timestamps: number[] = [];
      discordAdapter.sendMessage = async (target: MessageTarget, payload: FormattedMessage): Promise<DeliveryReceipt> => {
        discordAdapter.sendMessageCalls.push({ target, payload });
        timestamps.push(Date.now());
        return { success: false, retryable: true, error: 'Temporary failure' };
      };

      const engine = new NotificationEngine(db as any, new Map(), new Map());
      const message: FormattedMessage = { channelType: 'discord', payload: 'test', fallbackText: 'test' };
      const target: MessageTarget = { channelType: 'discord', platformChannelId: 'ch-1' };

      await engine.deliverWithRetry(discordAdapter, target, message, 'REQ-000042', 3);

      // Verify 4 attempts total
      expect(timestamps.length).toBe(4);

      // Check delays with tolerance (500ms)
      const delay1 = timestamps[1] - timestamps[0];
      const delay2 = timestamps[2] - timestamps[1];
      const delay3 = timestamps[3] - timestamps[2];

      expect(delay1).toBeGreaterThanOrEqual(800);
      expect(delay1).toBeLessThan(2000);

      expect(delay2).toBeGreaterThanOrEqual(1800);
      expect(delay2).toBeLessThan(3000);

      expect(delay3).toBeGreaterThanOrEqual(3800);
      expect(delay3).toBeLessThan(5000);
    }, 30_000);

    // Test 15: deduplication
    test('duplicate notification with same payload hash is skipped', async () => {
      const request = makeRequest();
      const db = makeMockDb(request);

      // Override findDuplicateDelivery to return a delivered entry
      db.findDuplicateDelivery = (_requestId: string, _payloadHash: string): NotificationDelivery | null => {
        return {
          delivery_id: 1,
          request_id: 'REQ-000042',
          channel_type: 'discord',
          target: '{}',
          payload_hash: 'abc123',
          status: 'delivered',
          attempts: 1,
          last_error: null,
          delivered_at: new Date().toISOString(),
        };
      };

      const discordAdapter = makeMockAdapter('discord');
      const engine = new NotificationEngine(db as any, new Map(), new Map());
      const message: FormattedMessage = { channelType: 'discord', payload: 'test', fallbackText: 'test' };
      const target: MessageTarget = { channelType: 'discord', platformChannelId: 'ch-1' };

      await engine.deliverWithRetry(discordAdapter, target, message, 'REQ-000042');

      expect(discordAdapter.sendMessageCalls.length).toBe(0);
      // No new delivery record inserted
      expect(db.deliveries.length).toBe(0);
    });

    // Test: exception on all retries -> delivery marked failed
    test('exceptions during delivery exhaust retries and mark failed', async () => {
      const request = makeRequest();
      const db = makeMockDb(request);
      const discordAdapter = makeMockAdapter('discord');

      let callCount = 0;
      discordAdapter.sendMessage = async (): Promise<DeliveryReceipt> => {
        callCount++;
        throw new Error('Connection refused');
      };

      const engine = new NotificationEngine(db as any, new Map(), new Map());
      const message: FormattedMessage = { channelType: 'discord', payload: 'test', fallbackText: 'test' };
      const target: MessageTarget = { channelType: 'discord', platformChannelId: 'ch-1' };

      await engine.deliverWithRetry(discordAdapter, target, message, 'REQ-000042', 3);

      expect(callCount).toBe(4);
      expect(db.deliveries[0].status).toBe('failed');
      expect(db.deliveries[0].last_error).toBe('Connection refused');
    }, 30_000);
  });

  // =========================================================================
  // Graceful handling tests
  // =========================================================================

  describe('Graceful handling', () => {
    // Test 16: missing adapter -> warning logged, no crash
    test('missing adapter logs warning and does not crash', async () => {
      const request = makeRequest({
        source_channel: 'discord',
        notification_config: JSON.stringify({
          verbosity: 'summary',
          routes: [{ channelType: 'discord', platformChannelId: 'ch-1' }],
        }),
      });
      const db = makeMockDb(request);
      const logger = makeMockLogger();

      // Register formatter for discord but NO adapter
      const discordFormatter = makeMockFormatter('discord');
      const adapters = new Map<ChannelType, IntakeAdapter>(); // empty -- no adapter
      const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);

      const engine = new NotificationEngine(db as any, adapters, formatters, logger);
      const event = makePhaseTransitionEvent();

      // Should not throw
      await engine.onPhaseTransition(event);

      expect(logger.warnings.some(w => w.message === 'Adapter unavailable for channel type')).toBe(true);
    });

    test('missing formatter logs warning and does not crash', async () => {
      const request = makeRequest({
        source_channel: 'discord',
        notification_config: JSON.stringify({
          verbosity: 'summary',
          routes: [{ channelType: 'discord', platformChannelId: 'ch-1' }],
        }),
      });
      const db = makeMockDb(request);
      const logger = makeMockLogger();

      // Register adapter for discord but NO formatter
      const discordAdapter = makeMockAdapter('discord');
      const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
      const formatters = new Map<ChannelType, NotificationFormatter>(); // empty

      const engine = new NotificationEngine(db as any, adapters, formatters, logger);
      const event = makePhaseTransitionEvent();

      await engine.onPhaseTransition(event);

      expect(logger.warnings.some(w => w.message === 'No formatter for channel type')).toBe(true);
      expect(discordAdapter.sendMessageCalls.length).toBe(0);
    });

    test('unknown request is handled gracefully', async () => {
      const db = makeMockDb(); // no request
      const logger = makeMockLogger();

      const engine = new NotificationEngine(db as any, new Map(), new Map(), logger);
      const event = makePhaseTransitionEvent({ requestId: 'REQ-UNKNOWN' });

      await engine.onPhaseTransition(event);

      expect(logger.warnings.some(w => w.message === 'Notification for unknown request')).toBe(true);
    });
  });

  // =========================================================================
  // Activity log tests
  // =========================================================================

  describe('Activity log', () => {
    // Test 17: activity log after delivery
    test('activity log entry created with correct fields after delivery', async () => {
      const request = makeRequest({
        source_channel: 'discord',
        notification_config: JSON.stringify({ verbosity: 'summary', routes: [] }),
      });
      const db = makeMockDb(request);
      const discordAdapter = makeMockAdapter('discord');
      const discordFormatter = makeMockFormatter('discord');

      const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
      const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);

      const engine = new NotificationEngine(db as any, adapters, formatters);
      const event = makePhaseTransitionEvent({ toPhase: 'execution' });

      await engine.onPhaseTransition(event);

      // Expect at least one activity log entry for notification_sent
      const sentLog = db.activityLogs.find(l => l.event === 'notification_sent');
      expect(sentLog).toBeDefined();
      expect(sentLog!.request_id).toBe('REQ-000042');
      expect(sentLog!.phase).toBe('execution');
      const details = JSON.parse(sentLog!.details);
      expect(details.targets).toContain('discord');
    });
  });

  // =========================================================================
  // Additional event handler tests
  // =========================================================================

  describe('Additional event handlers', () => {
    test('onBlockerDetected notifies on blocker event', async () => {
      const request = makeRequest({
        source_channel: 'discord',
        notification_config: JSON.stringify({ verbosity: 'summary', routes: [] }),
      });
      const db = makeMockDb(request);
      const discordAdapter = makeMockAdapter('discord');
      const discordFormatter = makeMockFormatter('discord');

      const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
      const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);

      const engine = new NotificationEngine(db as any, adapters, formatters);

      await engine.onBlockerDetected('REQ-000042', 'API credentials missing');

      expect(discordAdapter.sendMessageCalls.length).toBe(1);
      const sentLog = db.activityLogs.find(l => l.event === 'blocker_detected');
      expect(sentLog).toBeDefined();
    });

    test('onRequestCompleted notifies on completion', async () => {
      const request = makeRequest({
        source_channel: 'discord',
        notification_config: JSON.stringify({ verbosity: 'summary', routes: [] }),
      });
      const db = makeMockDb(request);
      const discordAdapter = makeMockAdapter('discord');
      const discordFormatter = makeMockFormatter('discord');

      const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
      const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);

      const engine = new NotificationEngine(db as any, adapters, formatters);

      await engine.onRequestCompleted('REQ-000042', {
        codePr: 'https://github.com/owner/repo/pull/42',
        branch: 'feat/oauth2',
      });

      expect(discordAdapter.sendMessageCalls.length).toBe(1);
      const sentLog = db.activityLogs.find(l => l.event === 'request_completed');
      expect(sentLog).toBeDefined();
    });

    test('onRequestFailed notifies on failure', async () => {
      const request = makeRequest({
        source_channel: 'discord',
        notification_config: JSON.stringify({ verbosity: 'summary', routes: [] }),
      });
      const db = makeMockDb(request);
      const discordAdapter = makeMockAdapter('discord');
      const discordFormatter = makeMockFormatter('discord');

      const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
      const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);

      const engine = new NotificationEngine(db as any, adapters, formatters);

      await engine.onRequestFailed('REQ-000042', 'Pipeline timeout after 6h');

      expect(discordAdapter.sendMessageCalls.length).toBe(1);
      const sentLog = db.activityLogs.find(l => l.event === 'request_failed');
      expect(sentLog).toBeDefined();
    });

    test('onBlockerDetected with silent verbosity produces no notification', async () => {
      const request = makeRequest({
        notification_config: JSON.stringify({ verbosity: 'silent', routes: [] }),
      });
      const db = makeMockDb(request);
      const discordAdapter = makeMockAdapter('discord');
      const discordFormatter = makeMockFormatter('discord');

      const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
      const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);

      const engine = new NotificationEngine(db as any, adapters, formatters);

      await engine.onBlockerDetected('REQ-000042', 'API credentials missing');

      expect(discordAdapter.sendMessageCalls.length).toBe(0);
    });
  });

  // =========================================================================
  // Payload hash computation
  // =========================================================================

  describe('computePayloadHash', () => {
    test('produces consistent SHA-256 hash for same input', () => {
      const engine = new NotificationEngine(makeMockDb() as any, new Map(), new Map());
      const msg: FormattedMessage = { channelType: 'discord', payload: 'test-payload', fallbackText: 'test' };

      const hash1 = engine.computePayloadHash(msg);
      const hash2 = engine.computePayloadHash(msg);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });

    test('produces different hashes for different inputs', () => {
      const engine = new NotificationEngine(makeMockDb() as any, new Map(), new Map());
      const msg1: FormattedMessage = { channelType: 'discord', payload: 'payload-1', fallbackText: 'test' };
      const msg2: FormattedMessage = { channelType: 'discord', payload: 'payload-2', fallbackText: 'test' };

      expect(engine.computePayloadHash(msg1)).not.toBe(engine.computePayloadHash(msg2));
    });
  });

  // =========================================================================
  // resolveTargets unit tests
  // =========================================================================

  describe('resolveTargets', () => {
    test('returns source channel when no routes configured', () => {
      const request = makeRequest({ source_channel: 'slack' });
      const config = { verbosity: 'summary' as VerbosityLevel, routes: [] };

      const engine = new NotificationEngine(makeMockDb() as any, new Map(), new Map());
      const targets = engine.resolveTargets(request, config);

      expect(targets.length).toBe(1);
      expect(targets[0].channelType).toBe('slack');
    });

    test('returns all configured routes', () => {
      const request = makeRequest();
      const config = {
        verbosity: 'summary' as VerbosityLevel,
        routes: [
          { channelType: 'discord' as ChannelType, platformChannelId: 'ch-1' },
          { channelType: 'slack' as ChannelType, platformChannelId: 'ch-2' },
        ],
      };

      const engine = new NotificationEngine(makeMockDb() as any, new Map(), new Map());
      const targets = engine.resolveTargets(request, config);

      expect(targets.length).toBe(2);
      expect(targets[0].channelType).toBe('discord');
      expect(targets[1].channelType).toBe('slack');
    });

    test('filters routes by event type', () => {
      const request = makeRequest();
      const config = {
        verbosity: 'summary' as VerbosityLevel,
        routes: [
          { channelType: 'discord' as ChannelType, platformChannelId: 'ch-1', events: ['execution'] },
          { channelType: 'slack' as ChannelType, platformChannelId: 'ch-2' }, // no filter
        ],
      };

      const engine = new NotificationEngine(makeMockDb() as any, new Map(), new Map());
      const event = { type: 'phase_transition', toPhase: 'tdd_review' };
      const targets = engine.resolveTargets(request, config, event);

      // Discord route should be filtered out (wants 'execution', got 'tdd_review')
      expect(targets.length).toBe(1);
      expect(targets[0].channelType).toBe('slack');
    });

    test('preserves threadId from route config', () => {
      const request = makeRequest();
      const config = {
        verbosity: 'summary' as VerbosityLevel,
        routes: [
          { channelType: 'discord' as ChannelType, platformChannelId: 'ch-1', threadId: 'thread-42' },
        ],
      };

      const engine = new NotificationEngine(makeMockDb() as any, new Map(), new Map());
      const targets = engine.resolveTargets(request, config);

      expect(targets[0].threadId).toBe('thread-42');
    });
  });
});

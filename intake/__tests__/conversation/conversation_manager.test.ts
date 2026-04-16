/**
 * Unit tests for ConversationManager & TimeoutHandler (SPEC-008-5-03, Tasks 7 & 8).
 *
 * Covers all 15 test cases from the spec:
 *
 *  1. promptAndWait: success -- adapter returns UserResponse; verify outbound/inbound messages, outbound marked responded
 *  2. promptAndWait: timeout -- adapter returns TimeoutExpired; verify TimeoutHandler.handle called
 *  3. promptAndWait: round limit -- 5 prior clarifying_question messages; verify ClarificationLimitError
 *  4. promptAndWait: round 5 -- 4 prior messages; 5th round succeeds
 *  5. receiveFeedback: event emitted -- feedback_received event on bus
 *  6. receiveFeedback: message stored -- conversation_messages entry with direction: 'inbound', message_type: 'feedback'
 *  7. receiveFeedback: activity log -- activity log entry with event: 'feedback_received'
 *  8. Timeout: pause action -- request status paused, request_paused event, notification sent
 *  9. Timeout: default action -- human_response event with TIMEOUT_DEFAULT, notification sent
 * 10. Timeout: escalate action -- escalation target notified with conversation history
 * 11. Timeout: escalate no target -- falls back to pause action
 * 12. Timeout: activity log -- human_response_timeout activity log entry
 * 13. Timeout: TimeoutError thrown -- after any action, TimeoutError thrown with correct requestId and messageId
 * 14. Target resolution: request with thread route -- target includes threadId
 * 15. Target resolution default: no routes -- source channel used
 *
 * @module conversation_manager.test
 */

import type {
  RequestEntity,
  ConversationMessage,
  ActivityLogEntry,
} from '../../db/repository';
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
} from '../../adapters/adapter_interface';
import type {
  PhaseTransitionEvent,
  NotificationFormatter,
} from '../../notifications/formatters/cli_formatter';
import type { EventMap } from '../../events/event_types';
import { ConversationManager, ClarificationLimitError } from '../../conversation/conversation_manager';
import {
  TimeoutHandler,
  TimeoutError,
  type TimeoutConfig,
  type TimeoutHandlerLogger,
} from '../../conversation/timeout_handler';

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
    priority: 'normal',
    target_repo: 'owner/repo',
    status: 'active',
    current_phase: 'tdd_generation',
    phase_progress: null,
    requester_id: 'user-1',
    source_channel: 'discord',
    notification_config: JSON.stringify({
      verbosity: 'summary',
      routes: [],
    }),
    deadline: null,
    related_tickets: '[]',
    technical_constraints: null,
    acceptance_criteria: null,
    blocker: null,
    promotion_count: 0,
    last_promoted_at: null,
    paused_at_phase: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a StructuredPrompt for testing. */
function makePrompt(overrides: Partial<StructuredPrompt> = {}): StructuredPrompt {
  return {
    promptType: 'clarifying_question',
    requestId: 'REQ-000042',
    content: 'Which authentication provider should we use?',
    timeoutSeconds: 300,
    ...overrides,
  };
}

/** A UserResponse returned by a mock adapter. */
function makeUserResponse(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    responderId: 'user-1',
    content: 'Use Auth0 please',
    timestamp: new Date(),
    ...overrides,
  };
}

/** A TimeoutExpired returned by a mock adapter. */
function makeTimeoutExpired(overrides: Partial<TimeoutExpired> = {}): TimeoutExpired {
  return {
    kind: 'timeout',
    requestId: 'REQ-000042',
    promptedAt: new Date(Date.now() - 300_000),
    expiredAt: new Date(),
    ...overrides,
  };
}

/** Create a mock IntakeAdapter with call tracking. */
function makeMockAdapter(
  channelType: ChannelType,
  promptResult?: UserResponse | TimeoutExpired,
): IntakeAdapter & {
  sendMessageCalls: Array<{ target: MessageTarget; payload: FormattedMessage }>;
  promptUserCalls: Array<{ target: MessageTarget; prompt: StructuredPrompt }>;
} {
  const sendCalls: Array<{ target: MessageTarget; payload: FormattedMessage }> = [];
  const promptCalls: Array<{ target: MessageTarget; prompt: StructuredPrompt }> = [];

  return {
    channelType,
    sendMessageCalls: sendCalls,
    promptUserCalls: promptCalls,
    async start(): Promise<AdapterHandle> {
      return { dispose: async () => {} };
    },
    async sendMessage(target: MessageTarget, payload: FormattedMessage): Promise<DeliveryReceipt> {
      sendCalls.push({ target, payload });
      return { success: true, platformMessageId: 'msg-sent-123' };
    },
    async promptUser(target: MessageTarget, prompt: StructuredPrompt): Promise<UserResponse | TimeoutExpired> {
      promptCalls.push({ target, prompt });
      return promptResult ?? makeUserResponse();
    },
    async shutdown(): Promise<void> {},
  };
}

/** Create a mock NotificationFormatter. */
function makeMockFormatter(channelType: ChannelType): NotificationFormatter {
  return {
    formatStatusCard(_request: RequestEntity): FormattedMessage {
      return { channelType, payload: 'status-card', fallbackText: 'status-card' };
    },
    formatPhaseTransition(_request: RequestEntity, _event: PhaseTransitionEvent): FormattedMessage {
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

/** Create a mock Repository with call tracking. */
function makeMockDb(
  request?: RequestEntity,
  conversationMessages: ConversationMessage[] = [],
  escalationTarget?: MessageTarget | null,
) {
  const insertedMessages: ConversationMessage[] = [];
  const activityLogs: ActivityLogEntry[] = [];
  const respondedMessageIds: string[] = [];
  const updateRequestCalls: Array<{ requestId: string; updates: Partial<RequestEntity> }> = [];
  let messageIdCounter = 0;

  return {
    insertedMessages,
    activityLogs,
    respondedMessageIds,
    updateRequestCalls,
    getRequest(_requestId: string): RequestEntity | null {
      return request ?? null;
    },
    insertConversationMessage(msg: ConversationMessage): string {
      messageIdCounter++;
      const messageId = `msg-${messageIdCounter}`;
      insertedMessages.push({ ...msg, message_id: messageId });
      return messageId;
    },
    markMessageResponded(messageId: string): void {
      respondedMessageIds.push(messageId);
    },
    getConversationMessages(_requestId: string): ConversationMessage[] {
      return conversationMessages;
    },
    getEscalationTarget(_requestId: string): MessageTarget | null {
      return escalationTarget ?? null;
    },
    insertActivityLog(entry: ActivityLogEntry): void {
      activityLogs.push(entry);
    },
    updateRequest(requestId: string, updates: Partial<RequestEntity>): void {
      updateRequestCalls.push({ requestId, updates });
    },
  };
}

/** Create a mock TypedEventBus with call tracking. */
function makeMockEventBus() {
  const emittedEvents: Array<{ channel: string; event: unknown }> = [];
  return {
    emittedEvents,
    async emit<K extends keyof EventMap>(channel: K, event: EventMap[K]): Promise<void> {
      emittedEvents.push({ channel: channel as string, event });
    },
    subscribe: jest.fn().mockReturnValue(() => {}),
    removeAllListeners: jest.fn(),
  };
}

/** Create a mock logger that collects warnings. */
function makeMockLogger(): TimeoutHandlerLogger & {
  warnings: Array<{ message: string; context?: Record<string, unknown> }>;
} {
  const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
  return {
    warnings,
    error(_message: string, _context?: Record<string, unknown>) {},
    warn(message: string, context?: Record<string, unknown>) {
      warnings.push({ message, context });
    },
    info(_message: string, _context?: Record<string, unknown>) {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConversationManager (SPEC-008-5-03, Task 7)', () => {
  // =========================================================================
  // Test 1: promptAndWait success
  // =========================================================================

  test('promptAndWait: success -- records outbound and inbound messages, marks outbound responded', async () => {
    const request = makeRequest();
    const db = makeMockDb(request);
    const userResponse = makeUserResponse();
    const discordAdapter = makeMockAdapter('discord', userResponse);
    const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
    const eventBus = makeMockEventBus();
    const timeoutHandler = new TimeoutHandler(
      db as any, adapters, new Map(), eventBus as any,
    );
    const manager = new ConversationManager(
      db as any, adapters, timeoutHandler, eventBus as any,
    );

    const prompt = makePrompt();
    const result = await manager.promptAndWait('REQ-000042', prompt);

    // Verify the response is the user's
    expect(result.content).toBe('Use Auth0 please');
    expect(result.responderId).toBe('user-1');

    // Verify outbound message recorded (first insertion)
    expect(db.insertedMessages.length).toBe(2);
    const outbound = db.insertedMessages[0];
    expect(outbound.direction).toBe('outbound');
    expect(outbound.message_type).toBe('clarifying_question');
    expect(outbound.timeout_at).toBeTruthy();
    expect(outbound.responded).toBe(0);

    // Verify inbound message recorded (second insertion)
    const inbound = db.insertedMessages[1];
    expect(inbound.direction).toBe('inbound');
    expect(inbound.content).toBe('Use Auth0 please');
    expect(inbound.message_type).toBe('feedback');
    expect(inbound.responded).toBe(1);

    // Verify outbound marked as responded
    expect(db.respondedMessageIds).toContain('msg-1');
  });

  // =========================================================================
  // Test 2: promptAndWait timeout
  // =========================================================================

  test('promptAndWait: timeout -- delegates to TimeoutHandler', async () => {
    const request = makeRequest();
    const db = makeMockDb(request);
    const discordAdapter = makeMockAdapter('discord', makeTimeoutExpired());
    const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
    const discordFormatter = makeMockFormatter('discord');
    const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);
    const eventBus = makeMockEventBus();
    const timeoutHandler = new TimeoutHandler(
      db as any, adapters, formatters, eventBus as any,
    );
    const manager = new ConversationManager(
      db as any, adapters, timeoutHandler, eventBus as any,
    );

    const prompt = makePrompt();

    await expect(manager.promptAndWait('REQ-000042', prompt)).rejects.toThrow(TimeoutError);

    // Verify timeout activity log was written
    const timeoutLog = db.activityLogs.find(l => l.event === 'human_response_timeout');
    expect(timeoutLog).toBeDefined();
  });

  // =========================================================================
  // Test 3: promptAndWait round limit (6th round)
  // =========================================================================

  test('promptAndWait: round limit -- throws ClarificationLimitError at 6th round', async () => {
    // Set up 5 prior outbound clarifying_question messages
    const priorMessages: ConversationMessage[] = Array.from({ length: 5 }, (_, i) => ({
      message_id: `prior-${i}`,
      request_id: 'REQ-000042',
      direction: 'outbound' as const,
      channel: 'discord' as const,
      content: `Question ${i + 1}`,
      message_type: 'clarifying_question' as const,
      responded: 1,
      timeout_at: null,
      thread_id: null,
    }));

    const request = makeRequest();
    const db = makeMockDb(request, priorMessages);
    const discordAdapter = makeMockAdapter('discord');
    const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
    const eventBus = makeMockEventBus();
    const timeoutHandler = new TimeoutHandler(
      db as any, adapters, new Map(), eventBus as any,
    );
    const manager = new ConversationManager(
      db as any, adapters, timeoutHandler, eventBus as any,
    );

    const prompt = makePrompt();
    await expect(manager.promptAndWait('REQ-000042', prompt)).rejects.toThrow(ClarificationLimitError);
    await expect(manager.promptAndWait('REQ-000042', prompt)).rejects.toThrow(
      /Maximum clarification rounds \(5\) reached/,
    );
  });

  // =========================================================================
  // Test 4: promptAndWait round 5 succeeds
  // =========================================================================

  test('promptAndWait: round 5 -- succeeds with 4 prior clarifying messages', async () => {
    // Set up 4 prior outbound clarifying_question messages
    const priorMessages: ConversationMessage[] = Array.from({ length: 4 }, (_, i) => ({
      message_id: `prior-${i}`,
      request_id: 'REQ-000042',
      direction: 'outbound' as const,
      channel: 'discord' as const,
      content: `Question ${i + 1}`,
      message_type: 'clarifying_question' as const,
      responded: 1,
      timeout_at: null,
      thread_id: null,
    }));

    const request = makeRequest();
    const db = makeMockDb(request, priorMessages);
    const discordAdapter = makeMockAdapter('discord', makeUserResponse());
    const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
    const eventBus = makeMockEventBus();
    const timeoutHandler = new TimeoutHandler(
      db as any, adapters, new Map(), eventBus as any,
    );
    const manager = new ConversationManager(
      db as any, adapters, timeoutHandler, eventBus as any,
    );

    const prompt = makePrompt();
    const result = await manager.promptAndWait('REQ-000042', prompt);
    expect(result.content).toBe('Use Auth0 please');
  });

  // =========================================================================
  // Test 5: receiveFeedback event emitted
  // =========================================================================

  test('receiveFeedback: event emitted -- feedback_received on event bus', async () => {
    const request = makeRequest();
    const db = makeMockDb(request);
    const eventBus = makeMockEventBus();
    const manager = new ConversationManager(
      db as any, new Map(), {} as any, eventBus as any,
    );

    await manager.receiveFeedback('REQ-000042', 'user-1', 'Looks great, ship it!');

    const feedbackEvent = eventBus.emittedEvents.find(
      (e) => (e.event as any).type === 'feedback_received',
    );
    expect(feedbackEvent).toBeDefined();
    expect(feedbackEvent!.channel).toBe('intake');
    expect((feedbackEvent!.event as any).requestId).toBe('REQ-000042');
    expect((feedbackEvent!.event as any).userId).toBe('user-1');
    expect((feedbackEvent!.event as any).content).toBe('Looks great, ship it!');
  });

  // =========================================================================
  // Test 6: receiveFeedback message stored
  // =========================================================================

  test('receiveFeedback: message stored -- inbound feedback in conversation_messages', async () => {
    const request = makeRequest();
    const db = makeMockDb(request);
    const eventBus = makeMockEventBus();
    const manager = new ConversationManager(
      db as any, new Map(), {} as any, eventBus as any,
    );

    await manager.receiveFeedback('REQ-000042', 'user-1', 'Please add OAuth2 support');

    expect(db.insertedMessages.length).toBe(1);
    const msg = db.insertedMessages[0];
    expect(msg.direction).toBe('inbound');
    expect(msg.channel).toBe('feedback');
    expect(msg.message_type).toBe('feedback');
    expect(msg.content).toBe('Please add OAuth2 support');
    expect(msg.responded).toBe(1);
    expect(msg.timeout_at).toBeNull();
    expect(msg.thread_id).toBeNull();
  });

  // =========================================================================
  // Test 7: receiveFeedback activity log
  // =========================================================================

  test('receiveFeedback: activity log -- feedback_received entry with userId and contentLength', async () => {
    const request = makeRequest();
    const db = makeMockDb(request);
    const eventBus = makeMockEventBus();
    const manager = new ConversationManager(
      db as any, new Map(), {} as any, eventBus as any,
    );

    await manager.receiveFeedback('REQ-000042', 'user-1', 'Ship it!');

    expect(db.activityLogs.length).toBe(1);
    const log = db.activityLogs[0];
    expect(log.request_id).toBe('REQ-000042');
    expect(log.event).toBe('feedback_received');
    const details = JSON.parse(log.details);
    expect(details.userId).toBe('user-1');
    expect(details.contentLength).toBe('Ship it!'.length);
  });

  // =========================================================================
  // Test 14: Target resolution with thread route
  // =========================================================================

  test('target resolution: request with thread route includes threadId', async () => {
    const request = makeRequest({
      notification_config: JSON.stringify({
        verbosity: 'summary',
        routes: [
          {
            channelType: 'discord',
            platformChannelId: 'channel-abc',
            threadId: 'thread-xyz',
          },
        ],
      }),
    });
    const db = makeMockDb(request);
    const discordAdapter = makeMockAdapter('discord', makeUserResponse());
    const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
    const eventBus = makeMockEventBus();
    const timeoutHandler = new TimeoutHandler(
      db as any, adapters, new Map(), eventBus as any,
    );
    const manager = new ConversationManager(
      db as any, adapters, timeoutHandler, eventBus as any,
    );

    await manager.promptAndWait('REQ-000042', makePrompt());

    // Verify adapter was called with the correct target (including threadId)
    expect(discordAdapter.promptUserCalls.length).toBe(1);
    const target = discordAdapter.promptUserCalls[0].target;
    expect(target.channelType).toBe('discord');
    expect(target.platformChannelId).toBe('channel-abc');
    expect(target.threadId).toBe('thread-xyz');
  });

  // =========================================================================
  // Test 15: Target resolution default (no routes)
  // =========================================================================

  test('target resolution default: no routes uses source channel', async () => {
    const request = makeRequest({
      source_channel: 'slack',
      requester_id: 'U12345',
      notification_config: JSON.stringify({
        verbosity: 'summary',
        routes: [],
      }),
    });
    const db = makeMockDb(request);
    const slackAdapter = makeMockAdapter('slack', makeUserResponse());
    const adapters = new Map<ChannelType, IntakeAdapter>([['slack', slackAdapter]]);
    const eventBus = makeMockEventBus();
    const timeoutHandler = new TimeoutHandler(
      db as any, adapters, new Map(), eventBus as any,
    );
    const manager = new ConversationManager(
      db as any, adapters, timeoutHandler, eventBus as any,
    );

    await manager.promptAndWait('REQ-000042', makePrompt());

    expect(slackAdapter.promptUserCalls.length).toBe(1);
    const target = slackAdapter.promptUserCalls[0].target;
    expect(target.channelType).toBe('slack');
    expect(target.userId).toBe('U12345');
    expect(target.platformChannelId).toBeUndefined();
    expect(target.threadId).toBeUndefined();
  });
});

describe('TimeoutHandler (SPEC-008-5-03, Task 8)', () => {
  // =========================================================================
  // Test 8: Timeout pause action
  // =========================================================================

  test('pause action: sets request to paused, emits request_paused, notifies requester', async () => {
    const request = makeRequest();
    const db = makeMockDb(request);
    const discordAdapter = makeMockAdapter('discord');
    const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
    const discordFormatter = makeMockFormatter('discord');
    const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);
    const eventBus = makeMockEventBus();
    const handler = new TimeoutHandler(db as any, adapters, formatters, eventBus as any);
    handler.setTimeoutConfig({ human_response_action: 'pause', timeout_seconds: 3600 });

    await expect(handler.handle('REQ-000042', 'msg-out-1')).rejects.toThrow(TimeoutError);

    // Verify request updated to paused
    expect(db.updateRequestCalls.length).toBe(1);
    expect(db.updateRequestCalls[0].updates.status).toBe('paused');
    expect(db.updateRequestCalls[0].updates.paused_at_phase).toBe('tdd_generation');

    // Verify request_paused event emitted
    const pauseEvent = eventBus.emittedEvents.find(
      (e) => (e.event as any).type === 'request_paused',
    );
    expect(pauseEvent).toBeDefined();
    expect((pauseEvent!.event as any).requestId).toBe('REQ-000042');

    // Verify notification sent to requester
    expect(discordAdapter.sendMessageCalls.length).toBe(1);
    const sentPayload = discordAdapter.sendMessageCalls[0].payload;
    expect(sentPayload.fallbackText).toContain('paused');
    expect(sentPayload.fallbackText).toContain('/resume');
  });

  // =========================================================================
  // Test 9: Timeout default action
  // =========================================================================

  test('default action: emits human_response with TIMEOUT_DEFAULT, notifies requester', async () => {
    const request = makeRequest();
    const db = makeMockDb(request);
    const discordAdapter = makeMockAdapter('discord');
    const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
    const discordFormatter = makeMockFormatter('discord');
    const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);
    const eventBus = makeMockEventBus();
    const handler = new TimeoutHandler(db as any, adapters, formatters, eventBus as any);
    handler.setTimeoutConfig({ human_response_action: 'default', timeout_seconds: 3600 });

    await expect(handler.handle('REQ-000042', 'msg-out-1')).rejects.toThrow(TimeoutError);

    // Verify human_response event with TIMEOUT_DEFAULT
    const responseEvent = eventBus.emittedEvents.find(
      (e) => (e.event as any).type === 'human_response',
    );
    expect(responseEvent).toBeDefined();
    expect((responseEvent!.event as any).requestId).toBe('REQ-000042');
    expect((responseEvent!.event as any).response.content).toBe('TIMEOUT_DEFAULT');
    expect((responseEvent!.event as any).response.responderId).toBe('system');

    // Verify notification sent to requester
    expect(discordAdapter.sendMessageCalls.length).toBe(1);
    const sentPayload = discordAdapter.sendMessageCalls[0].payload;
    expect(sentPayload.fallbackText).toContain('conservative default');
  });

  // =========================================================================
  // Test 10: Timeout escalate action
  // =========================================================================

  test('escalate action: notifies escalation target with conversation history', async () => {
    const conversationHistory: ConversationMessage[] = [
      {
        message_id: 'msg-1',
        request_id: 'REQ-000042',
        direction: 'outbound',
        channel: 'discord',
        content: 'Which auth provider?',
        message_type: 'clarifying_question',
        responded: 0,
        timeout_at: null,
        thread_id: null,
      },
    ];
    const escalationTarget: MessageTarget = {
      channelType: 'slack',
      platformChannelId: 'escalation-channel',
      userId: 'manager-1',
    };
    const request = makeRequest();
    const db = makeMockDb(request, conversationHistory, escalationTarget);
    const discordAdapter = makeMockAdapter('discord');
    const slackAdapter = makeMockAdapter('slack');
    const adapters = new Map<ChannelType, IntakeAdapter>([
      ['discord', discordAdapter],
      ['slack', slackAdapter],
    ]);
    const discordFormatter = makeMockFormatter('discord');
    const slackFormatter = makeMockFormatter('slack');
    const formatters = new Map<ChannelType, NotificationFormatter>([
      ['discord', discordFormatter],
      ['slack', slackFormatter],
    ]);
    const eventBus = makeMockEventBus();
    const handler = new TimeoutHandler(db as any, adapters, formatters, eventBus as any);
    handler.setTimeoutConfig({ human_response_action: 'escalate', timeout_seconds: 3600 });

    await expect(handler.handle('REQ-000042', 'msg-out-1')).rejects.toThrow(TimeoutError);

    // Verify escalation target was notified via Slack adapter
    expect(slackAdapter.sendMessageCalls.length).toBe(1);
    const sentTarget = slackAdapter.sendMessageCalls[0].target;
    expect(sentTarget.channelType).toBe('slack');
    expect(sentTarget.platformChannelId).toBe('escalation-channel');

    // Verify conversation history is included
    const sentPayload = slackAdapter.sendMessageCalls[0].payload;
    expect(sentPayload.fallbackText).toContain('Conversation History');
    expect(sentPayload.fallbackText).toContain('[outbound] Which auth provider?');
  });

  // =========================================================================
  // Test 11: Timeout escalate without target configured
  // =========================================================================

  test('escalate no target: falls back to pause action', async () => {
    const request = makeRequest();
    const db = makeMockDb(request, [], null); // null escalation target
    const discordAdapter = makeMockAdapter('discord');
    const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
    const discordFormatter = makeMockFormatter('discord');
    const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);
    const eventBus = makeMockEventBus();
    const logger = makeMockLogger();
    const handler = new TimeoutHandler(db as any, adapters, formatters, eventBus as any, logger);
    handler.setTimeoutConfig({ human_response_action: 'escalate', timeout_seconds: 3600 });

    await expect(handler.handle('REQ-000042', 'msg-out-1')).rejects.toThrow(TimeoutError);

    // Verify warning was logged
    expect(logger.warnings.length).toBeGreaterThan(0);
    expect(logger.warnings[0].message).toContain('No escalation target configured');

    // Verify it fell back to pause: request updated + paused event emitted
    expect(db.updateRequestCalls.length).toBe(1);
    expect(db.updateRequestCalls[0].updates.status).toBe('paused');

    const pauseEvent = eventBus.emittedEvents.find(
      (e) => (e.event as any).type === 'request_paused',
    );
    expect(pauseEvent).toBeDefined();
  });

  // =========================================================================
  // Test 12: Timeout activity log
  // =========================================================================

  test('timeout: activity log entry with human_response_timeout', async () => {
    const request = makeRequest();
    const db = makeMockDb(request);
    const discordAdapter = makeMockAdapter('discord');
    const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
    const discordFormatter = makeMockFormatter('discord');
    const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);
    const eventBus = makeMockEventBus();
    const handler = new TimeoutHandler(db as any, adapters, formatters, eventBus as any);
    handler.setTimeoutConfig({ human_response_action: 'pause', timeout_seconds: 3600 });

    await expect(handler.handle('REQ-000042', 'msg-out-1')).rejects.toThrow(TimeoutError);

    const timeoutLog = db.activityLogs.find((l) => l.event === 'human_response_timeout');
    expect(timeoutLog).toBeDefined();
    expect(timeoutLog!.request_id).toBe('REQ-000042');
    const details = JSON.parse(timeoutLog!.details);
    expect(details.messageId).toBe('msg-out-1');
    expect(details.action).toBe('pause');
  });

  // =========================================================================
  // Test 13: TimeoutError thrown after any action
  // =========================================================================

  test('TimeoutError thrown with correct requestId and messageId', async () => {
    const request = makeRequest();
    const db = makeMockDb(request);
    const discordAdapter = makeMockAdapter('discord');
    const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
    const discordFormatter = makeMockFormatter('discord');
    const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);
    const eventBus = makeMockEventBus();
    const handler = new TimeoutHandler(db as any, adapters, formatters, eventBus as any);
    handler.setTimeoutConfig({ human_response_action: 'pause', timeout_seconds: 3600 });

    try {
      await handler.handle('REQ-000042', 'msg-out-99');
      fail('Expected TimeoutError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      const timeoutErr = err as TimeoutError;
      expect(timeoutErr.requestId).toBe('REQ-000042');
      expect(timeoutErr.messageId).toBe('msg-out-99');
      expect(timeoutErr.name).toBe('TimeoutError');
      expect(timeoutErr.message).toContain('REQ-000042');
    }
  });

  // =========================================================================
  // Additional: TimeoutError for default action
  // =========================================================================

  test('TimeoutError thrown after default action as well', async () => {
    const request = makeRequest();
    const db = makeMockDb(request);
    const discordAdapter = makeMockAdapter('discord');
    const adapters = new Map<ChannelType, IntakeAdapter>([['discord', discordAdapter]]);
    const discordFormatter = makeMockFormatter('discord');
    const formatters = new Map<ChannelType, NotificationFormatter>([['discord', discordFormatter]]);
    const eventBus = makeMockEventBus();
    const handler = new TimeoutHandler(db as any, adapters, formatters, eventBus as any);
    handler.setTimeoutConfig({ human_response_action: 'default', timeout_seconds: 3600 });

    try {
      await handler.handle('REQ-000042', 'msg-out-77');
      fail('Expected TimeoutError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      const timeoutErr = err as TimeoutError;
      expect(timeoutErr.requestId).toBe('REQ-000042');
      expect(timeoutErr.messageId).toBe('msg-out-77');
    }
  });
});

/**
 * Test Case 1: Type compilation
 *
 * Verifies that all types from adapter_interface.ts can be imported and used
 * in a type-safe manner. This file should compile with `tsc --noEmit`.
 */

import type {
  ChannelType,
  IntakeAdapter,
  AdapterHandle,
  MessageTarget,
  FormattedMessage,
  StructuredPrompt,
  PromptOption,
  UserResponse,
  TimeoutExpired,
  DeliveryReceipt,
  IncomingCommand,
  CommandSource,
  ParsedRequest,
  ErrorResponse,
  ErrorCode,
  CommandHandler,
  CommandResult,
  VerbosityLevel,
  NotificationConfig,
  NotificationRoute,
  AuthzAction,
  AuthzContext,
  AuthzDecision,
  Priority,
  RequestStatus,
} from '../../../intake/adapters/adapter_interface';

describe('adapter_interface types', () => {
  test('ChannelType accepts valid values', () => {
    const channels: ChannelType[] = ['claude_app', 'discord', 'slack'];
    expect(channels).toHaveLength(3);
  });

  test('MessageTarget can be constructed', () => {
    const target: MessageTarget = {
      channelType: 'discord',
      userId: 'u123',
      platformChannelId: 'ch456',
      threadId: 'th789',
      isDM: false,
    };
    expect(target.channelType).toBe('discord');
    expect(target.userId).toBe('u123');
  });

  test('FormattedMessage can be constructed', () => {
    const msg: FormattedMessage = {
      channelType: 'slack',
      payload: { blocks: [] },
      fallbackText: 'Hello',
    };
    expect(msg.fallbackText).toBe('Hello');
  });

  test('StructuredPrompt can be constructed with options', () => {
    const option: PromptOption = {
      label: 'Yes',
      value: 'yes',
      style: 'primary',
    };
    const prompt: StructuredPrompt = {
      promptType: 'clarifying_question',
      requestId: 'REQ-001',
      content: 'Are you sure?',
      options: [option],
      timeoutSeconds: 300,
    };
    expect(prompt.options).toHaveLength(1);
    expect(prompt.timeoutSeconds).toBe(300);
  });

  test('UserResponse can be constructed', () => {
    const response: UserResponse = {
      responderId: 'u123',
      content: 'Yes',
      selectedOption: 'yes',
      timestamp: new Date(),
    };
    expect(response.responderId).toBe('u123');
  });

  test('TimeoutExpired can be constructed and discriminated', () => {
    const timeout: TimeoutExpired = {
      kind: 'timeout',
      requestId: 'REQ-001',
      promptedAt: new Date('2026-01-01'),
      expiredAt: new Date('2026-01-02'),
    };
    expect(timeout.kind).toBe('timeout');
  });

  test('DeliveryReceipt can represent success and failure', () => {
    const success: DeliveryReceipt = {
      success: true,
      platformMessageId: 'msg123',
    };
    const failure: DeliveryReceipt = {
      success: false,
      error: 'Channel not found',
      retryable: true,
    };
    expect(success.success).toBe(true);
    expect(failure.retryable).toBe(true);
  });

  test('IncomingCommand can be constructed', () => {
    const source: CommandSource = {
      channelType: 'claude_app',
      userId: 'u123',
      timestamp: new Date(),
    };
    const cmd: IncomingCommand = {
      commandName: 'submit',
      args: ['repo-name'],
      flags: { priority: 'high', verbose: true },
      rawText: '!submit repo-name --priority high --verbose',
      source,
    };
    expect(cmd.commandName).toBe('submit');
    expect(cmd.source.channelType).toBe('claude_app');
  });

  test('ParsedRequest can be constructed', () => {
    const parsed: ParsedRequest = {
      title: 'Add dark mode',
      description: 'Implement dark mode toggle in settings',
      priority: 'high',
      target_repo: 'my-app',
      deadline: '2026-06-01',
      related_tickets: ['JIRA-123'],
      technical_constraints: 'Must work in Safari',
      acceptance_criteria: 'Toggle visible in settings',
      confidence: 0.92,
    };
    expect(parsed.confidence).toBeGreaterThan(0);
    expect(parsed.confidence).toBeLessThanOrEqual(1);
  });

  test('ErrorResponse has success: false', () => {
    const err: ErrorResponse = {
      success: false,
      error: 'Rate limited',
      errorCode: 'RATE_LIMITED',
      retryAfterMs: 5000,
    };
    expect(err.success).toBe(false);
  });

  test('ErrorCode covers all variants', () => {
    const codes: ErrorCode[] = [
      'VALIDATION_ERROR',
      'AUTHZ_DENIED',
      'RATE_LIMITED',
      'NOT_FOUND',
      'INVALID_STATE',
      'QUEUE_FULL',
      'DUPLICATE_DETECTED',
      'INJECTION_BLOCKED',
      'INJECTION_FLAGGED',
      'INTERNAL_ERROR',
      'PLATFORM_ERROR',
    ];
    expect(codes).toHaveLength(11);
  });

  test('CommandResult can be constructed', () => {
    const result: CommandResult = {
      success: true,
      data: { requestId: 'REQ-001' },
    };
    expect(result.success).toBe(true);
  });

  test('VerbosityLevel accepts valid values', () => {
    const levels: VerbosityLevel[] = ['silent', 'summary', 'verbose', 'debug'];
    expect(levels).toHaveLength(4);
  });

  test('NotificationConfig can be constructed', () => {
    const route: NotificationRoute = {
      channelType: 'discord',
      platformChannelId: 'ch123',
      events: ['status_change', 'phase_complete'],
    };
    const config: NotificationConfig = {
      verbosity: 'summary',
      routes: [route],
    };
    expect(config.routes).toHaveLength(1);
  });

  test('AuthzAction covers all variants', () => {
    const actions: AuthzAction[] = [
      'submit', 'status', 'list', 'cancel', 'pause',
      'resume', 'priority', 'logs', 'feedback', 'kill',
      'approve_review', 'config_change',
    ];
    expect(actions).toHaveLength(12);
  });

  test('AuthzContext can be constructed', () => {
    const ctx: AuthzContext = {
      requestId: 'REQ-001',
      targetRepo: 'my-repo',
      gate: 'code-review',
    };
    expect(ctx.requestId).toBe('REQ-001');
  });

  test('AuthzDecision can be constructed', () => {
    const decision: AuthzDecision = {
      granted: true,
      userId: 'u123',
      action: 'submit',
      reason: 'User is admin',
      timestamp: new Date(),
    };
    expect(decision.granted).toBe(true);
  });

  test('Priority accepts valid values', () => {
    const priorities: Priority[] = ['high', 'normal', 'low'];
    expect(priorities).toHaveLength(3);
  });

  test('RequestStatus accepts valid values', () => {
    const statuses: RequestStatus[] = [
      'queued', 'active', 'paused', 'cancelled', 'done', 'failed',
    ];
    expect(statuses).toHaveLength(6);
  });
});

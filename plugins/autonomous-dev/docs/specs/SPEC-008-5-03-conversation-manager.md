# SPEC-008-5-03: ConversationManager & TimeoutHandler

## Metadata
- **Parent Plan**: PLAN-008-5
- **Tasks Covered**: Task 7, Task 8
- **Estimated effort**: 10 hours

## Description

Implement the `ConversationManager` that tracks all human-system exchanges per request, sends structured prompts via adapters, records inbound/outbound messages, enforces the 5-round clarification limit, and accepts unsolicited feedback. Also implement the `TimeoutHandler` that executes configurable timeout actions (pause, proceed-with-default, escalate).

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/conversation/conversation_manager.ts` | Create |
| `intake/conversation/timeout_handler.ts` | Create |

## Implementation Details

### Task 7: ConversationManager

```typescript
class ConversationManager {
  constructor(
    private db: Repository,
    private adapters: Map<ChannelType, IntakeAdapter>,
    private timeoutHandler: TimeoutHandler,
    private eventBus: TypedEventBus,
  ) {}

  async promptAndWait(
    requestId: string,
    prompt: StructuredPrompt
  ): Promise<UserResponse> {
    const request = await this.db.getRequest(requestId);
    if (!request) throw new Error(`Request ${requestId} not found`);

    // Check clarification round limit
    const roundCount = await this.getClarificationRoundCount(requestId);
    if (roundCount >= 5) {
      throw new ClarificationLimitError(
        `Maximum clarification rounds (5) reached for ${requestId}. ` +
        'Please submit a more detailed description.'
      );
    }

    // Record outbound message
    const timeoutAt = new Date(Date.now() + prompt.timeoutSeconds * 1000);
    const messageId = await this.db.insertConversationMessage({
      request_id: requestId,
      direction: 'outbound',
      channel: request.source_channel,
      content: prompt.content,
      message_type: prompt.promptType,
      responded: false,
      timeout_at: timeoutAt.toISOString(),
      thread_id: this.getThreadId(request),
    });

    // Send via the appropriate adapter
    const target = this.resolveTarget(request);
    const adapter = this.adapters.get(target.channelType);
    if (!adapter) {
      throw new Error(`No adapter available for channel ${target.channelType}`);
    }

    const response = await adapter.promptUser(target, prompt);

    // Handle timeout
    if ('kind' in response && response.kind === 'timeout') {
      return this.timeoutHandler.handle(requestId, messageId);
    }

    // Record inbound response
    await this.db.insertConversationMessage({
      request_id: requestId,
      direction: 'inbound',
      channel: request.source_channel,
      content: response.content,
      message_type: 'feedback',
      responded: true,
      timeout_at: null,
      thread_id: this.getThreadId(request),
    });

    // Mark the outbound message as responded
    await this.db.markMessageResponded(messageId);

    return response;
  }

  async receiveFeedback(
    requestId: string,
    userId: string,
    message: string
  ): Promise<void> {
    const request = await this.db.getRequest(requestId);
    if (!request) throw new Error(`Request ${requestId} not found`);

    await this.db.insertConversationMessage({
      request_id: requestId,
      direction: 'inbound',
      channel: 'feedback',
      content: message,
      message_type: 'feedback',
      responded: true,
      timeout_at: null,
      thread_id: null,
    });

    // Emit event for pipeline context injection
    await this.eventBus.emit('intake', {
      type: 'feedback_received',
      requestId,
      userId,
      content: message,
    });

    await this.db.insertActivityLog({
      request_id: requestId,
      event: 'feedback_received',
      details: JSON.stringify({ userId, contentLength: message.length }),
    });
  }

  private async getClarificationRoundCount(requestId: string): Promise<number> {
    const messages = await this.db.getConversationMessages(requestId);
    return messages.filter(m =>
      m.direction === 'outbound' && m.message_type === 'clarifying_question'
    ).length;
  }

  private resolveTarget(request: RequestEntity): MessageTarget {
    const config: NotificationConfig = JSON.parse(request.notification_config);
    if (config.routes && config.routes.length > 0) {
      const primaryRoute = config.routes[0];
      return {
        channelType: primaryRoute.channelType as ChannelType,
        platformChannelId: primaryRoute.platformChannelId,
        threadId: primaryRoute.threadId,
      };
    }
    return {
      channelType: request.source_channel as ChannelType,
      userId: request.requester_id,
    };
  }

  private getThreadId(request: RequestEntity): string | null {
    const config: NotificationConfig = JSON.parse(request.notification_config);
    return config.routes?.[0]?.threadId ?? null;
  }
}
```

### Task 8: TimeoutHandler

```typescript
class TimeoutHandler {
  constructor(
    private db: Repository,
    private adapters: Map<ChannelType, IntakeAdapter>,
    private formatters: Map<ChannelType, NotificationFormatter>,
    private eventBus: TypedEventBus,
  ) {}

  async handle(requestId: string, messageId: string): Promise<never> {
    const request = await this.db.getRequest(requestId);
    const config = await this.getTimeoutConfig();

    // Log timeout event
    await this.db.insertActivityLog({
      request_id: requestId,
      event: 'human_response_timeout',
      details: JSON.stringify({ messageId, action: config.human_response_action }),
    });

    switch (config.human_response_action) {
      case 'pause':
        await this.handlePause(request);
        break;
      case 'default':
        await this.handleDefault(request);
        break;
      case 'escalate':
        await this.handleEscalate(request, requestId);
        break;
    }

    throw new TimeoutError(requestId, messageId);
  }

  private async handlePause(request: RequestEntity): Promise<void> {
    await this.db.updateRequest(request.request_id, {
      status: 'paused',
      paused_at_phase: request.current_phase,
    });

    await this.eventBus.emit('intake', {
      type: 'request_paused',
      requestId: request.request_id,
    });

    await this.notifyRequester(request,
      'Your request has been paused because a response was not received within the timeout window. ' +
      'Use `/resume` when ready.'
    );
  }

  private async handleDefault(request: RequestEntity): Promise<void> {
    await this.eventBus.emit('intake', {
      type: 'human_response',
      requestId: request.request_id,
      messageId: '',
      response: {
        responderId: 'system',
        content: 'TIMEOUT_DEFAULT',
        timestamp: new Date(),
      },
    });

    await this.notifyRequester(request,
      'No response received within the timeout window. Proceeding with a conservative default. ' +
      'The assumption has been noted in the request log.'
    );
  }

  private async handleEscalate(request: RequestEntity, requestId: string): Promise<void> {
    const escalationTarget = await this.db.getEscalationTarget(requestId);

    if (!escalationTarget) {
      // Fallback to pause if no escalation target configured
      logger.warn('No escalation target configured, falling back to pause', { requestId });
      await this.handlePause(request);
      return;
    }

    // Get full conversation history for context
    const conversationHistory = await this.db.getConversationMessages(requestId);
    const historyText = conversationHistory
      .map(m => `[${m.direction}] ${m.content}`)
      .join('\n');

    await this.notifyTarget(escalationTarget, request,
      `Request ${requestId} requires input. The original requester did not respond within the timeout window.\n\n` +
      `*Conversation History:*\n${historyText}`
    );
  }

  private async notifyRequester(request: RequestEntity, message: string): Promise<void> {
    const target = this.resolveRequesterTarget(request);
    const adapter = this.adapters.get(target.channelType);
    if (!adapter) return;

    const formatter = this.formatters.get(target.channelType);
    if (!formatter) return;

    const formatted: FormattedMessage = {
      channelType: target.channelType,
      payload: message,
      fallbackText: message,
    };

    await adapter.sendMessage(target, formatted);
  }

  private async getTimeoutConfig(): Promise<TimeoutConfig> {
    // Load from intake-config.yaml or return defaults
    return {
      human_response_action: 'pause', // default
      timeout_seconds: 3600,          // default 1 hour
    };
  }
}

interface TimeoutConfig {
  human_response_action: 'pause' | 'default' | 'escalate';
  timeout_seconds: number;
}

class TimeoutError extends Error {
  constructor(public requestId: string, public messageId: string) {
    super(`Human response timeout for request ${requestId}`);
    this.name = 'TimeoutError';
  }
}

class ClarificationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClarificationLimitError';
  }
}
```

## Acceptance Criteria

1. `promptAndWait` records outbound message with `timeout_at` before sending.
2. `promptAndWait` sends via the correct adapter based on request's source channel.
3. On user response, inbound message recorded and outbound marked as responded.
4. On timeout, `TimeoutHandler.handle()` is called.
5. 5-round clarification limit enforced: 6th round throws `ClarificationLimitError`.
6. `receiveFeedback` records message and emits `feedback_received` event.
7. `receiveFeedback` creates activity log entry.
8. Timeout `pause` action: sets request to `paused`, emits `request_paused`, notifies requester.
9. Timeout `default` action: emits `human_response` with `TIMEOUT_DEFAULT`, notifies requester.
10. Timeout `escalate` action: notifies escalation target with full conversation history.
11. Timeout `escalate` without target configured: falls back to `pause` with warning log.
12. `TimeoutError` thrown after all timeout actions.

## Test Cases

1. **promptAndWait: success**: Mock adapter returns `UserResponse`; verify outbound and inbound messages in DB, outbound marked responded.
2. **promptAndWait: timeout**: Mock adapter returns `TimeoutExpired`; verify `TimeoutHandler.handle` called.
3. **promptAndWait: round limit**: Set up 5 prior outbound clarifying_question messages; call again; verify `ClarificationLimitError` thrown.
4. **promptAndWait: round 5**: Set up 4 prior messages; call again (5th round); verify succeeds.
5. **receiveFeedback: event emitted**: Call `receiveFeedback`; verify `feedback_received` event emitted on bus.
6. **receiveFeedback: message stored**: Call `receiveFeedback`; verify `conversation_messages` entry with `direction: 'inbound'`, `message_type: 'feedback'`.
7. **receiveFeedback: activity log**: Verify activity log entry with `event: 'feedback_received'`.
8. **Timeout: pause action**: Config `human_response_action: 'pause'`; call `handle`; verify request status `paused`, `request_paused` event, notification sent.
9. **Timeout: default action**: Config `'default'`; call `handle`; verify `human_response` event with `TIMEOUT_DEFAULT`, notification sent.
10. **Timeout: escalate action**: Config `'escalate'`, escalation target configured; verify target notified with conversation history.
11. **Timeout: escalate no target**: Config `'escalate'`, no target; verify falls back to `pause` action.
12. **Timeout: activity log**: Verify `human_response_timeout` activity log entry.
13. **Timeout: TimeoutError thrown**: After any action, verify `TimeoutError` thrown with correct requestId and messageId.
14. **Target resolution**: Request with thread route; verify target includes threadId.
15. **Target resolution default**: No routes; verify source channel used.

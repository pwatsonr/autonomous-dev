# SPEC-008-4-04: Thread Conversations, Socket Mode & Platform Rate Limits

## Metadata
- **Parent Plan**: PLAN-008-4
- **Tasks Covered**: Task 10, Task 12, Task 13
- **Estimated effort**: 8 hours

## Description

Implement thread-based clarifying conversations using Slack's `thread_ts` mechanism, the Socket Mode fallback for environments without public HTTPS endpoints, and platform rate limit handling that respects Slack's `Retry-After` header.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/adapters/slack/slack_adapter.ts` | Modify (add thread logic) |
| `intake/adapters/slack/slack_socket_mode.ts` | Create |
| `intake/adapters/slack/slack_rate_limiter.ts` | Create |

## Implementation Details

### Task 10: Thread-Based Clarifying Conversations

When the first clarifying question is needed for a request:

```typescript
async createClarifyingThread(
  channelId: string,
  originalMessageTs: string,
  requestId: string,
  content: string
): Promise<string> {
  const web = this.slackClient.getClient();

  // Post as a threaded reply
  const result = await web.chat.postMessage({
    channel: channelId,
    text: content,
    thread_ts: originalMessageTs,
  });

  // Join the thread to receive replies
  await web.conversations.join({ channel: channelId });

  const threadTs = result.ts!;

  // Store thread_ts for future use
  await this.db.insertConversationMessage({
    request_id: requestId,
    direction: 'outbound',
    channel: 'slack',
    content,
    message_type: 'clarifying_question',
    responded: false,
    timeout_at: new Date(Date.now() + this.config.default_timeout_seconds * 1000).toISOString(),
    thread_id: threadTs,
  });

  // Update notification config with thread_ts
  const request = await this.db.getRequest(requestId);
  const config = JSON.parse(request.notification_config);
  config.routes = config.routes || [];
  config.routes.push({
    channelType: 'slack',
    platformChannelId: channelId,
    threadId: threadTs,
  });
  await this.db.updateRequest(requestId, {
    notification_config: JSON.stringify(config),
  });

  return threadTs;
}
```

**Thread reuse**: Once the `thread_ts` is stored, all subsequent messages for this request use the same `thread_ts` in `chat.postMessage`. No new thread is created.

**`conversations.join`**: Required so the bot can receive `message` events for replies in the thread.

### Task 12: Socket Mode Fallback

```typescript
import { SocketModeClient } from '@slack/socket-mode';

class SlackSocketModeAdapter {
  private socketClient: SocketModeClient;

  constructor(
    private commandHandler: SlackCommandHandler,
    private interactionHandler: SlackInteractionHandler,
  ) {
    const appToken = process.env.SLACK_APP_TOKEN;
    if (!appToken) {
      throw new Error('SLACK_APP_TOKEN environment variable is not set (required for Socket Mode)');
    }
    if (!appToken.startsWith('xapp-')) {
      throw new Error('SLACK_APP_TOKEN must be an app-level token (xapp-*)');
    }
    this.socketClient = new SocketModeClient({ appToken });
  }

  async start(): Promise<void> {
    this.socketClient.on('slash_commands', async ({ body, ack }) => {
      await ack();
      // Convert Socket Mode payload to Express-like request for reuse
      await this.commandHandler.handleSocketMode(body);
    });

    this.socketClient.on('interactive', async ({ body, ack }) => {
      await ack();
      await this.interactionHandler.handleSocketMode(body);
    });

    this.socketClient.on('disconnect', () => {
      logger.warn('Socket Mode disconnected, attempting reconnect...');
    });

    await this.socketClient.start();
    logger.info('Slack Socket Mode connected');
  }

  async stop(): Promise<void> {
    await this.socketClient.disconnect();
  }
}
```

**Configuration**: Socket Mode is enabled via `slack.socket_mode: true` in `intake-config.yaml`.

**App token format validation**: The token must start with `xapp-` (app-level token, distinct from `xoxb-` bot tokens).

**Reconnection**: The `@slack/socket-mode` library handles reconnection internally. The `disconnect` event is logged.

**Command handler reuse**: The same `SlackCommandHandler` and `SlackInteractionHandler` logic is reused. Only the transport layer differs (Socket Mode vs HTTP webhooks).

### Task 13: Platform Rate Limit Handling

```typescript
class SlackRateLimiter {
  async executeWithRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (this.isRateLimited(error)) {
        const retryAfter = this.extractRetryAfter(error);
        logger.warn('Slack rate limit hit', { retryAfter });
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        return fn(); // Retry once
      }
      throw error;
    }
  }

  private isRateLimited(error: unknown): boolean {
    return (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as any).code === 'slack_webapi_platform_error' &&
      (error as any).data?.error === 'ratelimited'
    );
  }

  private extractRetryAfter(error: unknown): number {
    const retryAfter = (error as any).data?.headers?.['retry-after'];
    return retryAfter ? parseInt(retryAfter, 10) : 30; // Default 30s if header missing
  }
}
```

**Slack tier limits (for reference):**
- Tier 1: ~1 req/min (admin-level)
- Tier 2: ~20 req/min (most methods)
- Tier 3: ~50 req/min (`chat.postMessage`, `chat.update`)
- Tier 4: ~100+ req/min (high-volume)

**Integration with shared `withRetry`**: The Slack rate limiter wraps API calls and delegates to the shared `withRetry` utility for exponential backoff on 429 and `service_unavailable` errors.

## Acceptance Criteria

1. Thread created via `chat.postMessage` with `thread_ts` set to original message's `ts`.
2. `conversations.join` called to subscribe to thread replies.
3. `thread_ts` stored in `conversation_messages.thread_id` and `notification_config.routes[].threadId`.
4. Subsequent messages for the same request reuse the existing `thread_ts`.
5. Socket Mode connects with `xapp-*` app-level token.
6. Socket Mode validates token format (must start with `xapp-`).
7. Socket Mode routes slash commands and interactions through the same handlers as HTTP mode.
8. Socket Mode reconnects on disconnect.
9. Rate limit handler catches `ratelimited` errors and waits for `Retry-After` duration.
10. Rate limit events logged at `warn` level.
11. Default retry-after of 30 seconds when header is missing.

## Test Cases

1. **Thread creation**: Mock `chat.postMessage` with `thread_ts`; verify called with correct `thread_ts` and channel.
2. **Thread join**: Verify `conversations.join` called after posting to thread.
3. **Thread reuse**: Create thread (store thread_ts), send second message; verify `thread_ts` reused (not a new thread).
4. **Thread ID persistence**: After thread creation, verify DB has `thread_id` in conversation_messages and notification_config.
5. **Socket Mode: valid token**: Set `SLACK_APP_TOKEN=xapp-test-123`; verify construction succeeds.
6. **Socket Mode: invalid token format**: Set `SLACK_APP_TOKEN=xoxb-bot-token`; verify constructor throws with format error.
7. **Socket Mode: missing token**: Unset env var; verify constructor throws.
8. **Socket Mode: slash command routing**: Simulate `slash_commands` event; verify command handler called with correct body.
9. **Socket Mode: interaction routing**: Simulate `interactive` event; verify interaction handler called.
10. **Rate limit: ratelimited error**: Mock API to throw ratelimited with `retry-after: 5`; verify retry after 5s.
11. **Rate limit: missing retry-after**: Mock ratelimited error without header; verify 30s default wait.
12. **Rate limit: non-rate-limit error**: Mock 500 error; verify error propagated (not treated as rate limit).
13. **Rate limit: logging**: On rate limit, verify `warn` level log entry.

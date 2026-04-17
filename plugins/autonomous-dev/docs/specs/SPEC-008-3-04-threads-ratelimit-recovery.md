# SPEC-008-3-04: Thread Conversations, Platform Rate Limits & Bot Recovery

## Metadata
- **Parent Plan**: PLAN-008-3
- **Tasks Covered**: Task 9, Task 11, Task 12, Task 13
- **Estimated effort**: 9 hours

## Description

Implement thread-based clarifying conversations on Discord, platform rate limit awareness that respects Discord's per-route rate limit headers, bot startup recovery for pending prompts, and graceful gateway shutdown.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/adapters/discord/discord_adapter.ts` | Modify (add thread and recovery logic) |
| `intake/adapters/discord/discord_rate_limiter.ts` | Create |

## Implementation Details

### Task 9: Thread-Based Clarifying Conversations

When the first clarifying question is needed for a request, the bot creates a thread on the acknowledgment message:

```typescript
async createClarifyingThread(
  channelId: string,
  messageId: string,
  requestId: string
): Promise<ThreadChannel> {
  const channel = await this.client.getClient().channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error('Channel not found or not text-based');

  const message = await (channel as TextChannel).messages.fetch(messageId);
  const thread = await message.startThread({
    name: `${requestId} - Clarification`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
  });

  // Store thread ID for future use
  await this.db.updateRequest(requestId, {
    notification_config: JSON.stringify({
      ...JSON.parse(request.notification_config),
      routes: [{
        channelType: 'discord',
        threadId: thread.id,
        platformChannelId: channelId,
      }],
    }),
  });

  return thread;
}
```

**Thread reuse**: Once a thread is created for a request, all subsequent messages for that request use `thread.send()` via the stored `threadId`. A new thread is NOT created per question.

**Thread naming**: `{request_id} - Clarification` (e.g., "REQ-000042 - Clarification").

**Thread auto-archive**: Set to 1 day (`ThreadAutoArchiveDuration.OneDay`).

**Thread ID persistence**: Stored in both:
1. `ConversationMessage.thread_id` for message-level tracking.
2. `request.notification_config.routes[].threadId` for future notification routing.

### Task 11: Platform Rate Limit Awareness

```typescript
class DiscordRateLimitHandler {
  private buckets: Map<string, BucketState> = new Map();

  async executeWithRateLimit<T>(
    bucketKey: string,
    fn: () => Promise<T>
  ): Promise<T> {
    // Check if this bucket is currently rate-limited
    const bucket = this.buckets.get(bucketKey);
    if (bucket && bucket.remaining === 0 && Date.now() < bucket.resetAt) {
      const waitMs = bucket.resetAt - Date.now();
      logger.warn('Discord rate limit hit, waiting', { bucket: bucketKey, waitMs });
      await new Promise(r => setTimeout(r, waitMs));
    }

    try {
      const result = await fn();
      return result;
    } catch (error) {
      if (error instanceof DiscordAPIError && error.status === 429) {
        const retryAfter = (error as any).retryAfter ?? 5000;
        logger.warn('Discord 429 response', { retryAfter, bucket: bucketKey });
        await new Promise(r => setTimeout(r, retryAfter));
        return fn(); // Retry once
      }
      throw error;
    }
  }

  updateFromHeaders(bucketKey: string, headers: {
    'x-ratelimit-remaining'?: string;
    'x-ratelimit-reset'?: string;
    'x-ratelimit-bucket'?: string;
  }): void {
    const remaining = parseInt(headers['x-ratelimit-remaining'] ?? '', 10);
    const resetAt = parseFloat(headers['x-ratelimit-reset'] ?? '') * 1000;
    if (!isNaN(remaining) && !isNaN(resetAt)) {
      this.buckets.set(bucketKey, { remaining, resetAt });
    }
  }
}

interface BucketState {
  remaining: number;
  resetAt: number; // Unix timestamp in ms
}
```

**Global rate limit**: Discord enforces a 50 requests/second global limit. The handler respects this by integrating with the shared `withRetry` utility (from PLAN-008-1) for 429 and 5xx errors.

**Backoff strategy**: Exponential backoff with jitter via the shared `withRetry` utility:
- Base: 1s
- Max: 60s
- Jitter: +/- 25%
- Max attempts: 5

### Task 12: Bot Startup Recovery

```typescript
async startupRecovery(): Promise<void> {
  const pendingPrompts = await this.db.getPendingPrompts();
  const discordPrompts = pendingPrompts.filter(p =>
    p.channel === 'discord' && new Date(p.timeout_at) > new Date()
  );

  for (const prompt of discordPrompts) {
    try {
      const target: MessageTarget = {
        channelType: 'discord',
        platformChannelId: prompt.platform_channel_id,
        threadId: prompt.thread_id,
      };

      await this.sendMessage(target, {
        channelType: 'discord',
        payload: {
          title: '[Resent] Pending Question',
          description: prompt.content,
          color: 0xf39c12, // Yellow for resent
        },
        fallbackText: `[Resent] ${prompt.content}`,
      });

      logger.info('Re-sent pending prompt after startup', {
        requestId: prompt.request_id,
        messageId: prompt.message_id,
      });
    } catch (error) {
      logger.error('Failed to re-send pending prompt', {
        requestId: prompt.request_id,
        error: error.message,
      });
    }
  }
}
```

**Recovery runs on `start()`** after the gateway connects and commands are registered.

**Filter criteria**: Only re-send prompts where `channel = 'discord'`, `responded = false`, and `timeout_at > now`.

**Prefix**: Resent messages include "[Resent]" in the embed title and fallback text.

### Task 13: Graceful Shutdown

The `shutdown()` method is already defined in the adapter (SPEC-008-3-02). Additional detail:

```typescript
async shutdown(): Promise<void> {
  this.shuttingDown = true;

  // Wait for in-flight interactions to complete (max 10s)
  const deadline = Date.now() + 10_000;
  while (this.inFlightInteractions > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
  }

  if (this.inFlightInteractions > 0) {
    logger.warn('Forcing shutdown with in-flight interactions', {
      count: this.inFlightInteractions,
    });
  }

  // Disconnect the gateway
  await this.client.disconnect();
  logger.info('Discord adapter shutdown complete');
}
```

**Integrates with the core shutdown framework**: The core `setupGracefulShutdown` calls `adapter.shutdown()` on each adapter. The Discord adapter's `shutdown()` handles its own gateway cleanup.

## Acceptance Criteria

1. Thread created on the acknowledgment message when first clarifying question is needed.
2. Thread name includes the request ID.
3. Thread ID stored in both `conversation_messages.thread_id` and `notification_config.routes[].threadId`.
4. Subsequent messages reuse the existing thread (no duplicate thread creation).
5. Rate limit handler reads `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers.
6. When `Remaining` = 0, requests are queued until reset time.
7. 429 responses trigger retry with backoff.
8. Startup recovery re-sends pending prompts with "[Resent]" prefix.
9. Only prompts with `timeout_at > now` and `responded = false` are re-sent.
10. Graceful shutdown waits for in-flight interactions, then disconnects gateway.
11. Forced shutdown (after 10s) disconnects even with pending interactions.

## Test Cases

1. **Thread creation**: Mock channel and message; verify `startThread` called with correct name and auto-archive.
2. **Thread reuse**: Create thread for request, then send second message; verify `thread.send()` used (not `startThread` again).
3. **Thread ID persisted**: After thread creation, verify DB has thread_id in notification_config.
4. **Rate limit: bucket tracking**: Set bucket remaining=1, execute; verify bucket decremented. Set remaining=0, execute; verify wait.
5. **Rate limit: 429 retry**: Mock 429 error with retryAfter=2000; verify function retried after ~2s.
6. **Rate limit: header parsing**: Pass headers `x-ratelimit-remaining: 5, x-ratelimit-reset: 1700000000.5`; verify bucket state updated.
7. **Recovery: pending prompts re-sent**: Insert 2 pending discord prompts (one not expired, one expired); verify only the non-expired one re-sent with "[Resent]" prefix.
8. **Recovery: no pending prompts**: Empty conversation_messages; verify no sends attempted.
9. **Recovery: failed re-send**: Mock sendMessage to throw; verify error logged but no crash (other prompts still processed).
10. **Shutdown: clean**: No in-flight interactions; verify `disconnect()` called immediately.
11. **Shutdown: wait for in-flight**: 1 in-flight interaction; verify shutdown waits then disconnects.
12. **Shutdown: forced after timeout**: In-flight interaction never completes; verify disconnect after 10s with warning log.

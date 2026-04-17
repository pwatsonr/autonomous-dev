# SPEC-008-5-01: NotificationEngine, Verbosity Filtering & Delivery Retry

## Metadata
- **Parent Plan**: PLAN-008-5
- **Tasks Covered**: Task 1, Task 2, Task 3, Task 4
- **Estimated effort**: 14 hours

## Description

Implement the core `NotificationEngine` that subscribes to pipeline phase-transition events, resolves notification targets, selects the appropriate formatter per channel, and delivers with exponential backoff retry. Also implement verbosity filtering (silent/summary/verbose/debug) and cross-channel notification routing with per-request route configuration.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/notifications/notification_engine.ts` | Create |

## Implementation Details

### Task 1: NotificationEngine Class

```typescript
class NotificationEngine {
  constructor(
    private db: Repository,
    private adapters: Map<ChannelType, IntakeAdapter>,
    private formatters: Map<ChannelType, NotificationFormatter>,
  ) {}

  async onPhaseTransition(event: PhaseTransitionEvent): Promise<void> {
    const request = await this.db.getRequest(event.requestId);
    if (!request) {
      logger.warn('Notification for unknown request', { requestId: event.requestId });
      return;
    }

    const config: NotificationConfig = JSON.parse(request.notification_config);

    // Check verbosity filter
    if (!this.shouldNotify(config.verbosity ?? 'summary', event)) {
      return;
    }

    // Resolve targets
    const targets = this.resolveTargets(request, config);

    // Format and deliver per target
    for (const target of targets) {
      const formatter = this.formatters.get(target.channelType);
      if (!formatter) {
        logger.warn('No formatter for channel type', { channelType: target.channelType });
        continue;
      }

      const adapter = this.adapters.get(target.channelType);
      if (!adapter) {
        logger.warn('Adapter unavailable for channel type', { channelType: target.channelType });
        continue;
      }

      const message = formatter.formatPhaseTransition(request, event);
      await this.deliverWithRetry(adapter, target, message, event.requestId);
    }

    // Log notification
    await this.db.insertActivityLog({
      request_id: event.requestId,
      event: 'notification_sent',
      phase: event.toPhase,
      details: JSON.stringify({ targets: targets.map(t => t.channelType) }),
    });
  }

  // Also handle: onBlockerDetected, onRequestCompleted, onRequestFailed
  async onBlockerDetected(requestId: string, description: string): Promise<void> { /* similar pattern */ }
  async onRequestCompleted(requestId: string, artifacts: ArtifactLinks): Promise<void> { /* similar pattern */ }
  async onRequestFailed(requestId: string, error: string): Promise<void> { /* similar pattern */ }
}
```

### Task 2: Verbosity Filtering

```typescript
private shouldNotify(verbosity: VerbosityLevel, event: PhaseTransitionEvent | any): boolean {
  switch (verbosity) {
    case 'silent':
      return false;
    case 'summary':
      return this.isPhaseTransition(event);
    case 'verbose':
      return true; // Phase transitions + sub-steps
    case 'debug':
      return true; // Everything including agent reasoning
    default:
      return this.isPhaseTransition(event);
  }
}

private isPhaseTransition(event: any): boolean {
  return event.type === 'phase_transition' ||
    event.type === 'request_completed' ||
    event.type === 'request_failed' ||
    event.type === 'blocker_detected';
}
```

**Default verbosity**: `summary` (notify on phase transitions, completion, failure, and blockers; skip sub-step progress updates).

**Verbosity is per-request**: Each request's `notification_config.verbosity` field controls its own notification level.

### Task 3: Notification Routing

```typescript
private resolveTargets(request: RequestEntity, config: NotificationConfig): MessageTarget[] {
  if (config.routes && config.routes.length > 0) {
    return config.routes.map(route => ({
      channelType: route.channelType,
      platformChannelId: route.platformChannelId,
      threadId: route.threadId,
    }));
  }

  // Default: route to the request's source channel
  return [{
    channelType: request.source_channel as ChannelType,
    platformChannelId: request.source_platform_channel_id,
    threadId: request.source_thread_id,
  }];
}
```

**Cross-channel routing**: A request submitted via Slack can have routes targeting Discord and Claude App channels. Each route specifies the `channelType`, `platformChannelId`, and optional `threadId`.

**Phase filtering**: Each route can optionally specify `events: string[]` to only receive notifications for specific phases. If `events` is null/undefined, all notifications are sent.

```typescript
// Enhanced routing with phase filter
private resolveTargets(request: RequestEntity, config: NotificationConfig, event?: any): MessageTarget[] {
  const allRoutes = config.routes?.length > 0
    ? config.routes
    : [{ channelType: request.source_channel, platformChannelId: request.source_platform_channel_id }];

  return allRoutes
    .filter(route => {
      if (!route.events || route.events.length === 0) return true;
      return route.events.includes(event?.toPhase ?? event?.type);
    })
    .map(route => ({
      channelType: route.channelType as ChannelType,
      platformChannelId: route.platformChannelId,
      threadId: route.threadId,
    }));
}
```

### Task 4: Delivery with Retry

```typescript
private async deliverWithRetry(
  adapter: IntakeAdapter,
  target: MessageTarget,
  message: FormattedMessage,
  requestId: string,
  maxRetries: number = 3
): Promise<void> {
  // Deduplication check
  const payloadHash = this.computePayloadHash(message);
  const existing = await this.db.findDuplicateDelivery(requestId, payloadHash);
  if (existing && existing.status === 'delivered') {
    logger.debug('Duplicate notification skipped', { requestId, payloadHash });
    return;
  }

  // Record delivery attempt
  const deliveryId = await this.db.insertDelivery({
    request_id: requestId,
    channel_type: target.channelType,
    target: JSON.stringify(target),
    payload_hash: payloadHash,
    status: 'pending',
    attempts: 0,
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const receipt = await adapter.sendMessage(target, message);

      if (receipt.success) {
        await this.db.updateDeliveryStatus(deliveryId, 'delivered');
        return;
      }

      if (!receipt.retryable) {
        await this.db.updateDeliveryStatus(deliveryId, 'failed', receipt.error);
        await this.db.insertActivityLog({
          request_id: requestId,
          event: 'notification_failed',
          details: JSON.stringify({ error: receipt.error, attempt }),
        });
        return;
      }
    } catch (error) {
      if (attempt === maxRetries) {
        await this.db.updateDeliveryStatus(deliveryId, 'failed', error.message);
        return;
      }
    }

    // Exponential backoff: 1s, 2s, 4s
    const backoffMs = Math.pow(2, attempt) * 1000;
    await new Promise(r => setTimeout(r, backoffMs));
  }
}

private computePayloadHash(message: FormattedMessage): string {
  const content = JSON.stringify(message);
  return crypto.createHash('sha256').update(content).digest('hex');
}
```

**Backoff schedule**: 1s, 2s, 4s (exponential, 3 retries max).

**Non-retryable failures**: Logged to activity log and abandoned immediately (no retry).

**Deduplication**: SHA-256 hash of the serialized `FormattedMessage`. If a delivery with the same `request_id` and `payload_hash` already succeeded, skip.

**`notification_deliveries` table tracking**:
- `status`: `pending` -> `delivered` (success) or `failed` (non-retryable or max retries).
- `attempts`: Incremented per attempt.
- `delivered_at`: Set on successful delivery.

## Acceptance Criteria

1. `onPhaseTransition` fetches request, checks verbosity, resolves targets, formats per channel, and delivers.
2. `silent` verbosity produces zero notifications.
3. `summary` verbosity notifies on phase transitions, completion, failure, and blockers.
4. `verbose` notifies on everything (including sub-steps).
5. `debug` same as verbose but includes agent reasoning in metadata.
6. Default verbosity is `summary` when not configured.
7. Cross-channel routing: Slack-submitted request with Discord route -> Discord adapter receives notification.
8. Phase filtering: Route with `events: ['execution']` only receives execution phase notifications.
9. Default routing: No routes configured -> notification sent to source channel.
10. Retry: first attempt fails (retryable), second succeeds -> delivery marked as `delivered`.
11. Retry: all 3 attempts fail -> delivery marked as `failed`, activity log entry created.
12. Non-retryable failure: immediately marked as `failed`, no retry.
13. Deduplication: same payload hash for same request -> second delivery skipped.
14. Missing adapter handled gracefully (logged warning, no crash).
15. Missing formatter handled gracefully (logged warning, no crash).

## Test Cases

1. **Verbosity: silent**: Set verbosity to `silent`; emit phase transition; verify no adapter `sendMessage` call.
2. **Verbosity: summary phase transition**: Set to `summary`; emit phase transition; verify `sendMessage` called.
3. **Verbosity: summary sub-step**: Set to `summary`; emit sub-step event; verify `sendMessage` NOT called.
4. **Verbosity: verbose sub-step**: Set to `verbose`; emit sub-step; verify `sendMessage` called.
5. **Verbosity: default**: No verbosity set; verify behaves as `summary`.
6. **Routing: single route**: Route to discord channel X; verify discord adapter receives message for channel X.
7. **Routing: multiple routes**: Routes to discord and slack; verify both adapters called.
8. **Routing: cross-channel**: Request from `claude_app`, route to `discord`; verify discord adapter called, NOT claude adapter.
9. **Routing: phase filter**: Route with `events: ['execution']`; emit `tdd_review` event; verify route skipped.
10. **Routing: default fallback**: No routes configured; verify source channel adapter called.
11. **Retry: success on second attempt**: First `sendMessage` returns `{ success: false, retryable: true }`, second returns `{ success: true }`; verify 2 calls, delivery status `delivered`.
12. **Retry: max retries exhausted**: All 4 attempts (initial + 3 retries) fail; verify delivery status `failed`, activity log entry.
13. **Retry: non-retryable**: First attempt returns `{ success: false, retryable: false }`; verify 1 call, delivery status `failed`.
14. **Retry: backoff timing**: Verify delays between retries are ~1s, ~2s, ~4s (with tolerance).
15. **Deduplication**: Deliver message, then call again with same payload; verify second call skipped.
16. **Missing adapter**: Route to `discord` but no discord adapter registered; verify warning logged, no crash.
17. **Activity log**: After notification delivery, verify activity log entry with correct fields.

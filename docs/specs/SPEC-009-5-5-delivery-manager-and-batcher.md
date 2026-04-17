# SPEC-009-5-5: Delivery Manager and Notification Batcher

## Metadata
- **Parent Plan**: PLAN-009-5
- **Tasks Covered**: Task 12 (Implement Delivery Manager with Fallback Chain), Task 13 (Implement Notification Batcher)
- **Estimated effort**: 8 hours

## Description

Implement the delivery manager that orchestrates notification delivery with a fallback chain (configured -> CLI -> file_drop -> pipeline pause), and the notification batcher that accumulates non-urgent notifications and flushes them at configurable intervals or buffer size limits. Together these ensure reliable delivery: the fallback chain guarantees that notifications are never silently lost, and the batcher reduces notification noise for non-urgent events.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/notifications/delivery-manager.ts` | Create | Delivery orchestration with fallback chain |
| `src/notifications/batcher.ts` | Create | Non-urgent notification batching and flush |

## Implementation Details

### delivery-manager.ts

```typescript
export class DeliveryManager {
  constructor(
    private adapters: Map<DeliveryMethod, DeliveryAdapter>,
    private defaultMethod: DeliveryMethod,
    private perTypeOverrides: Map<NotificationEventType, DeliveryMethod>,
    private onAllFailed: () => void,    // Callback to pause pipeline
  ) {}

  // Deliver a single notification through the fallback chain
  deliver(payload: NotificationPayload): DeliveryResult;

  // Deliver a batch through the fallback chain
  deliverBatch(payloads: NotificationPayload[]): DeliveryResult;
}
```

#### Fallback Chain (TDD Section 3.5.1)

```
function deliver(payload):
  // Step 1: Determine configured method
  method = perTypeOverrides.get(payload.event_type) ?? defaultMethod

  // Step 2: Try configured method
  adapter = adapters.get(method)
  if adapter:
    result = adapter.deliver(payload)
    if result.success: return result

  // Step 3: Fallback to CLI
  if method !== "cli":
    cliAdapter = adapters.get("cli")
    if cliAdapter:
      result = cliAdapter.deliver(payload)
      if result.success: return result

  // Step 4: Fallback to file_drop
  if method !== "file_drop":
    fileAdapter = adapters.get("file_drop")
    if fileAdapter:
      result = fileAdapter.deliver(payload)
      if result.success: return result

  // Step 5: All failed -- signal pipeline to pause (NFR-10)
  onAllFailed()
  return { success: false, method: "none", formattedOutput: "", error: "All delivery methods failed" }
```

Per-type overrides allow sending escalations to Slack, pipeline completions to Discord, etc. If the per-type method fails, the same fallback chain applies.

### batcher.ts

```typescript
export class NotificationBatcher {
  constructor(
    private config: BatchingConfig,
    private deliveryManager: DeliveryManager,
    private timer: Timer,                    // Injectable for testing
  ) {}

  // Submit a notification for potential batching
  submit(payload: NotificationPayload): void;

  // Force flush the buffer (e.g., at DND end or shutdown)
  flush(): void;

  // Get current buffer size
  getBufferSize(): number;

  // Cleanup: cancel timer
  destroy(): void;
}
```

#### Batching Rules (TDD Section 3.5.2)

1. **Exempt types**: `escalation` and `pipeline_failed` are NEVER batched. They are delivered immediately via `deliveryManager.deliver()`.
2. **Immediate urgency**: NEVER batched regardless of type. Delivered immediately.
3. **All other notifications**: added to buffer.
4. **Flush triggers**:
   a. Timer fires at `config.flushIntervalMinutes` interval (default: 60 minutes).
   b. Buffer reaches `config.maxBufferSize` (default: 50 notifications).
5. **Flush behavior**: group buffered notifications by `request_id` and `event_type`, then call `deliveryManager.deliverBatch(group)` for each group.

#### Internal Buffer

```typescript
private buffer: NotificationPayload[] = [];
private flushTimer: TimerHandle | null = null;
```

On first non-exempt notification added to buffer, start the flush timer. Timer resets on each flush. On `destroy()`, cancel the timer and flush remaining buffer.

#### Grouping for Batch Delivery

```typescript
function groupForBatch(notifications: NotificationPayload[]): NotificationPayload[][] {
  const groups = new Map<string, NotificationPayload[]>();
  for (const n of notifications) {
    const key = `${n.request_id}:${n.event_type}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }
  return Array.from(groups.values());
}
```

## Acceptance Criteria

1. Configured delivery method tried first.
2. CLI fallback used when configured method fails.
3. File_drop fallback used when CLI also fails.
4. Pipeline pauses when all delivery methods fail.
5. Per-type delivery method overrides respected.
6. Exempt types (`escalation`, `pipeline_failed`) never batched -- delivered immediately.
7. `immediate` urgency never batched -- delivered immediately.
8. Non-exempt, non-immediate notifications buffered.
9. Buffer flushed at `flushIntervalMinutes` interval.
10. Buffer flushed when `maxBufferSize` reached.
11. Flushed batch grouped by `request_id` and `event_type`.
12. Timer cancellable via `destroy()`.
13. Remaining buffer flushed on `destroy()`.

## Test Cases

### Delivery Manager

1. **Configured method succeeds** -- Default is `"slack"`; slack adapter succeeds; result from slack returned.
2. **Configured method fails, CLI fallback** -- Slack adapter returns `success: false`; CLI adapter called and succeeds.
3. **Configured and CLI fail, file_drop fallback** -- Both fail; file_drop adapter called and succeeds.
4. **All fail: pipeline pauses** -- All 3 adapters fail; `onAllFailed` callback invoked.
5. **Per-type override: escalation to slack** -- Override `escalation -> slack`; escalation delivered via slack.
6. **Per-type override fails, fallback chain** -- Override adapter fails; CLI fallback used.
7. **Batch delivery uses same fallback** -- `deliverBatch` follows same chain as single delivery.

### Notification Batcher

8. **Exempt type delivered immediately** -- Submit `{ event_type: "escalation" }`; `deliveryManager.deliver()` called immediately; buffer unchanged.
9. **Immediate urgency delivered immediately** -- Submit `{ urgency: "immediate", event_type: "trust_level_changed" }`; delivered immediately.
10. **Non-exempt buffered** -- Submit `{ event_type: "pipeline_completed", urgency: "informational" }`; not delivered; `getBufferSize()` returns 1.
11. **Buffer flushed at interval** -- Add 3 notifications. Advance mock timer by `flushIntervalMinutes`. `deliverBatch` called with grouped notifications. Buffer empty.
12. **Buffer flushed at max size** -- Set `maxBufferSize: 5`. Submit 5 notifications. On 5th, buffer flushed automatically.
13. **Grouping** -- Buffer has 4 notifications: 2 for `req-1:pipeline_completed` and 2 for `req-2:trust_level_changed`. Flush produces 2 batch calls.
14. **Timer starts on first buffer entry** -- Before any buffered notification, no timer running. After first buffered notification, timer active.
15. **Timer resets on flush** -- After flush, timer restarts for next interval.
16. **Destroy cancels timer** -- `destroy()` cancels active timer.
17. **Destroy flushes remaining** -- `destroy()` with 3 buffered notifications triggers flush before cancel.
18. **pipeline_failed exempt** -- `{ event_type: "pipeline_failed" }` delivered immediately (exempt).

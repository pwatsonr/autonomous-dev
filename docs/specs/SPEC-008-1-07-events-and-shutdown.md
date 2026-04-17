# SPEC-008-1-07: Event Bus, Internal Event Contract & Graceful Shutdown

## Metadata
- **Parent Plan**: PLAN-008-1
- **Tasks Covered**: Task 14, Task 15
- **Estimated effort**: 5 hours

## Description

Define the typed internal event contract (`IntakeEvent` and `PipelineEvent` discriminated unions), implement a simple typed EventEmitter-based event bus, and build the graceful shutdown framework that stops accepting commands, drains in-flight work, and checkpoints the WAL before exiting.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/events/event_types.ts` | Create |
| `intake/events/event_bus.ts` | Create |
| `intake/core/shutdown.ts` | Create |

## Implementation Details

### Task 14: Internal Event Contract and Event Bus

**Intake events (emitted by the intake layer to the pipeline core):**

```typescript
type IntakeEvent =
  | { type: 'request_submitted'; requestId: string; request: RequestEntity }
  | { type: 'request_cancelled'; requestId: string; cleanupRequested: boolean }
  | { type: 'request_paused'; requestId: string }
  | { type: 'request_resumed'; requestId: string; resumeAtPhase: string }
  | { type: 'priority_changed'; requestId: string; oldPriority: Priority; newPriority: Priority }
  | { type: 'feedback_received'; requestId: string; userId: string; content: string }
  | { type: 'kill_all'; initiatedBy: string; timestamp: Date }
  | { type: 'human_response'; requestId: string; messageId: string; response: UserResponse };
```

**Pipeline events (consumed from the pipeline core):**

```typescript
type PipelineEvent =
  | { type: 'phase_transition'; requestId: string; fromPhase: string; toPhase: string; timestamp: Date; metadata: PhaseTransitionMetadata }
  | { type: 'blocker_detected'; requestId: string; description: string }
  | { type: 'human_input_needed'; requestId: string; prompt: StructuredPrompt }
  | { type: 'request_completed'; requestId: string; artifacts: ArtifactLinks }
  | { type: 'request_failed'; requestId: string; error: string };

interface PhaseTransitionMetadata {
  progress?: { current: number; total: number };
  artifactUrl?: string;
  blocker?: string;
  agentReasoning?: string;
}

interface ArtifactLinks {
  prdPr?: string;
  tddPr?: string;
  codePr?: string;
  branch?: string;
}
```

**Event bus implementation:**

```typescript
type EventMap = {
  intake: IntakeEvent;
  pipeline: PipelineEvent;
};

class TypedEventBus {
  private emitter = new EventEmitter();

  subscribe<K extends keyof EventMap>(
    channel: K,
    handler: (event: EventMap[K]) => void | Promise<void>
  ): () => void {
    this.emitter.on(channel, handler);
    return () => this.emitter.off(channel, handler);
  }

  async emit<K extends keyof EventMap>(channel: K, event: EventMap[K]): Promise<void> {
    this.emitter.emit(channel, event);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
```

**Key design rules:**
- The bus uses Node.js `EventEmitter` internally but wraps it with typed subscribe/emit.
- `subscribe` returns an unsubscribe function (disposable pattern).
- Handlers can be async; errors in handlers are caught and logged (do not crash the bus).
- The bus is a singleton per intake layer instance.
- Each handler must emit the corresponding `IntakeEvent` after successful execution (wired in the handler implementations from SPEC-008-1-06).

### Task 15: Graceful Shutdown

```typescript
function setupGracefulShutdown(
  adapters: IntakeAdapter[],
  eventBus: TypedEventBus,
  db: Repository,
  starvationMonitor: StarvationMonitor,
  digestScheduler?: DigestScheduler
): void {
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('Shutdown signal received, beginning graceful shutdown');

    // 1. Stop starvation monitor and digest scheduler
    starvationMonitor.stop();
    digestScheduler?.stop();

    // 2. Signal all adapters to stop accepting new commands
    await Promise.allSettled(adapters.map(a => a.shutdown()));

    // 3. Remove all event listeners
    eventBus.removeAllListeners();

    // 4. Flush database WAL
    db.checkpoint();

    logger.info('Graceful shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
```

**Shutdown order:**
1. Stop background timers (starvation monitor, digest scheduler) to prevent new work.
2. Signal all adapters to stop accepting new commands and wait for in-flight commands to complete (each adapter's `shutdown()` handles this with a timeout).
3. Remove all event bus listeners to prevent stale event processing.
4. Checkpoint the WAL to flush pending writes to the main database file.
5. Log completion and exit.

**Re-entry guard**: The `shuttingDown` boolean prevents double-shutdown from concurrent signals.

**`Promise.allSettled`**: Used instead of `Promise.all` so that one adapter failing to shut down does not prevent others from completing.

## Acceptance Criteria

1. `IntakeEvent` discriminated union covers all 8 event types.
2. `PipelineEvent` discriminated union covers all 5 event types.
3. `TypedEventBus.subscribe('intake', handler)` receives only `IntakeEvent` instances.
4. `TypedEventBus.subscribe('pipeline', handler)` receives only `PipelineEvent` instances.
5. `subscribe` returns a function that, when called, unsubscribes the handler.
6. Errors in event handlers are caught and logged, not propagated.
7. `SIGTERM` triggers the shutdown sequence.
8. `SIGINT` triggers the shutdown sequence.
9. Shutdown stops starvation monitor, signals adapter shutdown, checkpoints WAL, then exits.
10. Double `SIGTERM` does not cause double-shutdown (re-entry guard).
11. If one adapter's `shutdown()` rejects, other adapters still complete shutdown.

## Test Cases

1. **Event bus subscribe and emit**: Subscribe to `'intake'`, emit `{ type: 'request_submitted', ... }`; verify handler called with correct event.
2. **Event bus type discrimination**: Emit `{ type: 'request_paused', requestId: 'REQ-000001' }` on intake channel; verify handler receives it with correct type field.
3. **Event bus unsubscribe**: Subscribe, get unsub function, call it, emit again; verify handler is NOT called the second time.
4. **Event bus error isolation**: Subscribe a handler that throws; emit an event; verify bus does not crash and subsequent events still fire.
5. **Event bus multiple subscribers**: Subscribe 3 handlers to same channel; emit event; verify all 3 called.
6. **Event bus removeAllListeners**: Subscribe 3 handlers, call `removeAllListeners()`, emit; verify none called.
7. **Shutdown sequence**: Mock adapters, starvation monitor, digest scheduler, db; call `SIGTERM` handler; verify stop/shutdown/checkpoint called in order.
8. **Shutdown re-entry**: Call shutdown handler twice; verify adapter `shutdown()` called only once.
9. **Shutdown adapter failure**: One adapter's `shutdown()` rejects; verify other adapters still shut down and checkpoint still runs.
10. **Shutdown WAL checkpoint**: Verify `db.checkpoint()` is called after adapter shutdown completes.

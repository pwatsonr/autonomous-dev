# SPEC-006-5-1: Event Bus, Track State Machine, and Stall Detection

## Metadata
- **Parent Plan**: PLAN-006-5
- **Tasks Covered**: Task 1, Task 2, Task 3
- **Estimated effort**: 12 hours

## Description

Extend the event stub from PLAN-006-1 into a full event bus with typed subscriptions and audit logging. Implement the track state machine that governs lifecycle transitions with validation and timestamp recording. Implement stall detection that monitors agent activity and triggers alerts or termination for inactive tracks.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/parallel/events.ts` | **Modify** | Full EventBus class with typed subscriptions and logging |
| `src/parallel/progress-tracker.ts` | **Create** | Track state machine, stall detection, progress reporting |
| `tests/parallel/progress-tracker.test.ts` | **Create** | State machine, stall detection tests |

## Implementation Details

### 1. Full EventBus (`src/parallel/events.ts`)

Extend the event stubs from SPEC-006-1-2 into a full-featured event bus.

```typescript
// All event types from TDD Appendix B
export type EventType =
  | 'track.state_changed'
  | 'track.stalled'
  | 'worktree.created'
  | 'worktree.removed'
  | 'worktree.disk_warning'
  | 'worktree.disk_critical'
  | 'merge.started'
  | 'merge.completed'
  | 'merge.failed'
  | 'merge.conflict_detected'
  | 'merge.conflict_resolved'
  | 'merge.escalated'
  | 'merge.rolledback'
  | 'merge.integration_reset'
  | 'integration.test_started'
  | 'integration.test_passed'
  | 'integration.test_failed'
  | 'agent.spawned'
  | 'agent.completed'
  | 'agent.failed'
  | 'agent.budget_warning'
  | 'request.progress'
  | 'request.completed'
  | 'request.escalated'
  | 'security.isolation_violation';

export interface BaseEvent {
  type: EventType;
  timestamp: string;
}

export interface TrackStateChangedEvent extends BaseEvent {
  type: 'track.state_changed';
  requestId: string;
  trackName: string;
  from: TrackState;
  to: TrackState;
  reason: string;
}

export interface TrackStalledEvent extends BaseEvent {
  type: 'track.stalled';
  requestId: string;
  trackName: string;
  inactiveMinutes: number;
  action: 'warning' | 'terminated';
}

// ... (all other event interfaces from previous specs)

export type ParallelEvent =
  | TrackStateChangedEvent
  | TrackStalledEvent
  | WorktreeCreatedEvent
  | WorktreeRemovedEvent
  | WorktreeDiskWarningEvent
  | WorktreeDiskCriticalEvent
  // ... all other event types

export type EventHandler<T extends BaseEvent = BaseEvent> = (event: T) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<EventType, Set<EventHandler>>();
  private logStream: fs.WriteStream | null = null;

  constructor(private logDir?: string) {}

  /**
   * Initialize audit logging for a specific request.
   */
  initRequestLog(requestId: string): void {
    if (!this.logDir) return;
    const dir = path.join(this.logDir, `req-${requestId}`);
    fs.mkdirSync(dir, { recursive: true });
    this.logStream = fs.createWriteStream(
      path.join(dir, 'events.log'),
      { flags: 'a' }
    );
  }

  /**
   * Emit an event. Calls all registered handlers asynchronously.
   * Does NOT block the caller -- handler errors are logged but not thrown.
   */
  emit(event: ParallelEvent): void {
    // Log to audit file
    if (this.logStream) {
      this.logStream.write(JSON.stringify(event) + '\n');
    }

    const handlers = this.handlers.get(event.type);
    if (!handlers) return;

    for (const handler of handlers) {
      // Fire-and-forget: don't block on async handlers
      Promise.resolve(handler(event)).catch(err => {
        console.error(`Event handler error for ${event.type}:`, err);
      });
    }
  }

  on<T extends ParallelEvent>(eventType: T['type'], handler: EventHandler<T>): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler as EventHandler);
  }

  off(eventType: EventType, handler: EventHandler): void {
    this.handlers.get(eventType)?.delete(handler);
  }

  /**
   * Remove all handlers. Used in tests and shutdown.
   */
  removeAllListeners(): void {
    this.handlers.clear();
  }

  close(): void {
    this.logStream?.end();
    this.logStream = null;
  }
}
```

### 2. Track state machine

```typescript
export type TrackState =
  | 'pending'
  | 'queued'
  | 'executing'
  | 'testing'
  | 'reviewing'
  | 'merging'
  | 'complete'
  | 'failed'
  | 'escalated';

export interface StateTransition {
  from: TrackState;
  to: TrackState;
  timestamp: string;
  reason: string;
}

// Valid transitions defined as adjacency set
const VALID_TRANSITIONS: Record<TrackState, TrackState[]> = {
  pending:   ['queued'],
  queued:    ['executing', 'failed'],
  executing: ['testing', 'failed', 'escalated'],
  testing:   ['reviewing', 'failed', 'escalated'],
  reviewing: ['merging', 'failed', 'escalated'],
  merging:   ['complete', 'failed', 'escalated'],
  complete:  [],  // terminal state
  failed:    ['queued'],  // can re-queue after failure (retry)
  escalated: [],  // terminal state
};

export class TrackStateMachine {
  private state: TrackState;
  private transitions: StateTransition[] = [];

  constructor(
    private requestId: string,
    private trackName: string,
    private eventBus: EventBus,
    private persister: StatePersister,
    initialState: TrackState = 'pending'
  ) {
    this.state = initialState;
  }

  getState(): TrackState { return this.state; }
  getTransitions(): StateTransition[] { return [...this.transitions]; }

  /**
   * Transition to a new state. Throws if the transition is invalid.
   */
  async transition(to: TrackState, reason: string): Promise<void> {
    const from = this.state;

    if (!VALID_TRANSITIONS[from].includes(to)) {
      throw new InvalidStateTransitionError(
        this.trackName, from, to,
        `Valid transitions from "${from}": [${VALID_TRANSITIONS[from].join(', ')}]`
      );
    }

    const transition: StateTransition = {
      from,
      to,
      timestamp: new Date().toISOString(),
      reason,
    };

    this.state = to;
    this.transitions.push(transition);

    // Emit event
    this.eventBus.emit({
      type: 'track.state_changed',
      requestId: this.requestId,
      trackName: this.trackName,
      from,
      to,
      reason,
      timestamp: transition.timestamp,
    });

    // Persist state (non-blocking; errors logged)
    // The actual persistence is handled by the caller updating the PersistedExecutionState
  }

  /**
   * Check if a transition to the given state is valid.
   */
  canTransition(to: TrackState): boolean {
    return VALID_TRANSITIONS[this.state].includes(to);
  }

  /**
   * Restore from persisted state (for crash recovery).
   */
  static restore(
    requestId: string,
    trackName: string,
    eventBus: EventBus,
    persister: StatePersister,
    state: TrackState,
    transitions: StateTransition[]
  ): TrackStateMachine {
    const sm = new TrackStateMachine(requestId, trackName, eventBus, persister, state);
    sm.transitions = transitions;
    return sm;
  }
}
```

### 3. Stall detection

```typescript
export class StallDetector {
  private lastActivity = new Map<string, number>(); // trackName -> unix timestamp ms
  private monitorInterval: NodeJS.Timeout | null = null;

  constructor(
    private config: ParallelConfig,
    private eventBus: EventBus,
    private onTerminate: (trackName: string) => Promise<void>
  ) {}

  /**
   * Called by agent monitoring to record activity for a track.
   */
  updateActivity(trackName: string): void {
    this.lastActivity.set(trackName, Date.now());
  }

  /**
   * Start periodic stall checking.
   */
  startMonitoring(intervalMs: number = 30_000): void {
    this.monitorInterval = setInterval(() => this.checkAll(), intervalMs);
  }

  stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  /**
   * Register a track for stall monitoring.
   */
  registerTrack(trackName: string): void {
    this.lastActivity.set(trackName, Date.now());
  }

  /**
   * Unregister a completed/failed track.
   */
  unregisterTrack(trackName: string): void {
    this.lastActivity.delete(trackName);
  }

  /**
   * Check all registered tracks for stall conditions.
   */
  private async checkAll(): Promise<void> {
    const now = Date.now();
    const stallTimeoutMs = this.config.stall_timeout_minutes * 60 * 1000;
    const terminateTimeoutMs = stallTimeoutMs * 2;

    for (const [trackName, lastMs] of this.lastActivity) {
      const inactiveMs = now - lastMs;
      const inactiveMinutes = inactiveMs / 60_000;

      if (inactiveMs >= terminateTimeoutMs) {
        // 2x timeout: terminate the agent
        this.eventBus.emit({
          type: 'track.stalled',
          requestId: '', // filled by caller context
          trackName,
          inactiveMinutes: Math.round(inactiveMinutes),
          action: 'terminated',
          timestamp: new Date().toISOString(),
        });

        await this.onTerminate(trackName);
        this.unregisterTrack(trackName);
      } else if (inactiveMs >= stallTimeoutMs) {
        // 1x timeout: warning
        this.eventBus.emit({
          type: 'track.stalled',
          requestId: '',
          trackName,
          inactiveMinutes: Math.round(inactiveMinutes),
          action: 'warning',
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  /**
   * Activity sources: called by different components to signal activity.
   * - Agent tool call: AgentSpawner calls updateActivity after each turn
   * - Git commit: WorktreeManager polls git log -1 --format=%ct in worktree
   * - File modification: watch worktree directory for changes
   */
  async checkGitActivity(trackName: string, worktreePath: string): Promise<boolean> {
    try {
      const commitTime = execSync(
        `git -C "${worktreePath}" log -1 --format=%ct 2>/dev/null`,
        { encoding: 'utf-8' }
      ).trim();
      const commitMs = parseInt(commitTime, 10) * 1000;
      const lastKnown = this.lastActivity.get(trackName) ?? 0;
      if (commitMs > lastKnown) {
        this.updateActivity(trackName);
        return true;
      }
    } catch {
      // No commits yet or worktree gone
    }
    return false;
  }
}
```

## Acceptance Criteria

1. `EventBus.emit` calls all registered handlers and does not block the caller.
2. `EventBus.emit` logs every event to `.autonomous-dev/logs/req-{id}/events.log` as NDJSON.
3. `EventBus.on` supports multiple handlers per event type.
4. `EventBus.off` removes a specific handler.
5. Handler errors are caught and logged, not thrown to the emitter.
6. `TrackStateMachine` enforces valid transitions per the defined adjacency set.
7. `transition('complete')` from `'pending'` throws `InvalidStateTransitionError`.
8. Every transition is recorded as a `StateTransition` with from, to, timestamp, reason.
9. Every transition emits `track.state_changed` event.
10. `canTransition` returns true for valid transitions, false for invalid.
11. `StallDetector` emits `track.stalled` with action `warning` at `stall_timeout_minutes`.
12. `StallDetector` calls `onTerminate` at 2x `stall_timeout_minutes`.
13. `updateActivity` refreshes the activity timestamp, preventing stall alerts.
14. `checkGitActivity` detects new commits as activity signals.
15. Tracks can be registered and unregistered from stall monitoring.

## Test Cases

```
// progress-tracker.test.ts

describe('EventBus', () => {
  it('calls handler on matching event', () => {
    const received: any[] = [];
    bus.on('track.state_changed', (e) => received.push(e));
    bus.emit({ type: 'track.state_changed', requestId: 'r1', trackName: 't1',
               from: 'pending', to: 'queued', reason: 'scheduled', timestamp: 'now' });
    expect(received.length).toBe(1);
  });

  it('supports multiple handlers per event type', () => {
    let count = 0;
    bus.on('track.state_changed', () => count++);
    bus.on('track.state_changed', () => count++);
    bus.emit({ type: 'track.state_changed', ...minimalEvent });
    expect(count).toBe(2);
  });

  it('does not call handler for other event types', () => {
    const received: any[] = [];
    bus.on('merge.started', (e) => received.push(e));
    bus.emit({ type: 'track.state_changed', ...minimalEvent });
    expect(received.length).toBe(0);
  });

  it('off removes handler', () => {
    let count = 0;
    const handler = () => count++;
    bus.on('track.state_changed', handler);
    bus.off('track.state_changed', handler);
    bus.emit({ type: 'track.state_changed', ...minimalEvent });
    expect(count).toBe(0);
  });

  it('handler errors do not propagate', () => {
    bus.on('track.state_changed', () => { throw new Error('handler fail'); });
    expect(() => bus.emit({ type: 'track.state_changed', ...minimalEvent })).not.toThrow();
  });

  it('logs events to file', () => {
    bus.initRequestLog('req-001');
    bus.emit({ type: 'track.state_changed', ...minimalEvent });
    bus.close();
    const logContent = fs.readFileSync(
      path.join(logDir, 'req-req-001', 'events.log'), 'utf-8'
    );
    expect(logContent).toContain('track.state_changed');
  });
});

describe('TrackStateMachine', () => {
  it('starts in pending state', () => {
    expect(sm.getState()).toBe('pending');
  });

  it('allows valid transition: pending -> queued', async () => {
    await sm.transition('queued', 'scheduled');
    expect(sm.getState()).toBe('queued');
  });

  it('allows full happy path', async () => {
    await sm.transition('queued', 'scheduled');
    await sm.transition('executing', 'agent spawned');
    await sm.transition('testing', 'execution complete');
    await sm.transition('reviewing', 'tests passed');
    await sm.transition('merging', 'review passed');
    await sm.transition('complete', 'merge successful');
    expect(sm.getState()).toBe('complete');
  });

  it('rejects invalid transition: pending -> complete', async () => {
    await expect(sm.transition('complete', 'shortcut')).rejects.toThrow(InvalidStateTransitionError);
  });

  it('rejects invalid transition: pending -> executing (must go through queued)', async () => {
    await expect(sm.transition('executing', 'skip queue')).rejects.toThrow(InvalidStateTransitionError);
  });

  it('allows failure from any active state', async () => {
    await sm.transition('queued', 'scheduled');
    await sm.transition('executing', 'agent spawned');
    await sm.transition('failed', 'agent crashed');
    expect(sm.getState()).toBe('failed');
  });

  it('allows re-queue from failed', async () => {
    await sm.transition('queued', 'scheduled');
    await sm.transition('failed', 'error');
    await sm.transition('queued', 'retry');
    expect(sm.getState()).toBe('queued');
  });

  it('records all transitions with timestamps', async () => {
    await sm.transition('queued', 'scheduled');
    await sm.transition('executing', 'agent spawned');
    const transitions = sm.getTransitions();
    expect(transitions.length).toBe(2);
    expect(transitions[0].from).toBe('pending');
    expect(transitions[0].to).toBe('queued');
    expect(transitions[1].from).toBe('queued');
    expect(transitions[1].to).toBe('executing');
  });

  it('emits track.state_changed event', async () => {
    const events: any[] = [];
    bus.on('track.state_changed', e => events.push(e));
    await sm.transition('queued', 'scheduled');
    expect(events[0].from).toBe('pending');
    expect(events[0].to).toBe('queued');
  });

  it('canTransition returns correct results', () => {
    expect(sm.canTransition('queued')).toBe(true);
    expect(sm.canTransition('complete')).toBe(false);
    expect(sm.canTransition('failed')).toBe(false); // pending cannot go to failed directly
  });

  it('restores from persisted state', () => {
    const restored = TrackStateMachine.restore('r1', 't1', bus, persister, 'executing', [
      { from: 'pending', to: 'queued', timestamp: '2026-01-01', reason: 'test' },
      { from: 'queued', to: 'executing', timestamp: '2026-01-01', reason: 'test' },
    ]);
    expect(restored.getState()).toBe('executing');
    expect(restored.getTransitions().length).toBe(2);
  });
});

describe('StallDetector', () => {
  it('emits warning at stall timeout', async () => {
    const events: any[] = [];
    bus.on('track.stalled', e => events.push(e));

    detector.registerTrack('track-a');
    // Simulate passage of time: set lastActivity to 16 minutes ago
    detector['lastActivity'].set('track-a', Date.now() - 16 * 60 * 1000);
    await detector['checkAll']();

    expect(events.length).toBe(1);
    expect(events[0].action).toBe('warning');
  });

  it('terminates at 2x stall timeout', async () => {
    let terminated = false;
    const detector = new StallDetector(config, bus, async () => { terminated = true; });
    detector.registerTrack('track-a');
    detector['lastActivity'].set('track-a', Date.now() - 31 * 60 * 1000);
    await detector['checkAll']();

    expect(terminated).toBe(true);
  });

  it('does not alert for recently active tracks', async () => {
    const events: any[] = [];
    bus.on('track.stalled', e => events.push(e));

    detector.registerTrack('track-a');
    detector.updateActivity('track-a'); // just now
    await detector['checkAll']();

    expect(events.length).toBe(0);
  });

  it('updateActivity prevents stall alert', async () => {
    detector.registerTrack('track-a');
    // Set old activity
    detector['lastActivity'].set('track-a', Date.now() - 14 * 60 * 1000);
    // Update to now
    detector.updateActivity('track-a');
    await detector['checkAll']();
    // No stall alert since last activity is recent
  });

  it('unregisterTrack stops monitoring', async () => {
    detector.registerTrack('track-a');
    detector.unregisterTrack('track-a');
    detector['lastActivity'].set('track-a', Date.now() - 100 * 60 * 1000);
    // The track was unregistered, so it won't be checked
    expect(detector['lastActivity'].has('track-a')).toBe(false);
  });
});
```

/**
 * Event Bus and event type definitions for the parallel execution engine.
 *
 * Provides a full-featured event bus with typed subscriptions, audit logging
 * to NDJSON files, and fire-and-forget async handler execution.
 *
 * Based on SPEC-006-1-2 Section 5 and SPEC-006-5-1 Task 1.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Track state type (needed by TrackStateChangedEvent)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Event type enumeration
// ---------------------------------------------------------------------------

/** Union of all event type strings emitted by the parallel execution engine. */
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

// ---------------------------------------------------------------------------
// Base event interface
// ---------------------------------------------------------------------------

export interface BaseEvent {
  type: EventType;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Track lifecycle events (SPEC-006-5-1)
// ---------------------------------------------------------------------------

/** Emitted when a track transitions between lifecycle states. */
export interface TrackStateChangedEvent extends BaseEvent {
  type: 'track.state_changed';
  requestId: string;
  trackName: string;
  from: TrackState;
  to: TrackState;
  reason: string;
}

/** Emitted when a track is detected as stalled. */
export interface TrackStalledEvent extends BaseEvent {
  type: 'track.stalled';
  requestId: string;
  trackName: string;
  inactiveMinutes: number;
  action: 'warning' | 'terminated';
}

// ---------------------------------------------------------------------------
// Worktree lifecycle events
// ---------------------------------------------------------------------------

/** Emitted when a new worktree is successfully created. */
export interface WorktreeCreatedEvent extends BaseEvent {
  type: 'worktree.created';
  requestId: string;
  trackName: string;
  worktreePath: string;
}

/** Emitted when a worktree is successfully removed. */
export interface WorktreeRemovedEvent extends BaseEvent {
  type: 'worktree.removed';
  requestId: string;
  trackName: string;
}

// ---------------------------------------------------------------------------
// Disk monitoring events
// ---------------------------------------------------------------------------

/** Emitted when total worktree disk usage crosses the warning threshold. */
export interface WorktreeDiskWarningEvent extends BaseEvent {
  type: 'worktree.disk_warning';
  totalBytes: number;
  thresholdBytes: number;
}

/** Emitted when total worktree disk usage crosses the hard limit. */
export interface WorktreeDiskCriticalEvent extends BaseEvent {
  type: 'worktree.disk_critical';
  totalBytes: number;
  thresholdBytes: number;
}

// ---------------------------------------------------------------------------
// Merge lifecycle events (SPEC-006-4-1)
// ---------------------------------------------------------------------------

/** Emitted when a track merge starts. */
export interface MergeStartedEvent extends BaseEvent {
  type: 'merge.started';
  requestId: string;
  trackName: string;
  integrationBranch: string;
  trackBranch: string;
}

/** Emitted when a track merge completes successfully. */
export interface MergeCompletedEvent extends BaseEvent {
  type: 'merge.completed';
  trackName: string;
  integrationBranch: string;
  trackBranch: string;
  mergeCommitSha: string | null;
  conflictCount: number;
  resolutionStrategy: string;
  resolutionDurationMs: number;
}

/** Emitted when a track merge fails. */
export interface MergeFailedEvent extends BaseEvent {
  type: 'merge.failed';
  requestId: string;
  trackName: string;
  reason: string;
}

/** Emitted when a merge conflict is detected in a file. */
export interface MergeConflictDetectedEvent extends BaseEvent {
  type: 'merge.conflict_detected';
  requestId: string;
  trackName: string;
  file: string;
}

/** Emitted when a merge conflict is resolved. */
export interface MergeConflictResolvedEvent extends BaseEvent {
  type: 'merge.conflict_resolved';
  requestId: string;
  trackName: string;
  file: string;
  strategy: string;
}

// ---------------------------------------------------------------------------
// Escalation and rollback events (SPEC-006-4-3)
// ---------------------------------------------------------------------------

/** Emitted when a conflict is escalated to a human for resolution. */
export interface MergeEscalatedEvent extends BaseEvent {
  type: 'merge.escalated';
  requestId: string;
  file: string;
  trackA: string;
  trackB: string;
  reportPath: string;
}

/** Emitted when a single track's merge commit is reverted. */
export interface MergeRolledbackEvent extends BaseEvent {
  type: 'merge.rolledback';
  requestId: string;
  trackName: string;
  revertedCommit: string;
}

/** Emitted when an entire integration branch is reset to the branch point. */
export interface MergeIntegrationResetEvent extends BaseEvent {
  type: 'merge.integration_reset';
  requestId: string;
  resetToCommit: string;
}

// ---------------------------------------------------------------------------
// Integration test events
// ---------------------------------------------------------------------------

/** Emitted when integration tests start. */
export interface IntegrationTestStartedEvent extends BaseEvent {
  type: 'integration.test_started';
  requestId: string;
}

/** Emitted when integration tests pass. */
export interface IntegrationTestPassedEvent extends BaseEvent {
  type: 'integration.test_passed';
  requestId: string;
}

/** Emitted when integration tests fail. */
export interface IntegrationTestFailedEvent extends BaseEvent {
  type: 'integration.test_failed';
  requestId: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Agent lifecycle events (SPEC-006-3-1)
// ---------------------------------------------------------------------------

/** Emitted when an agent is spawned for a track. */
export interface AgentSpawnedEvent extends BaseEvent {
  type: 'agent.spawned';
  requestId: string;
  trackName: string;
  sessionId: string;
}

/** Emitted when an agent completes its work successfully. */
export interface AgentCompletedEvent extends BaseEvent {
  type: 'agent.completed';
  requestId: string;
  trackName: string;
  sessionId: string;
}

/** Emitted when an agent crashes or becomes unresponsive. */
export interface AgentFailedEvent extends BaseEvent {
  type: 'agent.failed';
  trackName: string;
  sessionId: string;
  reason: 'agent_crash' | 'budget_exceeded' | 'unknown';
  hasPartialWork: boolean;
}

// ---------------------------------------------------------------------------
// Agent budget events (SPEC-006-3-2)
// ---------------------------------------------------------------------------

/** Emitted when an agent hits 90% (warning) or 100% (terminated) of its turn budget. */
export interface AgentBudgetWarningEvent extends BaseEvent {
  type: 'agent.budget_warning';
  trackName: string;
  turnsUsed: number;
  turnBudget: number;
  action: 'warning' | 'terminated';
}

// ---------------------------------------------------------------------------
// Security events (SPEC-006-3-2)
// ---------------------------------------------------------------------------

/** Emitted when an agent attempts to access a path outside its worktree. */
export interface SecurityIsolationViolationEvent extends BaseEvent {
  type: 'security.isolation_violation';
  trackName: string;
  toolName: string;
  attemptedPath: string;
  worktreePath: string;
}

// ---------------------------------------------------------------------------
// Request-level events
// ---------------------------------------------------------------------------

/** Emitted for request-level progress updates. */
export interface RequestProgressEvent extends BaseEvent {
  type: 'request.progress';
  requestId: string;
  completedTracks: number;
  totalTracks: number;
  message: string;
}

/** Emitted when a request completes all tracks. */
export interface RequestCompletedEvent extends BaseEvent {
  type: 'request.completed';
  requestId: string;
}

/** Emitted when a circuit breaker trips for a request (merge or integration test). */
export interface RequestEscalatedEvent extends BaseEvent {
  type: 'request.escalated';
  requestId: string;
  reason: string;
  /** Present when escalated by the merge circuit breaker. */
  unresolvedConflicts?: number;
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

/** Union of all parallel execution events. */
export type ParallelEvent =
  | TrackStateChangedEvent
  | TrackStalledEvent
  | WorktreeCreatedEvent
  | WorktreeRemovedEvent
  | WorktreeDiskWarningEvent
  | WorktreeDiskCriticalEvent
  | MergeStartedEvent
  | MergeCompletedEvent
  | MergeFailedEvent
  | MergeConflictDetectedEvent
  | MergeConflictResolvedEvent
  | MergeEscalatedEvent
  | MergeRolledbackEvent
  | MergeIntegrationResetEvent
  | IntegrationTestStartedEvent
  | IntegrationTestPassedEvent
  | IntegrationTestFailedEvent
  | AgentSpawnedEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | AgentBudgetWarningEvent
  | SecurityIsolationViolationEvent
  | RequestProgressEvent
  | RequestCompletedEvent
  | RequestEscalatedEvent;

// ---------------------------------------------------------------------------
// Event handler type
// ---------------------------------------------------------------------------

export type EventHandler<T extends BaseEvent = BaseEvent> = (event: T) => void | Promise<void>;

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

/**
 * Full-featured event bus for the parallel execution engine.
 *
 * - Typed subscriptions via `on<T>(eventType, handler)`
 * - Audit logging to NDJSON files per request
 * - Fire-and-forget async handler execution (errors logged, not thrown)
 */
export class EventBus {
  private handlers = new Map<EventType, Set<EventHandler>>();
  private logStream: fs.WriteStream | null = null;

  constructor(private logDir?: string) {}

  /**
   * Initialize audit logging for a specific request.
   * Creates the log directory and opens an append-mode write stream
   * for `.autonomous-dev/logs/req-{id}/events.log`.
   */
  initRequestLog(requestId: string): void {
    if (!this.logDir) return;
    const dir = path.join(this.logDir, `req-${requestId}`);
    fs.mkdirSync(dir, { recursive: true });
    this.logStream = fs.createWriteStream(
      path.join(dir, 'events.log'),
      { flags: 'a' },
    );
  }

  /**
   * Emit an event. Calls all registered handlers asynchronously.
   * Does NOT block the caller -- handler errors are logged but not thrown.
   */
  emit(event: ParallelEvent): void {
    // Log to audit file as NDJSON
    if (this.logStream) {
      this.logStream.write(JSON.stringify(event) + '\n');
    }

    const handlers = this.handlers.get(event.type);
    if (!handlers) return;

    for (const handler of handlers) {
      // Fire-and-forget: don't block on async handlers
      try {
        const result = handler(event);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err) => {
            console.error(`Event handler error for ${event.type}:`, err);
          });
        }
      } catch (err) {
        console.error(`Event handler error for ${event.type}:`, err);
      }
    }
  }

  /**
   * Register a handler for a specific event type.
   * Multiple handlers per event type are supported.
   */
  on<T extends ParallelEvent>(eventType: T['type'], handler: EventHandler<T>): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler as EventHandler);
  }

  /**
   * Remove a specific handler for an event type.
   */
  off(eventType: EventType, handler: EventHandler): void {
    this.handlers.get(eventType)?.delete(handler);
  }

  /**
   * Remove all handlers. Used in tests and shutdown.
   */
  removeAllListeners(): void {
    this.handlers.clear();
  }

  /**
   * Close the audit log stream and release resources.
   */
  close(): void {
    this.logStream?.end();
    this.logStream = null;
  }
}

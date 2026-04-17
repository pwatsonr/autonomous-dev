/**
 * Track State Machine, Stall Detection, and Progress Reporting.
 *
 * SPEC-006-5-1: Event Bus, Track State Machine, and Stall Detection (Tasks 2 & 3)
 * SPEC-006-5-2: Progress Reporting and ETA Calculation (Tasks 4 & 5)
 *
 * Provides:
 *   - TrackStateMachine: governs lifecycle transitions with validation
 *   - StallDetector: monitors agent activity and triggers alerts/termination
 *   - InvalidStateTransitionError: thrown on illegal state transitions
 *   - Per-track progress reporting with phase, elapsed time, turn usage
 *   - Request-level progress with percentage, ETA, cluster info
 *   - ETA calculation via rolling average of completed track durations
 *   - Complexity-based heuristic ETA when no tracks have completed yet
 *   - Periodic `request.progress` event emission at configurable interval
 */

import { execSync } from 'child_process';

import type { ParallelConfig } from './config';
import {
  EventBus,
  TrackState,
} from './events';
import type { StatePersister } from './state-persister';
import type { TrackAssignment } from './types';

// Re-export TrackState so existing consumers continue to work
export type { TrackState } from './events';

// ============================================================================
// Error classes (SPEC-006-5-1)
// ============================================================================

/**
 * Thrown when an invalid state transition is attempted.
 */
export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly trackName: string,
    public readonly from: TrackState,
    public readonly to: TrackState,
    public readonly detail: string,
  ) {
    super(
      `Invalid state transition for track "${trackName}": ` +
      `"${from}" -> "${to}". ${detail}`,
    );
    this.name = 'InvalidStateTransitionError';
  }
}

// ============================================================================
// State transition types (SPEC-006-5-1)
// ============================================================================

export interface StateTransition {
  from: TrackState;
  to: TrackState;
  timestamp: string;
  reason: string;
}

// ============================================================================
// Valid transitions (adjacency set) (SPEC-006-5-1)
// ============================================================================

/** Valid state transitions defined as an adjacency set. */
export const VALID_TRANSITIONS: Record<TrackState, TrackState[]> = {
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

// ============================================================================
// TrackStateMachine (SPEC-006-5-1)
// ============================================================================

/**
 * Manages the lifecycle state of a single track, enforcing valid transitions
 * and emitting events on every state change.
 *
 * Each transition is recorded with a timestamp and reason for audit purposes.
 * The state machine can be restored from persisted state for crash recovery.
 */
export class TrackStateMachine {
  private state: TrackState;
  private transitions: StateTransition[] = [];

  constructor(
    private requestId: string,
    private trackName: string,
    private eventBus: EventBus,
    private persister: StatePersister,
    initialState: TrackState = 'pending',
  ) {
    this.state = initialState;
  }

  /** Returns the current state. */
  getState(): TrackState {
    return this.state;
  }

  /** Returns a copy of all recorded transitions. */
  getTransitions(): StateTransition[] {
    return [...this.transitions];
  }

  /**
   * Transition to a new state. Throws if the transition is invalid.
   *
   * @param to    Target state
   * @param reason Human-readable reason for the transition
   * @throws InvalidStateTransitionError if the transition is not allowed
   */
  async transition(to: TrackState, reason: string): Promise<void> {
    const from = this.state;

    if (!VALID_TRANSITIONS[from].includes(to)) {
      throw new InvalidStateTransitionError(
        this.trackName,
        from,
        to,
        `Valid transitions from "${from}": [${VALID_TRANSITIONS[from].join(', ')}]`,
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

    // Persistence is handled by the caller updating the PersistedExecutionState
  }

  /**
   * Check if a transition to the given state is valid from the current state.
   */
  canTransition(to: TrackState): boolean {
    return VALID_TRANSITIONS[this.state].includes(to);
  }

  /**
   * Restore a state machine from persisted state (for crash recovery).
   *
   * @param requestId   The request this track belongs to
   * @param trackName   The track name
   * @param eventBus    Event bus for emitting events
   * @param persister   State persister (for future persistence calls)
   * @param state       The persisted current state
   * @param transitions The persisted transition history
   */
  static restore(
    requestId: string,
    trackName: string,
    eventBus: EventBus,
    persister: StatePersister,
    state: TrackState,
    transitions: StateTransition[],
  ): TrackStateMachine {
    const sm = new TrackStateMachine(requestId, trackName, eventBus, persister, state);
    sm.transitions = [...transitions];
    return sm;
  }
}

// ============================================================================
// StallDetector (SPEC-006-5-1)
// ============================================================================

/**
 * Monitors agent activity and detects stalled tracks.
 *
 * Activity is tracked per-track via timestamps. The detector periodically
 * checks all registered tracks against configurable thresholds:
 *   - At 1x stall_timeout_minutes: emits a warning event
 *   - At 2x stall_timeout_minutes: emits a terminated event and calls onTerminate
 *
 * Activity can be updated via:
 *   - Direct calls to updateActivity() (e.g., after agent tool calls)
 *   - checkGitActivity() to detect new commits in a worktree
 */
export class StallDetector {
  private lastActivity = new Map<string, number>(); // trackName -> unix timestamp ms
  private monitorInterval: NodeJS.Timeout | null = null;
  private requestId: string = '';

  constructor(
    private config: ParallelConfig,
    private eventBus: EventBus,
    private onTerminate: (trackName: string) => Promise<void>,
  ) {}

  /**
   * Set the request ID for events emitted by this detector.
   */
  setRequestId(requestId: string): void {
    this.requestId = requestId;
  }

  /**
   * Called by agent monitoring to record activity for a track.
   */
  updateActivity(trackName: string): void {
    this.lastActivity.set(trackName, Date.now());
  }

  /**
   * Start periodic stall checking.
   *
   * @param intervalMs How often to check (default 30s)
   */
  startMonitoring(intervalMs: number = 30_000): void {
    this.monitorInterval = setInterval(() => this.checkAll(), intervalMs);
  }

  /**
   * Stop periodic stall checking.
   */
  stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  /**
   * Register a track for stall monitoring.
   * Initializes the activity timestamp to now.
   */
  registerTrack(trackName: string): void {
    this.lastActivity.set(trackName, Date.now());
  }

  /**
   * Unregister a completed/failed track from stall monitoring.
   */
  unregisterTrack(trackName: string): void {
    this.lastActivity.delete(trackName);
  }

  /**
   * Check all registered tracks for stall conditions.
   *
   * - At stall_timeout_minutes: emits track.stalled with action 'warning'
   * - At 2x stall_timeout_minutes: emits track.stalled with action 'terminated'
   *   and calls onTerminate callback, then unregisters the track
   */
  async checkAll(): Promise<void> {
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
          requestId: this.requestId,
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
          requestId: this.requestId,
          trackName,
          inactiveMinutes: Math.round(inactiveMinutes),
          action: 'warning',
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  /**
   * Check git activity for a track by inspecting the latest commit timestamp
   * in the worktree. If a newer commit is found, updates the activity timestamp.
   *
   * @param trackName     The track to check
   * @param worktreePath  Absolute path to the track's worktree
   * @returns true if new git activity was detected
   */
  async checkGitActivity(trackName: string, worktreePath: string): Promise<boolean> {
    try {
      const commitTime = execSync(
        `git -C "${worktreePath}" log -1 --format=%ct 2>/dev/null`,
        { encoding: 'utf-8' },
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

// ============================================================================
// Duck-typed interfaces for ProgressTracker
// These allow ProgressTracker to work with TrackStateMachine or any
// compatible implementation without a hard import cycle.
// ============================================================================

/**
 * Minimal interface for a track state machine.
 * Matches the TrackStateMachine from SPEC-006-5-1 by duck typing.
 */
export interface TrackStateMachineLike {
  getState(): TrackState;
}

/**
 * Minimal interface for the EventBus.
 * Matches the EventBus from SPEC-006-5-1 by duck typing.
 */
export interface EventBusLike {
  emit(event: Record<string, unknown>): void;
}

// ============================================================================
// Progress reporting types (from spec)
// ============================================================================

/**
 * Progress information for a single track.
 */
export interface TrackProgress {
  trackName: string;
  state: TrackState;
  /** Human-readable phase string, e.g. "executing (turn 23/60)", "complete" */
  phaseProgress: string;
  elapsedMinutes: number;
  turnsUsed: number;
  turnBudget: number;
  startedAt: string | null;
  completedAt: string | null;
}

/**
 * Request-level progress aggregating all tracks.
 */
export interface RequestProgress {
  requestId: string;
  totalTracks: number;
  completedTracks: number;
  failedTracks: number;
  inProgressTracks: TrackProgress[];
  /** Percentage of tracks completed, 0-100. */
  percentComplete: number;
  /** Estimated minutes remaining, null if insufficient data. */
  etaMinutes: number | null;
  currentCluster: number;
  totalClusters: number;
  elapsedMinutes: number;
  startedAt: string;
}

// ============================================================================
// ProgressTracker
// ============================================================================

/**
 * Tracks per-track and request-level progress, calculates ETAs,
 * and emits periodic `request.progress` events.
 */
export class ProgressTracker {
  private trackMachines = new Map<string, TrackStateMachineLike>();
  private trackAssignments = new Map<string, TrackAssignment>();
  private completedDurations: number[] = []; // minutes per completed track
  private requestStartTime: number = Date.now();
  private reportInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private requestId: string,
    private eventBus: EventBusLike,
    private config: ParallelConfig,
  ) {}

  // --------------------------------------------------------------------------
  // Track registration
  // --------------------------------------------------------------------------

  /**
   * Register a track for progress monitoring.
   *
   * @param trackName   Unique track identifier
   * @param assignment  The track's assignment record
   * @param sm          The track's state machine instance
   */
  registerTrack(
    trackName: string,
    assignment: TrackAssignment,
    sm: TrackStateMachineLike,
  ): void {
    this.trackMachines.set(trackName, sm);
    this.trackAssignments.set(trackName, assignment);
  }

  // --------------------------------------------------------------------------
  // Track completion recording
  // --------------------------------------------------------------------------

  /**
   * Record a track completion for ETA calculation.
   * Call this when a track transitions to 'complete'.
   *
   * @param _trackName       The completed track name (for future per-track stats)
   * @param durationMinutes  How long the track took from start to completion
   */
  recordTrackCompletion(_trackName: string, durationMinutes: number): void {
    this.completedDurations.push(durationMinutes);
  }

  // --------------------------------------------------------------------------
  // Per-track progress
  // --------------------------------------------------------------------------

  /**
   * Get progress information for a single track.
   *
   * @param trackName  The track to query
   * @returns TrackProgress with state, phase string, elapsed, turn usage
   * @throws Error if the track is not registered
   */
  getTrackProgress(trackName: string): TrackProgress {
    const sm = this.trackMachines.get(trackName);
    const assignment = this.trackAssignments.get(trackName);
    if (!sm || !assignment) {
      throw new Error(`Unknown track: ${trackName}`);
    }

    const state = sm.getState();
    let phaseProgress: string;
    switch (state) {
      case 'executing':
        phaseProgress = `executing (turn ${assignment.turnsUsed}/${assignment.turnBudget})`;
        break;
      case 'complete':
        phaseProgress = 'complete';
        break;
      case 'failed':
        phaseProgress = `failed (retry ${assignment.retryCount})`;
        break;
      default:
        phaseProgress = state;
    }

    const startedAt = assignment.startedAt;
    const elapsedMs = startedAt
      ? Date.now() - new Date(startedAt).getTime()
      : 0;

    return {
      trackName,
      state,
      phaseProgress,
      elapsedMinutes: Math.round(elapsedMs / 60_000),
      turnsUsed: assignment.turnsUsed,
      turnBudget: assignment.turnBudget,
      startedAt,
      completedAt: assignment.completedAt,
    };
  }

  // --------------------------------------------------------------------------
  // Request-level progress
  // --------------------------------------------------------------------------

  /**
   * Get aggregate progress for the entire request.
   *
   * @param currentCluster  Zero-based index of the currently executing cluster
   * @param totalClusters   Total number of clusters in the execution plan
   * @returns RequestProgress with totals, percentages, ETA, cluster info
   */
  getRequestProgress(
    currentCluster: number,
    totalClusters: number,
  ): RequestProgress {
    const total = this.trackMachines.size;
    let completed = 0;
    let failed = 0;
    const inProgress: TrackProgress[] = [];

    for (const [trackName, sm] of this.trackMachines) {
      const state = sm.getState();
      if (state === 'complete') {
        completed++;
      } else if (state === 'failed' || state === 'escalated') {
        failed++;
      } else {
        inProgress.push(this.getTrackProgress(trackName));
      }
    }

    const percentComplete = total > 0
      ? Math.round((completed / total) * 100)
      : 0;

    const etaMinutes = this.calculateETA(
      total,
      completed,
      inProgress.length,
      totalClusters - currentCluster,
    );

    return {
      requestId: this.requestId,
      totalTracks: total,
      completedTracks: completed,
      failedTracks: failed,
      inProgressTracks: inProgress,
      percentComplete,
      etaMinutes,
      currentCluster,
      totalClusters,
      elapsedMinutes: Math.round((Date.now() - this.requestStartTime) / 60_000),
      startedAt: new Date(this.requestStartTime).toISOString(),
    };
  }

  // --------------------------------------------------------------------------
  // ETA calculation
  // --------------------------------------------------------------------------

  /**
   * ETA calculation:
   *   1. If completed tracks exist: rolling average of completed durations
   *      divided by effective parallelism, plus cluster transition overhead.
   *   2. If no completed tracks: use complexity heuristic.
   *
   * @param total              Total number of tracks
   * @param completed          Number of completed tracks
   * @param inProgress         Number of currently in-progress tracks
   * @param remainingClusters  Number of clusters remaining (including current)
   * @returns Estimated minutes remaining, or 0 if all done, or null if no data
   */
  calculateETA(
    total: number,
    completed: number,
    inProgress: number,
    remainingClusters: number,
  ): number | null {
    const remaining = total - completed;
    if (remaining === 0) return 0;

    if (this.completedDurations.length > 0) {
      // Rolling average of completed track durations
      const avgDuration =
        this.completedDurations.reduce((a, b) => a + b, 0) /
        this.completedDurations.length;

      // Effective parallelism: min(max_tracks, remaining tracks)
      const parallelism = Math.min(this.config.max_tracks, remaining);

      // Remaining time = (remaining tracks / parallelism) * avgDuration
      // Adjust for cluster boundaries: add ~1 min per remaining cluster transition
      const trackTime = (remaining / parallelism) * avgDuration;
      const clusterOverhead = remainingClusters * 1; // 1 min per cluster merge

      return Math.round(trackTime + clusterOverhead);
    }

    // No completed tracks: use complexity heuristic
    const heuristicETA = this.calculateHeuristicETA(remaining, remainingClusters);
    return heuristicETA;
  }

  // --------------------------------------------------------------------------
  // Heuristic ETA (when no tracks have completed yet)
  // --------------------------------------------------------------------------

  /**
   * Complexity-based initial estimate:
   *   small = 5 min, medium = 15 min, large = 30 min
   * Divided by effective parallelism, plus cluster overhead.
   *
   * @param remaining          Number of incomplete tracks
   * @param remainingClusters  Number of clusters remaining
   * @returns Estimated minutes remaining
   */
  private calculateHeuristicETA(
    remaining: number,
    remainingClusters: number,
  ): number {
    let totalEstimate = 0;

    for (const [trackName, assignment] of this.trackAssignments) {
      const sm = this.trackMachines.get(trackName)!;
      if (sm.getState() !== 'complete' && sm.getState() !== 'failed') {
        switch (assignment.spec.complexity) {
          case 'small':
            totalEstimate += 5;
            break;
          case 'medium':
            totalEstimate += 15;
            break;
          case 'large':
            totalEstimate += 30;
            break;
          default:
            // If complexity is undefined, use medium as default
            totalEstimate += 15;
            break;
        }
      }
    }

    const parallelism = Math.min(this.config.max_tracks, remaining);
    return Math.round(totalEstimate / parallelism + remainingClusters);
  }

  // --------------------------------------------------------------------------
  // Periodic reporting
  // --------------------------------------------------------------------------

  /**
   * Start periodic progress event emission.
   *
   * Emits a `request.progress` event at the given interval with the full
   * RequestProgress payload plus a timestamp.
   *
   * @param currentCluster  Zero-based index of current cluster
   * @param totalClusters   Total number of clusters
   * @param intervalMs      Emission interval in milliseconds (default 60s)
   */
  startPeriodicReporting(
    currentCluster: number,
    totalClusters: number,
    intervalMs: number = 60_000,
  ): void {
    this.reportInterval = setInterval(() => {
      const progress = this.getRequestProgress(currentCluster, totalClusters);
      this.eventBus.emit({
        type: 'request.progress',
        ...progress,
        timestamp: new Date().toISOString(),
      });
    }, intervalMs);
  }

  /**
   * Stop periodic progress reporting.
   * Safe to call multiple times or when reporting was never started.
   */
  stopPeriodicReporting(): void {
    if (this.reportInterval) {
      clearInterval(this.reportInterval);
      this.reportInterval = null;
    }
  }
}

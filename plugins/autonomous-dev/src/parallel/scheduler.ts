// ============================================================================
// Scheduler — Cluster Sequencing, Priority Dispatch, and Slot Management
// SPEC-006-2-3: Scheduler and Priority Dispatch
// ============================================================================

import { ParallelConfig } from './config';
import { DependencyDAG, DiskPressureLevel } from './types';
import { ResourceExhaustedError } from './resource-monitor';

// Re-export for consumer convenience
export { ResourceExhaustedError } from './resource-monitor';

// ============================================================================
// Dependency interfaces (duck-typed for testability)
// ============================================================================

/**
 * Minimal WorktreeManager surface needed by the scheduler.
 * Allows both the real WorktreeManager and test stubs.
 */
export interface SchedulerWorktreeManager {
  /**
   * Returns the number of currently active worktrees.
   * The spec treats this as a synchronous query; implementations
   * that require async should cache and expose a sync accessor.
   */
  getActiveWorktreeCount(): number | Promise<number>;
}

/**
 * Minimal ResourceMonitor surface needed by the scheduler.
 */
export interface SchedulerResourceMonitor {
  getDiskPressureLevel(): DiskPressureLevel;
  canDispatch(): Promise<{ allowed: boolean; reason?: string }>;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Callbacks fired by the scheduler at key lifecycle points.
 *
 * - `onTrackDispatch`: called when a track is dispatched for execution.
 *   The returned promise resolves when the dispatching action completes
 *   (NOT when the track finishes executing).
 * - `onTrackComplete`: called when a track reports completion (success or failure).
 * - `onClusterComplete`: called when all tracks in a cluster have finished.
 * - `onAllClustersComplete`: called when the entire plan has been executed.
 */
export interface SchedulerCallbacks {
  onTrackDispatch: (requestId: string, trackName: string, cluster: number) => Promise<void>;
  onTrackComplete: (requestId: string, trackName: string, success: boolean) => void;
  onClusterComplete: (requestId: string, clusterIndex: number) => Promise<void>;
  onAllClustersComplete: (requestId: string) => Promise<void>;
}

/** Top-level execution plan describing the order and grouping of tracks. */
export interface ExecutionPlan {
  requestId: string;
  clusters: ClusterPlan[];
  totalTracks: number;
}

/** A single cluster within the execution plan. */
export interface ClusterPlan {
  clusterIndex: number;
  tracks: TrackDispatchInfo[];
}

/** Per-track dispatch metadata, sorted by priority within a cluster. */
export interface TrackDispatchInfo {
  trackName: string;
  priority: number;
  estimatedMinutes: number;
  complexity: 'small' | 'medium' | 'large';
}

/** Result of executing a single cluster. */
export interface ClusterResult {
  clusterIndex: number;
  completed: string[];
  failed: string[];
  allSucceeded: boolean;
}

// ============================================================================
// Scheduler
// ============================================================================

/**
 * Mixed-mode scheduler that processes clusters sequentially and dispatches
 * tracks in priority order within each cluster, respecting concurrency
 * limits and resource constraints.
 *
 * Slot management accounts for:
 *   - `config.max_tracks`: maximum parallel tracks
 *   - `config.max_worktrees`: maximum total worktrees (checked via WorktreeManager)
 *   - Disk pressure level from ResourceMonitor:
 *       normal   -> full parallelism
 *       warning  -> throttle to 1 concurrent track
 *       critical -> block all new worktrees
 */
export class Scheduler {
  /**
   * Internal callback for the current cluster execution.
   * Set by `executeCluster`, invoked by `notifyTrackComplete`.
   */
  private onTrackComplete:
    | ((trackName: string, success: boolean) => void)
    | null = null;

  /**
   * Cached active worktree count, refreshed before each cluster execution
   * and maintained by the scheduler as tracks are dispatched/completed.
   * Enables synchronous slot calculation inside the dispatch loop.
   */
  private cachedActiveWorktrees = 0;

  constructor(
    private config: ParallelConfig,
    private worktreeManager: SchedulerWorktreeManager,
    private resourceMonitor: SchedulerResourceMonitor,
    private callbacks: SchedulerCallbacks,
  ) {}

  // --------------------------------------------------------------------------
  // Execution plan creation
  // --------------------------------------------------------------------------

  /**
   * Converts a DependencyDAG into an ExecutionPlan.
   *
   * Each DAG cluster becomes a ClusterPlan. Tracks within a cluster are
   * sorted by priority descending so that critical-path nodes dispatch first.
   */
  createExecutionPlan(dag: DependencyDAG): ExecutionPlan {
    const clusters: ClusterPlan[] = dag.clusters.map((cluster) => ({
      clusterIndex: cluster.index,
      tracks: cluster.nodes
        .map((name) => {
          const node = dag.nodes.get(name)!;
          return {
            trackName: name,
            priority: node.priority,
            estimatedMinutes: node.estimatedMinutes,
            complexity: node.complexity,
          };
        })
        .sort((a, b) => b.priority - a.priority), // highest priority first
    }));

    return {
      requestId: dag.requestId,
      clusters,
      totalTracks: dag.nodes.size,
    };
  }

  // --------------------------------------------------------------------------
  // Cluster execution with slot management
  // --------------------------------------------------------------------------

  /**
   * Executes all tracks within a single cluster, respecting concurrency
   * limits and resource pressure.
   *
   * Tracks are dispatched in priority order. When a track completes, the
   * scheduler recalculates available slots and dispatches the next pending
   * track. The returned promise resolves when all tracks in the cluster
   * have completed (success or failure).
   */
  async executeCluster(
    requestId: string,
    clusterPlan: ClusterPlan,
  ): Promise<ClusterResult> {
    // Refresh cached active worktree count before dispatching
    this.cachedActiveWorktrees = await Promise.resolve(
      this.worktreeManager.getActiveWorktreeCount(),
    );

    const { tracks } = clusterPlan;
    const pending = [...tracks]; // tracks waiting to be dispatched
    const inFlight = new Set<string>(); // currently executing track names
    const completed: string[] = [];
    const failed: string[] = [];

    return new Promise<ClusterResult>((resolve) => {
      const checkDone = () => {
        if (inFlight.size === 0 && pending.length === 0) {
          // Unregister the internal completion callback
          this.onTrackComplete = null;
          resolve({
            clusterIndex: clusterPlan.clusterIndex,
            completed,
            failed,
            allSucceeded: failed.length === 0,
          });
        }
      };

      const dispatchNext = async () => {
        while (pending.length > 0) {
          const availableSlots = this.calculateAvailableSlots(inFlight.size);
          if (availableSlots <= 0) break;

          const track = pending.shift()!;
          inFlight.add(track.trackName);

          // Non-blocking dispatch: fire the callback but don't await the
          // track's full execution — only await the dispatch action itself.
          this.callbacks
            .onTrackDispatch(requestId, track.trackName, clusterPlan.clusterIndex)
            .catch(() => {
              // Dispatch failure = immediate track failure
              inFlight.delete(track.trackName);
              failed.push(track.trackName);
              checkDone();
            });
        }
      };

      const onTrackDone = (trackName: string, success: boolean) => {
        inFlight.delete(trackName);
        if (success) {
          completed.push(trackName);
        } else {
          failed.push(trackName);
        }
        // Notify the external callback
        this.callbacks.onTrackComplete(requestId, trackName, success);
        // Recalculate slots and dispatch next pending track
        dispatchNext();
        checkDone();
      };

      // Register the internal completion callback so notifyTrackComplete
      // can drive the cluster forward.
      this.onTrackComplete = onTrackDone;

      // Initial dispatch
      dispatchNext();

      // Edge case: if there are no tracks at all, resolve immediately
      checkDone();
    });
  }

  // --------------------------------------------------------------------------
  // Available slot calculation
  // --------------------------------------------------------------------------

  /**
   * Calculates how many additional tracks can be dispatched right now.
   *
   * Takes into account:
   *   - config.max_tracks
   *   - config.max_worktrees minus currently active worktrees
   *   - Disk pressure level (warning -> 1, critical -> 0)
   *   - Currently in-flight count
   *
   * @param currentInFlight Number of tracks currently executing
   * @returns Number of additional tracks that can be dispatched (>= 0)
   */
  private calculateAvailableSlots(currentInFlight: number): number {
    const maxTracks = this.config.max_tracks;
    const maxWorktrees = this.config.max_worktrees;
    const activeWorktrees = this.cachedActiveWorktrees;
    const pressureLevel = this.resourceMonitor.getDiskPressureLevel();

    let maxAllowed: number;

    switch (pressureLevel) {
      case 'critical':
        // Block all new worktrees
        maxAllowed = 0;
        break;
      case 'warning':
        // Throttle to 1 concurrent track (TDD 3.3.2)
        maxAllowed = 1;
        break;
      case 'normal':
        maxAllowed = Math.min(maxTracks, maxWorktrees - activeWorktrees);
        break;
    }

    return Math.max(0, maxAllowed - currentInFlight);
  }

  // --------------------------------------------------------------------------
  // External track completion notification
  // --------------------------------------------------------------------------

  /**
   * Called externally when a track finishes executing.
   * Drives the cluster execution forward by releasing a slot and
   * potentially dispatching the next pending track.
   */
  notifyTrackComplete(_requestId: string, trackName: string, success: boolean): void {
    if (this.onTrackComplete) {
      this.onTrackComplete(trackName, success);
    }
  }

  // --------------------------------------------------------------------------
  // Full scheduler run loop
  // --------------------------------------------------------------------------

  /**
   * Executes the full plan: clusters are processed sequentially,
   * tracks within each cluster are dispatched in parallel up to slot limits.
   *
   * Before each cluster:
   *   - A resource check is performed via ResourceMonitor.canDispatch()
   *   - If resources are exhausted, throws ResourceExhaustedError
   *
   * After each cluster:
   *   - onClusterComplete callback is fired
   *   - Failed tracks are noted but do not abort subsequent clusters
   *     (retry logic lives in PLAN-006-3)
   *
   * After all clusters:
   *   - onAllClustersComplete callback is fired
   */
  async run(plan: ExecutionPlan): Promise<void> {
    for (const clusterPlan of plan.clusters) {
      // Resource check before starting cluster
      const check = await this.resourceMonitor.canDispatch();
      if (!check.allowed) {
        throw new ResourceExhaustedError(check.reason!);
      }

      const result = await this.executeCluster(plan.requestId, clusterPlan);

      // Notify cluster completion (triggers merge-back in PLAN-006-4)
      await this.callbacks.onClusterComplete(plan.requestId, clusterPlan.clusterIndex);

      if (!result.allSucceeded) {
        // Failed tracks are handled by retry logic in PLAN-006-3;
        // the scheduler continues with next cluster as long as
        // non-failed tracks provide the needed dependencies
      }
    }

    await this.callbacks.onAllClustersComplete(plan.requestId);
  }
}

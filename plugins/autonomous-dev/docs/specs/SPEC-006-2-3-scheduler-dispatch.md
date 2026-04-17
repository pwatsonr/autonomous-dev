# SPEC-006-2-3: Scheduler and Priority Dispatch

## Metadata
- **Parent Plan**: PLAN-006-2
- **Tasks Covered**: Task 6, Task 7
- **Estimated effort**: 10 hours

## Description

Implement the mixed-mode scheduler that processes clusters sequentially and dispatches tracks in priority order within each cluster, respecting concurrency limits and resource constraints. Includes the resource monitor that queries WorktreeManager for disk pressure and slot availability, throttling parallelism under pressure.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/parallel/scheduler.ts` | **Create** | Cluster sequencing, priority dispatch, slot management |
| `src/parallel/resource-monitor.ts` | **Create** | Disk pressure querying, resource-aware throttle logic |
| `tests/parallel/scheduler.test.ts` | **Create** | Unit tests for scheduling |

## Implementation Details

### 1. Scheduler

```typescript
export interface SchedulerCallbacks {
  onTrackDispatch: (requestId: string, trackName: string, cluster: number) => Promise<void>;
  onTrackComplete: (requestId: string, trackName: string, success: boolean) => void;
  onClusterComplete: (requestId: string, clusterIndex: number) => Promise<void>;
  onAllClustersComplete: (requestId: string) => Promise<void>;
}

export interface ExecutionPlan {
  requestId: string;
  clusters: ClusterPlan[];
  totalTracks: number;
}

export interface ClusterPlan {
  clusterIndex: number;
  tracks: TrackDispatchInfo[];
}

export interface TrackDispatchInfo {
  trackName: string;
  priority: number;
  estimatedMinutes: number;
  complexity: 'small' | 'medium' | 'large';
}

export class Scheduler {
  constructor(
    private config: ParallelConfig,
    private worktreeManager: WorktreeManager,
    private resourceMonitor: ResourceMonitor,
    private callbacks: SchedulerCallbacks
  ) {}

  createExecutionPlan(dag: DependencyDAG): ExecutionPlan;
  async executeCluster(requestId: string, clusterPlan: ClusterPlan): Promise<ClusterResult>;
  async run(plan: ExecutionPlan): Promise<void>;
}
```

### 2. Execution plan creation

```typescript
createExecutionPlan(dag: DependencyDAG): ExecutionPlan {
  const clusters: ClusterPlan[] = dag.clusters.map(cluster => ({
    clusterIndex: cluster.index,
    tracks: cluster.nodes
      .map(name => {
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
```

### 3. Cluster execution with slot management

```typescript
async executeCluster(requestId: string, clusterPlan: ClusterPlan): Promise<ClusterResult> {
  const { tracks } = clusterPlan;
  const pending = [...tracks];      // tracks waiting to be dispatched
  const inFlight = new Set<string>(); // currently executing
  const completed: string[] = [];
  const failed: string[] = [];

  return new Promise((resolve) => {
    const dispatchNext = async () => {
      while (pending.length > 0) {
        const availableSlots = this.calculateAvailableSlots(inFlight.size);
        if (availableSlots <= 0) break;

        const track = pending.shift()!;
        inFlight.add(track.trackName);

        // Non-blocking dispatch: don't await the agent completing
        this.callbacks.onTrackDispatch(requestId, track.trackName, clusterPlan.clusterIndex)
          .catch(err => {
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
      // Recalculate slots and dispatch next pending track
      dispatchNext();
      checkDone();
    };

    const checkDone = () => {
      if (inFlight.size === 0 && pending.length === 0) {
        resolve({
          clusterIndex: clusterPlan.clusterIndex,
          completed,
          failed,
          allSucceeded: failed.length === 0,
        });
      }
    };

    // Register completion callback
    this.onTrackComplete = onTrackDone;

    // Initial dispatch
    dispatchNext();
  });
}
```

### 4. Available slot calculation

```typescript
private calculateAvailableSlots(currentInFlight: number): number {
  const maxTracks = this.config.max_tracks;
  const maxWorktrees = this.config.max_worktrees;
  const activeWorktrees = this.worktreeManager.getActiveWorktreeCount();
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
```

### 5. ResourceMonitor

```typescript
export class ResourceMonitor {
  constructor(
    private worktreeManager: WorktreeManager,
    private config: ParallelConfig
  ) {}

  getDiskPressureLevel(): DiskPressureLevel {
    return this.worktreeManager.getDiskPressureLevel();
  }

  async checkResources(): Promise<ResourceStatus> {
    const diskUsage = await this.worktreeManager.checkDiskUsage();
    const worktreeCount = await this.worktreeManager.getActiveWorktreeCount();

    return {
      diskUsageBytes: diskUsage.totalBytes,
      diskPressure: this.getDiskPressureLevel(),
      activeWorktrees: worktreeCount,
      maxWorktrees: this.config.max_worktrees,
      availableSlots: Math.max(0, this.config.max_worktrees - worktreeCount),
    };
  }

  /**
   * Pre-dispatch resource gate. Returns true if a new worktree can be created.
   * Checks are run:
   *   1. Before each worktree creation
   *   2. Every 60 seconds during execution
   *   3. After each track completion
   */
  async canDispatch(): Promise<{ allowed: boolean; reason?: string }> {
    const status = await this.checkResources();

    if (status.diskPressure === 'critical') {
      return { allowed: false, reason: 'Disk pressure critical: usage exceeds hard limit' };
    }

    if (status.activeWorktrees >= status.maxWorktrees) {
      return { allowed: false, reason: `Max worktrees reached (${status.maxWorktrees})` };
    }

    // Emergency: check available disk space via os.freemem or df
    const freeDiskBytes = await this.getFreeDiskSpace();
    if (freeDiskBytes < 1_073_741_824) { // 1 GB
      return { allowed: false, reason: 'Available disk space below 1 GB' };
    }

    return { allowed: true };
  }

  private async getFreeDiskSpace(): Promise<number> {
    // Use Node.js child_process to run: df -k {worktreeRoot} | tail -1 | awk '{print $4}'
    // Multiply by 1024 to get bytes
    // Cross-platform: on macOS use 'df -k', on Linux same command works
    const { execSync } = require('child_process');
    const output = execSync(`df -k "${this.worktreeManager.getWorktreeRoot()}" | tail -1`)
      .toString().trim();
    const parts = output.split(/\s+/);
    const availKB = parseInt(parts[3], 10);
    return availKB * 1024;
  }
}
```

### 6. Full scheduler run loop

```typescript
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
```

## Acceptance Criteria

1. `createExecutionPlan` produces clusters in DAG order with tracks sorted by priority (descending).
2. Within a cluster, up to `min(max_tracks, max_worktrees - active, cluster_size)` tracks dispatch simultaneously.
3. When a track completes, the scheduler recalculates available slots and dispatches the next pending track.
4. A cluster completes only when all its tracks finish (success or failure).
5. Clusters execute sequentially: cluster N+1 does not start until cluster N completes.
6. When disk pressure is `warning`, parallelism throttles to 1 concurrent track.
7. When disk pressure is `critical`, no new worktrees are created (all pending tracks wait).
8. When available disk < 1 GB, dispatch is blocked.
9. Worktree count is checked against `max_worktrees` before every dispatch.
10. `onTrackDispatch`, `onClusterComplete`, `onAllClustersComplete` callbacks fire at the correct times.

## Test Cases

```
// scheduler.test.ts

describe('createExecutionPlan', () => {
  it('sorts tracks by priority descending', () => {
    const dag = buildAndScheduleDAG('req-001', [
      { name: 'low', complexity: 'small', estimatedMinutes: 5 },
      { name: 'high', complexity: 'large', estimatedMinutes: 30 },
    ]);
    // 'high' has more estimated time but for independent nodes priority is based on
    // critical path (+10) and out-degree (+5 each). 'high' is on critical path.
    const plan = scheduler.createExecutionPlan(dag);
    expect(plan.clusters[0].tracks[0].trackName).toBe('high');
  });
});

describe('executeCluster', () => {
  it('dispatches all independent tracks simultaneously when slots available', async () => {
    // max_tracks=3, 3 independent tracks
    const dispatched: string[] = [];
    callbacks.onTrackDispatch = async (_, name) => { dispatched.push(name); };

    await scheduler.executeCluster('req-001', {
      clusterIndex: 0,
      tracks: [
        { trackName: 't1', priority: 10, estimatedMinutes: 5, complexity: 'small' },
        { trackName: 't2', priority: 5, estimatedMinutes: 5, complexity: 'small' },
        { trackName: 't3', priority: 1, estimatedMinutes: 5, complexity: 'small' },
      ],
    });
    expect(dispatched).toEqual(['t1', 't2', 't3']);
  });

  it('queues excess tracks when slots are limited', async () => {
    // max_tracks=2, 3 tracks -> first 2 dispatch, 3rd queues
    // Simulate: after t1 completes, t3 dispatches
    const dispatchOrder: string[] = [];
    callbacks.onTrackDispatch = async (_, name) => {
      dispatchOrder.push(name);
      // Simulate t1 completing quickly
      if (name === 't1') {
        setTimeout(() => scheduler.notifyTrackComplete('req-001', 't1', true), 10);
      }
    };
    // ... verify t3 dispatches after t1 completes
  });

  it('cluster completes only when all tracks done', async () => {
    // 2 tracks; complete in sequence; cluster resolves after both
    let clusterDone = false;
    const result = scheduler.executeCluster('req-001', cluster);
    result.then(() => { clusterDone = true; });
    // complete t1
    scheduler.notifyTrackComplete('req-001', 't1', true);
    expect(clusterDone).toBe(false);
    // complete t2
    scheduler.notifyTrackComplete('req-001', 't2', true);
    await result;
    expect(clusterDone).toBe(true);
  });
});

describe('resource-aware scheduling', () => {
  it('throttles to 1 track under disk warning', async () => {
    resourceMonitor.getDiskPressureLevel = () => 'warning';
    const dispatched: string[] = [];
    callbacks.onTrackDispatch = async (_, name) => { dispatched.push(name); };

    // 3 tracks available but warning -> only 1 dispatched initially
    await scheduler.executeCluster('req-001', clusterWith3Tracks);
    expect(dispatched[0]).toBeDefined();
    // Others dispatch only after first completes
  });

  it('blocks all dispatch under disk critical', async () => {
    resourceMonitor.getDiskPressureLevel = () => 'critical';
    const slots = scheduler['calculateAvailableSlots'](0);
    expect(slots).toBe(0);
  });

  it('respects max_worktrees limit', async () => {
    // max_worktrees=2, already 1 active
    worktreeManager.getActiveWorktreeCount = async () => 1;
    const slots = scheduler['calculateAvailableSlots'](0);
    expect(slots).toBeLessThanOrEqual(1);
  });
});

describe('cluster sequencing', () => {
  it('cluster 1 starts only after cluster 0 completes', async () => {
    const completionOrder: number[] = [];
    callbacks.onClusterComplete = async (_, idx) => { completionOrder.push(idx); };

    const plan = scheduler.createExecutionPlan(twoClusterDAG);
    await scheduler.run(plan);
    expect(completionOrder).toEqual([0, 1]);
  });
});

describe('priority ordering', () => {
  it('critical path nodes dispatch before non-critical', async () => {
    const dispatched: string[] = [];
    callbacks.onTrackDispatch = async (_, name) => { dispatched.push(name); };
    // max_tracks=1 to force serial dispatch within cluster
    config.max_tracks = 1;

    await scheduler.executeCluster('req-001', clusterWithMixedPriority);
    expect(dispatched[0]).toBe('critical-path-node');
  });
});
```

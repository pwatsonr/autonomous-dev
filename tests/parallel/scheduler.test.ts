// ============================================================================
// Tests for Scheduler and Resource Monitor — SPEC-006-2-3
// ============================================================================

import {
  Scheduler,
  SchedulerCallbacks,
  SchedulerWorktreeManager,
  SchedulerResourceMonitor,
  ClusterPlan,
  ResourceExhaustedError,
} from '../../src/parallel/scheduler';
import { ResourceMonitor } from '../../src/parallel/resource-monitor';
import { buildAndScheduleDAG } from '../../src/parallel/dag-constructor';
import { DiskPressureLevel } from '../../src/parallel/types';
import { ParallelConfig, DEFAULT_PARALLEL_CONFIG } from '../../src/parallel/config';

// ============================================================================
// Test helpers
// ============================================================================

function makeConfig(overrides?: Partial<ParallelConfig>): ParallelConfig {
  return { ...DEFAULT_PARALLEL_CONFIG, ...overrides };
}

function makeWorktreeManager(
  activeCount: number = 0,
): SchedulerWorktreeManager {
  return {
    getActiveWorktreeCount: () => activeCount,
  };
}

function makeResourceMonitor(
  pressureLevel: DiskPressureLevel = 'normal',
  canDispatchResult: { allowed: boolean; reason?: string } = { allowed: true },
): SchedulerResourceMonitor {
  return {
    getDiskPressureLevel: () => pressureLevel,
    canDispatch: async () => canDispatchResult,
  };
}

function makeCallbacks(overrides?: Partial<SchedulerCallbacks>): SchedulerCallbacks {
  return {
    onTrackDispatch: async () => {},
    onTrackComplete: () => {},
    onClusterComplete: async () => {},
    onAllClustersComplete: async () => {},
    ...overrides,
  };
}

/**
 * Helper that builds a simple cluster plan from track definitions.
 */
function makeClusterPlan(
  clusterIndex: number,
  tracks: Array<{ trackName: string; priority: number }>,
): ClusterPlan {
  return {
    clusterIndex,
    tracks: tracks.map((t) => ({
      trackName: t.trackName,
      priority: t.priority,
      estimatedMinutes: 5,
      complexity: 'small' as const,
    })),
  };
}

// ============================================================================
// createExecutionPlan
// ============================================================================

describe('createExecutionPlan', () => {
  it('sorts tracks by priority descending', () => {
    const dag = buildAndScheduleDAG('req-001', [
      { name: 'low', complexity: 'small', estimatedMinutes: 5 },
      { name: 'high', complexity: 'large', estimatedMinutes: 30 },
    ]);

    const config = makeConfig({ max_tracks: 5 });
    const scheduler = new Scheduler(
      config,
      makeWorktreeManager(),
      makeResourceMonitor(),
      makeCallbacks(),
    );

    const plan = scheduler.createExecutionPlan(dag);
    // 'high' has more estimated time. For independent nodes, priority is based
    // on critical path (+10) and out-degree (+5 each). 'high' is on critical path
    // because it has higher estimatedMinutes.
    expect(plan.clusters[0].tracks[0].trackName).toBe('high');
  });

  it('preserves cluster ordering from DAG', () => {
    // A -> B means cluster 0 = [A], cluster 1 = [B]
    const dag = buildAndScheduleDAG('req-002', [
      { name: 'A', complexity: 'small' },
      { name: 'B', complexity: 'small', dependsOn: ['A'] },
    ]);

    const scheduler = new Scheduler(
      makeConfig(),
      makeWorktreeManager(),
      makeResourceMonitor(),
      makeCallbacks(),
    );

    const plan = scheduler.createExecutionPlan(dag);
    expect(plan.clusters).toHaveLength(2);
    expect(plan.clusters[0].clusterIndex).toBe(0);
    expect(plan.clusters[0].tracks[0].trackName).toBe('A');
    expect(plan.clusters[1].clusterIndex).toBe(1);
    expect(plan.clusters[1].tracks[0].trackName).toBe('B');
  });

  it('sets totalTracks from DAG node count', () => {
    const dag = buildAndScheduleDAG('req-003', [
      { name: 'A' },
      { name: 'B' },
      { name: 'C' },
    ]);

    const scheduler = new Scheduler(
      makeConfig(),
      makeWorktreeManager(),
      makeResourceMonitor(),
      makeCallbacks(),
    );

    const plan = scheduler.createExecutionPlan(dag);
    expect(plan.totalTracks).toBe(3);
    expect(plan.requestId).toBe('req-003');
  });

  it('includes complexity and estimatedMinutes in track info', () => {
    const dag = buildAndScheduleDAG('req-004', [
      { name: 'spec-a', complexity: 'medium', estimatedMinutes: 20 },
    ]);

    const scheduler = new Scheduler(
      makeConfig(),
      makeWorktreeManager(),
      makeResourceMonitor(),
      makeCallbacks(),
    );

    const plan = scheduler.createExecutionPlan(dag);
    const track = plan.clusters[0].tracks[0];
    expect(track.complexity).toBe('medium');
    expect(track.estimatedMinutes).toBe(20);
  });
});

// ============================================================================
// executeCluster
// ============================================================================

describe('executeCluster', () => {
  it('dispatches all independent tracks simultaneously when slots available', async () => {
    const dispatched: string[] = [];
    const config = makeConfig({ max_tracks: 3, max_worktrees: 5 });

    const callbacks = makeCallbacks({
      onTrackDispatch: async (_req, name) => {
        dispatched.push(name);
      },
    });

    const scheduler = new Scheduler(
      config,
      makeWorktreeManager(0),
      makeResourceMonitor(),
      callbacks,
    );

    const cluster = makeClusterPlan(0, [
      { trackName: 't1', priority: 10 },
      { trackName: 't2', priority: 5 },
      { trackName: 't3', priority: 1 },
    ]);

    // Dispatch starts the cluster, then we complete all tracks
    const resultPromise = scheduler.executeCluster('req-001', cluster);

    // Give dispatch a tick to fire
    await new Promise((r) => setTimeout(r, 10));

    // All 3 should have been dispatched
    expect(dispatched).toEqual(['t1', 't2', 't3']);

    // Complete all tracks
    scheduler.notifyTrackComplete('req-001', 't1', true);
    scheduler.notifyTrackComplete('req-001', 't2', true);
    scheduler.notifyTrackComplete('req-001', 't3', true);

    const result = await resultPromise;
    expect(result.completed).toEqual(['t1', 't2', 't3']);
    expect(result.allSucceeded).toBe(true);
  });

  it('queues excess tracks when slots are limited', async () => {
    const dispatchOrder: string[] = [];
    const config = makeConfig({ max_tracks: 2, max_worktrees: 5 });

    const callbacks = makeCallbacks({
      onTrackDispatch: async (_req, name) => {
        dispatchOrder.push(name);
      },
    });

    const scheduler = new Scheduler(
      config,
      makeWorktreeManager(0),
      makeResourceMonitor(),
      callbacks,
    );

    const cluster = makeClusterPlan(0, [
      { trackName: 't1', priority: 10 },
      { trackName: 't2', priority: 5 },
      { trackName: 't3', priority: 1 },
    ]);

    const resultPromise = scheduler.executeCluster('req-001', cluster);

    // Give dispatch a tick
    await new Promise((r) => setTimeout(r, 10));

    // Only 2 dispatched initially (max_tracks=2)
    expect(dispatchOrder).toEqual(['t1', 't2']);

    // Complete t1 -> should trigger t3 dispatch
    scheduler.notifyTrackComplete('req-001', 't1', true);

    await new Promise((r) => setTimeout(r, 10));
    expect(dispatchOrder).toEqual(['t1', 't2', 't3']);

    // Complete remaining
    scheduler.notifyTrackComplete('req-001', 't2', true);
    scheduler.notifyTrackComplete('req-001', 't3', true);

    const result = await resultPromise;
    expect(result.completed).toEqual(['t1', 't2', 't3']);
    expect(result.allSucceeded).toBe(true);
  });

  it('cluster completes only when all tracks done', async () => {
    const config = makeConfig({ max_tracks: 3, max_worktrees: 5 });

    const scheduler = new Scheduler(
      config,
      makeWorktreeManager(0),
      makeResourceMonitor(),
      makeCallbacks(),
    );

    const cluster = makeClusterPlan(0, [
      { trackName: 't1', priority: 10 },
      { trackName: 't2', priority: 5 },
    ]);

    let clusterDone = false;
    const resultPromise = scheduler.executeCluster('req-001', cluster);
    resultPromise.then(() => {
      clusterDone = true;
    });

    await new Promise((r) => setTimeout(r, 10));

    // Complete t1 — cluster should NOT be done yet
    scheduler.notifyTrackComplete('req-001', 't1', true);
    await new Promise((r) => setTimeout(r, 10));
    expect(clusterDone).toBe(false);

    // Complete t2 — now cluster should resolve
    scheduler.notifyTrackComplete('req-001', 't2', true);
    await resultPromise;
    expect(clusterDone).toBe(true);
  });

  it('records failed tracks and reports allSucceeded=false', async () => {
    const config = makeConfig({ max_tracks: 3, max_worktrees: 5 });

    const scheduler = new Scheduler(
      config,
      makeWorktreeManager(0),
      makeResourceMonitor(),
      makeCallbacks(),
    );

    const cluster = makeClusterPlan(0, [
      { trackName: 't1', priority: 10 },
      { trackName: 't2', priority: 5 },
    ]);

    const resultPromise = scheduler.executeCluster('req-001', cluster);
    await new Promise((r) => setTimeout(r, 10));

    scheduler.notifyTrackComplete('req-001', 't1', true);
    scheduler.notifyTrackComplete('req-001', 't2', false);

    const result = await resultPromise;
    expect(result.completed).toEqual(['t1']);
    expect(result.failed).toEqual(['t2']);
    expect(result.allSucceeded).toBe(false);
  });

  it('resolves immediately for an empty cluster', async () => {
    const scheduler = new Scheduler(
      makeConfig(),
      makeWorktreeManager(),
      makeResourceMonitor(),
      makeCallbacks(),
    );

    const cluster: ClusterPlan = { clusterIndex: 0, tracks: [] };
    const result = await scheduler.executeCluster('req-001', cluster);
    expect(result.completed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.allSucceeded).toBe(true);
  });

  it('handles dispatch failure as immediate track failure', async () => {
    const config = makeConfig({ max_tracks: 3, max_worktrees: 5 });

    const callbacks = makeCallbacks({
      onTrackDispatch: async (_req, name) => {
        if (name === 't2') {
          throw new Error('dispatch failed');
        }
      },
    });

    const scheduler = new Scheduler(
      config,
      makeWorktreeManager(0),
      makeResourceMonitor(),
      callbacks,
    );

    const cluster = makeClusterPlan(0, [
      { trackName: 't1', priority: 10 },
      { trackName: 't2', priority: 5 },
    ]);

    const resultPromise = scheduler.executeCluster('req-001', cluster);
    await new Promise((r) => setTimeout(r, 10));

    // t1 completes normally
    scheduler.notifyTrackComplete('req-001', 't1', true);

    const result = await resultPromise;
    expect(result.completed).toEqual(['t1']);
    expect(result.failed).toEqual(['t2']);
    expect(result.allSucceeded).toBe(false);
  });
});

// ============================================================================
// resource-aware scheduling
// ============================================================================

describe('resource-aware scheduling', () => {
  it('throttles to 1 track under disk warning', async () => {
    const dispatched: string[] = [];
    const config = makeConfig({ max_tracks: 3, max_worktrees: 5 });

    const callbacks = makeCallbacks({
      onTrackDispatch: async (_req, name) => {
        dispatched.push(name);
      },
    });

    const scheduler = new Scheduler(
      config,
      makeWorktreeManager(0),
      makeResourceMonitor('warning'),
      callbacks,
    );

    const cluster = makeClusterPlan(0, [
      { trackName: 't1', priority: 10 },
      { trackName: 't2', priority: 5 },
      { trackName: 't3', priority: 1 },
    ]);

    const resultPromise = scheduler.executeCluster('req-001', cluster);
    await new Promise((r) => setTimeout(r, 10));

    // Only 1 dispatched under warning
    expect(dispatched).toEqual(['t1']);

    // Complete t1 -> dispatches t2
    scheduler.notifyTrackComplete('req-001', 't1', true);
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatched).toEqual(['t1', 't2']);

    // Complete t2 -> dispatches t3
    scheduler.notifyTrackComplete('req-001', 't2', true);
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatched).toEqual(['t1', 't2', 't3']);

    // Complete t3
    scheduler.notifyTrackComplete('req-001', 't3', true);
    const result = await resultPromise;
    expect(result.allSucceeded).toBe(true);
  });

  it('blocks all dispatch under disk critical', async () => {
    const dispatched: string[] = [];
    const config = makeConfig({ max_tracks: 3, max_worktrees: 5 });

    const callbacks = makeCallbacks({
      onTrackDispatch: async (_req, name) => {
        dispatched.push(name);
      },
    });

    const scheduler = new Scheduler(
      config,
      makeWorktreeManager(0),
      makeResourceMonitor('critical'),
      callbacks,
    );

    // Access private method via bracket notation for testing
    const slots = (scheduler as any)['calculateAvailableSlots'](0);
    expect(slots).toBe(0);
  });

  it('respects max_worktrees limit', () => {
    const config = makeConfig({ max_tracks: 5, max_worktrees: 2 });

    // Already 1 active worktree, so only 1 slot available
    const scheduler = new Scheduler(
      config,
      makeWorktreeManager(1),
      makeResourceMonitor('normal'),
      makeCallbacks(),
    );

    // Force the cached count to be set
    (scheduler as any).cachedActiveWorktrees = 1;

    const slots = (scheduler as any)['calculateAvailableSlots'](0);
    expect(slots).toBeLessThanOrEqual(1);
  });

  it('returns 0 slots when active worktrees equals max_worktrees', () => {
    const config = makeConfig({ max_tracks: 5, max_worktrees: 3 });

    const scheduler = new Scheduler(
      config,
      makeWorktreeManager(3),
      makeResourceMonitor('normal'),
      makeCallbacks(),
    );

    (scheduler as any).cachedActiveWorktrees = 3;

    const slots = (scheduler as any)['calculateAvailableSlots'](0);
    expect(slots).toBe(0);
  });

  it('accounts for currentInFlight in slot calculation', () => {
    const config = makeConfig({ max_tracks: 3, max_worktrees: 5 });

    const scheduler = new Scheduler(
      config,
      makeWorktreeManager(0),
      makeResourceMonitor('normal'),
      makeCallbacks(),
    );

    (scheduler as any).cachedActiveWorktrees = 0;

    // 2 already in flight, max_tracks=3 -> 1 slot available
    const slots = (scheduler as any)['calculateAvailableSlots'](2);
    expect(slots).toBe(1);
  });
});

// ============================================================================
// cluster sequencing
// ============================================================================

describe('cluster sequencing', () => {
  it('cluster 1 starts only after cluster 0 completes', async () => {
    const completionOrder: number[] = [];
    const config = makeConfig({ max_tracks: 3, max_worktrees: 5 });

    const callbacks = makeCallbacks({
      onTrackDispatch: async () => {},
      onClusterComplete: async (_req, idx) => {
        completionOrder.push(idx);
      },
    });

    // A -> B creates 2 clusters
    const dag = buildAndScheduleDAG('req-001', [
      { name: 'A', complexity: 'small' },
      { name: 'B', complexity: 'small', dependsOn: ['A'] },
    ]);

    const scheduler = new Scheduler(
      config,
      makeWorktreeManager(0),
      makeResourceMonitor(),
      callbacks,
    );

    const plan = scheduler.createExecutionPlan(dag);
    expect(plan.clusters).toHaveLength(2);

    // Run in background; complete tracks as they dispatch
    const runPromise = (async () => {
      // Small delay to let dispatch happen
      await new Promise((r) => setTimeout(r, 10));
      scheduler.notifyTrackComplete('req-001', 'A', true);
      await new Promise((r) => setTimeout(r, 10));
      scheduler.notifyTrackComplete('req-001', 'B', true);
    })();

    await scheduler.run(plan);
    await runPromise;

    expect(completionOrder).toEqual([0, 1]);
  });

  it('throws ResourceExhaustedError when resources unavailable before cluster', async () => {
    const config = makeConfig({ max_tracks: 3, max_worktrees: 5 });

    const scheduler = new Scheduler(
      config,
      makeWorktreeManager(0),
      makeResourceMonitor('critical', {
        allowed: false,
        reason: 'Disk pressure critical: usage exceeds hard limit',
      }),
      makeCallbacks(),
    );

    const dag = buildAndScheduleDAG('req-001', [{ name: 'A' }]);
    const plan = scheduler.createExecutionPlan(dag);

    await expect(scheduler.run(plan)).rejects.toThrow(ResourceExhaustedError);
  });

  it('fires onAllClustersComplete after all clusters finish', async () => {
    let allDone = false;
    const config = makeConfig({ max_tracks: 3, max_worktrees: 5 });

    const callbacks = makeCallbacks({
      onAllClustersComplete: async () => {
        allDone = true;
      },
    });

    const dag = buildAndScheduleDAG('req-001', [{ name: 'A' }]);

    const scheduler = new Scheduler(
      config,
      makeWorktreeManager(0),
      makeResourceMonitor(),
      callbacks,
    );

    const plan = scheduler.createExecutionPlan(dag);

    const runPromise = (async () => {
      await new Promise((r) => setTimeout(r, 10));
      scheduler.notifyTrackComplete('req-001', 'A', true);
    })();

    await scheduler.run(plan);
    await runPromise;

    expect(allDone).toBe(true);
  });

  it('continues to next cluster even when some tracks fail', async () => {
    const completionOrder: number[] = [];
    const config = makeConfig({ max_tracks: 3, max_worktrees: 5 });

    // A and B are independent (cluster 0), C depends on A (cluster 1)
    const dag = buildAndScheduleDAG('req-001', [
      { name: 'A', complexity: 'small' },
      { name: 'B', complexity: 'small' },
      { name: 'C', complexity: 'small', dependsOn: ['A'] },
    ]);

    const callbacks = makeCallbacks({
      onClusterComplete: async (_req, idx) => {
        completionOrder.push(idx);
      },
    });

    const scheduler = new Scheduler(
      config,
      makeWorktreeManager(0),
      makeResourceMonitor(),
      callbacks,
    );

    const plan = scheduler.createExecutionPlan(dag);

    const runPromise = (async () => {
      await new Promise((r) => setTimeout(r, 10));
      // B fails but A succeeds; scheduler should still proceed to cluster 1
      scheduler.notifyTrackComplete('req-001', 'A', true);
      scheduler.notifyTrackComplete('req-001', 'B', false);
      await new Promise((r) => setTimeout(r, 10));
      scheduler.notifyTrackComplete('req-001', 'C', true);
    })();

    await scheduler.run(plan);
    await runPromise;

    expect(completionOrder).toEqual([0, 1]);
  });
});

// ============================================================================
// priority ordering
// ============================================================================

describe('priority ordering', () => {
  it('critical path nodes dispatch before non-critical', async () => {
    const dispatched: string[] = [];
    // max_tracks=1 to force serial dispatch within cluster
    const config = makeConfig({ max_tracks: 1, max_worktrees: 5 });

    const callbacks = makeCallbacks({
      onTrackDispatch: async (_req, name) => {
        dispatched.push(name);
      },
    });

    // Build a DAG where 'critical' is on the critical path
    // and 'minor' is not
    const dag = buildAndScheduleDAG('req-001', [
      { name: 'critical', complexity: 'large', estimatedMinutes: 30 },
      { name: 'minor', complexity: 'small', estimatedMinutes: 5 },
    ]);

    const scheduler = new Scheduler(
      config,
      makeWorktreeManager(0),
      makeResourceMonitor(),
      callbacks,
    );

    const plan = scheduler.createExecutionPlan(dag);

    // Verify priority ordering: critical should be first in cluster tracks
    expect(plan.clusters[0].tracks[0].trackName).toBe('critical');
    expect(plan.clusters[0].tracks[0].priority).toBeGreaterThan(
      plan.clusters[0].tracks[1].priority,
    );

    const resultPromise = scheduler.executeCluster('req-001', plan.clusters[0]);
    await new Promise((r) => setTimeout(r, 10));

    // With max_tracks=1, only 'critical' dispatched first
    expect(dispatched[0]).toBe('critical');

    scheduler.notifyTrackComplete('req-001', 'critical', true);
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatched[1]).toBe('minor');

    scheduler.notifyTrackComplete('req-001', 'minor', true);
    await resultPromise;
  });

  it('dispatches higher priority tracks before lower within a cluster', async () => {
    const dispatched: string[] = [];
    // max_tracks=1 to force strictly serial dispatch
    const config = makeConfig({ max_tracks: 1, max_worktrees: 5 });

    const callbacks = makeCallbacks({
      onTrackDispatch: async (_req, name) => {
        dispatched.push(name);
      },
    });

    const scheduler = new Scheduler(
      config,
      makeWorktreeManager(0),
      makeResourceMonitor(),
      callbacks,
    );

    const cluster = makeClusterPlan(0, [
      { trackName: 'high', priority: 20 },
      { trackName: 'mid', priority: 10 },
      { trackName: 'low', priority: 1 },
    ]);

    const resultPromise = scheduler.executeCluster('req-001', cluster);
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatched).toEqual(['high']);

    scheduler.notifyTrackComplete('req-001', 'high', true);
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatched).toEqual(['high', 'mid']);

    scheduler.notifyTrackComplete('req-001', 'mid', true);
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatched).toEqual(['high', 'mid', 'low']);

    scheduler.notifyTrackComplete('req-001', 'low', true);
    await resultPromise;
  });
});

// ============================================================================
// notifyTrackComplete
// ============================================================================

describe('notifyTrackComplete', () => {
  it('is a no-op when no cluster is executing', () => {
    const scheduler = new Scheduler(
      makeConfig(),
      makeWorktreeManager(),
      makeResourceMonitor(),
      makeCallbacks(),
    );

    // Should not throw
    expect(() => {
      scheduler.notifyTrackComplete('req-001', 't1', true);
    }).not.toThrow();
  });

  it('fires onTrackComplete callback with correct arguments', async () => {
    const completedTracks: Array<{ req: string; name: string; success: boolean }> = [];
    const config = makeConfig({ max_tracks: 3, max_worktrees: 5 });

    const callbacks = makeCallbacks({
      onTrackComplete: (req, name, success) => {
        completedTracks.push({ req, name, success });
      },
    });

    const scheduler = new Scheduler(
      config,
      makeWorktreeManager(0),
      makeResourceMonitor(),
      callbacks,
    );

    const cluster = makeClusterPlan(0, [
      { trackName: 't1', priority: 10 },
    ]);

    const resultPromise = scheduler.executeCluster('req-001', cluster);
    await new Promise((r) => setTimeout(r, 10));

    scheduler.notifyTrackComplete('req-001', 't1', true);
    await resultPromise;

    expect(completedTracks).toEqual([
      { req: 'req-001', name: 't1', success: true },
    ]);
  });
});

// ============================================================================
// ResourceMonitor (integration-style with mock WorktreeManager)
// ============================================================================

describe('ResourceMonitor', () => {
  // Create a mock WorktreeManager with the minimal interface needed
  function makeMockWorkTreeManagerForRM(overrides: {
    pressureLevel?: DiskPressureLevel;
    activeCount?: number;
    diskUsageBytes?: number;
    worktreeRoot?: string;
  } = {}) {
    const {
      pressureLevel = 'normal',
      activeCount = 0,
      diskUsageBytes = 0,
      worktreeRoot = '/tmp/worktrees',
    } = overrides;

    return {
      getDiskPressureLevel: () => pressureLevel,
      getActiveWorktreeCount: async () => activeCount,
      checkDiskUsage: async () => ({
        totalBytes: diskUsageBytes,
        perWorktree: {},
      }),
      resolvedWorktreeRoot: worktreeRoot,
    } as any;
  }

  it('returns disk pressure level from worktree manager', () => {
    const wm = makeMockWorkTreeManagerForRM({ pressureLevel: 'warning' });
    const config = makeConfig();
    const rm = new ResourceMonitor(wm, config);
    expect(rm.getDiskPressureLevel()).toBe('warning');
  });

  it('checkResources returns full status snapshot', async () => {
    const wm = makeMockWorkTreeManagerForRM({
      pressureLevel: 'normal',
      activeCount: 2,
      diskUsageBytes: 1024,
    });
    const config = makeConfig({ max_worktrees: 5 });
    const rm = new ResourceMonitor(wm, config);

    const status = await rm.checkResources();
    expect(status.diskPressure).toBe('normal');
    expect(status.activeWorktrees).toBe(2);
    expect(status.maxWorktrees).toBe(5);
    expect(status.availableSlots).toBe(3);
    expect(status.diskUsageBytes).toBe(1024);
  });

  it('canDispatch blocks when disk pressure is critical', async () => {
    const wm = makeMockWorkTreeManagerForRM({ pressureLevel: 'critical' });
    const config = makeConfig();
    const rm = new ResourceMonitor(wm, config);

    const result = await rm.canDispatch();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('critical');
  });

  it('canDispatch blocks when max worktrees reached', async () => {
    const wm = makeMockWorkTreeManagerForRM({
      pressureLevel: 'normal',
      activeCount: 5,
    });
    const config = makeConfig({ max_worktrees: 5 });
    const rm = new ResourceMonitor(wm, config);

    const result = await rm.canDispatch();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Max worktrees');
  });

  it('canDispatch allows when resources are available', async () => {
    const wm = makeMockWorkTreeManagerForRM({
      pressureLevel: 'normal',
      activeCount: 2,
    });
    const config = makeConfig({ max_worktrees: 5 });
    const rm = new ResourceMonitor(wm, config);

    const result = await rm.canDispatch();
    expect(result.allowed).toBe(true);
  });
});

/**
 * Tests for EventBus, TrackStateMachine, StallDetector, and ProgressTracker.
 *
 * SPEC-006-5-1: Event Bus, Track State Machine, and Stall Detection
 * SPEC-006-5-2: Progress Reporting and ETA Calculation (Tasks 4 & 5)
 *
 * Covers:
 *   - EventBus: handler registration, emission, off, error isolation, audit logging
 *   - TrackStateMachine: valid transitions, invalid transitions, transition recording,
 *     event emission, canTransition, restore from persisted state
 *   - StallDetector: warning at stall_timeout, termination at 2x, activity updates,
 *     track registration/unregistration
 *   - Per-track progress reporting (getTrackProgress)
 *   - Request-level progress aggregation (getRequestProgress)
 *   - ETA calculation via rolling average of completed track durations
 *   - Complexity-based heuristic ETA when no tracks have completed
 *   - Periodic request.progress event emission
 *   - Edge cases: unknown tracks, zero tracks, all complete
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { EventBus, ParallelEvent, TrackState as EventTrackState } from '../../src/parallel/events';
import {
  ProgressTracker,
  TrackProgress,
  RequestProgress,
  TrackState,
  TrackStateMachineLike,
  EventBusLike,
  TrackStateMachine,
  StallDetector,
  InvalidStateTransitionError,
  StateTransition,
  VALID_TRANSITIONS,
} from '../../src/parallel/progress-tracker';
import { StatePersister } from '../../src/parallel/state-persister';
import { ParallelConfig, DEFAULT_PARALLEL_CONFIG } from '../../src/parallel/config';
import type { TrackAssignment } from '../../src/parallel/types';
import { AgentLifecyclePhase } from '../../src/parallel/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal TrackStateMachine stub for testing.
 */
class StubStateMachine implements TrackStateMachineLike {
  private state: TrackState;

  constructor(initialState: TrackState = 'pending') {
    this.state = initialState;
  }

  getState(): TrackState {
    return this.state;
  }

  setState(state: TrackState): void {
    this.state = state;
  }

  /**
   * Simulate a transition (no validation, just sets state).
   */
  async transition(to: TrackState, _reason: string): Promise<void> {
    this.state = to;
  }
}

/**
 * Stub EventBus that records all emitted events.
 */
class StubEventBus implements EventBusLike {
  public events: Array<Record<string, unknown>> = [];

  emit(event: Record<string, unknown>): void {
    this.events.push(event);
  }
}

function createAssignment(
  overrides: Partial<TrackAssignment> = {},
): TrackAssignment {
  return {
    trackName: 'track-a',
    worktreePath: '/tmp/fake-worktree',
    branchName: 'auto/req-001/track-a',
    agentSessionId: null,
    spec: { name: 'test-spec', path: '/tmp/fake-spec.md', complexity: 'small' },
    parentPlan: '/tmp/fake-plan.md',
    parentTDD: '/tmp/fake-tdd.md',
    parentPRD: '/tmp/fake-prd.md',
    turnsUsed: 0,
    turnBudget: 60,
    retryCount: 0,
    lastActivityAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    lifecyclePhase: AgentLifecyclePhase.Executing,
    interfaceContracts: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ProgressTracker', () => {
  let tracker: ProgressTracker;
  let bus: StubEventBus;
  let config: ParallelConfig;

  beforeEach(() => {
    bus = new StubEventBus();
    config = { ...DEFAULT_PARALLEL_CONFIG, max_tracks: 5 };
    tracker = new ProgressTracker('req-001', bus, config);
  });

  // =========================================================================
  // getTrackProgress
  // =========================================================================

  describe('getTrackProgress', () => {
    it('reports executing track with turn count', () => {
      const sm = new StubStateMachine('executing');
      const assignment = createAssignment({
        trackName: 'track-a',
        turnsUsed: 23,
        turnBudget: 60,
        startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      });
      tracker.registerTrack('track-a', assignment, sm);

      const progress = tracker.getTrackProgress('track-a');
      expect(progress.phaseProgress).toBe('executing (turn 23/60)');
      expect(progress.elapsedMinutes).toBeGreaterThanOrEqual(4);
      expect(progress.turnsUsed).toBe(23);
      expect(progress.turnBudget).toBe(60);
      expect(progress.state).toBe('executing');
    });

    it('reports complete track', () => {
      const sm = new StubStateMachine('complete');
      const now = new Date().toISOString();
      const assignment = createAssignment({
        trackName: 'track-a',
        startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        completedAt: now,
      });
      tracker.registerTrack('track-a', assignment, sm);

      const progress = tracker.getTrackProgress('track-a');
      expect(progress.state).toBe('complete');
      expect(progress.phaseProgress).toBe('complete');
      expect(progress.completedAt).toBe(now);
    });

    it('reports failed track with retry count', () => {
      const sm = new StubStateMachine('failed');
      const assignment = createAssignment({
        trackName: 'track-a',
        retryCount: 2,
      });
      tracker.registerTrack('track-a', assignment, sm);

      const progress = tracker.getTrackProgress('track-a');
      expect(progress.state).toBe('failed');
      expect(progress.phaseProgress).toBe('failed (retry 2)');
    });

    it('reports pending track', () => {
      const sm = new StubStateMachine('pending');
      const assignment = createAssignment({ trackName: 'track-a' });
      tracker.registerTrack('track-a', assignment, sm);

      const progress = tracker.getTrackProgress('track-a');
      expect(progress.state).toBe('pending');
      expect(progress.phaseProgress).toBe('pending');
      expect(progress.elapsedMinutes).toBe(0);
    });

    it('reports queued track', () => {
      const sm = new StubStateMachine('queued');
      const assignment = createAssignment({ trackName: 'track-a' });
      tracker.registerTrack('track-a', assignment, sm);

      const progress = tracker.getTrackProgress('track-a');
      expect(progress.state).toBe('queued');
      expect(progress.phaseProgress).toBe('queued');
    });

    it('reports testing track', () => {
      const sm = new StubStateMachine('testing');
      const assignment = createAssignment({
        trackName: 'track-a',
        startedAt: new Date().toISOString(),
      });
      tracker.registerTrack('track-a', assignment, sm);

      const progress = tracker.getTrackProgress('track-a');
      expect(progress.state).toBe('testing');
      expect(progress.phaseProgress).toBe('testing');
    });

    it('reports reviewing track', () => {
      const sm = new StubStateMachine('reviewing');
      const assignment = createAssignment({
        trackName: 'track-a',
        startedAt: new Date().toISOString(),
      });
      tracker.registerTrack('track-a', assignment, sm);

      const progress = tracker.getTrackProgress('track-a');
      expect(progress.phaseProgress).toBe('reviewing');
    });

    it('reports merging track', () => {
      const sm = new StubStateMachine('merging');
      const assignment = createAssignment({
        trackName: 'track-a',
        startedAt: new Date().toISOString(),
      });
      tracker.registerTrack('track-a', assignment, sm);

      const progress = tracker.getTrackProgress('track-a');
      expect(progress.phaseProgress).toBe('merging');
    });

    it('throws for unknown track', () => {
      expect(() => tracker.getTrackProgress('nonexistent')).toThrow(
        'Unknown track: nonexistent',
      );
    });

    it('reports zero elapsed when startedAt is null', () => {
      const sm = new StubStateMachine('pending');
      const assignment = createAssignment({
        trackName: 'track-a',
        startedAt: null,
      });
      tracker.registerTrack('track-a', assignment, sm);

      const progress = tracker.getTrackProgress('track-a');
      expect(progress.elapsedMinutes).toBe(0);
      expect(progress.startedAt).toBeNull();
    });
  });

  // =========================================================================
  // getRequestProgress
  // =========================================================================

  describe('getRequestProgress', () => {
    it('calculates correct percentages', () => {
      // 3 tracks: 1 complete, 1 executing, 1 pending
      const smComplete = new StubStateMachine('complete');
      const smExecuting = new StubStateMachine('executing');
      const smPending = new StubStateMachine('pending');

      tracker.registerTrack(
        'track-a',
        createAssignment({ trackName: 'track-a', spec: { name: 'a', complexity: 'small' } }),
        smComplete,
      );
      tracker.registerTrack(
        'track-b',
        createAssignment({ trackName: 'track-b', turnsUsed: 10, startedAt: new Date().toISOString(), spec: { name: 'b', complexity: 'small' } }),
        smExecuting,
      );
      tracker.registerTrack(
        'track-c',
        createAssignment({ trackName: 'track-c', spec: { name: 'c', complexity: 'small' } }),
        smPending,
      );

      const progress = tracker.getRequestProgress(0, 2);
      expect(progress.totalTracks).toBe(3);
      expect(progress.completedTracks).toBe(1);
      expect(progress.failedTracks).toBe(0);
      expect(progress.percentComplete).toBe(33);
    });

    it('includes in-progress track details', () => {
      const smComplete = new StubStateMachine('complete');
      const smExecuting = new StubStateMachine('executing');

      tracker.registerTrack(
        'track-a',
        createAssignment({ trackName: 'track-a', spec: { name: 'a', complexity: 'small' } }),
        smComplete,
      );
      tracker.registerTrack(
        'track-b',
        createAssignment({ trackName: 'track-b', turnsUsed: 5, startedAt: new Date().toISOString(), spec: { name: 'b', complexity: 'small' } }),
        smExecuting,
      );

      const progress = tracker.getRequestProgress(0, 2);
      expect(progress.inProgressTracks.length).toBe(1);
      expect(progress.inProgressTracks[0].trackName).toBe('track-b');
    });

    it('counts failed and escalated tracks', () => {
      const smFailed = new StubStateMachine('failed');
      const smEscalated = new StubStateMachine('escalated');
      const smComplete = new StubStateMachine('complete');

      tracker.registerTrack(
        'track-a',
        createAssignment({ trackName: 'track-a', spec: { name: 'a', complexity: 'small' } }),
        smFailed,
      );
      tracker.registerTrack(
        'track-b',
        createAssignment({ trackName: 'track-b', spec: { name: 'b', complexity: 'small' } }),
        smEscalated,
      );
      tracker.registerTrack(
        'track-c',
        createAssignment({ trackName: 'track-c', spec: { name: 'c', complexity: 'small' } }),
        smComplete,
      );

      const progress = tracker.getRequestProgress(1, 3);
      expect(progress.failedTracks).toBe(2);
      expect(progress.completedTracks).toBe(1);
      expect(progress.inProgressTracks.length).toBe(0);
    });

    it('returns 0% for zero tracks', () => {
      const progress = tracker.getRequestProgress(0, 1);
      expect(progress.totalTracks).toBe(0);
      expect(progress.percentComplete).toBe(0);
    });

    it('returns 100% when all tracks complete', () => {
      tracker.registerTrack(
        'track-a',
        createAssignment({ trackName: 'track-a', spec: { name: 'a', complexity: 'small' } }),
        new StubStateMachine('complete'),
      );
      tracker.registerTrack(
        'track-b',
        createAssignment({ trackName: 'track-b', spec: { name: 'b', complexity: 'small' } }),
        new StubStateMachine('complete'),
      );

      const progress = tracker.getRequestProgress(1, 1);
      expect(progress.percentComplete).toBe(100);
      expect(progress.completedTracks).toBe(2);
    });

    it('includes cluster info', () => {
      tracker.registerTrack(
        'track-a',
        createAssignment({ trackName: 'track-a', spec: { name: 'a', complexity: 'small' } }),
        new StubStateMachine('executing'),
      );

      const progress = tracker.getRequestProgress(2, 5);
      expect(progress.currentCluster).toBe(2);
      expect(progress.totalClusters).toBe(5);
    });

    it('includes startedAt and elapsedMinutes', () => {
      tracker.registerTrack(
        'track-a',
        createAssignment({ trackName: 'track-a', spec: { name: 'a', complexity: 'small' } }),
        new StubStateMachine('executing'),
      );

      const progress = tracker.getRequestProgress(0, 1);
      expect(progress.startedAt).toBeDefined();
      expect(typeof progress.elapsedMinutes).toBe('number');
      expect(progress.elapsedMinutes).toBeGreaterThanOrEqual(0);
    });

    it('includes requestId', () => {
      const progress = tracker.getRequestProgress(0, 1);
      expect(progress.requestId).toBe('req-001');
    });
  });

  // =========================================================================
  // ETA calculation
  // =========================================================================

  describe('ETA calculation', () => {
    it('uses rolling average when completed tracks exist', () => {
      // Register 5 tracks, 2 completed
      for (let i = 0; i < 5; i++) {
        const state = i < 2 ? 'complete' : 'executing';
        tracker.registerTrack(
          `track-${i}`,
          createAssignment({
            trackName: `track-${i}`,
            startedAt: new Date().toISOString(),
            spec: { name: `spec-${i}`, complexity: 'small' },
          }),
          new StubStateMachine(state as TrackState),
        );
      }

      tracker.recordTrackCompletion('track-0', 10);
      tracker.recordTrackCompletion('track-1', 20);

      // Average = 15 min, 3 remaining, parallelism = min(5, 3) = 3
      // trackTime = (3 / 3) * 15 = 15, clusterOverhead = 1 * 1 = 1
      // ETA = round(15 + 1) = 16
      const eta = tracker.calculateETA(5, 2, 3, 1);
      expect(eta).toBeGreaterThan(0);
      expect(eta).toBeLessThan(30);
    });

    it('uses heuristic when no completed tracks', () => {
      // All small (5 min each), 5 tracks, parallelism 5
      for (let i = 0; i < 5; i++) {
        tracker.registerTrack(
          `track-${i}`,
          createAssignment({
            trackName: `track-${i}`,
            spec: { name: `spec-${i}`, complexity: 'small' },
          }),
          new StubStateMachine('executing'),
        );
      }

      // 5 tracks x 5 min = 25, parallelism = 5 -> 25/5 = 5, + 1 cluster = 6
      const eta = tracker.calculateETA(5, 0, 5, 1);
      expect(eta).toBeGreaterThan(0);
      expect(eta).toBe(6);
    });

    it('returns 0 when all tracks complete', () => {
      const eta = tracker.calculateETA(5, 5, 0, 0);
      expect(eta).toBe(0);
    });

    it('accounts for cluster overhead', () => {
      tracker.recordTrackCompletion('t1', 10);

      // Register some tracks so heuristic has data
      for (let i = 0; i < 3; i++) {
        tracker.registerTrack(
          `track-${i}`,
          createAssignment({
            trackName: `track-${i}`,
            spec: { name: `spec-${i}`, complexity: 'medium' },
          }),
          new StubStateMachine(i === 0 ? 'complete' : 'executing' as TrackState),
        );
      }

      const etaWith1Cluster = tracker.calculateETA(3, 1, 2, 1);
      const etaWith3Clusters = tracker.calculateETA(3, 1, 2, 3);
      expect(etaWith3Clusters!).toBeGreaterThan(etaWith1Cluster!);
    });

    it('returns null-equivalent heuristic for no data edge case', () => {
      // Register a single track with medium complexity
      tracker.registerTrack(
        'track-a',
        createAssignment({
          trackName: 'track-a',
          spec: { name: 'a', complexity: 'medium' },
        }),
        new StubStateMachine('executing'),
      );

      const eta = tracker.calculateETA(1, 0, 1, 0);
      // 1 track x 15 min / parallelism 1 + 0 clusters = 15
      expect(eta).toBe(15);
    });

    it('handles large complexity tracks in heuristic', () => {
      tracker.registerTrack(
        'track-a',
        createAssignment({
          trackName: 'track-a',
          spec: { name: 'a', complexity: 'large' },
        }),
        new StubStateMachine('executing'),
      );

      const eta = tracker.calculateETA(1, 0, 1, 0);
      // 1 track x 30 min / parallelism 1 + 0 clusters = 30
      expect(eta).toBe(30);
    });

    it('respects max_tracks for parallelism calculation', () => {
      // Config has max_tracks = 5, but only 2 remaining
      tracker.recordTrackCompletion('t1', 10);

      const eta = tracker.calculateETA(5, 3, 2, 0);
      // 2 remaining, parallelism = min(5, 2) = 2
      // trackTime = (2 / 2) * 10 = 10, clusters = 0
      expect(eta).toBe(10);
    });

    it('caps parallelism at max_tracks when many tracks remain', () => {
      config = { ...DEFAULT_PARALLEL_CONFIG, max_tracks: 3 };
      tracker = new ProgressTracker('req-001', bus, config);

      tracker.recordTrackCompletion('t1', 12);

      // 8 remaining, parallelism = min(3, 8) = 3
      // trackTime = (8 / 3) * 12 = 32, clusters = 2
      const eta = tracker.calculateETA(10, 2, 8, 2);
      expect(eta).toBe(34);
    });
  });

  // =========================================================================
  // recordTrackCompletion
  // =========================================================================

  describe('recordTrackCompletion', () => {
    it('accumulates completed durations', () => {
      tracker.recordTrackCompletion('track-a', 10);
      tracker.recordTrackCompletion('track-b', 20);
      tracker.recordTrackCompletion('track-c', 30);

      // Average should be 20 min
      // With 2 remaining, parallelism 2: (2/2) * 20 + 1 cluster = 21
      for (let i = 0; i < 5; i++) {
        tracker.registerTrack(
          `t-${i}`,
          createAssignment({
            trackName: `t-${i}`,
            spec: { name: `s-${i}`, complexity: 'medium' },
          }),
          new StubStateMachine(i < 3 ? 'complete' : 'executing' as TrackState),
        );
      }

      const eta = tracker.calculateETA(5, 3, 2, 1);
      expect(eta).toBe(21); // (2/2) * 20 + 1
    });
  });

  // =========================================================================
  // Periodic reporting
  // =========================================================================

  describe('startPeriodicReporting / stopPeriodicReporting', () => {
    afterEach(() => {
      tracker.stopPeriodicReporting();
    });

    it('emits request.progress events at interval', (done) => {
      tracker.registerTrack(
        'track-a',
        createAssignment({
          trackName: 'track-a',
          spec: { name: 'a', complexity: 'small' },
        }),
        new StubStateMachine('executing'),
      );

      // Use a short interval for testing
      tracker.startPeriodicReporting(0, 1, 50);

      setTimeout(() => {
        tracker.stopPeriodicReporting();
        const progressEvents = bus.events.filter(
          (e) => e.type === 'request.progress',
        );
        expect(progressEvents.length).toBeGreaterThanOrEqual(1);

        const event = progressEvents[0];
        expect(event.requestId).toBe('req-001');
        expect(event.totalTracks).toBe(1);
        expect(event.timestamp).toBeDefined();
        done();
      }, 200);
    });

    it('stops emitting after stopPeriodicReporting', (done) => {
      tracker.registerTrack(
        'track-a',
        createAssignment({
          trackName: 'track-a',
          spec: { name: 'a', complexity: 'small' },
        }),
        new StubStateMachine('executing'),
      );

      tracker.startPeriodicReporting(0, 1, 50);

      setTimeout(() => {
        tracker.stopPeriodicReporting();
        const countAtStop = bus.events.filter(
          (e) => e.type === 'request.progress',
        ).length;

        setTimeout(() => {
          const countAfterStop = bus.events.filter(
            (e) => e.type === 'request.progress',
          ).length;
          // No new events after stop
          expect(countAfterStop).toBe(countAtStop);
          done();
        }, 150);
      }, 100);
    });

    it('stopPeriodicReporting is safe to call when not started', () => {
      expect(() => tracker.stopPeriodicReporting()).not.toThrow();
    });

    it('stopPeriodicReporting is safe to call multiple times', () => {
      tracker.startPeriodicReporting(0, 1, 100);
      tracker.stopPeriodicReporting();
      expect(() => tracker.stopPeriodicReporting()).not.toThrow();
    });
  });

  // =========================================================================
  // registerTrack
  // =========================================================================

  describe('registerTrack', () => {
    it('allows querying progress for registered tracks', () => {
      const sm = new StubStateMachine('pending');
      const assignment = createAssignment({ trackName: 'track-a' });
      tracker.registerTrack('track-a', assignment, sm);

      expect(() => tracker.getTrackProgress('track-a')).not.toThrow();
    });

    it('supports registering multiple tracks', () => {
      for (let i = 0; i < 5; i++) {
        tracker.registerTrack(
          `track-${i}`,
          createAssignment({
            trackName: `track-${i}`,
            spec: { name: `s-${i}`, complexity: 'small' },
          }),
          new StubStateMachine('pending'),
        );
      }

      const progress = tracker.getRequestProgress(0, 1);
      expect(progress.totalTracks).toBe(5);
    });
  });
});

// ===========================================================================
// SPEC-006-5-1: EventBus, TrackStateMachine, StallDetector
// ===========================================================================

// ---------------------------------------------------------------------------
// Shared setup for SPEC-006-5-1 tests
// ---------------------------------------------------------------------------

let spec51TmpDir: string;
let spec51LogDir: string;
let spec51StateDir: string;
let spec51ArchiveDir: string;

function makeMinimalStateChangedEvent(
  overrides?: Partial<Record<string, unknown>>,
): ParallelEvent {
  return {
    type: 'track.state_changed',
    requestId: 'r1',
    trackName: 't1',
    from: 'pending' as EventTrackState,
    to: 'queued' as EventTrackState,
    reason: 'test',
    timestamp: new Date().toISOString(),
    ...overrides,
  } as ParallelEvent;
}

function makeSpec51Config(overrides?: Partial<ParallelConfig>): ParallelConfig {
  return { ...DEFAULT_PARALLEL_CONFIG, ...overrides };
}

beforeEach(async () => {
  spec51TmpDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'spec-006-5-1-test-'),
  );
  spec51LogDir = path.join(spec51TmpDir, 'logs');
  spec51StateDir = path.join(spec51TmpDir, 'state');
  spec51ArchiveDir = path.join(spec51TmpDir, 'archive');
  await fsp.mkdir(spec51LogDir, { recursive: true });
  await fsp.mkdir(spec51StateDir, { recursive: true });
  await fsp.mkdir(spec51ArchiveDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(spec51TmpDir, { recursive: true, force: true });
});

// ===========================================================================
// EventBus
// ===========================================================================

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus(spec51LogDir);
  });

  afterEach(() => {
    bus.close();
  });

  it('calls handler on matching event', () => {
    const received: ParallelEvent[] = [];
    bus.on('track.state_changed', (e) => received.push(e));
    bus.emit(makeMinimalStateChangedEvent());
    expect(received.length).toBe(1);
    expect(received[0].type).toBe('track.state_changed');
  });

  it('supports multiple handlers per event type', () => {
    let count = 0;
    bus.on('track.state_changed', () => count++);
    bus.on('track.state_changed', () => count++);
    bus.emit(makeMinimalStateChangedEvent());
    expect(count).toBe(2);
  });

  it('does not call handler for other event types', () => {
    const received: ParallelEvent[] = [];
    bus.on('merge.started', (e) => received.push(e));
    bus.emit(makeMinimalStateChangedEvent());
    expect(received.length).toBe(0);
  });

  it('off removes handler', () => {
    let count = 0;
    const handler = () => count++;
    bus.on('track.state_changed', handler);
    bus.off('track.state_changed', handler);
    bus.emit(makeMinimalStateChangedEvent());
    expect(count).toBe(0);
  });

  it('handler errors do not propagate', () => {
    bus.on('track.state_changed', () => {
      throw new Error('handler fail');
    });
    expect(() => bus.emit(makeMinimalStateChangedEvent())).not.toThrow();
  });

  it('async handler errors do not propagate', async () => {
    bus.on('track.state_changed', async () => {
      throw new Error('async handler fail');
    });
    expect(() => bus.emit(makeMinimalStateChangedEvent())).not.toThrow();
    // Give the promise rejection time to be caught
    await new Promise((r) => setTimeout(r, 10));
  });

  it('logs events to file as NDJSON', async () => {
    bus.initRequestLog('req-001');
    bus.emit(makeMinimalStateChangedEvent());
    bus.close();

    // Allow write stream to flush
    await new Promise((r) => setTimeout(r, 50));

    const logContent = fs.readFileSync(
      path.join(spec51LogDir, 'req-req-001', 'events.log'),
      'utf-8',
    );
    expect(logContent).toContain('track.state_changed');

    // Verify it's valid NDJSON
    const lines = logContent.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe('track.state_changed');
  });

  it('does not log when logDir is not provided', () => {
    const busNoLog = new EventBus(); // no logDir
    // Should not throw
    busNoLog.emit(makeMinimalStateChangedEvent());
    busNoLog.close();
  });

  it('removeAllListeners clears all handlers', () => {
    let count = 0;
    bus.on('track.state_changed', () => count++);
    bus.on('merge.started', () => count++);
    bus.removeAllListeners();
    bus.emit(makeMinimalStateChangedEvent());
    expect(count).toBe(0);
  });
});

// ===========================================================================
// TrackStateMachine
// ===========================================================================

describe('TrackStateMachine', () => {
  let bus: EventBus;
  let persister: StatePersister;
  let sm: TrackStateMachine;

  beforeEach(() => {
    bus = new EventBus();
    persister = new StatePersister(spec51StateDir, spec51ArchiveDir);
    sm = new TrackStateMachine('r1', 't1', bus, persister);
  });

  afterEach(() => {
    bus.close();
  });

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
    await expect(sm.transition('complete', 'shortcut')).rejects.toThrow(
      InvalidStateTransitionError,
    );
  });

  it('rejects invalid transition: pending -> executing (must go through queued)', async () => {
    await expect(sm.transition('executing', 'skip queue')).rejects.toThrow(
      InvalidStateTransitionError,
    );
  });

  it('allows failure from queued', async () => {
    await sm.transition('queued', 'scheduled');
    await sm.transition('failed', 'error');
    expect(sm.getState()).toBe('failed');
  });

  it('allows failure from executing', async () => {
    await sm.transition('queued', 'scheduled');
    await sm.transition('executing', 'agent spawned');
    await sm.transition('failed', 'agent crashed');
    expect(sm.getState()).toBe('failed');
  });

  it('allows escalation from executing', async () => {
    await sm.transition('queued', 'scheduled');
    await sm.transition('executing', 'agent spawned');
    await sm.transition('escalated', 'human intervention required');
    expect(sm.getState()).toBe('escalated');
  });

  it('allows re-queue from failed', async () => {
    await sm.transition('queued', 'scheduled');
    await sm.transition('failed', 'error');
    await sm.transition('queued', 'retry');
    expect(sm.getState()).toBe('queued');
  });

  it('does not allow transition from complete (terminal)', async () => {
    await sm.transition('queued', 'scheduled');
    await sm.transition('executing', 'agent spawned');
    await sm.transition('testing', 'done');
    await sm.transition('reviewing', 'tests passed');
    await sm.transition('merging', 'review passed');
    await sm.transition('complete', 'merged');
    await expect(sm.transition('queued', 'restart')).rejects.toThrow(
      InvalidStateTransitionError,
    );
  });

  it('does not allow transition from escalated (terminal)', async () => {
    await sm.transition('queued', 'scheduled');
    await sm.transition('executing', 'agent spawned');
    await sm.transition('escalated', 'needs human');
    await expect(sm.transition('queued', 'retry')).rejects.toThrow(
      InvalidStateTransitionError,
    );
  });

  it('records all transitions with timestamps', async () => {
    await sm.transition('queued', 'scheduled');
    await sm.transition('executing', 'agent spawned');
    const transitions = sm.getTransitions();
    expect(transitions.length).toBe(2);
    expect(transitions[0].from).toBe('pending');
    expect(transitions[0].to).toBe('queued');
    expect(transitions[0].reason).toBe('scheduled');
    expect(transitions[0].timestamp).toBeDefined();
    expect(transitions[1].from).toBe('queued');
    expect(transitions[1].to).toBe('executing');
    expect(transitions[1].reason).toBe('agent spawned');
    expect(transitions[1].timestamp).toBeDefined();
  });

  it('emits track.state_changed event on transition', async () => {
    const events: ParallelEvent[] = [];
    bus.on('track.state_changed', (e) => events.push(e));
    await sm.transition('queued', 'scheduled');
    expect(events.length).toBe(1);
    const evt = events[0] as any;
    expect(evt.from).toBe('pending');
    expect(evt.to).toBe('queued');
    expect(evt.trackName).toBe('t1');
    expect(evt.requestId).toBe('r1');
    expect(evt.reason).toBe('scheduled');
  });

  it('does not emit event on invalid transition', async () => {
    const events: ParallelEvent[] = [];
    bus.on('track.state_changed', (e) => events.push(e));
    await expect(sm.transition('complete', 'shortcut')).rejects.toThrow();
    expect(events.length).toBe(0);
  });

  it('canTransition returns correct results', () => {
    // pending can go to queued
    expect(sm.canTransition('queued')).toBe(true);
    // pending cannot go to complete
    expect(sm.canTransition('complete')).toBe(false);
    // pending cannot go to failed
    expect(sm.canTransition('failed')).toBe(false);
    // pending cannot go to executing directly
    expect(sm.canTransition('executing')).toBe(false);
  });

  it('canTransition updates after state changes', async () => {
    await sm.transition('queued', 'scheduled');
    expect(sm.canTransition('executing')).toBe(true);
    expect(sm.canTransition('failed')).toBe(true);
    expect(sm.canTransition('pending')).toBe(false);
  });

  it('restores from persisted state', () => {
    const transitions: StateTransition[] = [
      { from: 'pending', to: 'queued', timestamp: '2026-01-01T00:00:00Z', reason: 'test' },
      { from: 'queued', to: 'executing', timestamp: '2026-01-01T00:01:00Z', reason: 'test' },
    ];
    const restored = TrackStateMachine.restore(
      'r1', 't1', bus, persister,
      'executing',
      transitions,
    );
    expect(restored.getState()).toBe('executing');
    expect(restored.getTransitions().length).toBe(2);
    expect(restored.getTransitions()[0].from).toBe('pending');
    expect(restored.getTransitions()[1].to).toBe('executing');
  });

  it('restored state machine can continue transitioning', async () => {
    const transitions: StateTransition[] = [
      { from: 'pending', to: 'queued', timestamp: '2026-01-01T00:00:00Z', reason: 'test' },
      { from: 'queued', to: 'executing', timestamp: '2026-01-01T00:01:00Z', reason: 'test' },
    ];
    const restored = TrackStateMachine.restore(
      'r1', 't1', bus, persister,
      'executing',
      transitions,
    );
    await restored.transition('testing', 'execution complete');
    expect(restored.getState()).toBe('testing');
    expect(restored.getTransitions().length).toBe(3);
  });

  it('getTransitions returns a copy (not a mutable reference)', async () => {
    await sm.transition('queued', 'scheduled');
    const t1 = sm.getTransitions();
    await sm.transition('executing', 'spawned');
    const t2 = sm.getTransitions();
    // t1 should still have length 1 (it was a copy)
    expect(t1.length).toBe(1);
    expect(t2.length).toBe(2);
  });

  it('error message includes track name and valid transitions', async () => {
    try {
      await sm.transition('complete', 'shortcut');
      fail('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(InvalidStateTransitionError);
      expect(err.message).toContain('t1');
      expect(err.message).toContain('pending');
      expect(err.message).toContain('complete');
      expect(err.message).toContain('queued'); // valid transition listed
      expect(err.trackName).toBe('t1');
      expect(err.from).toBe('pending');
      expect(err.to).toBe('complete');
    }
  });
});

// ===========================================================================
// StallDetector
// ===========================================================================

describe('StallDetector', () => {
  let bus: EventBus;
  let config: ParallelConfig;
  let terminatedTracks: string[];
  let detector: StallDetector;

  beforeEach(() => {
    bus = new EventBus();
    config = makeSpec51Config({ stall_timeout_minutes: 15 });
    terminatedTracks = [];
    detector = new StallDetector(config, bus, async (trackName) => {
      terminatedTracks.push(trackName);
    });
  });

  afterEach(() => {
    detector.stopMonitoring();
    bus.close();
  });

  it('emits warning at stall timeout', async () => {
    const events: ParallelEvent[] = [];
    bus.on('track.stalled', (e) => events.push(e));

    detector.registerTrack('track-a');
    // Simulate passage of time: set lastActivity to 16 minutes ago
    (detector as any).lastActivity.set('track-a', Date.now() - 16 * 60 * 1000);
    await (detector as any).checkAll();

    expect(events.length).toBe(1);
    const evt = events[0] as any;
    expect(evt.action).toBe('warning');
    expect(evt.trackName).toBe('track-a');
    expect(evt.inactiveMinutes).toBeGreaterThanOrEqual(16);
  });

  it('terminates at 2x stall timeout', async () => {
    const events: ParallelEvent[] = [];
    bus.on('track.stalled', (e) => events.push(e));

    detector.registerTrack('track-a');
    // Simulate 31 minutes of inactivity (2x 15 = 30 min threshold)
    (detector as any).lastActivity.set('track-a', Date.now() - 31 * 60 * 1000);
    await (detector as any).checkAll();

    expect(terminatedTracks).toContain('track-a');
    expect(events.length).toBe(1);
    const evt = events[0] as any;
    expect(evt.action).toBe('terminated');
  });

  it('does not alert for recently active tracks', async () => {
    const events: ParallelEvent[] = [];
    bus.on('track.stalled', (e) => events.push(e));

    detector.registerTrack('track-a');
    detector.updateActivity('track-a'); // just now
    await (detector as any).checkAll();

    expect(events.length).toBe(0);
    expect(terminatedTracks.length).toBe(0);
  });

  it('updateActivity prevents stall alert', async () => {
    const events: ParallelEvent[] = [];
    bus.on('track.stalled', (e) => events.push(e));

    detector.registerTrack('track-a');
    // Set old activity
    (detector as any).lastActivity.set('track-a', Date.now() - 14 * 60 * 1000);
    // Update to now
    detector.updateActivity('track-a');
    await (detector as any).checkAll();
    // No stall alert since last activity is recent
    expect(events.length).toBe(0);
  });

  it('unregisterTrack stops monitoring', async () => {
    detector.registerTrack('track-a');
    detector.unregisterTrack('track-a');
    // The track was deleted from the map
    expect((detector as any).lastActivity.has('track-a')).toBe(false);

    // Even if we try to check, no events
    const events: ParallelEvent[] = [];
    bus.on('track.stalled', (e) => events.push(e));
    await (detector as any).checkAll();
    expect(events.length).toBe(0);
  });

  it('registerTrack initializes activity to now', () => {
    const before = Date.now();
    detector.registerTrack('track-a');
    const after = Date.now();
    const lastActivity = (detector as any).lastActivity.get('track-a');
    expect(lastActivity).toBeGreaterThanOrEqual(before);
    expect(lastActivity).toBeLessThanOrEqual(after);
  });

  it('handles multiple tracks independently', async () => {
    const events: ParallelEvent[] = [];
    bus.on('track.stalled', (e) => events.push(e));

    detector.registerTrack('track-a');
    detector.registerTrack('track-b');

    // track-a is stalled (16 min), track-b is fine
    (detector as any).lastActivity.set('track-a', Date.now() - 16 * 60 * 1000);
    (detector as any).lastActivity.set('track-b', Date.now());

    await (detector as any).checkAll();

    expect(events.length).toBe(1);
    expect((events[0] as any).trackName).toBe('track-a');
  });

  it('terminated track is automatically unregistered', async () => {
    detector.registerTrack('track-a');
    (detector as any).lastActivity.set('track-a', Date.now() - 31 * 60 * 1000);
    await (detector as any).checkAll();

    // Track should be unregistered after termination
    expect((detector as any).lastActivity.has('track-a')).toBe(false);
  });

  it('setRequestId populates requestId in emitted events', async () => {
    const events: ParallelEvent[] = [];
    bus.on('track.stalled', (e) => events.push(e));

    detector.setRequestId('req-42');
    detector.registerTrack('track-a');
    (detector as any).lastActivity.set('track-a', Date.now() - 16 * 60 * 1000);
    await (detector as any).checkAll();

    expect((events[0] as any).requestId).toBe('req-42');
  });

  it('stopMonitoring clears the interval', () => {
    detector.startMonitoring(1000);
    expect((detector as any).monitorInterval).not.toBeNull();
    detector.stopMonitoring();
    expect((detector as any).monitorInterval).toBeNull();
  });

  it('stopMonitoring is safe to call multiple times', () => {
    detector.stopMonitoring();
    detector.stopMonitoring();
    // No error thrown
  });
});

// ===========================================================================
// VALID_TRANSITIONS adjacency set
// ===========================================================================

describe('VALID_TRANSITIONS', () => {
  it('complete is a terminal state (no outgoing transitions)', () => {
    expect(VALID_TRANSITIONS.complete).toEqual([]);
  });

  it('escalated is a terminal state (no outgoing transitions)', () => {
    expect(VALID_TRANSITIONS.escalated).toEqual([]);
  });

  it('failed can retry to queued', () => {
    expect(VALID_TRANSITIONS.failed).toContain('queued');
  });

  it('pending can only go to queued', () => {
    expect(VALID_TRANSITIONS.pending).toEqual(['queued']);
  });

  it('all active states can transition to failed', () => {
    const activeStates: TrackState[] = ['queued', 'executing', 'testing', 'reviewing', 'merging'];
    for (const state of activeStates) {
      expect(VALID_TRANSITIONS[state]).toContain('failed');
    }
  });

  it('executing/testing/reviewing/merging can transition to escalated', () => {
    const escalatableStates: TrackState[] = ['executing', 'testing', 'reviewing', 'merging'];
    for (const state of escalatableStates) {
      expect(VALID_TRANSITIONS[state]).toContain('escalated');
    }
  });

  it('pending and queued cannot transition to escalated', () => {
    expect(VALID_TRANSITIONS.pending).not.toContain('escalated');
    expect(VALID_TRANSITIONS.queued).not.toContain('escalated');
  });
});

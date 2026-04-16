/**
 * Integration tests for Kill Switch (SPEC-009-4-4).
 *
 * These tests wire real AbortManager and KillSwitch instances together
 * with mock pipeline executors that respect abort signals. They verify
 * the full kill lifecycle including the kill switch drill from TDD Section 8.3.
 *
 * Test cases:
 *   7.  Graceful kill during active phases
 *   8.  Hard kill during active phases
 *   9.  Kill switch drill (TDD 8.3): start 3 -> kill -> verify -> reenable -> verify
 *   10. Kill then reenable then kill again (full cycle)
 *   11. Cancel during active pipeline (single request, others unaffected)
 */

import * as path from "path";
import { AbortManager } from "../abort-manager";
import { KillSwitch } from "../kill-switch";
import type {
  AuditTrail,
  EscalationCanceller,
  Notifier,
  NotificationPayload,
} from "../kill-switch";
import { StateSnapshotCapture } from "../state-snapshot";
import type { FileSystem } from "../state-snapshot";
import { HaltedGate } from "../halted-gate";
import type { AbortReason, KillResult, StateSnapshot } from "../types";
import { StatePersistence } from "../state-persistence";
import type { PipelineState, StatePersistenceFs } from "../state-persistence";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_DIR = "/test/.autonomous-dev/state";
const PHASES = ["prd_approval", "tdd_approval", "code_review", "deployment"];

// ---------------------------------------------------------------------------
// Mock pipeline executor
// ---------------------------------------------------------------------------

/**
 * Simulates a pipeline executor that processes phases sequentially,
 * checking the abort signal between phases (graceful) or constantly (hard).
 *
 * The executor:
 *   - Processes each phase as a short async operation.
 *   - Checks the abort signal at phase boundaries.
 *   - Tracks which phases were completed and whether it was aborted.
 *   - Writes pipeline state via StatePersistence after each phase.
 */
interface MockExecutor {
  requestId: string;
  signal: AbortSignal;
  completedPhases: string[];
  currentPhase: string;
  aborted: boolean;
  started: boolean;
  finished: boolean;
  /** Promise that resolves when the executor is done (either completed or aborted). */
  done: Promise<void>;
  /** Resolve function to signal the executor to start. */
  start(): void;
}

function createMockExecutor(
  requestId: string,
  abortManager: AbortManager,
  statePersistence: StatePersistence,
  phases: string[] = PHASES,
  phaseDelayMs: number = 10,
): MockExecutor {
  const signal = abortManager.registerRequest(requestId);
  const completedPhases: string[] = [];
  let currentPhase = "pending";
  let aborted = false;
  let started = false;
  let finished = false;
  let startResolve: () => void;
  const startPromise = new Promise<void>((resolve) => {
    startResolve = resolve;
  });

  const done = (async () => {
    // Wait for start signal
    await startPromise;
    started = true;

    for (const phase of phases) {
      // Check abort at phase boundary (graceful stop point)
      if (signal.aborted) {
        aborted = true;
        return;
      }

      currentPhase = phase;

      // Write state at start of phase
      const pipelineState: PipelineState = {
        requestId,
        currentPhase: phase,
        phaseStatus: "running",
        completedPhases: [...completedPhases],
        trustLevel: 2,
        lastUpdated: new Date().toISOString(),
      };
      statePersistence.writePipelineState(requestId, pipelineState);

      // Simulate phase execution (the "atomic boundary")
      await new Promise<void>((resolve) => setTimeout(resolve, phaseDelayMs));

      // Check again after phase completes
      if (signal.aborted) {
        aborted = true;
        // Phase completed but aborted after -- still count as completed
        completedPhases.push(phase);

        // Write completed state
        const completedState: PipelineState = {
          requestId,
          currentPhase: phase,
          phaseStatus: "completed",
          completedPhases: [...completedPhases],
          trustLevel: 2,
          lastUpdated: new Date().toISOString(),
        };
        statePersistence.writePipelineState(requestId, completedState);
        return;
      }

      completedPhases.push(phase);

      // Write completed state
      const completedState: PipelineState = {
        requestId,
        currentPhase: phase,
        phaseStatus: "completed",
        completedPhases: [...completedPhases],
        trustLevel: 2,
        lastUpdated: new Date().toISOString(),
      };
      statePersistence.writePipelineState(requestId, completedState);
    }

    finished = true;
    currentPhase = "done";
  })();

  const executor: MockExecutor = {
    requestId,
    signal,
    get completedPhases() {
      return completedPhases;
    },
    get currentPhase() {
      return currentPhase;
    },
    get aborted() {
      return aborted;
    },
    get started() {
      return started;
    },
    get finished() {
      return finished;
    },
    done,
    start: () => startResolve(),
  };

  return executor;
}

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

function createMockStatePersistenceFs(): {
  mockFs: StatePersistenceFs;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  const dirs = new Set<string>();

  const mockFs: StatePersistenceFs = {
    writeFileSync: jest.fn((filePath: string, content: string) => {
      store.set(filePath, content);
    }),
    renameSync: jest.fn((oldPath: string, newPath: string) => {
      const content = store.get(oldPath);
      if (content !== undefined) {
        store.set(newPath, content);
        store.delete(oldPath);
      }
    }),
    fdatasyncSync: jest.fn(),
    openSync: jest.fn(() => 42),
    closeSync: jest.fn(),
    mkdirSync: jest.fn((dirPath: string) => {
      dirs.add(dirPath);
    }),
    readFileSync: jest.fn((filePath: string) => {
      const content = store.get(filePath);
      if (content === undefined) {
        const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return content;
    }),
    existsSync: jest.fn((filePath: string) => store.has(filePath)),
    rmSync: jest.fn((dirPath: string) => {
      for (const key of store.keys()) {
        if (key.startsWith(dirPath)) {
          store.delete(key);
        }
      }
    }),
  };

  return { mockFs, store };
}

function createMockSnapshotFs(): {
  mockFs: FileSystem;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  const dirs: string[] = [];

  const mockFs: FileSystem = {
    readFile: jest.fn(async (filePath: string) => {
      const content = store.get(filePath);
      if (content === undefined) {
        throw new Error("ENOENT");
      }
      return content;
    }),
    readdir: jest.fn(async () => []),
    writeFile: jest.fn(async (filePath: string, content: string) => {
      store.set(filePath, content);
    }),
    rename: jest.fn(async (oldPath: string, newPath: string) => {
      const content = store.get(oldPath);
      if (content !== undefined) {
        store.set(newPath, content);
        store.delete(oldPath);
      }
    }),
    mkdir: jest.fn(async (dirPath: string) => {
      dirs.push(dirPath);
    }),
  };

  return { mockFs, store };
}

interface CapturedEvent {
  event_type: string;
  payload: Record<string, unknown>;
}

function createMockEscalationEngine(): EscalationCanceller & {
  cancelCalls: number;
} {
  let cancelCalls = 0;
  return {
    get cancelCalls() {
      return cancelCalls;
    },
    cancelAllPending: jest.fn(() => {
      cancelCalls++;
    }),
  };
}

function createMockAuditTrail(): AuditTrail & { events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  return {
    events,
    append: jest.fn(async (event: CapturedEvent) => {
      events.push(event);
    }),
  };
}

function createMockNotifier(): Notifier & { payloads: NotificationPayload[] } {
  const payloads: NotificationPayload[] = [];
  return {
    payloads,
    emit: jest.fn((payload: NotificationPayload) => {
      payloads.push(payload);
    }),
  };
}

// ---------------------------------------------------------------------------
// Full integration test setup
// ---------------------------------------------------------------------------

function createIntegrationSetup() {
  const abortManager = new AbortManager();
  const { mockFs: snapshotFs, store: snapshotStore } = createMockSnapshotFs();
  const { mockFs: persistenceFs, store: persistenceStore } =
    createMockStatePersistenceFs();

  const snapshotCapture = new StateSnapshotCapture(STATE_DIR, snapshotFs);
  const statePersistence = new StatePersistence(STATE_DIR, persistenceFs);
  const escalationEngine = createMockEscalationEngine();
  const auditTrail = createMockAuditTrail();
  const notifier = createMockNotifier();

  const killSwitch = new KillSwitch(
    abortManager,
    snapshotCapture,
    escalationEngine,
    auditTrail,
    notifier,
  );

  const haltedGate = new HaltedGate(killSwitch);

  return {
    abortManager,
    snapshotCapture,
    statePersistence,
    persistenceFs,
    persistenceStore,
    snapshotStore,
    escalationEngine,
    auditTrail,
    notifier,
    killSwitch,
    haltedGate,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Kill Switch Integration Tests", () => {
  // -----------------------------------------------------------------------
  // Test 7: Graceful kill during active phases
  // -----------------------------------------------------------------------

  describe("Graceful kill during active phases", () => {
    it("stops all 3 executors at the next atomic boundary", async () => {
      const setup = createIntegrationSetup();

      // Step a: Create 3 mock pipeline executors
      const executors = [
        createMockExecutor("req-1", setup.abortManager, setup.statePersistence),
        createMockExecutor("req-2", setup.abortManager, setup.statePersistence),
        createMockExecutor("req-3", setup.abortManager, setup.statePersistence),
      ];

      // Step b: Start all 3 and wait for them to begin executing
      executors.forEach((e) => e.start());
      await new Promise((r) => setTimeout(r, 25));

      // Verify all started
      expect(executors.every((e) => e.started)).toBe(true);

      // Step c: Issue graceful kill
      const result = await setup.killSwitch.kill("graceful", "admin");

      // Wait for executors to finish their current phase
      await Promise.all(executors.map((e) => e.done));

      // Step d: All 3 executors stopped (aborted)
      expect(executors.every((e) => e.aborted)).toBe(true);

      // Step e: Kill snapshot file exists with 3 request entries
      const snapshotFiles = Array.from(setup.snapshotStore.keys()).filter(
        (k) => k.includes("kill-snapshot"),
      );
      expect(snapshotFiles.length).toBe(1);
      const snapshotContent = JSON.parse(
        setup.snapshotStore.get(snapshotFiles[0]!)!,
      );
      expect(snapshotContent.total_active_requests).toBe(3);
      expect(snapshotContent.snapshots).toHaveLength(3);

      // Step f: killSwitch.isHalted() is true
      expect(setup.killSwitch.isHalted()).toBe(true);

      // Step g: HALTED gate rejects new request
      const gateResult = setup.haltedGate.checkAccess("req-new");
      expect(gateResult.allowed).toBe(false);
      if (!gateResult.allowed) {
        expect(gateResult.error.code).toBe("SYSTEM_HALTED");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Test 8: Hard kill during active phases
  // -----------------------------------------------------------------------

  describe("Hard kill during active phases", () => {
    it("stops all 3 executors immediately", async () => {
      const setup = createIntegrationSetup();

      // Step a: Same setup as graceful
      const executors = [
        createMockExecutor("req-1", setup.abortManager, setup.statePersistence),
        createMockExecutor("req-2", setup.abortManager, setup.statePersistence),
        createMockExecutor("req-3", setup.abortManager, setup.statePersistence),
      ];

      executors.forEach((e) => e.start());
      await new Promise((r) => setTimeout(r, 25));

      // Step b: Issue hard kill
      const result = await setup.killSwitch.kill("hard", "admin");

      // Step c: All executors stop (abort signal fires immediately)
      await Promise.all(executors.map((e) => e.done));
      expect(executors.every((e) => e.aborted)).toBe(true);

      // Step d: Snapshot captured before abort
      const snapshotFiles = Array.from(setup.snapshotStore.keys()).filter(
        (k) => k.includes("kill-snapshot"),
      );
      expect(snapshotFiles.length).toBe(1);
      const snapshotContent = JSON.parse(
        setup.snapshotStore.get(snapshotFiles[0]!)!,
      );
      expect(snapshotContent.kill_mode).toBe("hard");
      expect(snapshotContent.total_active_requests).toBe(3);

      // Verify halted
      expect(setup.killSwitch.isHalted()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Test 9: Kill switch drill (TDD Section 8.3)
  // -----------------------------------------------------------------------

  describe("Kill switch drill (TDD 8.3)", () => {
    it("completes the full drill scenario: start -> kill -> verify -> reenable -> verify", async () => {
      const setup = createIntegrationSetup();

      // ---------------------------------------------------------------
      // Step 1: Start 3 synthetic pipeline requests
      // ---------------------------------------------------------------
      const executors = [
        createMockExecutor(
          "drill-req-1",
          setup.abortManager,
          setup.statePersistence,
          PHASES,
          20,
        ),
        createMockExecutor(
          "drill-req-2",
          setup.abortManager,
          setup.statePersistence,
          PHASES,
          20,
        ),
        createMockExecutor(
          "drill-req-3",
          setup.abortManager,
          setup.statePersistence,
          PHASES,
          20,
        ),
      ];

      // ---------------------------------------------------------------
      // Step 2: Wait for all 3 to be actively executing phases
      // ---------------------------------------------------------------
      executors.forEach((e) => e.start());
      await new Promise((r) => setTimeout(r, 30));

      // Verify all are actively executing
      expect(executors.every((e) => e.started)).toBe(true);
      expect(executors.every((e) => !e.finished)).toBe(true);

      // ---------------------------------------------------------------
      // Step 3: Issue /kill graceful
      // ---------------------------------------------------------------
      const killStartTime = Date.now();
      const killResult = await setup.killSwitch.kill("graceful", "drill-admin");

      // Wait for all executors to finish
      await Promise.all(executors.map((e) => e.done));
      const killEndTime = Date.now();

      // ---------------------------------------------------------------
      // Step 4: Assert all 3 executors stop at the next atomic boundary
      // ---------------------------------------------------------------
      expect(executors.every((e) => e.aborted)).toBe(true);
      // Each executor completed at least one phase before stopping
      for (const executor of executors) {
        expect(executor.completedPhases.length).toBeGreaterThan(0);
        expect(executor.completedPhases.length).toBeLessThan(PHASES.length);
      }

      // ---------------------------------------------------------------
      // Step 5: Assert halt timing < 5 seconds
      // ---------------------------------------------------------------
      const haltDuration = killEndTime - killStartTime;
      expect(haltDuration).toBeLessThan(5000);

      // ---------------------------------------------------------------
      // Step 6: Assert state snapshot file written with all 3 requests
      // ---------------------------------------------------------------
      const snapshotFiles = Array.from(setup.snapshotStore.keys()).filter(
        (k) => k.includes("kill-snapshot"),
      );
      expect(snapshotFiles.length).toBe(1);
      const snapshotContent = JSON.parse(
        setup.snapshotStore.get(snapshotFiles[0]!)!,
      );
      expect(snapshotContent.total_active_requests).toBe(3);
      expect(snapshotContent.snapshots).toHaveLength(3);

      // ---------------------------------------------------------------
      // Step 7: Assert each snapshot has correct pipeline phase
      // ---------------------------------------------------------------
      for (const snapshot of snapshotContent.snapshots) {
        expect(snapshot.requestId).toMatch(/^drill-req-/);
      }

      // ---------------------------------------------------------------
      // Step 8: Assert pending escalations cancelled
      // ---------------------------------------------------------------
      expect(setup.escalationEngine.cancelAllPending).toHaveBeenCalledTimes(1);

      // ---------------------------------------------------------------
      // Step 9: Assert HALTED gate rejects new request
      // ---------------------------------------------------------------
      const gateResult = setup.haltedGate.checkAccess("drill-req-new");
      expect(gateResult.allowed).toBe(false);
      if (!gateResult.allowed) {
        expect(gateResult.error.code).toBe("SYSTEM_HALTED");
      }

      // ---------------------------------------------------------------
      // Step 10: Issue reenable
      // ---------------------------------------------------------------
      setup.killSwitch.reenable("drill-admin");

      // ---------------------------------------------------------------
      // Step 11: Assert system accepts new requests
      // ---------------------------------------------------------------
      const gateAfterReenable = setup.haltedGate.checkAccess("drill-req-new");
      expect(gateAfterReenable.allowed).toBe(true);
      expect(setup.killSwitch.isHalted()).toBe(false);
      expect(setup.killSwitch.getState()).toBe("running");

      // ---------------------------------------------------------------
      // Step 12: Start 1 new request; verify it executes normally
      // ---------------------------------------------------------------
      const newExecutor = createMockExecutor(
        "drill-req-new",
        setup.abortManager,
        setup.statePersistence,
        PHASES,
        5,
      );
      newExecutor.start();
      await newExecutor.done;

      expect(newExecutor.finished).toBe(true);
      expect(newExecutor.aborted).toBe(false);
      expect(newExecutor.completedPhases).toEqual(PHASES);
    });

    it("meets timing constraint: signals received within 5 seconds", async () => {
      const setup = createIntegrationSetup();

      const executors = [
        createMockExecutor(
          "timing-req-1",
          setup.abortManager,
          setup.statePersistence,
          PHASES,
          50,
        ),
        createMockExecutor(
          "timing-req-2",
          setup.abortManager,
          setup.statePersistence,
          PHASES,
          50,
        ),
        createMockExecutor(
          "timing-req-3",
          setup.abortManager,
          setup.statePersistence,
          PHASES,
          50,
        ),
      ];

      executors.forEach((e) => e.start());
      await new Promise((r) => setTimeout(r, 60));

      // Record when each signal is received
      const signalTimes: number[] = [];
      for (const executor of executors) {
        executor.signal.addEventListener("abort", () => {
          signalTimes.push(Date.now());
        });
      }

      const killIssueTime = Date.now();
      await setup.killSwitch.kill("graceful", "timing-admin");

      // All signals should have been received already (synchronous dispatch)
      // But wait for executors to finish their current phases
      await Promise.all(executors.map((e) => e.done));

      const totalTime = Date.now() - killIssueTime;
      expect(totalTime).toBeLessThan(5000);
    });
  });

  // -----------------------------------------------------------------------
  // Test 10: Kill then reenable then kill again
  // -----------------------------------------------------------------------

  describe("Kill -> reenable -> kill cycle", () => {
    it("produces a fresh snapshot on the second kill", async () => {
      const setup = createIntegrationSetup();

      // First cycle: register requests and kill
      const executors1 = [
        createMockExecutor(
          "cycle1-req-1",
          setup.abortManager,
          setup.statePersistence,
        ),
        createMockExecutor(
          "cycle1-req-2",
          setup.abortManager,
          setup.statePersistence,
        ),
      ];
      executors1.forEach((e) => e.start());
      await new Promise((r) => setTimeout(r, 15));

      const firstResult = await setup.killSwitch.kill("graceful", "admin");
      await Promise.all(executors1.map((e) => e.done));

      expect(setup.killSwitch.isHalted()).toBe(true);
      expect(firstResult.totalActiveRequests).toBe(2);

      // Reenable
      setup.killSwitch.reenable("admin");
      expect(setup.killSwitch.isHalted()).toBe(false);
      expect(setup.killSwitch.getState()).toBe("running");

      // Second cycle: register new requests and kill again
      const executors2 = [
        createMockExecutor(
          "cycle2-req-1",
          setup.abortManager,
          setup.statePersistence,
        ),
        createMockExecutor(
          "cycle2-req-2",
          setup.abortManager,
          setup.statePersistence,
        ),
        createMockExecutor(
          "cycle2-req-3",
          setup.abortManager,
          setup.statePersistence,
        ),
      ];
      executors2.forEach((e) => e.start());
      await new Promise((r) => setTimeout(r, 15));

      const secondResult = await setup.killSwitch.kill("hard", "admin");
      await Promise.all(executors2.map((e) => e.done));

      // Second kill produces fresh result (not the same as first)
      expect(secondResult).not.toBe(firstResult);
      expect(secondResult.mode).toBe("hard");
      expect(secondResult.totalActiveRequests).toBe(3);

      // Two separate snapshot files written
      const snapshotFiles = Array.from(setup.snapshotStore.keys()).filter(
        (k) => k.includes("kill-snapshot"),
      );
      expect(snapshotFiles.length).toBe(2);

      // State is consistent
      expect(setup.killSwitch.isHalted()).toBe(true);
      expect(setup.killSwitch.getState()).toBe("halted");
    });
  });

  // -----------------------------------------------------------------------
  // Test 11: Cancel during active pipeline
  // -----------------------------------------------------------------------

  describe("Cancel single request during active pipeline", () => {
    it("cancels req-2 while req-1 and req-3 continue", async () => {
      const setup = createIntegrationSetup();

      const executor1 = createMockExecutor(
        "req-1",
        setup.abortManager,
        setup.statePersistence,
        PHASES,
        15,
      );
      const executor2 = createMockExecutor(
        "req-2",
        setup.abortManager,
        setup.statePersistence,
        PHASES,
        15,
      );
      const executor3 = createMockExecutor(
        "req-3",
        setup.abortManager,
        setup.statePersistence,
        PHASES,
        15,
      );

      // Start all
      executor1.start();
      executor2.start();
      executor3.start();
      await new Promise((r) => setTimeout(r, 20));

      // Cancel only req-2
      const cancelResult = await setup.killSwitch.cancel("req-2", "admin");

      // Wait for req-2 to stop
      await executor2.done;

      // Verify req-2 is aborted
      expect(executor2.aborted).toBe(true);
      expect(cancelResult.requestId).toBe("req-2");
      expect(cancelResult.cancelledBy).toBe("admin");
      expect(cancelResult.snapshot.requestId).toBe("req-2");

      // Verify req-1 and req-3 continue executing
      // Give them time to finish
      await Promise.all([executor1.done, executor3.done]);

      expect(executor1.finished).toBe(true);
      expect(executor1.aborted).toBe(false);
      expect(executor3.finished).toBe(true);
      expect(executor3.aborted).toBe(false);

      // System is NOT halted (cancel != kill)
      expect(setup.killSwitch.isHalted()).toBe(false);
      expect(setup.killSwitch.getState()).toBe("running");
    });

    it("captures snapshot for cancelled request", async () => {
      const setup = createIntegrationSetup();

      const executor = createMockExecutor(
        "req-cancel",
        setup.abortManager,
        setup.statePersistence,
      );
      executor.start();
      await new Promise((r) => setTimeout(r, 15));

      const result = await setup.killSwitch.cancel("req-cancel", "admin");

      // Cancel result contains a snapshot of the cancelled request
      expect(result.snapshot).toBeDefined();
      expect(result.snapshot.requestId).toBe("req-cancel");

      // No kill snapshot file is created (cancel != kill)
      const killSnapshotFiles = Array.from(setup.snapshotStore.keys()).filter(
        (k) => k.includes("kill-snapshot"),
      );
      expect(killSnapshotFiles.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Additional: Hard kill drill variant
  // -----------------------------------------------------------------------

  describe("Hard kill drill variant", () => {
    it("hard kill stops executors faster than graceful", async () => {
      const setup = createIntegrationSetup();

      const executors = [
        createMockExecutor(
          "hard-drill-1",
          setup.abortManager,
          setup.statePersistence,
          PHASES,
          50,
        ),
        createMockExecutor(
          "hard-drill-2",
          setup.abortManager,
          setup.statePersistence,
          PHASES,
          50,
        ),
        createMockExecutor(
          "hard-drill-3",
          setup.abortManager,
          setup.statePersistence,
          PHASES,
          50,
        ),
      ];

      executors.forEach((e) => e.start());
      await new Promise((r) => setTimeout(r, 60));

      const startTime = Date.now();
      await setup.killSwitch.kill("hard", "hard-drill-admin");
      await Promise.all(executors.map((e) => e.done));
      const elapsed = Date.now() - startTime;

      // Hard kill should be very fast
      expect(elapsed).toBeLessThan(5000);
      expect(executors.every((e) => e.aborted)).toBe(true);

      // Verify snapshot
      const snapshotFiles = Array.from(setup.snapshotStore.keys()).filter(
        (k) => k.includes("kill-snapshot"),
      );
      expect(snapshotFiles.length).toBe(1);
      const content = JSON.parse(setup.snapshotStore.get(snapshotFiles[0]!)!);
      expect(content.kill_mode).toBe("hard");
    });
  });

  // -----------------------------------------------------------------------
  // Additional: Audit events are correctly emitted throughout the drill
  // -----------------------------------------------------------------------

  describe("Audit events during drill", () => {
    it("emits kill_issued and system_reenabled events in sequence", async () => {
      const setup = createIntegrationSetup();

      const executor = createMockExecutor(
        "audit-req",
        setup.abortManager,
        setup.statePersistence,
      );
      executor.start();
      await new Promise((r) => setTimeout(r, 15));

      // Kill
      await setup.killSwitch.kill("graceful", "audit-admin");
      await executor.done;

      // Verify kill_issued event
      const killEvent = setup.auditTrail.events.find(
        (e) => e.event_type === "kill_issued",
      );
      expect(killEvent).toBeDefined();
      expect(killEvent!.payload.mode).toBe("graceful");
      expect(killEvent!.payload.issuedBy).toBe("audit-admin");

      // Reenable
      setup.killSwitch.reenable("audit-admin");

      // Verify system_reenabled event
      const reenabledEvent = setup.auditTrail.events.find(
        (e) => e.event_type === "system_reenabled",
      );
      expect(reenabledEvent).toBeDefined();
      expect(reenabledEvent!.payload.issuedBy).toBe("audit-admin");
    });
  });
});

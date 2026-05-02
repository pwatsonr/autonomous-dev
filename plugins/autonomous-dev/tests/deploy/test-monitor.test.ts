/**
 * SPEC-023-3-04 HealthMonitor tests.
 *
 * Uses jest.useFakeTimers() throughout — no real timers anywhere. Covers
 * scheduling, three-strikes auto-rollback, success-resets-counter,
 * rollback-success vs rollback-failure escalations, stop() cleanup, and
 * the start-after-stop guard.
 *
 * @module tests/deploy/test-monitor.test
 */

import { HealthMonitor } from '../../intake/deploy/monitor';
import { MonitorAlreadyStoppedError } from '../../intake/deploy/errors';
import type {
  DeploymentBackend,
  DeploymentRecord,
  HealthStatus,
  RollbackResult,
} from '../../intake/deploy/types';
import type {
  EscalationMessage,
  SlaConfig,
} from '../../intake/deploy/monitor-types';

function makeRecord(deployId: string): DeploymentRecord {
  return {
    deployId,
    backend: 'static',
    environment: 'prod',
    artifactId: 'art-1',
    deployedAt: '2026-05-02T12:00:00.000Z',
    status: 'deployed',
    details: {},
    hmac: 'a'.repeat(64),
  };
}

interface BackendStub extends DeploymentBackend {
  setHealthSequence(seq: boolean[]): void;
  rollbackCalls(): number;
  setRollbackThrows(err: Error | null): void;
  setRollbackResult(result: RollbackResult): void;
}

function makeBackendStub(): BackendStub {
  let healthSeq: boolean[] = [];
  let healthIdx = 0;
  let rollbackCount = 0;
  let rollbackThrows: Error | null = null;
  let rollbackResult: RollbackResult = { success: true, errors: [] };
  return {
    metadata: {
      name: 'static',
      version: '0.0.1',
      supportedTargets: [],
      capabilities: [],
      requiredTools: [],
    },
    async build() {
      throw new Error('not used');
    },
    async deploy() {
      throw new Error('not used');
    },
    async healthCheck(): Promise<HealthStatus> {
      const next = healthIdx < healthSeq.length ? healthSeq[healthIdx] : true;
      healthIdx += 1;
      return { healthy: next, checks: [] };
    },
    async rollback(): Promise<RollbackResult> {
      rollbackCount += 1;
      if (rollbackThrows) throw rollbackThrows;
      return rollbackResult;
    },
    setHealthSequence(seq: boolean[]) {
      healthSeq = seq;
      healthIdx = 0;
    },
    rollbackCalls() {
      return rollbackCount;
    },
    setRollbackThrows(err: Error | null) {
      rollbackThrows = err;
    },
    setRollbackResult(result: RollbackResult) {
      rollbackResult = result;
    },
  };
}

const FAST_SLA: SlaConfig = {
  uptime_pct: 0.99,
  consecutive_failures_for_rollback: 3,
  health_check_interval_ms: 100,
  health_check_timeout_ms: 50,
  rolling_window_size: 10,
};

interface Harness {
  monitor: HealthMonitor;
  backend: BackendStub;
  escalations: EscalationMessage[];
  rollbackRecords: { parentDeployId: string }[];
}

function buildHarness(record: DeploymentRecord): Harness {
  const backend = makeBackendStub();
  const escalations: EscalationMessage[] = [];
  const rollbackRecords: { parentDeployId: string }[] = [];
  const monitor = new HealthMonitor({
    activeDeployments: async () => [record],
    getBackend: () => backend,
    resolveSla: () => FAST_SLA,
    writeRollbackRecord: async (rec) => {
      rollbackRecords.push({ parentDeployId: rec.parentDeployId });
      return { deployId: `rb-${rec.parentDeployId}` };
    },
    escalate: (msg) => {
      escalations.push(msg);
    },
  });
  return { monitor, backend, escalations, rollbackRecords };
}

/**
 * Drain queued microtasks (the monitor schedules many awaits per tick).
 * Each call yields once to the event loop.
 */
async function drain(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/**
 * Stop the monitor under fake timers: kicks the stop()-internal grace
 * setTimeout via `runOnlyPendingTimers()` so the awaited promise resolves.
 */
async function stopUnderFakeTimers(monitor: HealthMonitor): Promise<void> {
  const stopP = monitor.stop(0);
  // The grace setTimeout is unref'd; advance fake clock so it fires.
  jest.runOnlyPendingTimers();
  await stopP;
}

describe('SPEC-023-3-04 HealthMonitor', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('three consecutive failures invoke rollback exactly once', async () => {
    const record = makeRecord('dep-1');
    const h = buildHarness(record);
    h.backend.setHealthSequence([false, false, false, false, false]);
    h.monitor.start();
    // Initial sync schedules per-deploy interval.
    await drain();
    // Advance enough ticks to fire 5 health checks.
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(FAST_SLA.health_check_interval_ms);
      await drain(20);
    }
    expect(h.backend.rollbackCalls()).toBe(1);
    await stopUnderFakeTimers(h.monitor);
  });

  it('two failures + one success resets counter (no rollback)', async () => {
    const record = makeRecord('dep-2');
    const h = buildHarness(record);
    h.backend.setHealthSequence([false, false, true, false, false]);
    h.monitor.start();
    await drain();
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(FAST_SLA.health_check_interval_ms);
      await drain(20);
    }
    expect(h.backend.rollbackCalls()).toBe(0);
    await stopUnderFakeTimers(h.monitor);
  });

  it('successful rollback writes a follow-up DeploymentRecord and emits info escalation', async () => {
    const record = makeRecord('dep-3');
    const h = buildHarness(record);
    h.backend.setRollbackResult({ success: true, restoredArtifactId: 'art-prev', errors: [] });
    h.backend.setHealthSequence([false, false, false]);
    h.monitor.start();
    await drain();
    for (let i = 0; i < 4; i++) {
      jest.advanceTimersByTime(FAST_SLA.health_check_interval_ms);
      await drain(20);
    }
    // Drain the post-rollback async chain.
    await drain(30);
    expect(h.rollbackRecords.length).toBeGreaterThanOrEqual(1);
    expect(h.rollbackRecords[0].parentDeployId).toBe('dep-3');
    const infos = h.escalations.filter((e) => e.severity === 'info');
    expect(infos.length).toBeGreaterThanOrEqual(1);
    await stopUnderFakeTimers(h.monitor);
  });

  it('failed rollback emits one critical escalation', async () => {
    const record = makeRecord('dep-4');
    const h = buildHarness(record);
    h.backend.setRollbackThrows(new Error('storage offline'));
    h.backend.setHealthSequence([false, false, false]);
    h.monitor.start();
    await drain();
    for (let i = 0; i < 4; i++) {
      jest.advanceTimersByTime(FAST_SLA.health_check_interval_ms);
      await drain(20);
    }
    await drain(30);
    const critical = h.escalations.filter((e) => e.severity === 'critical');
    expect(critical).toHaveLength(1);
    expect(critical[0].message).toMatch(/storage offline/);
    await stopUnderFakeTimers(h.monitor);
  });

  it('start() after stop() throws MonitorAlreadyStoppedError', async () => {
    const record = makeRecord('dep-5');
    const h = buildHarness(record);
    h.monitor.start();
    await stopUnderFakeTimers(h.monitor);
    expect(() => h.monitor.start()).toThrow(MonitorAlreadyStoppedError);
  });

  it('start() is idempotent', async () => {
    const record = makeRecord('dep-6');
    const h = buildHarness(record);
    h.monitor.start();
    h.monitor.start(); // second call is a no-op
    await drain();
    await stopUnderFakeTimers(h.monitor);
  });

  it('getStatus returns undefined for unknown deploy', () => {
    const record = makeRecord('dep-7');
    const h = buildHarness(record);
    expect(h.monitor.getStatus('nope')).toBeUndefined();
  });
});

/**
 * SPEC-023-3-04 integration: deploy → monitor → fail → rollback.
 *
 * Wires `DeployLogger`, `CostLedger`, `CostCapEnforcer`, `HealthMonitor`,
 * and a `FakeBackend` together. Exercises the full lifecycle: cap check
 * passes, ledger entry appended, backend deploys, monitor attaches, three
 * consecutive health failures trigger auto-rollback, and assertions
 * verify the per-component log files plus the escalation contract.
 *
 * @module tests/integration/test-deploy-monitoring.test
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CostLedger } from '../../intake/deploy/cost-ledger';
import { CostCapEnforcer } from '../../intake/deploy/cost-cap-enforcer';
import { DeployLogger } from '../../intake/deploy/logger';
import { HealthMonitor } from '../../intake/deploy/monitor';
import type {
  DeploymentRecord,
} from '../../intake/deploy/types';
import type {
  EscalationMessage,
  SlaConfig,
} from '../../intake/deploy/monitor-types';

import { FakeBackend } from '../deploy/helpers/fake-backend';
import { TEST_HMAC_KEY } from '../deploy/fixtures/cost-ledger-fixtures';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'deploy-monitor-it-'));
}

const FAST_SLA: SlaConfig = {
  uptime_pct: 0.99,
  consecutive_failures_for_rollback: 3,
  health_check_interval_ms: 100,
  health_check_timeout_ms: 50,
  rolling_window_size: 10,
};

const FIXED_NOW = new Date('2026-05-02T12:00:00.000Z');

async function drain(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

async function stopUnderFakeTimers(monitor: HealthMonitor): Promise<void> {
  const stopP = monitor.stop(0);
  jest.runOnlyPendingTimers();
  await stopP;
}

describe('SPEC-023-3-04 deploy → monitor → rollback integration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    process.env.DEPLOY_COST_HMAC_KEY = TEST_HMAC_KEY;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('three consecutive health failures trigger auto-rollback; logs + escalations recorded', async () => {
    const stateDir = await tmp();
    const requestRoot = await tmp();
    try {
      const ledger = new CostLedger({
        dir: stateDir,
        keyHex: TEST_HMAC_KEY,
        clock: () => FIXED_NOW,
      });
      const escalations: EscalationMessage[] = [];
      const enforcer = new CostCapEnforcer({
        ledger,
        config: () => ({ cost_cap_usd_per_day: 100 }),
        escalate: (msg) => {
          escalations.push(msg);
        },
        stateDir,
        clock: () => FIXED_NOW,
      });

      // (1) Cap check passes.
      await enforcer.check({
        actor: 'op@example',
        deployId: 'dep-prod-art-1',
        estimated_cost_usd: 5.0,
        env: 'prod',
        backend: 'fake',
      });

      // (2) Append cost-ledger entry.
      await ledger.appendEstimated({
        deployId: 'dep-prod-art-1',
        env: 'prod',
        backend: 'fake',
        estimated_cost_usd: 5.0,
      });

      // (3) Backend deploys (using FakeBackend.deploy()).
      const backend = new FakeBackend({
        healthSequence: [true, true, false, false, false, true],
      });
      const record = await backend.deploy(
        await backend.build({
          repoPath: requestRoot,
          commitSha: 'sha',
          branch: 'main',
          requestId: 'req-1',
          cleanWorktree: true,
          params: {},
        }),
        'prod',
        {},
      );
      expect(record.deployId).toBe('dep-prod-art-1');

      // (4) Per-deploy logger writing to <requestRoot>/.autonomous-dev/...
      const monitorLogger = new DeployLogger({
        requestRoot,
        deployId: record.deployId,
        component: 'monitor',
        env: 'prod',
        backend: 'fake',
      });

      // (5) Monitor attaches.
      const followups: DeploymentRecord[] = [];
      const monitor = new HealthMonitor({
        activeDeployments: async () => [record],
        getBackend: () => backend,
        resolveSla: () => FAST_SLA,
        writeRollbackRecord: async (rec) => {
          const next: DeploymentRecord = {
            deployId: `rb-${rec.parentDeployId}`,
            backend: rec.backend,
            environment: rec.environment,
            artifactId: 'art-prev',
            deployedAt: rec.rolledBackAt,
            status: 'deployed',
            details: { cause: rec.cause, parent_deploy_id: rec.parentDeployId },
            hmac: '',
          };
          followups.push(next);
          return { deployId: next.deployId };
        },
        escalate: (msg) => {
          escalations.push(msg);
        },
        logger: monitorLogger,
      });
      monitor.start();
      await drain();

      // (6) Advance through enough ticks for 5 health checks.
      for (let i = 0; i < 6; i++) {
        jest.advanceTimersByTime(FAST_SLA.health_check_interval_ms);
        await drain(20);
      }
      // Drain post-rollback async chain (logger flush, escalation).
      await drain(40);

      // Rollback was invoked exactly once.
      expect(backend.rollbackCallCount).toBe(1);
      // Follow-up DeploymentRecord written, with cause + parent linkage.
      expect(followups).toHaveLength(1);
      expect(followups[0].details.cause).toBe('auto-rollback');
      expect(followups[0].details.parent_deploy_id).toBe('dep-prod-art-1');

      // Exactly one info-severity escalation for the rollback success.
      const infos = escalations.filter((e) => e.severity === 'info');
      expect(infos).toHaveLength(1);
      expect(infos[0].deployId).toBe('dep-prod-art-1');
      expect(infos[0].message).toContain('dep-prod-art-1');

      // Flush + close logger so all monitor lines are on disk.
      await monitorLogger.flush();
      await monitorLogger.close();

      const monitorLog = await readFile(
        join(
          requestRoot,
          '.autonomous-dev',
          'deploy-logs',
          record.deployId,
          'monitor',
          'monitor.log',
        ),
        'utf8',
      );
      expect(monitorLog).toContain('monitor_started');
      expect(monitorLog).toContain('health_check_failed');
      expect(monitorLog).toContain('auto_rollback_triggered');
      expect(monitorLog).toContain('auto_rollback_completed');

      // Cost ledger has exactly one entry for the original deploy and zero
      // new entries for the rollback (rollbacks are free per current policy).
      const all = await ledger.readAll();
      expect(all).toHaveLength(1);
      expect(all[0].deployId).toBe('dep-prod-art-1');

      await stopUnderFakeTimers(monitor);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(requestRoot, { recursive: true, force: true });
    }
  });

  it('rollback failure variant: one critical escalation containing the error', async () => {
    const stateDir = await tmp();
    const requestRoot = await tmp();
    try {
      const ledger = new CostLedger({
        dir: stateDir,
        keyHex: TEST_HMAC_KEY,
        clock: () => FIXED_NOW,
      });
      const escalations: EscalationMessage[] = [];
      const backend = new FakeBackend({
        healthSequence: [false, false, false],
        rollbackThrows: new Error('storage offline'),
      });
      const record = await backend.deploy(
        await backend.build({
          repoPath: requestRoot,
          commitSha: 'sha',
          branch: 'main',
          requestId: 'req-1',
          cleanWorktree: true,
          params: {},
        }),
        'prod',
        {},
      );
      await ledger.appendEstimated({
        deployId: record.deployId,
        env: 'prod',
        backend: 'fake',
        estimated_cost_usd: 5.0,
      });
      const monitorLogger = new DeployLogger({
        requestRoot,
        deployId: record.deployId,
        component: 'monitor',
      });
      const monitor = new HealthMonitor({
        activeDeployments: async () => [record],
        getBackend: () => backend,
        resolveSla: () => FAST_SLA,
        writeRollbackRecord: async () => ({ deployId: 'unused' }),
        escalate: (msg) => {
          escalations.push(msg);
        },
        logger: monitorLogger,
      });
      monitor.start();
      await drain();
      for (let i = 0; i < 4; i++) {
        jest.advanceTimersByTime(FAST_SLA.health_check_interval_ms);
        await drain(20);
      }
      await drain(40);

      const critical = escalations.filter((e) => e.severity === 'critical');
      expect(critical).toHaveLength(1);
      expect(critical[0].deployId).toBe(record.deployId);
      expect(critical[0].message).toContain('storage offline');

      await monitorLogger.flush();
      await monitorLogger.close();
      await stopUnderFakeTimers(monitor);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(requestRoot, { recursive: true, force: true });
    }
  });
});

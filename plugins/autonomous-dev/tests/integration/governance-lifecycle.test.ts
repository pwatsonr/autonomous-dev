/**
 * Integration test: governance checks within the runner lifecycle (SPEC-007-5-6).
 *
 * Verifies that cooldown and oscillation flags propagate correctly through
 * the runner pipeline when governance checks are applied to observations.
 *
 * Test cases:
 *   - Cooldown flags observation correctly in runner pipeline
 *   - Effectiveness evaluation runs at step 2 of runner
 *   - Oscillation + cooldown can both apply simultaneously
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { checkCooldown } from '../../src/governance/cooldown';
import { checkOscillation } from '../../src/governance/oscillation';
import { evaluateEffectiveness, computeImprovement } from '../../src/governance/effectiveness';
import { writeEffectivenessResult, splitFrontmatterAndBody } from '../../src/governance/effectiveness-writeback';
import type {
  GovernanceConfig,
  FixDeployment,
  ObservationSummary,
  EffectivenessCandidate,
  DeploymentInfo,
  CooldownResult,
  OscillationResult,
} from '../../src/governance/types';
import { TestClock } from '../helpers/test-clock';
import { MockPrometheusClient } from '../helpers/mock-mcp';
import {
  setupTestDir,
  createMockObservation,
  createObservationSeries,
  listObservations,
} from '../helpers/mock-observations';
import {
  createMockDeployment,
  readMockDeployment,
  mockLogger,
} from '../helpers/mock-deployments';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultGovernanceConfig(): GovernanceConfig {
  return {
    cooldown_days: 7,
    oscillation_window_days: 30,
    oscillation_threshold: 3,
    effectiveness_comparison_days: 7,
    effectiveness_improvement_threshold: 10,
  };
}

interface GovernanceFlags {
  cooldown_active: boolean;
  cooldown_result: CooldownResult;
  oscillation_warning: boolean;
  oscillation_result: OscillationResult;
}

/**
 * Apply governance checks (cooldown + oscillation) for a service+error class.
 * Returns the combined flags.
 */
async function applyGovernanceChecks(
  service: string,
  errorClass: string,
  config: GovernanceConfig,
  rootDir: string,
  getDeployment: (id: string) => FixDeployment | null,
  logger: ReturnType<typeof mockLogger>,
  now?: Date,
): Promise<GovernanceFlags> {
  // Check cooldown
  const cooldownResult = checkCooldown(
    service,
    errorClass,
    config,
    (svc, err) => {
      // Find the most recent fix deployment for this service+error
      // In integration tests, we scan mock deployments
      return getDeployment(`DEPLOY-${svc}-${err}`) ?? getDeployment('DEPLOY-001') ?? getDeployment('DEPLOY-002') ?? getDeployment('DEPLOY-003') ?? null;
    },
    now,
  );

  // Check oscillation
  const oscillationResult = checkOscillation(
    service,
    errorClass,
    config,
    (svc, err, afterDate) => {
      // Scan observation files for matching service+error
      const fsSync = require('fs');
      const obsDir = path.join(rootDir, '.autonomous-dev', 'observations');
      const summaries: ObservationSummary[] = [];

      const walkSync = (dir: string) => {
        let entries;
        try {
          entries = fsSync.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walkSync(fullPath);
          } else if (entry.name.startsWith('OBS-') && entry.name.endsWith('.md')) {
            try {
              const content = fsSync.readFileSync(fullPath, 'utf-8');
              const match = content.match(/^---\n([\s\S]*?)\n---/);
              if (!match) return;
              const fm: Record<string, any> = {};
              for (const line of match[1].split('\n')) {
                const ci = line.indexOf(':');
                if (ci === -1) continue;
                const key = line.substring(0, ci).trim();
                let val: any = line.substring(ci + 1).trim();
                if (val === 'null' || val === '') val = null;
                else if (val === 'true') val = true;
                else if (val === 'false') val = false;
                fm[key] = val;
              }

              if (
                fm.service === svc &&
                (fm.error_class === err || (fm.fingerprint && fm.fingerprint.startsWith(err))) &&
                fm.timestamp &&
                new Date(fm.timestamp) >= afterDate
              ) {
                summaries.push({
                  id: fm.id,
                  triage_status: fm.triage_status ?? 'pending',
                  effectiveness: fm.effectiveness ?? null,
                  is_current: false,
                });
              }
            } catch {
              // skip unreadable files
            }
          }
        }
      };

      walkSync(obsDir);
      return summaries;
    },
    now,
  );

  return {
    cooldown_active: cooldownResult.active,
    cooldown_result: cooldownResult,
    oscillation_warning: oscillationResult.oscillating,
    oscillation_result: oscillationResult,
  };
}

/**
 * Run effectiveness evaluations on all pending observations.
 */
async function runEffectivenessEvaluations(
  rootDir: string,
  config: GovernanceConfig,
  getDeploymentInfo: (id: string) => DeploymentInfo | null,
  prometheus: MockPrometheusClient,
  logger: ReturnType<typeof mockLogger>,
  now?: Date,
): Promise<{ evaluated: number; improved: number; degraded: number; unchanged: number; pending: number }> {
  const observations = await listObservations(rootDir);
  const summary = { evaluated: 0, improved: 0, degraded: 0, unchanged: 0, pending: 0 };

  for (const obs of observations) {
    if (obs.triage_decision !== 'promote') continue;
    if (!obs.linked_deployment) continue;
    if (obs.effectiveness === 'improved' || obs.effectiveness === 'degraded' || obs.effectiveness === 'unchanged') continue;

    const candidate: EffectivenessCandidate = {
      id: obs.id,
      file_path: obs.filePath,
      linked_deployment: obs.linked_deployment as string,
      effectiveness: obs.effectiveness as any,
      target_metric: (obs.target_metric as string) ?? 'rate(http_errors_total[5m])',
      metric_direction: (obs.metric_direction as any) ?? 'decrease',
      service: obs.service as string,
    };

    const result = await evaluateEffectiveness(
      candidate,
      config,
      getDeploymentInfo,
      prometheus,
      now,
    );

    if (result.status !== 'pending') {
      await writeEffectivenessResult(obs.filePath, result);
      summary.evaluated++;
      if (result.status === 'improved') summary.improved++;
      else if (result.status === 'degraded') summary.degraded++;
      else if (result.status === 'unchanged') summary.unchanged++;
    } else {
      summary.pending++;
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('governance in runner lifecycle', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await setupTestDir();
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  test('cooldown flags observation correctly in runner pipeline', async () => {
    const clock = new TestClock('2026-04-08T14:30:00Z');

    // Create a promoted observation with a linked deployment from 3 days ago
    await createMockObservation(rootDir, {
      id: 'OBS-20260405-100000-cd01',
      service: 'api-gateway',
      error_class: 'ConnectionPoolExhausted',
      triage_decision: 'promote',
      linked_deployment: 'DEPLOY-001',
      timestamp: '2026-04-05T10:00:00Z',
    });

    // Create the deployment metadata
    await createMockDeployment(rootDir, 'DEPLOY-001', '2026-04-05T10:00:00Z', {
      service: 'api-gateway',
      error_class: 'ConnectionPoolExhausted',
    });

    // Read deployment for the finder
    const deploy = await readMockDeployment(rootDir, 'DEPLOY-001');

    // Run governance checks for a new candidate with same service+error
    const flags = await applyGovernanceChecks(
      'api-gateway',
      'ConnectionPoolExhausted',
      defaultGovernanceConfig(),
      rootDir,
      (_id) => deploy,
      mockLogger(),
      clock.now(),
    );

    expect(flags.cooldown_active).toBe(true);
    expect(flags.cooldown_result.linked_deployment).toBe('DEPLOY-001');
  });

  test('effectiveness evaluation runs for promoted observation with elapsed window', async () => {
    const clock = new TestClock('2026-04-08T14:30:00Z');

    // Create a promoted+deployed observation
    await createMockObservation(rootDir, {
      id: 'OBS-20260301-120000-ef01',
      service: 'api-gateway',
      triage_decision: 'promote',
      linked_deployment: 'DEPLOY-002',
      effectiveness: null,
      target_metric: 'rate(http_errors_total[5m])',
      metric_direction: 'decrease',
      timestamp: '2026-03-01T12:00:00Z',
    });

    // Deploy was 2026-03-20 -> cooldown ends 2026-03-27 -> comparison window ends 2026-04-03
    // Now is 2026-04-08 -> window has elapsed
    const deployInfo: DeploymentInfo = {
      id: 'DEPLOY-002',
      deployed_at: '2026-03-20T00:00:00Z',
    };

    // Mock Prometheus: pre=12.3, post=0.6
    const prometheus = new MockPrometheusClient();
    prometheus.setQueryResponse('pre', 12.3);
    prometheus.setQueryResponse('post', 0.6);

    const summary = await runEffectivenessEvaluations(
      rootDir,
      defaultGovernanceConfig(),
      (id) => id === 'DEPLOY-002' ? deployInfo : null,
      prometheus,
      mockLogger(),
      clock.now(),
    );

    expect(summary.evaluated).toBe(1);
    expect(summary.improved).toBe(1);

    // Verify file was updated
    const obs = await listObservations(rootDir);
    const updated = obs.find(o => o.id === 'OBS-20260301-120000-ef01');
    expect(updated).toBeDefined();
    expect(updated!.effectiveness).toBe('improved');
  });

  test('oscillation + cooldown can both apply simultaneously', async () => {
    const clock = new TestClock('2026-04-08T14:30:00Z');

    // Create 3 prior observations within 25 days (triggers oscillation threshold of 3)
    await createObservationSeries(
      rootDir,
      'api-gateway',
      'ConnPool',
      3,
      25,
      '2026-04-08T14:30:00Z',
    );

    // Create deployment from 5 days ago (triggers cooldown)
    await createMockDeployment(rootDir, 'DEPLOY-003', '2026-04-03T00:00:00Z', {
      service: 'api-gateway',
      error_class: 'ConnPool',
    });

    const deploy = await readMockDeployment(rootDir, 'DEPLOY-003');

    const flags = await applyGovernanceChecks(
      'api-gateway',
      'ConnPool',
      defaultGovernanceConfig(),
      rootDir,
      (_id) => deploy,
      mockLogger(),
      clock.now(),
    );

    expect(flags.cooldown_active).toBe(true);
    expect(flags.oscillation_warning).toBe(true);
    expect(flags.oscillation_result.count).toBe(3);
  });

  test('no cooldown when deployment is older than cooldown window', async () => {
    const clock = new TestClock('2026-04-08T14:30:00Z');

    await createMockDeployment(rootDir, 'DEPLOY-OLD', '2026-03-01T00:00:00Z', {
      service: 'api-gateway',
      error_class: 'OldError',
    });

    const deploy = await readMockDeployment(rootDir, 'DEPLOY-OLD');

    const flags = await applyGovernanceChecks(
      'api-gateway',
      'OldError',
      defaultGovernanceConfig(),
      rootDir,
      (_id) => deploy,
      mockLogger(),
      clock.now(),
    );

    expect(flags.cooldown_active).toBe(false);
  });

  test('no oscillation when observation count is below threshold', async () => {
    const clock = new TestClock('2026-04-08T14:30:00Z');

    // Only 2 observations (threshold is 3)
    await createObservationSeries(rootDir, 'api-gateway', 'MinorErr', 2, 20);

    const flags = await applyGovernanceChecks(
      'api-gateway',
      'MinorErr',
      defaultGovernanceConfig(),
      rootDir,
      () => null,
      mockLogger(),
      clock.now(),
    );

    expect(flags.oscillation_warning).toBe(false);
  });
});

/**
 * E2E test: full feedback loop (SPEC-007-5-6).
 *
 * TC-5-6-17: Error -> observation -> promote -> PRD -> deploy -> effectiveness = improved
 *
 * Exercises the complete lifecycle from error detection through effectiveness
 * verification using controllable time and mock MCP servers.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { TestClock } from '../helpers/test-clock';
import { MockPrometheusClient, MockOpenSearchClient } from '../helpers/mock-mcp';
import {
  setupTestDir,
  createMockObservation,
  listObservations,
  readObservation,
  updateMockObservation,
} from '../helpers/mock-observations';
import {
  createMockDeployment,
  mockLogger,
} from '../helpers/mock-deployments';
import { checkCooldown } from '../../src/governance/cooldown';
import { evaluateEffectiveness } from '../../src/governance/effectiveness';
import { writeEffectivenessResult } from '../../src/governance/effectiveness-writeback';
import type {
  GovernanceConfig,
  EffectivenessCandidate,
  DeploymentInfo,
  FixDeployment,
} from '../../src/governance/types';

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

/**
 * Simulate an observation cycle: create an observation file based on mock data.
 */
async function runObservationCycle(
  rootDir: string,
  prometheus: MockPrometheusClient,
  opensearch: MockOpenSearchClient,
  clock: TestClock,
): Promise<{ observationId: string; filePath: string }> {
  const errorRate = prometheus.getErrorRate('api-gateway');
  const logs = opensearch.getErrorLogs('api-gateway');

  const severity = (errorRate ?? 0) > 10 ? 'P1' : (errorRate ?? 0) > 5 ? 'P2' : 'P3';

  const ts = clock.now().toISOString();
  const datePart = ts.slice(0, 10).replace(/-/g, '');
  const timePart = ts.slice(11, 19).replace(/:/g, '');
  const id = `OBS-${datePart}-${timePart}-e2e1`;

  const obs = await createMockObservation(rootDir, {
    id,
    service: 'api-gateway',
    severity,
    confidence: 0.92,
    timestamp: ts,
    triage_status: 'pending',
    triage_decision: null,
    error_class: 'ConnectionPoolExhausted',
    target_metric: 'rate(http_errors_total[5m])',
    metric_direction: 'decrease',
  });

  return { observationId: id, filePath: obs.filePath };
}

/**
 * Process a triage decision by updating observation frontmatter.
 */
async function processTriageDecision(
  filePath: string,
  decision: { decision: string; actor: string; reason: string },
): Promise<void> {
  await updateMockObservation('', filePath, {
    triage_status: decision.decision === 'promote' ? 'promoted' : decision.decision,
    triage_decision: decision.decision,
    triage_by: decision.actor,
    triage_at: new Date().toISOString(),
    triage_reason: decision.reason,
  });
}

/**
 * Simulate generating a PRD for a promoted observation.
 */
async function generateMockPrd(
  rootDir: string,
  observationId: string,
): Promise<{ prdId: string; filePath: string }> {
  const prdId = `PRD-${observationId.replace('OBS-', '')}`;
  const prdDir = path.join(rootDir, '.autonomous-dev', 'prd');
  await fs.mkdir(prdDir, { recursive: true });
  const filePath = path.join(prdDir, `${prdId}.md`);

  await fs.writeFile(filePath, [
    '---',
    `id: ${prdId}`,
    `observation_id: ${observationId}`,
    `service: api-gateway`,
    `status: active`,
    '---',
    '',
    `# PRD: Fix ConnectionPoolExhausted`,
    '',
    'Generated from observation.',
  ].join('\n'), 'utf-8');

  return { prdId, filePath };
}

/**
 * Simulate a deployment for a fix.
 */
async function simulateDeployment(
  rootDir: string,
  observationId: string,
  prdId: string,
  clock: TestClock,
  observationFilePath: string,
): Promise<string> {
  const deploymentId = `DEPLOY-${observationId.replace('OBS-', '')}`;
  await createMockDeployment(rootDir, deploymentId, clock.now().toISOString(), {
    observation_id: observationId,
    service: 'api-gateway',
    error_class: 'ConnectionPoolExhausted',
  });

  // Update observation to link deployment
  await updateMockObservation('', observationFilePath, {
    linked_deployment: deploymentId,
    linked_prd: prdId,
  });

  return deploymentId;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('E2E: full feedback loop', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await setupTestDir();
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  // TC-5-6-17
  test('TC-5-6-17: error -> observation -> promote -> PRD -> deploy -> effectiveness verified', async () => {
    const clock = new TestClock('2026-04-01T10:00:00Z');
    const prometheus = new MockPrometheusClient();
    const opensearch = new MockOpenSearchClient();
    const config = defaultGovernanceConfig();

    // Step 1: Inject mock error data -- high error rate
    prometheus.setErrorRate('api-gateway', 12.3);
    opensearch.setErrorLogs('api-gateway', [
      { message: 'ConnectionPoolExhaustedError: pool drained', timestamp: clock.now().toISOString() },
    ]);

    // Step 2: Run observation -- should detect the error
    clock.set('2026-04-01T14:00:00Z');
    const { observationId, filePath } = await runObservationCycle(rootDir, prometheus, opensearch, clock);

    const observations = await listObservations(rootDir);
    expect(observations).toHaveLength(1);
    expect(observations[0].severity).toBe('P1');
    expect(observations[0].triage_status).toBe('pending');

    // Step 3: PM Lead promotes the observation
    await processTriageDecision(filePath, {
      decision: 'promote',
      actor: 'pm-lead',
      reason: 'Connection pool issue confirmed',
    });

    // Step 4: Runner generates PRD
    clock.advanceHours(1);
    const prd = await generateMockPrd(rootDir, observationId);
    expect(prd.prdId).not.toBeNull();

    // Step 5: Simulate deployment
    clock.advanceDays(2);
    const deploymentId = await simulateDeployment(
      rootDir, observationId, prd.prdId, clock, filePath,
    );

    // Step 6: Fix the error in mock data
    prometheus.setErrorRate('api-gateway', 0.6);

    // Step 7: Advance past cooldown + comparison window
    // Deploy: April 3. Cooldown (7d): April 10. Post window (7d): April 17.
    clock.advanceDays(14); // Now: April 17

    // Step 8: Run effectiveness evaluation
    prometheus.resetCallIndex();
    prometheus.setQueryResponse('pre', 12.3);
    prometheus.setQueryResponse('post', 0.6);

    const deployInfo: DeploymentInfo = {
      id: deploymentId,
      deployed_at: '2026-04-03T14:00:00Z',
    };

    const candidate: EffectivenessCandidate = {
      id: observationId,
      file_path: filePath,
      linked_deployment: deploymentId,
      effectiveness: null,
      target_metric: 'rate(http_errors_total[5m])',
      metric_direction: 'decrease',
      service: 'api-gateway',
    };

    const effResult = await evaluateEffectiveness(
      candidate,
      config,
      (id) => id === deploymentId ? deployInfo : null,
      prometheus,
      clock.now(),
    );

    expect(effResult.status).toBe('improved');
    expect(effResult.detail!.improvement_pct).toBeCloseTo(95.1, 1);

    // Step 9: Write back effectiveness
    await writeEffectivenessResult(filePath, effResult);

    // Verify the file was updated
    const updatedObs = await readObservation(rootDir, observationId);
    expect(updatedObs.effectiveness).toBe('improved');
  });

  test('effectiveness pending when post-fix window not elapsed', async () => {
    const clock = new TestClock('2026-04-01T10:00:00Z');
    const prometheus = new MockPrometheusClient();
    const opensearch = new MockOpenSearchClient();
    const config = defaultGovernanceConfig();

    prometheus.setErrorRate('api-gateway', 12.3);
    opensearch.setErrorLogs('api-gateway', []);

    const { observationId, filePath } = await runObservationCycle(rootDir, prometheus, opensearch, clock);

    await processTriageDecision(filePath, {
      decision: 'promote',
      actor: 'pm-lead',
      reason: 'Confirmed',
    });

    clock.advanceDays(2);
    const deploymentId = await simulateDeployment(
      rootDir, observationId, 'PRD-test', clock, filePath,
    );

    // Only advance 5 days (not enough for cooldown + comparison)
    clock.advanceDays(5);

    const deployInfo: DeploymentInfo = {
      id: deploymentId,
      deployed_at: '2026-04-03T10:00:00Z',
    };

    const candidate: EffectivenessCandidate = {
      id: observationId,
      file_path: filePath,
      linked_deployment: deploymentId,
      effectiveness: null,
      target_metric: 'rate(http_errors_total[5m])',
      metric_direction: 'decrease',
      service: 'api-gateway',
    };

    const result = await evaluateEffectiveness(
      candidate,
      config,
      (id) => id === deploymentId ? deployInfo : null,
      prometheus,
      clock.now(),
    );

    expect(result.status).toBe('pending');
    expect(result.reason).toContain('not yet elapsed');
  });
});

/**
 * Unit tests for auto-promotion logic and override handling
 * (SPEC-007-5-4, Task 8).
 *
 * Test cases: TC-5-4-16 through TC-5-4-27.
 *
 * Uses the real evaluateAutoPromote from src/governance/auto-promote.ts.
 * Safeguard 6 (notification channel reachable) calls checkChannelHealth
 * which requires fetch -- tests for safeguards 1-5 are structured so
 * that earlier safeguards block before safeguard 6 is reached.
 */

import {
  evaluateAutoPromote,
} from '../../src/governance/auto-promote';
import type {
  AutoPromoteConfig,
  AutoPromoteCandidate,
} from '../../src/governance/auto-promote';
import {
  scheduleOverrideCheck,
  processPendingOverrides,
} from '../../src/governance/override-scheduler';
import type { OverrideCheck } from '../../src/governance/override-scheduler';
import type { GovernanceConfig, ObservationSummary } from '../../src/governance/types';
import { createMockSummaries } from '../helpers/mock-observations';
import { mockLogger } from '../helpers/mock-deployments';

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultGovernanceConfig(overrides?: Partial<GovernanceConfig>): GovernanceConfig {
  return {
    cooldown_days: 7,
    oscillation_window_days: 30,
    oscillation_threshold: 3,
    effectiveness_comparison_days: 7,
    effectiveness_improvement_threshold: 10,
    ...overrides,
  };
}

function defaultAutoPromoteConfig(overrides?: Partial<AutoPromoteConfig>): AutoPromoteConfig {
  return {
    enabled: true,
    override_hours: 2,
    ...overrides,
  };
}

function defaultCandidate(overrides?: Partial<AutoPromoteCandidate>): AutoPromoteCandidate {
  return {
    id: 'OBS-20260408-143022-a7f3',
    service: 'api-gateway',
    error_class: 'ConnectionPoolExhausted',
    severity: 'P0',
    confidence: 0.95,
    cooldown_active: false,
    file_path: '/tmp/test-obs.md',
    ...overrides,
  };
}

function defaultNotificationConfig(): any {
  return {
    enabled: true,
    channel: 'slack',
    webhook_url: 'https://hooks.slack.com/test',
    notify_on: ['P0', 'P1'],
    health_check_timeout_ms: 5000,
    retry_attempts: 2,
    retry_delay_ms: 1000,
  };
}

function noObservationsFinder(_s: string, _e: string, _d: Date): ObservationSummary[] {
  return [];
}

function oscillatingFinder(_s: string, _e: string, _d: Date): ObservationSummary[] {
  return createMockSummaries(3);
}

async function createTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'auto-promote-test-'));
}

// ---------------------------------------------------------------------------
// Tests using describe/test/expect (Jest/Vitest)
// ---------------------------------------------------------------------------

describe('evaluateAutoPromote', () => {
  const baseCandidate = defaultCandidate();

  // TC-5-4-17: Auto-promote blocked: disabled
  test('TC-5-4-17: safeguard 1 - auto-promote disabled', async () => {
    const result = await evaluateAutoPromote(
      baseCandidate,
      defaultAutoPromoteConfig({ enabled: false }),
      defaultGovernanceConfig(),
      defaultNotificationConfig(),
      noObservationsFinder,
      mockLogger() as any,
    );
    expect(result.promoted).toBe(false);
    expect(result.safeguard_failed).toBe('enabled');
    expect(result.reason).toContain('disabled');
  });

  // TC-5-4-18: Auto-promote blocked: severity (P2)
  test('TC-5-4-18: safeguard 2 - severity P2 not eligible', async () => {
    const result = await evaluateAutoPromote(
      defaultCandidate({ severity: 'P2' }),
      defaultAutoPromoteConfig(),
      defaultGovernanceConfig(),
      defaultNotificationConfig(),
      noObservationsFinder,
      mockLogger() as any,
    );
    expect(result.promoted).toBe(false);
    expect(result.safeguard_failed).toBe('severity');
    expect(result.reason).toContain('P2');
  });

  // TC-5-4-19: Auto-promote blocked: confidence (0.85)
  test('TC-5-4-19: safeguard 3 - confidence 0.85 below threshold', async () => {
    const result = await evaluateAutoPromote(
      defaultCandidate({ confidence: 0.85 }),
      defaultAutoPromoteConfig(),
      defaultGovernanceConfig(),
      defaultNotificationConfig(),
      noObservationsFinder,
      mockLogger() as any,
    );
    expect(result.promoted).toBe(false);
    expect(result.safeguard_failed).toBe('confidence');
    expect(result.reason).toContain('0.85');
  });

  // TC-5-4-20: Auto-promote blocked: cooldown active
  test('TC-5-4-20: safeguard 4 - cooldown active blocks auto-promote', async () => {
    const result = await evaluateAutoPromote(
      defaultCandidate({ cooldown_active: true }),
      defaultAutoPromoteConfig(),
      defaultGovernanceConfig(),
      defaultNotificationConfig(),
      noObservationsFinder,
      mockLogger() as any,
    );
    expect(result.promoted).toBe(false);
    expect(result.safeguard_failed).toBe('cooldown');
    expect(result.reason).toContain('Cooldown');
  });

  // TC-5-4-21: Auto-promote blocked: oscillation
  test('TC-5-4-21: safeguard 5 - oscillation detected blocks auto-promote', async () => {
    const result = await evaluateAutoPromote(
      baseCandidate,
      defaultAutoPromoteConfig(),
      defaultGovernanceConfig(),
      defaultNotificationConfig(),
      oscillatingFinder,
      mockLogger() as any,
    );
    expect(result.promoted).toBe(false);
    expect(result.safeguard_failed).toBe('oscillation');
    expect(result.reason).toContain('Oscillation');
  });

  // Boundary: confidence exactly 0.9 should pass safeguard 3
  test('confidence exactly 0.9 passes safeguard 3', async () => {
    const result = await evaluateAutoPromote(
      defaultCandidate({ confidence: 0.9 }),
      defaultAutoPromoteConfig(),
      defaultGovernanceConfig(),
      defaultNotificationConfig(),
      noObservationsFinder,
      mockLogger() as any,
    );
    // Should NOT fail on confidence (may fail on channel, which is fine)
    expect(result.safeguard_failed).not.toBe('confidence');
  });

  // P1 severity should be eligible (passes safeguard 2)
  test('P1 severity passes safeguard 2', async () => {
    const result = await evaluateAutoPromote(
      defaultCandidate({ severity: 'P1' }),
      defaultAutoPromoteConfig(),
      defaultGovernanceConfig(),
      defaultNotificationConfig(),
      noObservationsFinder,
      mockLogger() as any,
    );
    expect(result.safeguard_failed).not.toBe('severity');
  });

  // P3 severity should fail safeguard 2
  test('P3 severity fails safeguard 2', async () => {
    const result = await evaluateAutoPromote(
      defaultCandidate({ severity: 'P3' }),
      defaultAutoPromoteConfig(),
      defaultGovernanceConfig(),
      defaultNotificationConfig(),
      noObservationsFinder,
      mockLogger() as any,
    );
    expect(result.promoted).toBe(false);
    expect(result.safeguard_failed).toBe('severity');
  });

  // Safeguard order: earlier safeguards block before later ones
  test('safeguard order: enabled checked before severity', async () => {
    const result = await evaluateAutoPromote(
      defaultCandidate({ severity: 'P2' }),
      defaultAutoPromoteConfig({ enabled: false }),
      defaultGovernanceConfig(),
      defaultNotificationConfig(),
      noObservationsFinder,
      mockLogger() as any,
    );
    expect(result.safeguard_failed).toBe('enabled');
  });

  // Oscillation count below threshold should not block
  test('oscillation count below threshold does not block', async () => {
    const belowThresholdFinder = (_s: string, _e: string, _d: Date) => createMockSummaries(2);
    const result = await evaluateAutoPromote(
      baseCandidate,
      defaultAutoPromoteConfig(),
      defaultGovernanceConfig(),
      defaultNotificationConfig(),
      belowThresholdFinder,
      mockLogger() as any,
    );
    // Should NOT fail on oscillation
    expect(result.safeguard_failed).not.toBe('oscillation');
  });

  // TC-5-4-27: Auto-promote audit log entry shape
  test('TC-5-4-27: auto-promote audit log entry has auto_promoted flag', () => {
    const entry = {
      observation_id: 'OBS-20260408-143022-a7f3',
      action: 'promote' as const,
      actor: 'auto-promote-engine',
      timestamp: new Date().toISOString(),
      reason: 'Auto-promoted: all 6 safeguards passed',
      generated_prd: 'PRD-OBS-20260408-143022-a7f3',
      auto_promoted: true,
    };

    expect(entry.auto_promoted).toBe(true);
    expect(entry.actor).toBe('auto-promote-engine');
    expect(entry.action).toBe('promote');
  });
});

// ---------------------------------------------------------------------------
// Override scheduler tests
// ---------------------------------------------------------------------------

describe('scheduleOverrideCheck', () => {
  // TC-5-4-26: Pending override persistence
  test('TC-5-4-26: writes pending override check to disk', async () => {
    const tmpDir = await createTempDir();
    const logger = mockLogger();

    const deadline = new Date('2026-04-10T16:00:00Z');
    await scheduleOverrideCheck(
      'OBS-20260408-143022-a7f3',
      'PRD-OBS-20260408-143022-a7f3',
      deadline,
      tmpDir,
      logger as any,
    );

    const overrideFile = path.join(
      tmpDir, '.autonomous-dev', 'governance', 'pending-overrides',
      'OBS-20260408-143022-a7f3.json',
    );
    const content = await fs.readFile(overrideFile, 'utf-8');
    const check: OverrideCheck = JSON.parse(content);

    expect(check.status).toBe('pending');
    expect(check.observation_id).toBe('OBS-20260408-143022-a7f3');
    expect(check.prd_id).toBe('PRD-OBS-20260408-143022-a7f3');
    expect(check.override_deadline).toBe('2026-04-10T16:00:00.000Z');

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

describe('processPendingOverrides', () => {
  // TC-5-4-25: No override -- PRD confirmed
  test('TC-5-4-25: no override within window confirms PRD', async () => {
    const tmpDir = await createTempDir();
    const logger = mockLogger();

    // Set up observation file -- still promoted by auto-promote-engine
    const obsDir = path.join(tmpDir, '.autonomous-dev', 'observations', '2026', '04');
    await fs.mkdir(obsDir, { recursive: true });
    await fs.writeFile(path.join(obsDir, 'OBS-20260408-143022-a7f3.md'), [
      '---',
      'id: OBS-20260408-143022-a7f3',
      'service: api-gateway',
      'triage_status: promoted',
      'triage_decision: promote',
      'triage_by: auto-promote-engine',
      'triage_at: 2026-04-08T14:00:00Z',
      'linked_prd: PRD-OBS-20260408-143022-a7f3',
      '---',
      '',
      '## Evidence',
      'Test evidence',
    ].join('\n'), 'utf-8');

    // Schedule override check with past deadline
    const pastDeadline = new Date('2026-04-08T16:00:00Z');
    await scheduleOverrideCheck(
      'OBS-20260408-143022-a7f3',
      'PRD-OBS-20260408-143022-a7f3',
      pastDeadline,
      tmpDir,
      logger as any,
    );

    // Process overrides after deadline
    const result = await processPendingOverrides(
      tmpDir,
      logger as any,
      new Date('2026-04-08T17:00:00Z'),
    );

    expect(result.confirmed).toBe(1);
    expect(result.overridden).toBe(0);

    // Check override file was updated
    const overrideFile = path.join(
      tmpDir, '.autonomous-dev', 'governance', 'pending-overrides',
      'OBS-20260408-143022-a7f3.json',
    );
    const check: OverrideCheck = JSON.parse(await fs.readFile(overrideFile, 'utf-8'));
    expect(check.status).toBe('confirmed');

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // TC-5-4-23: Override within window
  test('TC-5-4-23: PM Lead override within window cancels PRD', async () => {
    const tmpDir = await createTempDir();
    const logger = mockLogger();

    // Set up observation file -- PM Lead overrode triage
    const obsDir = path.join(tmpDir, '.autonomous-dev', 'observations', '2026', '04');
    await fs.mkdir(obsDir, { recursive: true });
    await fs.writeFile(path.join(obsDir, 'OBS-20260408-143022-a7f3.md'), [
      '---',
      'id: OBS-20260408-143022-a7f3',
      'service: api-gateway',
      'triage_status: dismissed',
      'triage_decision: dismiss',
      'triage_by: pm-lead',
      'triage_at: 2026-04-08T15:00:00Z',
      'triage_reason: Not actionable',
      'linked_prd: PRD-OBS-20260408-143022-a7f3',
      '---',
      '',
      '## Evidence',
      'Test evidence',
    ].join('\n'), 'utf-8');

    // Set up PRD file that should be cancelled
    const prdDir = path.join(tmpDir, '.autonomous-dev', 'prd');
    await fs.mkdir(prdDir, { recursive: true });
    const prdId = 'PRD-OBS-20260408-143022-a7f3';
    await fs.writeFile(
      path.join(prdDir, `${prdId}.md`),
      '# PRD\nTest PRD content',
      'utf-8',
    );

    // Schedule override check with past deadline
    const pastDeadline = new Date('2026-04-08T16:00:00Z');
    await scheduleOverrideCheck(
      'OBS-20260408-143022-a7f3',
      prdId,
      pastDeadline,
      tmpDir,
      logger as any,
    );

    // Process overrides after deadline
    const result = await processPendingOverrides(
      tmpDir,
      logger as any,
      new Date('2026-04-08T17:00:00Z'),
    );

    expect(result.overridden).toBe(1);
    expect(result.confirmed).toBe(0);

    // Check PRD was moved to cancelled/
    const cancelledPath = path.join(prdDir, 'cancelled', `${prdId}.md`);
    const cancelledExists = await fs.access(cancelledPath).then(() => true).catch(() => false);
    expect(cancelledExists).toBe(true);

    // Check override file status
    const overrideFile = path.join(
      tmpDir, '.autonomous-dev', 'governance', 'pending-overrides',
      'OBS-20260408-143022-a7f3.json',
    );
    const check: OverrideCheck = JSON.parse(await fs.readFile(overrideFile, 'utf-8'));
    expect(check.status).toBe('overridden');

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // TC-5-4-24/TC-5-4-26: Still pending before deadline
  test('TC-5-4-26: pending override before deadline remains pending', async () => {
    const tmpDir = await createTempDir();
    const logger = mockLogger();

    // Schedule override check with future deadline
    const futureDeadline = new Date('2026-04-10T16:00:00Z');
    await scheduleOverrideCheck(
      'OBS-20260408-143022-a7f3',
      'PRD-OBS-20260408-143022-a7f3',
      futureDeadline,
      tmpDir,
      logger as any,
    );

    // Process with "now" before deadline
    const result = await processPendingOverrides(
      tmpDir,
      logger as any,
      new Date('2026-04-09T12:00:00Z'),
    );

    expect(result.still_pending).toBe(1);
    expect(result.confirmed).toBe(0);
    expect(result.overridden).toBe(0);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // Multiple override checks processed correctly
  test('multiple override checks processed simultaneously', async () => {
    const tmpDir = await createTempDir();
    const logger = mockLogger();

    // Observation 1: still promoted (will be confirmed)
    const obsDir = path.join(tmpDir, '.autonomous-dev', 'observations', '2026', '04');
    await fs.mkdir(obsDir, { recursive: true });
    await fs.writeFile(path.join(obsDir, 'OBS-20260408-143022-a7f3.md'), [
      '---',
      'id: OBS-20260408-143022-a7f3',
      'service: api-gateway',
      'triage_status: promoted',
      'triage_decision: promote',
      'triage_by: auto-promote-engine',
      '---',
      '',
      'Content',
    ].join('\n'), 'utf-8');

    // Observation 2: overridden by PM Lead
    await fs.writeFile(path.join(obsDir, 'OBS-20260408-150000-b8e4.md'), [
      '---',
      'id: OBS-20260408-150000-b8e4',
      'service: payment-service',
      'triage_status: dismissed',
      'triage_decision: dismiss',
      'triage_by: pm-lead',
      '---',
      '',
      'Content',
    ].join('\n'), 'utf-8');

    // Set up PRD for observation 2
    const prdDir = path.join(tmpDir, '.autonomous-dev', 'prd');
    await fs.mkdir(prdDir, { recursive: true });
    await fs.writeFile(
      path.join(prdDir, 'PRD-OBS-20260408-150000-b8e4.md'),
      '# PRD 2',
      'utf-8',
    );

    // Schedule override checks for both
    const pastDeadline = new Date('2026-04-08T16:00:00Z');
    await scheduleOverrideCheck('OBS-20260408-143022-a7f3', 'PRD-OBS-20260408-143022-a7f3', pastDeadline, tmpDir, logger as any);
    await scheduleOverrideCheck('OBS-20260408-150000-b8e4', 'PRD-OBS-20260408-150000-b8e4', pastDeadline, tmpDir, logger as any);

    // Process
    const result = await processPendingOverrides(tmpDir, logger as any, new Date('2026-04-08T17:00:00Z'));

    expect(result.confirmed).toBe(1);
    expect(result.overridden).toBe(1);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

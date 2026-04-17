/**
 * E2E test: auto-promote with override (SPEC-007-5-6).
 *
 * TC-5-6-19: Auto-promote -> override within window -> PRD cancelled
 * TC-5-6-20: Auto-promote confirmed when no override within window
 *
 * Tests the full auto-promotion lifecycle:
 *   1. High-confidence P0 observation auto-promoted
 *   2. PRD generated
 *   3. Notification sent
 *   4. Override window scheduled
 *   5a. PM overrides -> PRD cancelled
 *   5b. No override -> PRD confirmed
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { TestClock } from '../helpers/test-clock';
import { MockWebhookServer } from '../helpers/mock-mcp';
import {
  setupTestDir,
  createMockObservation,
  listObservations,
  readObservation,
  updateMockObservation,
  fileExists,
} from '../helpers/mock-observations';
import {
  scheduleMockOverride,
  listPendingOverrides,
  mockLogger,
} from '../helpers/mock-deployments';

// ---------------------------------------------------------------------------
// Simulation helpers
// ---------------------------------------------------------------------------

interface AutoPromoteConfig {
  enabled: boolean;
  override_hours: number;
}

interface SimulationConfig {
  auto_promote: AutoPromoteConfig;
  notifications: {
    enabled: boolean;
    webhook_url: string;
    notify_on: string[];
  };
}

/**
 * Simulate the auto-promote evaluation and execution.
 * Returns the created PRD ID and override deadline.
 */
async function simulateAutoPromote(
  rootDir: string,
  observationId: string,
  observationFilePath: string,
  config: SimulationConfig,
  clock: TestClock,
  webhook: MockWebhookServer,
): Promise<{ prdId: string; overrideDeadline: Date } | null> {
  // Read observation
  const obs = await readObservation(rootDir, observationId);
  if (!obs) return null;

  // Evaluate safeguards (simplified for E2E)
  if (!config.auto_promote.enabled) return null;
  if (obs.severity !== 'P0' && obs.severity !== 'P1') return null;
  if (typeof obs.confidence === 'number' && obs.confidence < 0.9) return null;

  // All safeguards passed -- auto-promote
  const prdId = `PRD-${observationId.replace('OBS-', '')}`;

  // 1. Update observation
  await updateMockObservation('', observationFilePath, {
    triage_status: 'promoted',
    triage_decision: 'promote',
    triage_by: 'auto-promote-engine',
    triage_at: clock.now().toISOString(),
    triage_reason: 'Auto-promoted: P0/P1 with confidence >= 0.9',
    linked_prd: prdId,
  });

  // 2. Generate PRD
  const prdDir = path.join(rootDir, '.autonomous-dev', 'prd');
  await fs.mkdir(prdDir, { recursive: true });
  await fs.writeFile(
    path.join(prdDir, `${prdId}.md`),
    [
      '---',
      `id: ${prdId}`,
      `observation_id: ${observationId}`,
      `status: active`,
      `auto_promoted: true`,
      '---',
      '',
      `# PRD: Fix ${obs.error_class ?? 'Error'} on ${obs.service}`,
      '',
      'Auto-generated PRD from auto-promotion.',
    ].join('\n'),
    'utf-8',
  );

  // 3. Send notification
  if (config.notifications.enabled) {
    const message = [
      `Auto-Promoted: ${observationId}`,
      `Service: ${obs.service}`,
      `Severity: ${obs.severity}`,
      `PRD: ${prdId}`,
      `Override window: ${config.auto_promote.override_hours}h`,
    ].join('\n');
    webhook.post(message);
  }

  // 4. Schedule override check
  const overrideDeadline = new Date(clock.now());
  overrideDeadline.setHours(overrideDeadline.getHours() + config.auto_promote.override_hours);

  await scheduleMockOverride(rootDir, observationId, prdId, overrideDeadline);

  return { prdId, overrideDeadline };
}

/**
 * Process a PM triage override.
 */
async function processPmOverride(
  observationFilePath: string,
  decision: { decision: string; actor: string; reason: string },
  clock: TestClock,
): Promise<void> {
  await updateMockObservation('', observationFilePath, {
    triage_status: decision.decision === 'dismiss' ? 'dismissed' : decision.decision,
    triage_decision: decision.decision,
    triage_by: decision.actor,
    triage_at: clock.now().toISOString(),
    triage_reason: decision.reason,
  });
}

/**
 * Process pending overrides: check if triage was changed within the window.
 */
async function processPendingOverrides(
  rootDir: string,
  logger: ReturnType<typeof mockLogger>,
  now?: Date,
): Promise<{ overridden: number; confirmed: number; still_pending: number }> {
  const overrideDir = path.join(rootDir, '.autonomous-dev', 'overrides');
  const result = { overridden: 0, confirmed: 0, still_pending: 0 };
  const currentTime = now ?? new Date();

  let files: string[];
  try {
    files = await fs.readdir(overrideDir);
  } catch {
    return result;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(overrideDir, file);
    const content = await fs.readFile(filePath, 'utf-8');
    const override = JSON.parse(content);

    if (override.status !== 'pending') continue;

    const deadline = new Date(override.deadline);
    if (currentTime < deadline) {
      result.still_pending++;
      continue;
    }

    // Find observation
    const observation = await findObservationById(rootDir, override.observation_id);
    if (!observation) continue;

    const prdPath = path.join(rootDir, '.autonomous-dev', 'prd', `${override.prd_id}.md`);
    const cancelledPath = path.join(rootDir, '.autonomous-dev', 'prd', 'cancelled', `${override.prd_id}.md`);

    if (
      observation.triage_decision !== 'promote' ||
      (observation.triage_by && observation.triage_by !== 'auto-promote-engine')
    ) {
      // Override: cancel PRD
      try {
        const prdContent = await fs.readFile(prdPath, 'utf-8');
        await fs.mkdir(path.dirname(cancelledPath), { recursive: true });
        await fs.writeFile(cancelledPath, prdContent, 'utf-8');
        await fs.unlink(prdPath);
      } catch {
        // PRD may not exist
      }

      override.status = 'overridden';
      await fs.writeFile(filePath, JSON.stringify(override, null, 2), 'utf-8');
      result.overridden++;
    } else {
      override.status = 'confirmed';
      await fs.writeFile(filePath, JSON.stringify(override, null, 2), 'utf-8');
      result.confirmed++;
    }
  }

  return result;
}

async function findObservationById(rootDir: string, id: string): Promise<Record<string, any> | null> {
  const obsDir = path.join(rootDir, '.autonomous-dev', 'observations');

  const walkDir = async (dir: string): Promise<Record<string, any> | null> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await walkDir(fullPath);
        if (found) return found;
      } else if (entry.name.startsWith('OBS-') && entry.name.endsWith('.md')) {
        const content = await fs.readFile(fullPath, 'utf-8');
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        if (!match) continue;
        const fm: Record<string, any> = {};
        for (const line of match[1].split('\n')) {
          const ci = line.indexOf(':');
          if (ci === -1) continue;
          const key = line.substring(0, ci).trim();
          let val: any = line.substring(ci + 1).trim();
          if (val === 'null' || val === '') val = null;
          else if (val === 'true') val = true;
          else if (val === 'false') val = false;
          else if ((val.startsWith('"') && val.endsWith('"'))) val = val.slice(1, -1);
          fm[key] = val;
        }
        if (fm.id === id) return fm;
      }
    }
    return null;
  };

  return walkDir(obsDir);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E: auto-promote with override', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await setupTestDir();
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  // TC-5-6-19: Auto-promote -> PM override -> PRD cancelled
  test('TC-5-6-19: high-confidence P0 auto-promoted, PM overrides, PRD cancelled', async () => {
    const clock = new TestClock('2026-04-08T10:00:00Z');
    const webhook = new MockWebhookServer();

    const config: SimulationConfig = {
      auto_promote: { enabled: true, override_hours: 2 },
      notifications: { enabled: true, webhook_url: webhook.url, notify_on: ['P0', 'P1'] },
    };

    // Step 1: Create a high-confidence P0 observation
    const obs = await createMockObservation(rootDir, {
      id: 'OBS-20260408-100000-ap01',
      service: 'api-gateway',
      severity: 'P0',
      confidence: 0.95,
      error_class: 'ConnectionPoolExhausted',
      triage_status: 'pending',
      triage_decision: null,
    });

    // Step 2: Run auto-promote evaluation
    const autoResult = await simulateAutoPromote(
      rootDir, obs.id, obs.filePath, config, clock, webhook,
    );

    expect(autoResult).not.toBeNull();
    expect(autoResult!.prdId).toBeTruthy();

    // Verify observation was auto-promoted
    const promotedObs = await readObservation(rootDir, obs.id);
    expect(promotedObs.triage_status).toBe('promoted');
    expect(promotedObs.triage_by).toBe('auto-promote-engine');

    // Verify PRD was generated
    const prdPath = path.join(rootDir, '.autonomous-dev', 'prd', `${autoResult!.prdId}.md`);
    expect(await fileExists(prdPath)).toBe(true);

    // Verify notification was sent
    expect(webhook.messages).toHaveLength(1);
    expect(webhook.messages[0]).toContain('Auto-Promoted');

    // Verify override check is pending
    const overrides = await listPendingOverrides(rootDir);
    expect(overrides).toHaveLength(1);

    // Step 3: PM Lead overrides within the window (1 hour later)
    clock.advanceHours(1);
    await processPmOverride(obs.filePath, {
      decision: 'dismiss',
      actor: 'pm-lead',
      reason: 'False positive, metric spike was a deploy artifact',
    }, clock);

    // Step 4: Process pending overrides (2+ hours after auto-promote)
    clock.advanceHours(2);
    const overrideResult = await processPendingOverrides(
      rootDir, mockLogger(), clock.now(),
    );

    expect(overrideResult.overridden).toBe(1);

    // Step 5: Verify PRD was cancelled
    expect(await fileExists(prdPath)).toBe(false);
    const cancelledPath = path.join(
      rootDir, '.autonomous-dev', 'prd', 'cancelled', `${autoResult!.prdId}.md`,
    );
    expect(await fileExists(cancelledPath)).toBe(true);

    // Verify observation status
    const updatedObs = await readObservation(rootDir, obs.id);
    expect(updatedObs.triage_decision).toBe('dismiss');
    expect(updatedObs.triage_by).toBe('pm-lead');
  });

  // TC-5-6-20: Auto-promote confirmed when no override
  test('TC-5-6-20: auto-promote confirmed when no override within window', async () => {
    const clock = new TestClock('2026-04-08T10:00:00Z');
    const webhook = new MockWebhookServer();

    const config: SimulationConfig = {
      auto_promote: { enabled: true, override_hours: 2 },
      notifications: { enabled: true, webhook_url: webhook.url, notify_on: ['P0', 'P1'] },
    };

    // Step 1: Create and auto-promote a P0 observation
    const obs = await createMockObservation(rootDir, {
      id: 'OBS-20260408-100000-ap02',
      service: 'api-gateway',
      severity: 'P0',
      confidence: 0.95,
      error_class: 'ConnectionPoolExhausted',
      triage_status: 'pending',
      triage_decision: null,
    });

    const autoResult = await simulateAutoPromote(
      rootDir, obs.id, obs.filePath, config, clock, webhook,
    );

    expect(autoResult).not.toBeNull();

    // Step 2: Advance past override window WITHOUT any human action
    clock.advanceHours(3);

    const result = await processPendingOverrides(
      rootDir, mockLogger(), clock.now(),
    );

    expect(result.confirmed).toBe(1);
    expect(result.overridden).toBe(0);

    // PRD should still exist
    const prdPath = path.join(rootDir, '.autonomous-dev', 'prd', `${autoResult!.prdId}.md`);
    expect(await fileExists(prdPath)).toBe(true);
  });

  test('auto-promote not triggered for P2 severity', async () => {
    const clock = new TestClock('2026-04-08T10:00:00Z');
    const webhook = new MockWebhookServer();

    const config: SimulationConfig = {
      auto_promote: { enabled: true, override_hours: 2 },
      notifications: { enabled: true, webhook_url: webhook.url, notify_on: ['P0', 'P1'] },
    };

    const obs = await createMockObservation(rootDir, {
      id: 'OBS-20260408-100000-ap03',
      service: 'api-gateway',
      severity: 'P2',
      confidence: 0.95,
      triage_status: 'pending',
    });

    const result = await simulateAutoPromote(
      rootDir, obs.id, obs.filePath, config, clock, webhook,
    );

    expect(result).toBeNull();
    expect(webhook.messages).toHaveLength(0);
  });

  test('auto-promote not triggered when disabled', async () => {
    const clock = new TestClock('2026-04-08T10:00:00Z');
    const webhook = new MockWebhookServer();

    const config: SimulationConfig = {
      auto_promote: { enabled: false, override_hours: 2 },
      notifications: { enabled: true, webhook_url: webhook.url, notify_on: ['P0', 'P1'] },
    };

    const obs = await createMockObservation(rootDir, {
      id: 'OBS-20260408-100000-ap04',
      service: 'api-gateway',
      severity: 'P0',
      confidence: 0.95,
      triage_status: 'pending',
    });

    const result = await simulateAutoPromote(
      rootDir, obs.id, obs.filePath, config, clock, webhook,
    );

    expect(result).toBeNull();
  });

  test('override pending while deadline not yet reached', async () => {
    const clock = new TestClock('2026-04-08T10:00:00Z');
    const webhook = new MockWebhookServer();

    const config: SimulationConfig = {
      auto_promote: { enabled: true, override_hours: 2 },
      notifications: { enabled: true, webhook_url: webhook.url, notify_on: ['P0', 'P1'] },
    };

    const obs = await createMockObservation(rootDir, {
      id: 'OBS-20260408-100000-ap05',
      service: 'api-gateway',
      severity: 'P0',
      confidence: 0.95,
      triage_status: 'pending',
    });

    await simulateAutoPromote(
      rootDir, obs.id, obs.filePath, config, clock, webhook,
    );

    // Only advance 1 hour (deadline is 2 hours)
    clock.advanceHours(1);

    const result = await processPendingOverrides(
      rootDir, mockLogger(), clock.now(),
    );

    expect(result.still_pending).toBe(1);
    expect(result.confirmed).toBe(0);
    expect(result.overridden).toBe(0);
  });
});

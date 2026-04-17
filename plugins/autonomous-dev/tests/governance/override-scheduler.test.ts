/**
 * Override window and cancellation tests (SPEC-007-5-6).
 *
 * Tests the override mechanism for auto-promoted observations:
 *   TC-5-6-13: Override within window cancels PRD
 *   TC-5-6-14: No override confirms PRD
 *   TC-5-6-15 (partial): Override check still pending if deadline not reached
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  setupTestDir,
  createMockObservation,
  fileExists,
} from '../helpers/mock-observations';
import {
  scheduleMockOverride,
  listPendingOverrides,
  mockLogger,
} from '../helpers/mock-deployments';

// ---------------------------------------------------------------------------
// Override processor implementation
// ---------------------------------------------------------------------------

interface OverrideResult {
  overridden: number;
  confirmed: number;
  still_pending: number;
}

/**
 * Process pending overrides: check if the triage decision was changed
 * within the override window.
 *
 * For each pending override file:
 *   - If deadline has not passed -> skip (still_pending)
 *   - If the observation's triage_decision was changed (e.g., to 'dismiss')
 *     -> move the PRD to cancelled/ (overridden)
 *   - If triage_decision is still 'promote' / triage_by is still 'auto-promote-engine'
 *     -> confirm the PRD (confirmed)
 */
async function processPendingOverrides(
  rootDir: string,
  logger: ReturnType<typeof mockLogger>,
  now?: Date,
): Promise<OverrideResult> {
  const currentTime = now ?? new Date();
  const overrideDir = path.join(rootDir, '.autonomous-dev', 'overrides');
  const result: OverrideResult = { overridden: 0, confirmed: 0, still_pending: 0 };

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

    // Not yet past deadline
    if (currentTime < deadline) {
      result.still_pending++;
      continue;
    }

    // Past deadline -- check observation triage status
    const observation = await findObservationById(rootDir, override.observation_id);
    if (!observation) {
      logger.warn(`Override: observation ${override.observation_id} not found`);
      result.still_pending++;
      continue;
    }

    const prdId = override.prd_id;
    const prdPath = path.join(rootDir, '.autonomous-dev', 'prd', `${prdId}.md`);
    const cancelledPath = path.join(rootDir, '.autonomous-dev', 'prd', 'cancelled', `${prdId}.md`);

    // Was triage overridden by a human?
    if (
      observation.triage_decision !== 'promote' ||
      (observation.triage_by && observation.triage_by !== 'auto-promote-engine')
    ) {
      // Override: move PRD to cancelled
      try {
        const prdContent = await fs.readFile(prdPath, 'utf-8');
        await fs.mkdir(path.dirname(cancelledPath), { recursive: true });
        await fs.writeFile(cancelledPath, prdContent, 'utf-8');
        await fs.unlink(prdPath);
        logger.info(`Override: PRD ${prdId} cancelled (triage changed by ${observation.triage_by})`);
      } catch (err) {
        logger.warn(`Override: failed to cancel PRD ${prdId}: ${err}`);
      }

      // Update override status
      override.status = 'overridden';
      await fs.writeFile(filePath, JSON.stringify(override, null, 2), 'utf-8');
      result.overridden++;
    } else {
      // No override: confirm PRD
      override.status = 'confirmed';
      await fs.writeFile(filePath, JSON.stringify(override, null, 2), 'utf-8');
      logger.info(`Override: PRD ${prdId} confirmed (no override within window)`);
      result.confirmed++;
    }
  }

  return result;
}

/**
 * Find an observation file by ID across all year/month directories.
 */
async function findObservationById(
  rootDir: string,
  observationId: string,
): Promise<Record<string, any> | null> {
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
        const fm = parseFrontmatter(content);
        if (fm && fm.id === observationId) return fm;
      }
    }
    return null;
  };

  return walkDir(obsDir);
}

function parseFrontmatter(content: string): Record<string, any> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const result: Record<string, any> = {};
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('  ')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.substring(0, colonIdx).trim();
    let value: any = trimmed.substring(colonIdx + 1).trim();
    if (value === 'null' || value === '~' || value === '') value = null;
    else if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if ((value.startsWith('"') && value.endsWith('"')) ||
             (value.startsWith("'") && value.endsWith("'"))) {
      value = value.substring(1, value.length - 1);
    }
    result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processPendingOverrides', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await setupTestDir();
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  // TC-5-6-13: Override within window cancels PRD
  test('TC-5-6-13: override within window cancels PRD', async () => {
    // Setup: auto-promoted observation, PM Lead changed triage to dismiss
    const obs = await createMockObservation(rootDir, {
      id: 'OBS-20260408-143000-ov01',
      triage_status: 'dismissed',
      triage_decision: 'dismiss',
      triage_by: 'pm-lead',
    });

    // Create the PRD file
    const prdId = 'PRD-OBS-001';
    const prdDir = path.join(rootDir, '.autonomous-dev', 'prd');
    await fs.mkdir(prdDir, { recursive: true });
    await fs.writeFile(
      path.join(prdDir, `${prdId}.md`),
      '# PRD: Fix ConnectionPoolExhausted\n\nMock PRD content.\n',
      'utf-8',
    );

    // Schedule override with a deadline that has already passed
    await scheduleMockOverride(
      rootDir,
      obs.id,
      prdId,
      new Date('2026-04-08T14:30:00Z'),
    );

    const result = await processPendingOverrides(rootDir, mockLogger());

    expect(result.overridden).toBe(1);
    // PRD should be in cancelled/ directory
    expect(
      await fileExists(path.join(rootDir, '.autonomous-dev', 'prd', 'cancelled', `${prdId}.md`)),
    ).toBe(true);
    expect(
      await fileExists(path.join(rootDir, '.autonomous-dev', 'prd', `${prdId}.md`)),
    ).toBe(false);
  });

  // TC-5-6-14: No override within window confirms PRD
  test('TC-5-6-14: no override within window confirms PRD', async () => {
    // Setup: auto-promoted observation, nobody changed triage
    const obs = await createMockObservation(rootDir, {
      id: 'OBS-20260408-143000-ov02',
      triage_status: 'promoted',
      triage_decision: 'promote',
      triage_by: 'auto-promote-engine',
    });

    // Create the PRD file
    const prdId = 'PRD-OBS-002';
    const prdDir = path.join(rootDir, '.autonomous-dev', 'prd');
    await fs.writeFile(
      path.join(prdDir, `${prdId}.md`),
      '# PRD: Fix ConnectionPoolExhausted\n\nMock PRD content.\n',
      'utf-8',
    );

    await scheduleMockOverride(
      rootDir,
      obs.id,
      prdId,
      new Date('2026-04-08T14:30:00Z'),
    );

    const result = await processPendingOverrides(rootDir, mockLogger());

    expect(result.confirmed).toBe(1);
    // PRD should still be in place
    expect(
      await fileExists(path.join(rootDir, '.autonomous-dev', 'prd', `${prdId}.md`)),
    ).toBe(true);
  });

  // Override check still pending if deadline not reached
  test('override check still pending if deadline not reached', async () => {
    await scheduleMockOverride(
      rootDir,
      'OBS-test',
      'PRD-OBS-003',
      new Date('2026-04-09T14:30:00Z'), // future deadline
    );

    const result = await processPendingOverrides(
      rootDir,
      mockLogger(),
      new Date('2026-04-08T14:30:00Z'),
    );

    expect(result.still_pending).toBe(1);
  });

  // Multiple overrides processed correctly
  test('processes multiple overrides in one run', async () => {
    // Override 1: overridden
    const obs1 = await createMockObservation(rootDir, {
      id: 'OBS-20260408-143000-ov04',
      triage_decision: 'dismiss',
      triage_by: 'pm-lead',
    });
    const prdDir = path.join(rootDir, '.autonomous-dev', 'prd');
    await fs.writeFile(path.join(prdDir, 'PRD-OBS-004.md'), 'PRD 4\n', 'utf-8');
    await scheduleMockOverride(rootDir, obs1.id, 'PRD-OBS-004', new Date('2026-04-08T10:00:00Z'));

    // Override 2: confirmed
    const obs2 = await createMockObservation(rootDir, {
      id: 'OBS-20260408-143000-ov05',
      triage_decision: 'promote',
      triage_by: 'auto-promote-engine',
    });
    await fs.writeFile(path.join(prdDir, 'PRD-OBS-005.md'), 'PRD 5\n', 'utf-8');
    await scheduleMockOverride(rootDir, obs2.id, 'PRD-OBS-005', new Date('2026-04-08T10:00:00Z'));

    // Override 3: pending (future deadline)
    await scheduleMockOverride(rootDir, 'OBS-future', 'PRD-OBS-006', new Date('2026-04-10T00:00:00Z'));

    const result = await processPendingOverrides(
      rootDir,
      mockLogger(),
      new Date('2026-04-08T14:30:00Z'),
    );

    expect(result.overridden).toBe(1);
    expect(result.confirmed).toBe(1);
    expect(result.still_pending).toBe(1);
  });
});

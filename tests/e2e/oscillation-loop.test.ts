/**
 * E2E test: oscillation detection over multiple runs (SPEC-007-5-6).
 *
 * TC-5-6-18: 3 recurring errors in 30 days -> oscillation warning on third
 *
 * Simulates three observation cycles spaced 10 days apart with a
 * persistent error that is never fixed. Verifies that the third
 * observation triggers an oscillation warning.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { TestClock } from '../helpers/test-clock';
import { MockPrometheusClient, MockOpenSearchClient } from '../helpers/mock-mcp';
import {
  setupTestDir,
  createMockObservation,
  listObservations,
} from '../helpers/mock-observations';
import { checkOscillation, buildOscillationWarningMarkdown } from '../../src/governance/oscillation';
import type { GovernanceConfig, ObservationSummary } from '../../src/governance/types';

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
 * Run a single observation cycle: create an observation and check oscillation.
 * Returns whether oscillation was detected and the observation file path.
 */
async function runObservationCycle(
  rootDir: string,
  service: string,
  errorClass: string,
  clock: TestClock,
  config: GovernanceConfig,
): Promise<{ oscillationDetected: boolean; observationId: string; filePath: string }> {
  const ts = clock.now().toISOString();
  const datePart = ts.slice(0, 10).replace(/-/g, '');
  const timePart = ts.slice(11, 19).replace(/:/g, '');
  const id = `OBS-${datePart}-${timePart}-osc1`;

  // Check oscillation BEFORE creating the new observation
  // (the new observation is the "current" one)
  const existingObservations = await findObservationsForOscillation(
    rootDir, service, errorClass, config, clock,
  );

  // Create the new observation
  const obs = await createMockObservation(rootDir, {
    id,
    service,
    severity: 'P2',
    confidence: 0.87,
    timestamp: ts,
    error_class: errorClass,
    fingerprint: `${errorClass}-fingerprint`,
    triage_status: 'pending',
    triage_decision: null,
  });

  // Include the new observation in the count
  const allObservations = [
    ...existingObservations,
    { id, triage_status: 'pending', effectiveness: null, is_current: true },
  ];

  const oscillationDetected = allObservations.length >= config.oscillation_threshold;

  // If oscillation detected, append warning to the observation file
  if (oscillationDetected) {
    const oscillationResult = {
      oscillating: true,
      count: allObservations.length,
      window_days: config.oscillation_window_days,
      observation_ids: allObservations.map(o => o.id),
      observation_summaries: allObservations,
      recommendation: 'systemic_investigation' as const,
    };

    const warningMd = buildOscillationWarningMarkdown(oscillationResult);
    const content = await fs.readFile(obs.filePath, 'utf-8');

    // Update frontmatter
    const updatedContent = content
      .replace('oscillation_warning: false', 'oscillation_warning: true');

    // Append oscillation warning to the body
    await fs.writeFile(obs.filePath, updatedContent + '\n' + warningMd + '\n', 'utf-8');
  }

  return { oscillationDetected, observationId: id, filePath: obs.filePath };
}

/**
 * Find existing observations for oscillation checking.
 */
async function findObservationsForOscillation(
  rootDir: string,
  service: string,
  errorClass: string,
  config: GovernanceConfig,
  clock: TestClock,
): Promise<ObservationSummary[]> {
  const windowStart = new Date(clock.now());
  windowStart.setDate(windowStart.getDate() - config.oscillation_window_days);

  const obsDir = path.join(rootDir, '.autonomous-dev', 'observations');
  const summaries: ObservationSummary[] = [];

  const walkDir = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath);
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
          fm[key] = val;
        }

        if (
          fm.service === service &&
          (fm.error_class === errorClass || (fm.fingerprint && fm.fingerprint.startsWith(errorClass))) &&
          fm.timestamp &&
          new Date(fm.timestamp) >= windowStart
        ) {
          summaries.push({
            id: fm.id,
            triage_status: fm.triage_status ?? 'pending',
            effectiveness: fm.effectiveness ?? null,
            is_current: false,
          });
        }
      }
    }
  };

  await walkDir(obsDir);
  return summaries.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E: oscillation detection over multiple runs', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await setupTestDir();
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  // TC-5-6-18: 3 observations trigger oscillation warning
  test('TC-5-6-18: 3 observations within 30 days trigger oscillation warning', async () => {
    const clock = new TestClock('2026-03-10T10:00:00Z');
    const config = defaultGovernanceConfig();

    // Run 1: first observation -- no oscillation
    const run1 = await runObservationCycle(
      rootDir, 'api-gateway', 'ConnPool', clock, config,
    );
    expect(run1.oscillationDetected).toBe(false);

    const obs1 = await listObservations(rootDir);
    expect(obs1).toHaveLength(1);
    expect(obs1[0].oscillation_warning).toBe(false);

    // Advance 10 days
    clock.advanceDays(10);

    // Run 2: second observation -- still no oscillation (2 < 3)
    const run2 = await runObservationCycle(
      rootDir, 'api-gateway', 'ConnPool', clock, config,
    );
    expect(run2.oscillationDetected).toBe(false);

    const obs2 = await listObservations(rootDir);
    expect(obs2).toHaveLength(2);
    expect(obs2[1].oscillation_warning).toBe(false);

    // Advance 10 days
    clock.advanceDays(10);

    // Run 3: third observation -- OSCILLATION DETECTED (3 >= 3)
    const run3 = await runObservationCycle(
      rootDir, 'api-gateway', 'ConnPool', clock, config,
    );
    expect(run3.oscillationDetected).toBe(true);

    const obs3 = await listObservations(rootDir);
    expect(obs3).toHaveLength(3);
    expect(obs3[2].oscillation_warning).toBe(true);

    // Verify the Markdown contains the oscillation warning
    const content = await fs.readFile(obs3[2].filePath, 'utf-8');
    expect(content).toContain('## Oscillation Warning');
    expect(content).toContain('3 observations in the last 30 days');
    expect(content).toContain('architectural investigation PRD');
  });

  test('no oscillation when observations are outside the 30-day window', async () => {
    const clock = new TestClock('2026-01-01T10:00:00Z');
    const config = defaultGovernanceConfig();

    // Create 2 observations 40+ days apart (outside window)
    await runObservationCycle(rootDir, 'api-gateway', 'OldError', clock, config);

    clock.advanceDays(35);
    await runObservationCycle(rootDir, 'api-gateway', 'OldError', clock, config);

    clock.advanceDays(35);
    const run3 = await runObservationCycle(rootDir, 'api-gateway', 'OldError', clock, config);

    // Each observation is more than 30 days apart from the others
    // So only the most recent 1-2 should be within the window
    // With 35-day gaps, at most 1 prior observation is within 30 days
    expect(run3.oscillationDetected).toBe(false);
  });

  test('oscillation is per service+error class', async () => {
    const clock = new TestClock('2026-03-10T10:00:00Z');
    const config = defaultGovernanceConfig();

    // 3 observations for service A, error class X
    await runObservationCycle(rootDir, 'svc-a', 'ErrorX', clock, config);
    clock.advanceDays(5);
    await runObservationCycle(rootDir, 'svc-a', 'ErrorX', clock, config);
    clock.advanceDays(5);
    const run3 = await runObservationCycle(rootDir, 'svc-a', 'ErrorX', clock, config);
    expect(run3.oscillationDetected).toBe(true);

    // 1 observation for service B, error class X -- should NOT oscillate
    clock.advanceDays(1);
    const runB = await runObservationCycle(rootDir, 'svc-b', 'ErrorX', clock, config);
    expect(runB.oscillationDetected).toBe(false);

    // 1 observation for service A, error class Y -- should NOT oscillate
    clock.advanceDays(1);
    const runY = await runObservationCycle(rootDir, 'svc-a', 'ErrorY', clock, config);
    expect(runY.oscillationDetected).toBe(false);
  });
});

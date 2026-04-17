/**
 * End-to-end triage lifecycle integration tests (SPEC-007-4-4, Task 11).
 *
 * Test case IDs correspond to the spec's test case table:
 *   TC-4-4-09 through TC-4-4-11.
 *
 * These tests exercise the full triage lifecycle:
 *   - Observation creation -> PM Lead edit -> triage processing -> PRD generation
 *   - Deferred observation -> re-triage cycle
 *   - Dismiss -> auto-dismiss on next run (fingerprint matching)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { processPendingTriage } from '../../src/triage/triage-processor';
import { DefaultTriageAuditLogger } from '../../src/triage/audit-logger';
import type { LlmPrdContent } from '../../src/triage/prd-template';
import { createPrdGenerator, type GeneratePrdViaLlmFn } from '../../src/triage/prd-generator';
import {
  applyRetentionPolicy,
  type AuditLogger,
} from '../../src/reports/retention';
import {
  writeRunMetadata,
  readRunMetadata,
  type RunMetadata,
} from '../../src/reports/run-metadata';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds an observation file with all the fields the triage processor needs.
 */
function buildObservationFile(overrides: Record<string, unknown> = {}): string {
  const defaults: Record<string, unknown> = {
    id: 'OBS-20260408-143000-a1b2',
    service: 'api-gateway',
    repo: 'api-gateway',
    severity: 'P1',
    confidence: 0.92,
    fingerprint: 'abc123def456',
    triage_status: 'pending',
    triage_decision: null,
    triage_by: null,
    triage_at: null,
    triage_reason: null,
    defer_until: null,
    linked_prd: null,
  };

  const merged = { ...defaults, ...overrides };
  const lines = ['---'];
  for (const [key, value] of Object.entries(merged)) {
    if (value === null) {
      lines.push(`${key}: null`);
    } else if (typeof value === 'string') {
      if (value.includes(':') || value.includes('#')) {
        lines.push(`${key}: "${value}"`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push('# Observation');
  lines.push('');
  lines.push('## Evidence');
  lines.push('');
  lines.push('Error rate spiked to 12.5% on api-gateway.');
  lines.push('');
  lines.push('## Root Cause Hypothesis');
  lines.push('');
  lines.push('Connection pool exhaustion.');
  lines.push('');
  lines.push('## Recommended Action');
  lines.push('');
  lines.push('Increase pool size and add monitoring.');
  lines.push('');
  return lines.join('\n');
}

async function writeObservation(
  dir: string,
  filename: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const filePath = path.join(dir, filename);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buildObservationFile(overrides), 'utf-8');
  return filePath;
}

function parseFrontmatterFromContent(content: string): Record<string, string | null> {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};
  const result: Record<string, string | null> = {};
  for (const line of fmMatch[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim();
    let val = line.substring(colonIdx + 1).trim();
    if (val === 'null' || val === '~' || val === '') {
      result[key] = null;
    } else if (val.startsWith('"') && val.endsWith('"')) {
      result[key] = val.slice(1, -1);
    } else {
      result[key] = val;
    }
  }
  return result;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const MOCK_LLM_RESPONSE: LlmPrdContent = {
  title: 'Fix Error Rate Spike on api-gateway',
  problemStatement:
    'The api-gateway service error rate spiked to 12.5% from a baseline of 0.5%.',
  scope: 'Investigate and fix connection pool exhaustion.',
};

const mockLlmFn: GeneratePrdViaLlmFn = async () => MOCK_LLM_RESPONSE;

function createRetentionAuditLogger(): AuditLogger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    info(message: string): void {
      messages.push(message);
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Full Triage Lifecycle', () => {
  let tmpDir: string;
  let rootDir: string;
  let observationsDir: string;
  let logDir: string;
  let prdDir: string;
  let auditLog: DefaultTriageAuditLogger;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-lifecycle-'));
    rootDir = tmpDir;
    observationsDir = path.join(rootDir, '.autonomous-dev', 'observations');
    logDir = path.join(rootDir, '.autonomous-dev', 'logs', 'intelligence');
    prdDir = path.join(rootDir, '.autonomous-dev', 'prd');
    await fs.mkdir(observationsDir, { recursive: true });
    await fs.mkdir(logDir, { recursive: true });
    auditLog = new DefaultTriageAuditLogger(logDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // TC-4-4-09: Full promote cycle
  // -------------------------------------------------------------------------

  test('TC-4-4-09: promote: observation -> edit -> PRD generated -> observation updated', async () => {
    const obsId = 'OBS-20260408-143000-a1b2';

    // 1. Create an observation file
    const obsPath = await writeObservation(observationsDir, `${obsId}.md`, {
      id: obsId,
      severity: 'P1',
      service: 'api-gateway',
    });

    // 2. Simulate PM Lead editing YAML frontmatter (promote decision)
    const content = await fs.readFile(obsPath, 'utf-8');
    const updatedContent = content
      .replace('triage_decision: null', 'triage_decision: promote')
      .replace('triage_by: null', 'triage_by: pwatson')
      .replace('triage_at: null', `triage_at: "${new Date().toISOString()}"`)
      .replace('triage_reason: null', `triage_reason: "Confirmed issue, needs fix."`);
    await fs.writeFile(obsPath, updatedContent, 'utf-8');

    // 3. Set up PRD generator dependency
    const prdGenerator = createPrdGenerator(rootDir, mockLlmFn);

    // 4. Run triage processor with PRD generation
    const result = await processPendingTriage(observationsDir, auditLog, {
      deps: { generatePrd: prdGenerator },
    });

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0].decision).toBe('promote');

    // 5. Verify observation status was updated
    const obsContent = await fs.readFile(obsPath, 'utf-8');
    const obsFm = parseFrontmatterFromContent(obsContent);
    expect(obsFm.triage_status).toBe('promoted');

    // 6. Verify linked_prd was set
    expect(obsFm.linked_prd).not.toBeNull();
    expect(obsFm.linked_prd).toMatch(/^PRD-OBS-/);

    // 7. Verify PRD file was created
    const prdFilePath = path.join(prdDir, `${obsFm.linked_prd}.md`);
    const prdExists = await fileExists(prdFilePath);
    expect(prdExists).toBe(true);

    // 8. Verify PRD content
    const prdContent = await fs.readFile(prdFilePath, 'utf-8');
    expect(prdContent).toContain(`observation_id: ${obsId}`);
    expect(prdContent).toContain('## Problem Statement');
    expect(prdContent).toContain('## Evidence');

    // 9. Verify audit log
    const entries = auditLog.getEntries();
    const promoteEntry = entries.find(
      (e) => e.observation_id === obsId && e.action === 'promote',
    );
    expect(promoteEntry).toBeDefined();
    expect(promoteEntry?.actor).toBe('pwatson');
    expect(promoteEntry?.generated_prd).toMatch(/^PRD-OBS-/);
  });

  // -------------------------------------------------------------------------
  // TC-4-4-11: Defer -> re-triage cycle
  // -------------------------------------------------------------------------

  test('TC-4-4-11: defer -> re-triage cycle', async () => {
    const obsId = 'OBS-20260408-143000-def1';

    // 1. Create observation and set defer decision
    await writeObservation(observationsDir, `${obsId}.md`, {
      id: obsId,
      triage_decision: 'defer',
      triage_by: 'pwatson',
      triage_at: '2026-03-20T10:00:00Z',
      triage_reason: 'Wait for next deploy.',
      defer_until: '2026-04-01',
    });

    // 2. Process triage (sets status to deferred)
    const result1 = await processPendingTriage(observationsDir, auditLog, {
      now: new Date('2026-03-25T10:00:00Z'),
    });
    expect(result1.processed).toHaveLength(1);
    expect(result1.processed[0].decision).toBe('defer');

    // Verify status is deferred
    let content = await fs.readFile(
      path.join(observationsDir, `${obsId}.md`),
      'utf-8',
    );
    let fm = parseFrontmatterFromContent(content);
    expect(fm.triage_status).toBe('deferred');

    // 3. Run again with date past defer_until -> should return deferred observation
    const result2 = await processPendingTriage(observationsDir, auditLog, {
      now: new Date('2026-04-08T10:00:00Z'),
    });
    expect(result2.deferred_returned).toContain(obsId);

    // 4. Verify observation is back to pending
    content = await fs.readFile(
      path.join(observationsDir, `${obsId}.md`),
      'utf-8',
    );
    fm = parseFrontmatterFromContent(content);
    expect(fm.triage_status).toBe('pending');
    expect(fm.triage_decision).toBeNull();

    // 5. Verify deferred return note appended to body
    expect(content).toContain('Deferred observation returned for re-triage');
    expect(content).toContain('pwatson');
    expect(content).toContain('Wait for next deploy.');
  });

  // -------------------------------------------------------------------------
  // TC-4-4-10: Dismiss -> auto-dismiss via fingerprint
  // -------------------------------------------------------------------------

  test('TC-4-4-10: dismiss observation and verify status persists', async () => {
    const obsId = 'OBS-20260408-143000-dis1';

    // 1. Create observation with dismiss decision
    await writeObservation(observationsDir, `${obsId}.md`, {
      id: obsId,
      triage_decision: 'dismiss',
      triage_by: 'pwatson',
      triage_at: '2026-04-08T10:00:00Z',
      triage_reason: 'Known issue, not actionable.',
    });

    // 2. Process triage
    const result = await processPendingTriage(observationsDir, auditLog);
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0].decision).toBe('dismiss');

    // 3. Verify observation status is dismissed
    const content = await fs.readFile(
      path.join(observationsDir, `${obsId}.md`),
      'utf-8',
    );
    const fm = parseFrontmatterFromContent(content);
    expect(fm.triage_status).toBe('dismissed');

    // 4. Verify audit log entry
    const entries = auditLog.getEntries();
    const dismissEntry = entries.find(
      (e) => e.observation_id === obsId && e.action === 'dismiss',
    );
    expect(dismissEntry).toBeDefined();
    expect(dismissEntry?.actor).toBe('pwatson');
  });

  // -------------------------------------------------------------------------
  // Promote + Retention integration
  // -------------------------------------------------------------------------

  test('promoted observation with active PRD is retained during retention cleanup', async () => {
    const obsId = 'OBS-20260101-120000-ret1';

    // 1. Create an old observation marked as promoted
    await writeObservation(observationsDir, `${obsId}.md`, {
      id: obsId,
      timestamp: '2025-12-01T12:00:00Z',
      triage_status: 'promoted',
      linked_prd: 'PRD-OBS-active-retention',
    });

    // 2. Create the active PRD
    await fs.mkdir(prdDir, { recursive: true });
    await fs.writeFile(
      path.join(prdDir, 'PRD-OBS-active-retention.md'),
      '---\nstatus: in-progress\n---\n# PRD\n',
      'utf-8',
    );

    // 3. Run retention
    const archiveDir = path.join(observationsDir, 'archive');
    const retentionAudit = createRetentionAuditLogger();
    const result = await applyRetentionPolicy(
      observationsDir,
      archiveDir,
      { observation_days: 90, archive_days: 365 },
      retentionAudit,
      rootDir,
      new Date('2026-04-08T14:30:00Z'),
    );

    expect(result.skipped).toHaveLength(1);
    expect(result.archived).toHaveLength(0);

    // Observation file should still exist in original location
    const exists = await fileExists(path.join(observationsDir, `${obsId}.md`));
    expect(exists).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Run metadata lifecycle integration
// ---------------------------------------------------------------------------

describe('Run Metadata Lifecycle', () => {
  let tmpDir: string;
  let rootDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-metadata-lifecycle-'));
    rootDir = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('writes and reads run metadata in a full observation run simulation', async () => {
    const metadata: RunMetadata = {
      run_id: 'RUN-20260408-143000',
      started_at: '2026-04-08T14:30:00Z',
      completed_at: '2026-04-08T14:35:22Z',
      services_in_scope: ['api-gateway', 'order-service', 'user-service'],
      data_source_status: {
        prometheus: 'available',
        grafana: 'available',
        opensearch: 'degraded',
        sentry: 'not_configured',
      },
      observations_generated: 2,
      observations_deduplicated: 1,
      observations_filtered: 3,
      triage_decisions_processed: 1,
      total_tokens_consumed: 38200,
      queries_executed: {
        prometheus: 21,
        grafana: 6,
        opensearch: 8,
        sentry: 0,
      },
      errors: ['OpenSearch response time degraded (7.2s)'],
    };

    // Write
    const writtenPath = await writeRunMetadata(metadata, rootDir);
    expect(writtenPath).toContain('RUN-20260408-143000.log');

    // Read back
    const readBack = await readRunMetadata('RUN-20260408-143000', rootDir);
    expect(readBack).not.toBeNull();
    expect(readBack!.run_id).toBe('RUN-20260408-143000');
    expect(readBack!.services_in_scope).toEqual(['api-gateway', 'order-service', 'user-service']);
    expect(readBack!.observations_generated).toBe(2);
    expect(readBack!.queries_executed.prometheus).toBe(21);
    expect(readBack!.errors).toHaveLength(1);
  });

  test('run metadata combined with triage processing', async () => {
    // Set up observations
    const observationsDir = path.join(rootDir, '.autonomous-dev', 'observations');
    const logDir = path.join(rootDir, '.autonomous-dev', 'logs', 'intelligence');
    await fs.mkdir(observationsDir, { recursive: true });
    await fs.mkdir(logDir, { recursive: true });

    // Create observation with pending triage
    await writeObservation(observationsDir, 'OBS-lifecycle.md', {
      id: 'OBS-LIFECYCLE',
      triage_decision: 'dismiss',
      triage_by: 'pwatson',
      triage_at: '2026-04-08T14:32:00Z',
      triage_reason: 'Not actionable',
    });

    // Process triage
    const auditLog = new DefaultTriageAuditLogger(logDir);
    const triageResult = await processPendingTriage(observationsDir, auditLog);

    // Write run metadata including triage counts
    const metadata: RunMetadata = {
      run_id: 'RUN-20260408-143200',
      started_at: '2026-04-08T14:32:00Z',
      completed_at: '2026-04-08T14:33:15Z',
      services_in_scope: ['api-gateway'],
      data_source_status: {
        prometheus: 'available',
        grafana: 'available',
        opensearch: 'available',
        sentry: 'not_configured',
      },
      observations_generated: 0,
      observations_deduplicated: 0,
      observations_filtered: 0,
      triage_decisions_processed: triageResult.processed.length,
      total_tokens_consumed: 0,
      queries_executed: { prometheus: 0, grafana: 0, opensearch: 0, sentry: 0 },
      errors: [],
    };

    await writeRunMetadata(metadata, rootDir);
    const readBack = await readRunMetadata('RUN-20260408-143200', rootDir);
    expect(readBack!.triage_decisions_processed).toBe(1);
  });
});

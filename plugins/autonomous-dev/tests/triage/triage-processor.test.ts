/**
 * Unit tests for the file-based triage processor (SPEC-007-4-2, Task 4).
 *
 * Test case IDs correspond to the spec's test case table:
 *   TC-4-2-01 through TC-4-2-16.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { processPendingTriage } from '../../src/triage/triage-processor';
import { DefaultTriageAuditLogger } from '../../src/triage/audit-logger';
import type { TriageAuditLogger, TriageAuditEntry } from '../../src/triage/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildObservationFile(overrides: Record<string, unknown> = {}): string {
  const defaults: Record<string, unknown> = {
    id: 'OBS-001',
    service: 'api-gateway',
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
      // Quote strings that contain special chars
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
  lines.push('# Observation OBS-001');
  lines.push('');
  lines.push('This is the observation body.');
  lines.push('');
  return lines.join('\n');
}

async function writeObservation(
  dir: string,
  filename: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const filePath = path.join(dir, filename);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, buildObservationFile(overrides), 'utf-8');
  return filePath;
}

async function readFileContent(filePath: string): Promise<string> {
  return fsp.readFile(filePath, 'utf-8');
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('processPendingTriage', () => {
  let tmpDir: string;
  let observationsDir: string;
  let logDir: string;
  let auditLog: DefaultTriageAuditLogger;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'triage-processor-test-'));
    observationsDir = path.join(tmpDir, 'observations');
    logDir = path.join(tmpDir, 'logs');
    await fsp.mkdir(observationsDir, { recursive: true });
    await fsp.mkdir(logDir, { recursive: true });
    auditLog = new DefaultTriageAuditLogger(logDir);
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // TC-4-2-01: Detect promote edit
  // -------------------------------------------------------------------------

  it('TC-4-2-01: detects promote edit and dispatches promote action', async () => {
    await writeObservation(observationsDir, 'obs-001.md', {
      triage_decision: 'promote',
      triage_status: 'pending',
      triage_by: 'pm-lead',
      triage_at: '2026-04-08T10:00:00Z',
      triage_reason: 'High impact issue',
    });

    const result = await processPendingTriage(observationsDir, auditLog);

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0].decision).toBe('promote');
    expect(result.processed[0].observation_id).toBe('OBS-001');
    expect(result.errors).toHaveLength(0);

    // Verify file was updated
    const content = await readFileContent(path.join(observationsDir, 'obs-001.md'));
    const fm = parseFrontmatterFromContent(content);
    expect(fm.triage_status).toBe('promoted');
  });

  // -------------------------------------------------------------------------
  // TC-4-2-02: Detect dismiss edit
  // -------------------------------------------------------------------------

  it('TC-4-2-02: detects dismiss edit and dispatches dismiss action', async () => {
    await writeObservation(observationsDir, 'obs-002.md', {
      id: 'OBS-002',
      triage_decision: 'dismiss',
      triage_status: 'pending',
      triage_by: 'pm-lead',
      triage_at: '2026-04-08T10:00:00Z',
      triage_reason: 'Known issue, not actionable',
    });

    const result = await processPendingTriage(observationsDir, auditLog);

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0].decision).toBe('dismiss');

    const content = await readFileContent(path.join(observationsDir, 'obs-002.md'));
    const fm = parseFrontmatterFromContent(content);
    expect(fm.triage_status).toBe('dismissed');
  });

  // -------------------------------------------------------------------------
  // TC-4-2-03: Detect defer edit
  // -------------------------------------------------------------------------

  it('TC-4-2-03: detects defer edit with defer_until and dispatches defer action', async () => {
    await writeObservation(observationsDir, 'obs-003.md', {
      id: 'OBS-003',
      triage_decision: 'defer',
      triage_status: 'pending',
      triage_by: 'pm-lead',
      triage_at: '2026-04-08T10:00:00Z',
      triage_reason: 'Revisit after release',
      defer_until: '2026-04-15',
    });

    const result = await processPendingTriage(observationsDir, auditLog);

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0].decision).toBe('defer');
    expect(result.processed[0].defer_until).toBe('2026-04-15');

    const content = await readFileContent(path.join(observationsDir, 'obs-003.md'));
    const fm = parseFrontmatterFromContent(content);
    expect(fm.triage_status).toBe('deferred');
  });

  // -------------------------------------------------------------------------
  // TC-4-2-04: Detect investigate edit
  // -------------------------------------------------------------------------

  it('TC-4-2-04: detects investigate edit and dispatches investigate action', async () => {
    await writeObservation(observationsDir, 'obs-004.md', {
      id: 'OBS-004',
      triage_decision: 'investigate',
      triage_status: 'pending',
      triage_by: 'pm-lead',
      triage_at: '2026-04-08T10:00:00Z',
      triage_reason: 'Need more data',
    });

    const result = await processPendingTriage(observationsDir, auditLog);

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0].decision).toBe('investigate');

    const content = await readFileContent(path.join(observationsDir, 'obs-004.md'));
    const fm = parseFrontmatterFromContent(content);
    expect(fm.triage_status).toBe('investigating');
  });

  // -------------------------------------------------------------------------
  // TC-4-2-05: Invalid decision rejected
  // -------------------------------------------------------------------------

  it('TC-4-2-05: rejects invalid triage_decision with error', async () => {
    await writeObservation(observationsDir, 'obs-005.md', {
      id: 'OBS-005',
      triage_decision: 'delete',
      triage_status: 'pending',
      triage_by: 'pm-lead',
      triage_at: '2026-04-08T10:00:00Z',
    });

    const result = await processPendingTriage(observationsDir, auditLog);

    expect(result.processed).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('Invalid triage_decision');
    expect(result.errors[0].error).toContain('"delete"');

    // File should be unchanged
    const content = await readFileContent(path.join(observationsDir, 'obs-005.md'));
    const fm = parseFrontmatterFromContent(content);
    expect(fm.triage_status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // TC-4-2-06: Missing triage_by rejected
  // -------------------------------------------------------------------------

  it('TC-4-2-06: rejects when triage_by is missing', async () => {
    await writeObservation(observationsDir, 'obs-006.md', {
      id: 'OBS-006',
      triage_decision: 'promote',
      triage_status: 'pending',
      triage_by: null,
      triage_at: '2026-04-08T10:00:00Z',
    });

    const result = await processPendingTriage(observationsDir, auditLog);

    expect(result.processed).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('triage_by is required');
  });

  // -------------------------------------------------------------------------
  // TC-4-2-07: Missing defer_until rejected
  // -------------------------------------------------------------------------

  it('TC-4-2-07: rejects defer without defer_until', async () => {
    await writeObservation(observationsDir, 'obs-007.md', {
      id: 'OBS-007',
      triage_decision: 'defer',
      triage_status: 'pending',
      triage_by: 'pm-lead',
      triage_at: '2026-04-08T10:00:00Z',
      defer_until: null,
    });

    const result = await processPendingTriage(observationsDir, auditLog);

    expect(result.processed).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('defer_until is required');
  });

  // -------------------------------------------------------------------------
  // TC-4-2-08: Already processed skipped
  // -------------------------------------------------------------------------

  it('TC-4-2-08: skips observations where triage_status already matches decision', async () => {
    await writeObservation(observationsDir, 'obs-008.md', {
      id: 'OBS-008',
      triage_decision: 'promote',
      triage_status: 'promoted',
      triage_by: 'pm-lead',
      triage_at: '2026-04-08T10:00:00Z',
    });

    const result = await processPendingTriage(observationsDir, auditLog);

    // Should be skipped -- status is not 'pending'
    expect(result.processed).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // TC-4-2-11: Defer excludes from pending triage queue
  // -------------------------------------------------------------------------

  it('TC-4-2-11: deferred observation is excluded from pending triage scans', async () => {
    await writeObservation(observationsDir, 'obs-011.md', {
      id: 'OBS-011',
      triage_decision: null,
      triage_status: 'deferred',
      triage_by: 'pm-lead',
      triage_at: '2026-04-01T10:00:00Z',
      defer_until: '2026-04-15',
    });

    // Run with current date before defer_until
    const result = await processPendingTriage(observationsDir, auditLog, {
      now: new Date('2026-04-08T10:00:00Z'),
    });

    // Should NOT process and NOT return (still deferred)
    expect(result.processed).toHaveLength(0);
    expect(result.deferred_returned).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // TC-4-2-13: Deferred return: past date
  // -------------------------------------------------------------------------

  it('TC-4-2-13: returns deferred observation when defer_until has passed', async () => {
    await writeObservation(observationsDir, 'obs-013.md', {
      id: 'OBS-013',
      triage_decision: null,
      triage_status: 'deferred',
      triage_by: 'pm-lead',
      triage_at: '2026-03-25T10:00:00Z',
      triage_reason: 'Revisit in April',
      defer_until: '2026-04-01',
    });

    const result = await processPendingTriage(observationsDir, auditLog, {
      now: new Date('2026-04-08T10:00:00Z'),
    });

    expect(result.deferred_returned).toHaveLength(1);
    expect(result.deferred_returned[0]).toBe('OBS-013');

    // Verify file was reset
    const content = await readFileContent(path.join(observationsDir, 'obs-013.md'));
    const fm = parseFrontmatterFromContent(content);
    expect(fm.triage_status).toBe('pending');
    expect(fm.triage_decision).toBeNull();
  });

  // -------------------------------------------------------------------------
  // TC-4-2-14: Deferred return: future date
  // -------------------------------------------------------------------------

  it('TC-4-2-14: does not return deferred observation when defer_until is in the future', async () => {
    await writeObservation(observationsDir, 'obs-014.md', {
      id: 'OBS-014',
      triage_decision: null,
      triage_status: 'deferred',
      triage_by: 'pm-lead',
      triage_at: '2026-04-01T10:00:00Z',
      defer_until: '2026-04-15',
    });

    const result = await processPendingTriage(observationsDir, auditLog, {
      now: new Date('2026-04-08T10:00:00Z'),
    });

    expect(result.deferred_returned).toHaveLength(0);

    // File should remain deferred
    const content = await readFileContent(path.join(observationsDir, 'obs-014.md'));
    const fm = parseFrontmatterFromContent(content);
    expect(fm.triage_status).toBe('deferred');
  });

  // -------------------------------------------------------------------------
  // TC-4-2-15: Deferred return note
  // -------------------------------------------------------------------------

  it('TC-4-2-15: appends deferred return note to Markdown body', async () => {
    await writeObservation(observationsDir, 'obs-015.md', {
      id: 'OBS-015',
      triage_decision: null,
      triage_status: 'deferred',
      triage_by: 'pm-lead',
      triage_at: '2026-03-25T10:00:00Z',
      triage_reason: 'Revisit after Q2 planning',
      defer_until: '2026-04-01',
    });

    await processPendingTriage(observationsDir, auditLog, {
      now: new Date('2026-04-08T10:00:00Z'),
    });

    const content = await readFileContent(path.join(observationsDir, 'obs-015.md'));
    expect(content).toContain('Deferred observation returned for re-triage');
    expect(content).toContain('pm-lead');
    expect(content).toContain('2026-03-25T10:00:00Z');
    expect(content).toContain('Revisit after Q2 planning');
    expect(content).toContain('2026-04-01');
  });

  // -------------------------------------------------------------------------
  // TC-4-2-16: Audit log for each action
  // -------------------------------------------------------------------------

  it('TC-4-2-16: logs audit entries for each processed decision', async () => {
    await writeObservation(observationsDir, 'obs-a.md', {
      id: 'OBS-A',
      triage_decision: 'promote',
      triage_status: 'pending',
      triage_by: 'pm-lead',
      triage_at: '2026-04-08T10:00:00Z',
      triage_reason: 'Promote it',
    });

    await writeObservation(observationsDir, 'obs-b.md', {
      id: 'OBS-B',
      triage_decision: 'dismiss',
      triage_status: 'pending',
      triage_by: 'pm-lead',
      triage_at: '2026-04-08T11:00:00Z',
      triage_reason: 'Not relevant',
    });

    await writeObservation(observationsDir, 'obs-c.md', {
      id: 'OBS-C',
      triage_decision: 'defer',
      triage_status: 'pending',
      triage_by: 'pm-lead',
      triage_at: '2026-04-08T12:00:00Z',
      triage_reason: 'Later',
      defer_until: '2026-05-01',
    });

    const result = await processPendingTriage(observationsDir, auditLog);

    expect(result.processed).toHaveLength(3);
    expect(auditLog.getEntries()).toHaveLength(3);

    const actions = auditLog.getEntries().map((e) => e.action);
    expect(actions).toContain('promote');
    expect(actions).toContain('dismiss');
    expect(actions).toContain('defer');
  });

  // -------------------------------------------------------------------------
  // Edge: missing triage_at rejected
  // -------------------------------------------------------------------------

  it('rejects when triage_at is missing', async () => {
    await writeObservation(observationsDir, 'obs-no-at.md', {
      id: 'OBS-NO-AT',
      triage_decision: 'promote',
      triage_status: 'pending',
      triage_by: 'pm-lead',
      triage_at: null,
    });

    const result = await processPendingTriage(observationsDir, auditLog);

    expect(result.processed).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('triage_at is required');
  });

  // -------------------------------------------------------------------------
  // Edge: observations with no triage_decision are skipped
  // -------------------------------------------------------------------------

  it('skips observations where triage_decision is null', async () => {
    await writeObservation(observationsDir, 'obs-null.md', {
      id: 'OBS-NULL',
      triage_decision: null,
      triage_status: 'pending',
    });

    const result = await processPendingTriage(observationsDir, auditLog);

    expect(result.processed).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Edge: subdirectory scanning
  // -------------------------------------------------------------------------

  it('scans subdirectories for observation files', async () => {
    const subDir = path.join(observationsDir, '2026', '04');
    await writeObservation(subDir, 'obs-sub.md', {
      id: 'OBS-SUB',
      triage_decision: 'dismiss',
      triage_status: 'pending',
      triage_by: 'pm-lead',
      triage_at: '2026-04-08T10:00:00Z',
      triage_reason: 'Dismissing from subdir',
    });

    const result = await processPendingTriage(observationsDir, auditLog);

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0].observation_id).toBe('OBS-SUB');
  });

  // -------------------------------------------------------------------------
  // Edge: empty observations directory
  // -------------------------------------------------------------------------

  it('handles empty observations directory gracefully', async () => {
    const result = await processPendingTriage(observationsDir, auditLog);

    expect(result.processed).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.deferred_returned).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Edge: mixed valid and invalid files
  // -------------------------------------------------------------------------

  it('processes valid files and reports errors for invalid files', async () => {
    // Valid
    await writeObservation(observationsDir, 'valid.md', {
      id: 'OBS-VALID',
      triage_decision: 'dismiss',
      triage_status: 'pending',
      triage_by: 'pm-lead',
      triage_at: '2026-04-08T10:00:00Z',
      triage_reason: 'Valid',
    });

    // Invalid - missing id
    await fsp.writeFile(
      path.join(observationsDir, 'invalid.md'),
      '---\nservice: api\ntriage_status: pending\n---\nBroken\n',
      'utf-8',
    );

    const result = await processPendingTriage(observationsDir, auditLog);

    expect(result.processed).toHaveLength(1);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // SPEC-007-4-4: Full lifecycle tests
  // -------------------------------------------------------------------------

  it('TC-4-4-11: defer -> re-triage cycle (defer with past date returns to pending)', async () => {
    // 1. Create observation and set up defer decision
    await writeObservation(observationsDir, 'obs-defer-cycle.md', {
      id: 'OBS-DEFER-CYCLE',
      triage_decision: 'defer',
      triage_status: 'pending',
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

    // Verify status is now 'deferred'
    const contentAfterDefer = await readFileContent(
      path.join(observationsDir, 'obs-defer-cycle.md'),
    );
    const fmAfterDefer = parseFrontmatterFromContent(contentAfterDefer);
    expect(fmAfterDefer.triage_status).toBe('deferred');

    // 3. Run again with date past defer_until -> should return deferred observation
    const result2 = await processPendingTriage(observationsDir, auditLog, {
      now: new Date('2026-04-08T10:00:00Z'),
    });
    expect(result2.deferred_returned).toContain('OBS-DEFER-CYCLE');

    // 4. Verify observation is back to pending
    const contentAfterReturn = await readFileContent(
      path.join(observationsDir, 'obs-defer-cycle.md'),
    );
    const fmAfterReturn = parseFrontmatterFromContent(contentAfterReturn);
    expect(fmAfterReturn.triage_status).toBe('pending');
    expect(fmAfterReturn.triage_decision).toBeNull();
  });

  it('processes multiple observation types in a single run', async () => {
    await writeObservation(observationsDir, 'obs-promote.md', {
      id: 'OBS-P',
      triage_decision: 'promote',
      triage_status: 'pending',
      triage_by: 'pm-lead',
      triage_at: '2026-04-08T10:00:00Z',
      triage_reason: 'High impact',
    });
    await writeObservation(observationsDir, 'obs-dismiss.md', {
      id: 'OBS-D',
      triage_decision: 'dismiss',
      triage_status: 'pending',
      triage_by: 'pm-lead',
      triage_at: '2026-04-08T10:00:00Z',
      triage_reason: 'Not relevant',
    });
    await writeObservation(observationsDir, 'obs-investigate.md', {
      id: 'OBS-I',
      triage_decision: 'investigate',
      triage_status: 'pending',
      triage_by: 'pm-lead',
      triage_at: '2026-04-08T10:00:00Z',
      triage_reason: 'Need data',
    });

    const result = await processPendingTriage(observationsDir, auditLog);

    expect(result.processed).toHaveLength(3);
    const decisions = result.processed.map((p) => p.decision).sort();
    expect(decisions).toEqual(['dismiss', 'investigate', 'promote']);
  });

  it('deferred return adds audit log entry', async () => {
    await writeObservation(observationsDir, 'obs-audit-defer.md', {
      id: 'OBS-AUDIT-DEFER',
      triage_decision: null,
      triage_status: 'deferred',
      triage_by: 'pm-lead',
      triage_at: '2026-03-01T10:00:00Z',
      triage_reason: 'Deferred for testing',
      defer_until: '2026-04-01',
    });

    await processPendingTriage(observationsDir, auditLog, {
      now: new Date('2026-04-08T10:00:00Z'),
    });

    const entries = auditLog.getEntries();
    const deferredReturn = entries.find(
      (e) => e.observation_id === 'OBS-AUDIT-DEFER' && e.action === 'deferred_return',
    );
    expect(deferredReturn).toBeDefined();
    expect(deferredReturn?.actor).toBe('system');
  });
});

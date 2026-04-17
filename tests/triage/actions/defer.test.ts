/**
 * Unit tests for the defer triage action (SPEC-007-4-2, Task 5).
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { executeDefer } from '../../../src/triage/actions/defer';
import type { TriageDecision, TriageAuditEntry, TriageAuditLogger } from '../../../src/triage/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDecision(overrides: Partial<TriageDecision> = {}): TriageDecision {
  return {
    observation_id: 'OBS-003',
    file_path: '/tmp/obs-003.md',
    decision: 'defer',
    triage_by: 'pm-lead',
    triage_at: '2026-04-08T10:00:00Z',
    triage_reason: 'Revisit after release',
    defer_until: '2026-04-15',
    ...overrides,
  };
}

function buildObservationContent(): string {
  const lines = [
    '---',
    'id: OBS-003',
    'service: api-gateway',
    'fingerprint: abc123',
    'triage_status: pending',
    'triage_decision: defer',
    'triage_by: pm-lead',
    'triage_at: 2026-04-08T10:00:00Z',
    'triage_reason: Revisit after release',
    'defer_until: 2026-04-15',
    'linked_prd: null',
    '---',
    '',
    '# Observation',
  ];
  return lines.join('\n');
}

function createMockAuditLog(): TriageAuditLogger & { entries: TriageAuditEntry[] } {
  const entries: TriageAuditEntry[] = [];
  return {
    entries,
    log(entry: TriageAuditEntry) { entries.push(entry); },
    logError() {},
    getEntries() { return entries; },
    async flush() {},
  };
}

function parseFm(content: string): Record<string, string | null> {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};
  const result: Record<string, string | null> = {};
  for (const line of fmMatch[1].split('\n')) {
    const ci = line.indexOf(':');
    if (ci === -1) continue;
    const key = line.substring(0, ci).trim();
    let val = line.substring(ci + 1).trim();
    if (val === 'null' || val === '~' || val === '') result[key] = null;
    else if (val.startsWith('"') && val.endsWith('"')) result[key] = val.slice(1, -1);
    else result[key] = val;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeDefer', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'defer-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('updates triage_status to deferred', async () => {
    const filePath = path.join(tmpDir, 'obs-003.md');
    await fsp.writeFile(filePath, buildObservationContent(), 'utf-8');

    const auditLog = createMockAuditLog();
    const decision = buildDecision({ file_path: filePath });

    await executeDefer(decision, filePath, auditLog);

    const content = await fsp.readFile(filePath, 'utf-8');
    const fm = parseFm(content);
    expect(fm.triage_status).toBe('deferred');
  });

  it('preserves defer_until in frontmatter', async () => {
    const filePath = path.join(tmpDir, 'obs-003.md');
    await fsp.writeFile(filePath, buildObservationContent(), 'utf-8');

    const auditLog = createMockAuditLog();
    const decision = buildDecision({ file_path: filePath });

    await executeDefer(decision, filePath, auditLog);

    const content = await fsp.readFile(filePath, 'utf-8');
    const fm = parseFm(content);
    expect(fm.defer_until).toBe('2026-04-15');
  });

  it('logs defer action to audit trail', async () => {
    const filePath = path.join(tmpDir, 'obs-003.md');
    await fsp.writeFile(filePath, buildObservationContent(), 'utf-8');

    const auditLog = createMockAuditLog();
    const decision = buildDecision({ file_path: filePath });

    await executeDefer(decision, filePath, auditLog);

    expect(auditLog.entries).toHaveLength(1);
    expect(auditLog.entries[0].action).toBe('defer');
    expect(auditLog.entries[0].observation_id).toBe('OBS-003');
    expect(auditLog.entries[0].reason).toBe('Revisit after release');
    expect(auditLog.entries[0].generated_prd).toBeNull();
  });
});

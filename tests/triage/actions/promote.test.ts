/**
 * Unit tests for the promote triage action (SPEC-007-4-2, Task 5).
 *
 * TC-4-2-09: Promote creates PRD.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { executePromote } from '../../../src/triage/actions/promote';
import type { GeneratePrdFromObservationFn } from '../../../src/triage/actions/promote';
import type { TriageDecision, TriageAuditEntry, TriageAuditLogger } from '../../../src/triage/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDecision(overrides: Partial<TriageDecision> = {}): TriageDecision {
  return {
    observation_id: 'OBS-001',
    file_path: '/tmp/obs-001.md',
    decision: 'promote',
    triage_by: 'pm-lead',
    triage_at: '2026-04-08T10:00:00Z',
    triage_reason: 'High impact',
    ...overrides,
  };
}

function buildObservationContent(overrides: Record<string, string | null> = {}): string {
  const defaults: Record<string, string | null> = {
    id: 'OBS-001',
    service: 'api-gateway',
    fingerprint: 'abc123',
    triage_status: 'pending',
    triage_decision: 'promote',
    triage_by: 'pm-lead',
    triage_at: '2026-04-08T10:00:00Z',
    triage_reason: 'High impact',
    defer_until: null,
    linked_prd: null,
  };
  const merged = { ...defaults, ...overrides };
  const lines = ['---'];
  for (const [key, value] of Object.entries(merged)) {
    lines.push(`${key}: ${value === null ? 'null' : value}`);
  }
  lines.push('---');
  lines.push('');
  lines.push('# Observation');
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

describe('executePromote', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'promote-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // TC-4-2-09: Promote creates PRD
  it('TC-4-2-09: updates triage_status to promoted and sets linked_prd', async () => {
    const filePath = path.join(tmpDir, 'obs-001.md');
    await fsp.writeFile(filePath, buildObservationContent(), 'utf-8');

    const auditLog = createMockAuditLog();
    const decision = buildDecision({ file_path: filePath });

    const mockGeneratePrd: GeneratePrdFromObservationFn = async () => 'PRD-042';

    await executePromote(decision, filePath, auditLog, mockGeneratePrd);

    const content = await fsp.readFile(filePath, 'utf-8');
    const fm = parseFm(content);

    expect(fm.triage_status).toBe('promoted');
    expect(fm.linked_prd).toBe('PRD-042');
  });

  it('logs promote action to audit trail', async () => {
    const filePath = path.join(tmpDir, 'obs-001.md');
    await fsp.writeFile(filePath, buildObservationContent(), 'utf-8');

    const auditLog = createMockAuditLog();
    const decision = buildDecision({ file_path: filePath });

    await executePromote(decision, filePath, auditLog);

    expect(auditLog.entries).toHaveLength(1);
    expect(auditLog.entries[0].action).toBe('promote');
    expect(auditLog.entries[0].observation_id).toBe('OBS-001');
    expect(auditLog.entries[0].actor).toBe('pm-lead');
    expect(auditLog.entries[0].generated_prd).toBeDefined();
    expect(auditLog.entries[0].auto_promoted).toBe(false);
  });

  it('uses default PRD generator when none provided', async () => {
    const filePath = path.join(tmpDir, 'obs-001.md');
    await fsp.writeFile(filePath, buildObservationContent(), 'utf-8');

    const auditLog = createMockAuditLog();
    const decision = buildDecision({ file_path: filePath });

    await executePromote(decision, filePath, auditLog);

    const content = await fsp.readFile(filePath, 'utf-8');
    const fm = parseFm(content);
    expect(fm.linked_prd).toBe('PRD-OBS-001');
  });
});

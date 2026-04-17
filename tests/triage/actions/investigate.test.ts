/**
 * Unit tests for the investigate triage action (SPEC-007-4-2, Task 5).
 *
 * TC-4-2-12: Investigate flags for additional collection.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  executeInvestigate,
  createInvestigationRequestWriter,
} from '../../../src/triage/actions/investigate';
import type { WriteInvestigationRequestFn } from '../../../src/triage/actions/investigate';
import type {
  TriageDecision,
  TriageAuditEntry,
  TriageAuditLogger,
  InvestigationRequest,
} from '../../../src/triage/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDecision(overrides: Partial<TriageDecision> = {}): TriageDecision {
  return {
    observation_id: 'OBS-004',
    file_path: '/tmp/obs-004.md',
    decision: 'investigate',
    triage_by: 'pm-lead',
    triage_at: '2026-04-08T10:00:00Z',
    triage_reason: 'Need more data',
    ...overrides,
  };
}

function buildObservationContent(overrides: Record<string, string | null> = {}): string {
  const defaults: Record<string, string | null> = {
    id: 'OBS-004',
    service: 'payment-service',
    fingerprint: 'xyz789',
    error_class: 'ConnectionPoolExhausted',
    triage_status: 'pending',
    triage_decision: 'investigate',
    triage_by: 'pm-lead',
    triage_at: '2026-04-08T10:00:00Z',
    triage_reason: 'Need more data',
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

describe('executeInvestigate', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'investigate-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('updates triage_status to investigating', async () => {
    const filePath = path.join(tmpDir, 'obs-004.md');
    await fsp.writeFile(filePath, buildObservationContent(), 'utf-8');

    const auditLog = createMockAuditLog();
    const decision = buildDecision({ file_path: filePath });

    await executeInvestigate(decision, filePath, auditLog);

    const content = await fsp.readFile(filePath, 'utf-8');
    const fm = parseFm(content);
    expect(fm.triage_status).toBe('investigating');
  });

  // TC-4-2-12: Investigate flags for additional collection
  it('TC-4-2-12: writes investigation request file', async () => {
    const filePath = path.join(tmpDir, 'obs-004.md');
    await fsp.writeFile(filePath, buildObservationContent(), 'utf-8');

    const investigationsDir = path.join(tmpDir, 'investigations');
    const writeRequest = createInvestigationRequestWriter(investigationsDir);

    const auditLog = createMockAuditLog();
    const decision = buildDecision({ file_path: filePath });

    await executeInvestigate(decision, filePath, auditLog, writeRequest);

    // Verify investigation request file was created
    const requestPath = path.join(investigationsDir, 'investigate-OBS-004.json');
    const requestContent = await fsp.readFile(requestPath, 'utf-8');
    const request = JSON.parse(requestContent) as InvestigationRequest;

    expect(request.observation_id).toBe('OBS-004');
    expect(request.service).toBe('payment-service');
    expect(request.error_class).toBe('ConnectionPoolExhausted');
    expect(request.requested_by).toBe('pm-lead');
    expect(request.requested_at).toBe('2026-04-08T10:00:00Z');
  });

  it('logs investigate action to audit trail', async () => {
    const filePath = path.join(tmpDir, 'obs-004.md');
    await fsp.writeFile(filePath, buildObservationContent(), 'utf-8');

    const auditLog = createMockAuditLog();
    const decision = buildDecision({ file_path: filePath });

    await executeInvestigate(decision, filePath, auditLog);

    expect(auditLog.entries).toHaveLength(1);
    expect(auditLog.entries[0].action).toBe('investigate');
    expect(auditLog.entries[0].observation_id).toBe('OBS-004');
    expect(auditLog.entries[0].generated_prd).toBeNull();
  });

  it('works without investigation request writer', async () => {
    const filePath = path.join(tmpDir, 'obs-004.md');
    await fsp.writeFile(filePath, buildObservationContent(), 'utf-8');

    const auditLog = createMockAuditLog();
    const decision = buildDecision({ file_path: filePath });

    // Should not throw when no writer provided
    await executeInvestigate(decision, filePath, auditLog);

    const content = await fsp.readFile(filePath, 'utf-8');
    const fm = parseFm(content);
    expect(fm.triage_status).toBe('investigating');
  });

  it('handles observation without error_class', async () => {
    const filePath = path.join(tmpDir, 'obs-no-class.md');
    await fsp.writeFile(
      filePath,
      buildObservationContent({ error_class: null }),
      'utf-8',
    );

    const investigationsDir = path.join(tmpDir, 'investigations');
    const writeRequest = createInvestigationRequestWriter(investigationsDir);
    const auditLog = createMockAuditLog();
    const decision = buildDecision({
      file_path: filePath,
      observation_id: 'OBS-004',
    });

    await executeInvestigate(decision, filePath, auditLog, writeRequest);

    const requestPath = path.join(investigationsDir, 'investigate-OBS-004.json');
    const requestContent = await fsp.readFile(requestPath, 'utf-8');
    const request = JSON.parse(requestContent) as InvestigationRequest;
    expect(request.error_class).toBe('unknown');
  });
});

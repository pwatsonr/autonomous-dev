/**
 * Unit tests for the dismiss triage action (SPEC-007-4-2, Task 5).
 *
 * TC-4-2-10: Dismiss updates fingerprint store.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { executeDismiss, createFingerprintStoreUpdater } from '../../../src/triage/actions/dismiss';
import type { UpdateFingerprintStoreFn } from '../../../src/triage/actions/dismiss';
import type { TriageDecision, TriageAuditEntry, TriageAuditLogger } from '../../../src/triage/types';
import type { FingerprintStore } from '../../../src/engine/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDecision(overrides: Partial<TriageDecision> = {}): TriageDecision {
  return {
    observation_id: 'OBS-002',
    file_path: '/tmp/obs-002.md',
    decision: 'dismiss',
    triage_by: 'pm-lead',
    triage_at: '2026-04-08T10:00:00Z',
    triage_reason: 'Known issue',
    ...overrides,
  };
}

function buildObservationContent(overrides: Record<string, string | null> = {}): string {
  const defaults: Record<string, string | null> = {
    id: 'OBS-002',
    service: 'api-gateway',
    fingerprint: 'abc123def456',
    triage_status: 'pending',
    triage_decision: 'dismiss',
    triage_by: 'pm-lead',
    triage_at: '2026-04-08T10:00:00Z',
    triage_reason: 'Known issue',
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

describe('executeDismiss', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dismiss-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('updates triage_status to dismissed', async () => {
    const filePath = path.join(tmpDir, 'obs-002.md');
    await fsp.writeFile(filePath, buildObservationContent(), 'utf-8');

    const auditLog = createMockAuditLog();
    const decision = buildDecision({ file_path: filePath });

    await executeDismiss(decision, filePath, auditLog);

    const content = await fsp.readFile(filePath, 'utf-8');
    const fm = parseFm(content);
    expect(fm.triage_status).toBe('dismissed');
  });

  // TC-4-2-10: Dismiss updates fingerprint store
  it('TC-4-2-10: updates fingerprint store with dismissal status', async () => {
    const filePath = path.join(tmpDir, 'obs-002.md');
    await fsp.writeFile(filePath, buildObservationContent(), 'utf-8');

    const fpDir = path.join(tmpDir, 'fingerprints');
    await fsp.mkdir(fpDir, { recursive: true });

    // Pre-populate fingerprint store
    const initialStore: FingerprintStore = {
      fingerprints: [
        {
          hash: 'abc123def456',
          service: 'api-gateway',
          error_class: 'ConnectionError',
          endpoint: '/api/v2/orders',
          first_seen: '2026-04-01T10:00:00Z',
          last_seen: '2026-04-07T10:00:00Z',
          occurrence_count: 3,
          linked_observation_id: 'OBS-002',
          triage_status: 'pending',
        },
      ],
    };
    await fsp.writeFile(
      path.join(fpDir, 'api-gateway.json'),
      JSON.stringify(initialStore, null, 2),
      'utf-8',
    );

    const updateFp = createFingerprintStoreUpdater(fpDir);
    const auditLog = createMockAuditLog();
    const decision = buildDecision({ file_path: filePath });

    await executeDismiss(decision, filePath, auditLog, updateFp);

    // Read updated fingerprint store
    const storeContent = await fsp.readFile(
      path.join(fpDir, 'api-gateway.json'),
      'utf-8',
    );
    const store = JSON.parse(storeContent) as FingerprintStore;

    expect(store.fingerprints[0].triage_status).toBe('dismissed');
    expect(store.fingerprints[0].last_seen).toBeDefined();
  });

  it('logs dismiss action to audit trail', async () => {
    const filePath = path.join(tmpDir, 'obs-002.md');
    await fsp.writeFile(filePath, buildObservationContent(), 'utf-8');

    const auditLog = createMockAuditLog();
    const decision = buildDecision({ file_path: filePath });

    await executeDismiss(decision, filePath, auditLog);

    expect(auditLog.entries).toHaveLength(1);
    expect(auditLog.entries[0].action).toBe('dismiss');
    expect(auditLog.entries[0].observation_id).toBe('OBS-002');
    expect(auditLog.entries[0].generated_prd).toBeNull();
  });

  it('creates fingerprint entry when none exists', async () => {
    const filePath = path.join(tmpDir, 'obs-002.md');
    await fsp.writeFile(filePath, buildObservationContent(), 'utf-8');

    const fpDir = path.join(tmpDir, 'fingerprints');
    const updateFp = createFingerprintStoreUpdater(fpDir);
    const auditLog = createMockAuditLog();
    const decision = buildDecision({ file_path: filePath });

    await executeDismiss(decision, filePath, auditLog, updateFp);

    const storeContent = await fsp.readFile(
      path.join(fpDir, 'api-gateway.json'),
      'utf-8',
    );
    const store = JSON.parse(storeContent) as FingerprintStore;

    expect(store.fingerprints).toHaveLength(1);
    expect(store.fingerprints[0].triage_status).toBe('dismissed');
    expect(store.fingerprints[0].service).toBe('api-gateway');
  });
});

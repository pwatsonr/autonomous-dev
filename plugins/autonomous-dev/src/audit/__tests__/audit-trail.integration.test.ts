/**
 * Integration tests for the audit trail subsystem (SPEC-009-5-7, Task 23).
 *
 * Tests cover:
 *   17. Hash chain verification end-to-end (clean)
 *   18. Hash chain verification end-to-end (tampered)
 *   19. Decision replay end-to-end
 *   20. Archival end-to-end
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AuditTrailEngine } from '../audit-trail-engine';
import { AuditEventWriter } from '../event-writer';
import { HashChainComputer } from '../hash-chain';
import { HashChainVerifier } from '../hash-verifier';
import { DecisionReplay } from '../decision-replay';
import { LogArchival } from '../log-archival';
import type { AuditEvent } from '../types';
import { createAuditTrailEngine } from '../index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-integration-'));
}

function readEventsFromFile(filePath: string): AuditEvent[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuditTrailEngine Integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Test Case 17: Hash chain verification end-to-end (clean)
  // =========================================================================
  test('hash chain verification: 20 clean events verify as valid', async () => {
    const logPath = path.join(tmpDir, 'events.jsonl');
    const hashChain = new HashChainComputer(true);
    const writer = new AuditEventWriter(logPath, hashChain);
    const replay = new DecisionReplay(logPath);
    const verifier = new HashChainVerifier(hashChain);
    const engine = new AuditTrailEngine(
      writer,
      hashChain,
      replay,
      verifier,
      logPath,
    );

    // Write 20 events
    for (let i = 0; i < 20; i++) {
      await engine.append({
        event_type: 'gate_decision',
        request_id: `req-${(i % 5) + 1}`,
        repository: 'test-repo',
        pipeline_phase: 'code_review',
        agent: 'test-agent',
        payload: { index: i, decision: 'approved' },
      });
    }

    // Verify
    const result = await engine.verify();

    expect(result.valid).toBe(true);
    expect(result.totalEvents).toBe(20);
    expect(result.errors).toHaveLength(0);
    expect(result.chainHeadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // =========================================================================
  // Test Case 18: Hash chain verification end-to-end (tampered)
  // =========================================================================
  test('hash chain verification: tampered event 10 detected', async () => {
    const logPath = path.join(tmpDir, 'events.jsonl');
    const hashChain = new HashChainComputer(true);
    const writer = new AuditEventWriter(logPath, hashChain);
    const replay = new DecisionReplay(logPath);
    const verifier = new HashChainVerifier(hashChain);
    const engine = new AuditTrailEngine(
      writer,
      hashChain,
      replay,
      verifier,
      logPath,
    );

    // Write 20 events
    for (let i = 0; i < 20; i++) {
      await engine.append({
        event_type: 'gate_decision',
        request_id: `req-${(i % 5) + 1}`,
        repository: 'test-repo',
        pipeline_phase: 'code_review',
        agent: 'test-agent',
        payload: { index: i },
      });
    }

    // Tamper with event 10 (0-indexed: line 10 in the file)
    const events = readEventsFromFile(logPath);
    events[9].payload = { index: 999, tampered: true };
    const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(logPath, content, 'utf-8');

    // Verify
    const result = await engine.verify();

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    // The error should be at or near event 10
    const hashError = result.errors.find(
      e => e.errorType === 'hash_mismatch',
    );
    expect(hashError).toBeDefined();
  });

  // =========================================================================
  // Test Case 19: Decision replay end-to-end
  // =========================================================================
  test('decision replay: 50 events for 5 requests, replay returns only matching', async () => {
    const logPath = path.join(tmpDir, 'events.jsonl');
    const hashChain = new HashChainComputer(false);
    const writer = new AuditEventWriter(logPath, hashChain);
    const replay = new DecisionReplay(logPath);
    const verifier = new HashChainVerifier(hashChain);
    const engine = new AuditTrailEngine(
      writer,
      hashChain,
      replay,
      verifier,
      logPath,
    );

    // Write 50 events across 5 requests (10 events each)
    for (let i = 0; i < 50; i++) {
      await engine.append({
        event_type: 'gate_decision',
        request_id: `req-${(i % 5) + 1}`,
        repository: 'test-repo',
        pipeline_phase: 'code_review',
        agent: 'test-agent',
        payload: { index: i },
      });
    }

    // Replay request 3
    const req3Events = await engine.replay('req-3');

    expect(req3Events).toHaveLength(10);
    expect(req3Events.every(e => e.request_id === 'req-3')).toBe(true);

    // Events should be in chronological order
    for (let i = 1; i < req3Events.length; i++) {
      expect(req3Events[i].timestamp >= req3Events[i - 1].timestamp).toBe(
        true,
      );
    }
  });

  // =========================================================================
  // Test Case 20: Archival end-to-end
  // =========================================================================
  test('archival: events spanning 120 days archived with 90-day retention', async () => {
    const logPath = path.join(tmpDir, 'events.jsonl');
    const archivePath = path.join(tmpDir, 'archive');

    // Write events spanning 120 days directly to the file
    // (Using direct file write since the writer uses current timestamps)
    const events: AuditEvent[] = [];
    for (let day = 120; day >= 0; day -= 3) {
      const date = new Date();
      date.setDate(date.getDate() - day);

      events.push({
        event_id: `evt-day-${day}`,
        event_type: 'gate_decision',
        timestamp: date.toISOString(),
        request_id: `req-day-${day}`,
        repository: 'test-repo',
        pipeline_phase: 'code_review',
        agent: 'test-agent',
        payload: { day },
        hash: '',
        prev_hash: '',
      });
    }

    const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, content, 'utf-8');

    // Archive with 90-day retention
    const archival = new LogArchival(logPath, archivePath, 90);
    const result = await archival.archive();

    // Events older than 90 days should be archived
    expect(result.archivedEventCount).toBeGreaterThan(0);
    expect(result.activeEventCount).toBeGreaterThan(0);
    expect(result.archivedEventCount + result.activeEventCount).toBe(
      events.length,
    );

    // Active log should have ~30 days of events
    const activeEvents = readEventsFromFile(logPath);
    expect(activeEvents.length).toBe(result.activeEventCount);

    // All active events should be within 90 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    for (const event of activeEvents) {
      expect(new Date(event.timestamp) >= cutoff).toBe(true);
    }

    // Archive file should exist
    expect(fs.existsSync(result.archiveFilePath)).toBe(true);

    // Metadata sidecar should exist
    const metaPath = result.archiveFilePath + '.meta.json';
    expect(fs.existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(meta.eventCount).toBe(result.archivedEventCount);
    expect(meta.dateRange).toBeDefined();
    expect(meta.chainHeadHash).toBeDefined();
  });

  // =========================================================================
  // Factory function creates fully wired engine
  // =========================================================================
  test('createAuditTrailEngine factory wires all dependencies', async () => {
    const logPath = path.join(tmpDir, 'events.jsonl');
    const engine = createAuditTrailEngine({
      log_path: logPath,
      integrity: {
        hash_chain_enabled: true,
        verification_schedule: '0 2 * * *',
      },
      retention: {
        active_days: 90,
        archive_path: path.join(tmpDir, 'archive'),
      },
      decision_log: {
        include_alternatives: true,
        include_confidence: true,
      },
    });

    // Write events via the engine
    await engine.append({
      event_type: 'gate_decision',
      request_id: 'req-001',
      repository: 'test-repo',
      pipeline_phase: 'code_review',
      agent: 'test-agent',
      payload: { decision: 'approved' },
    });

    // Verify
    const verifyResult = await engine.verify();
    expect(verifyResult.valid).toBe(true);
    expect(verifyResult.totalEvents).toBe(1);

    // Replay
    const replayResult = await engine.replay('req-001');
    expect(replayResult).toHaveLength(1);
    expect(replayResult[0].request_id).toBe('req-001');
  });
});

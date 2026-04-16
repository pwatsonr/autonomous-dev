/**
 * Unit tests for HashChainVerifier (SPEC-009-5-7, Task 21).
 *
 * Tests cover:
 *   4. verify returns valid for clean chain
 *   5. verify detects tampering (hash_mismatch)
 *   - verify detects prev_hash break
 *   - verify handles missing file
 *   - verify handles empty file
 *   - integrity log written on failure
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HashChainVerifier } from '../hash-verifier';
import { HashChainComputer, GENESIS_HASH, canonicalize } from '../hash-chain';
import type { AuditEvent } from '../types';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hash-verifier-test-'));
}

function buildChainedEvents(count: number): AuditEvent[] {
  const computer = new HashChainComputer(true);
  const events: AuditEvent[] = [];
  let prevHash = GENESIS_HASH;

  for (let i = 0; i < count; i++) {
    const eventData: Omit<AuditEvent, 'hash' | 'prev_hash'> = {
      event_id: `evt-${i.toString().padStart(3, '0')}`,
      event_type: 'gate_decision',
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
      request_id: `req-${(i % 3) + 1}`,
      repository: 'test-repo',
      pipeline_phase: 'code_review',
      agent: 'test-agent',
      payload: { index: i },
    };

    const { hash, prev_hash } = computer.computeHash(eventData, prevHash);

    events.push({
      ...eventData,
      hash,
      prev_hash,
    });

    prevHash = hash;
  }

  return events;
}

function writeEventsToFile(filePath: string, events: AuditEvent[]): void {
  const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HashChainVerifier', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test Case 4: verify returns valid for clean chain
  test('verify returns valid for 5 hash-chained events', async () => {
    const logPath = path.join(tmpDir, 'events.jsonl');
    const events = buildChainedEvents(5);
    writeEventsToFile(logPath, events);

    const computer = new HashChainComputer(true);
    const verifier = new HashChainVerifier(computer);
    const result = await verifier.verify(logPath);

    expect(result.valid).toBe(true);
    expect(result.totalEvents).toBe(5);
    expect(result.errors).toHaveLength(0);
    expect(result.chainHeadHash).toBe(events[4].hash);
  });

  // Test Case 5: verify detects tampering (modified event)
  test('verify detects tampering when event payload is modified', async () => {
    const logPath = path.join(tmpDir, 'events.jsonl');
    const events = buildChainedEvents(5);

    // Tamper with event 2 (index 2)
    events[2].payload = { index: 999, tampered: true };

    writeEventsToFile(logPath, events);

    const computer = new HashChainComputer(true);
    const verifier = new HashChainVerifier(computer);
    const result = await verifier.verify(logPath);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    // Should detect hash mismatch at the tampered event
    const hashError = result.errors.find(e => e.errorType === 'hash_mismatch');
    expect(hashError).toBeDefined();
  });

  // Detects prev_hash chain break
  test('verify detects broken chain when event is deleted', async () => {
    const logPath = path.join(tmpDir, 'events.jsonl');
    const events = buildChainedEvents(5);

    // Remove event at index 2 (breaking the chain)
    const withGap = [...events.slice(0, 2), ...events.slice(3)];
    writeEventsToFile(logPath, withGap);

    const computer = new HashChainComputer(true);
    const verifier = new HashChainVerifier(computer);
    const result = await verifier.verify(logPath);

    expect(result.valid).toBe(false);
    const prevHashError = result.errors.find(
      e => e.errorType === 'prev_hash_mismatch',
    );
    expect(prevHashError).toBeDefined();
  });

  // Missing file returns valid with zero events
  test('verify returns valid for non-existent file', async () => {
    const logPath = path.join(tmpDir, 'does-not-exist.jsonl');
    const computer = new HashChainComputer(true);
    const verifier = new HashChainVerifier(computer);
    const result = await verifier.verify(logPath);

    expect(result.valid).toBe(true);
    expect(result.totalEvents).toBe(0);
    expect(result.chainHeadHash).toBe(GENESIS_HASH);
  });

  // Empty file returns valid
  test('verify returns valid for empty file', async () => {
    const logPath = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(logPath, '', 'utf-8');

    const computer = new HashChainComputer(true);
    const verifier = new HashChainVerifier(computer);
    const result = await verifier.verify(logPath);

    expect(result.valid).toBe(true);
    expect(result.totalEvents).toBe(0);
  });

  // Integrity log written on failure
  test('integrity failures logged to separate file', async () => {
    const logPath = path.join(tmpDir, 'events.jsonl');
    const integrityLogPath = path.join(tmpDir, 'integrity.jsonl');
    const events = buildChainedEvents(5);
    events[2].payload = { tampered: true };
    writeEventsToFile(logPath, events);

    const computer = new HashChainComputer(true);
    const verifier = new HashChainVerifier(computer, integrityLogPath);
    await verifier.verify(logPath);

    expect(fs.existsSync(integrityLogPath)).toBe(true);
    const integrityContent = fs.readFileSync(integrityLogPath, 'utf-8');
    const record = JSON.parse(integrityContent.trim());
    expect(record.event_type).toBe('hash_chain_integrity_failure');
    expect(record.error_count).toBeGreaterThan(0);
  });
});

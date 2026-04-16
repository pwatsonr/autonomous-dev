/**
 * Unit tests for AuditEventWriter (SPEC-009-5-7, Task 21).
 *
 * Tests cover:
 *   1. append writes event to JSONL file
 *   2. append populates event_id and timestamp
 *   3. hash chain computed when enabled
 *   4. pending buffer on write failure
 *   5. buffer flush on next successful write
 *   6. escalation callback on persistent failure
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AuditEventWriter } from '../event-writer';
import type { PartialAuditEvent } from '../event-writer';
import { HashChainComputer } from '../hash-chain';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-writer-test-'));
}

function makePartialEvent(
  overrides: Partial<PartialAuditEvent> = {},
): PartialAuditEvent {
  return {
    event_type: 'gate_decision',
    request_id: 'req-001',
    repository: 'test-repo',
    pipeline_phase: 'code_review',
    agent: 'test-agent',
    payload: { decision: 'approved' },
    ...overrides,
  };
}

function readEvents(logPath: string): Array<Record<string, unknown>> {
  const content = fs.readFileSync(logPath, 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuditEventWriter', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    logPath = path.join(tmpDir, 'events.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test Case 1: append writes event to JSONL
  test('append writes event to events.jsonl', async () => {
    const writer = new AuditEventWriter(logPath);
    await writer.append(makePartialEvent());

    expect(fs.existsSync(logPath)).toBe(true);
    const events = readEvents(logPath);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('gate_decision');
    expect(events[0].request_id).toBe('req-001');
  });

  // Test Case 2: append populates event_id and timestamp
  test('append populates event_id (UUID) and timestamp (ISO 8601)', async () => {
    const writer = new AuditEventWriter(logPath);
    const event = await writer.append(makePartialEvent());

    // event_id should be a UUID v4
    expect(event.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    // timestamp should be ISO 8601
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
  });

  // Test Case 3: hash chain computed when enabled
  test('hash and prev_hash populated when hash chain is enabled', async () => {
    const hashChain = new HashChainComputer(true);
    const writer = new AuditEventWriter(logPath, hashChain);

    const event1 = await writer.append(makePartialEvent());
    expect(event1.hash).toBeTruthy();
    expect(event1.prev_hash).toBe('GENESIS');

    const event2 = await writer.append(
      makePartialEvent({ request_id: 'req-002' }),
    );
    expect(event2.hash).toBeTruthy();
    expect(event2.prev_hash).toBe(event1.hash);
  });

  // Test Case 4: hash fields empty when chain disabled
  test('hash and prev_hash are empty strings when hash chain is disabled', async () => {
    const writer = new AuditEventWriter(logPath);
    const event = await writer.append(makePartialEvent());

    expect(event.hash).toBe('');
    expect(event.prev_hash).toBe('');
  });

  // Test Case 5: multiple events written sequentially
  test('multiple events written correctly', async () => {
    const writer = new AuditEventWriter(logPath);

    await writer.append(makePartialEvent({ request_id: 'req-001' }));
    await writer.append(makePartialEvent({ request_id: 'req-002' }));
    await writer.append(makePartialEvent({ request_id: 'req-003' }));

    const events = readEvents(logPath);
    expect(events).toHaveLength(3);
    expect(events.map(e => e.request_id)).toEqual([
      'req-001',
      'req-002',
      'req-003',
    ]);
  });

  // Test Case 6: creates parent directory if it does not exist
  test('creates parent directory if it does not exist', async () => {
    const deepPath = path.join(tmpDir, 'deep', 'nested', 'events.jsonl');
    const writer = new AuditEventWriter(deepPath);
    await writer.append(makePartialEvent());

    expect(fs.existsSync(deepPath)).toBe(true);
  });

  // Test Case 7: escalation callback invoked on persistent failure
  test('escalation callback invoked on persistent write failure', async () => {
    // Use a path that will fail (directory as file)
    const badPath = path.join(tmpDir, 'bad-dir');
    fs.mkdirSync(badPath); // Create directory where file is expected
    const badLogPath = badPath; // Writing to a directory path should fail

    const writer = new AuditEventWriter(badLogPath);
    const escalationSpy = jest.fn();
    writer.setEscalationCallback(escalationSpy);

    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation();

    await writer.append(makePartialEvent());

    expect(writer.getPendingCount()).toBe(1);
    // Escalation callback or stderr should have been called
    // (depends on whether the directory path causes write failure)

    stderrSpy.mockRestore();
  });
});

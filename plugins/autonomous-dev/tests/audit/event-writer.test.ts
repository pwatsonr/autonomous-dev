import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  AuditEventWriter,
  PartialAuditEvent,
  HashChainComputer,
} from '../../src/audit/event-writer';
import type { AuditEvent } from '../../src/audit/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ISO_8601_MS_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function makePartialEvent(overrides: Partial<PartialAuditEvent> = {}): PartialAuditEvent {
  return {
    event_type: 'trust_level_changed',
    request_id: 'req-001',
    repository: 'test-repo',
    pipeline_phase: 'review',
    agent: 'trust-manager',
    payload: { from: 'low', to: 'medium' },
    ...overrides,
  };
}

function readEventsFromFile(logPath: string): AuditEvent[] {
  const content = fs.readFileSync(logPath, 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AuditEventWriter', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'audit-event-writer-test-'));
    logPath = path.join(tmpDir, 'events.jsonl');
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: Append single event
  // -------------------------------------------------------------------------

  it('appends a single event with all fields', async () => {
    const writer = new AuditEventWriter(logPath);
    const result = await writer.append(makePartialEvent());

    // Verify returned event has all fields
    expect(result.event_id).toBeDefined();
    expect(result.event_type).toBe('trust_level_changed');
    expect(result.timestamp).toBeDefined();
    expect(result.request_id).toBe('req-001');
    expect(result.repository).toBe('test-repo');
    expect(result.pipeline_phase).toBe('review');
    expect(result.agent).toBe('trust-manager');
    expect(result.payload).toEqual({ from: 'low', to: 'medium' });
    expect(result.hash).toBe('');
    expect(result.prev_hash).toBe('');

    // Verify file contains exactly one JSON line
    const events = readEventsFromFile(logPath);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(result);
  });

  // -------------------------------------------------------------------------
  // Test 2: Event ID is UUID v4
  // -------------------------------------------------------------------------

  it('generates UUID v4 event IDs', async () => {
    const writer = new AuditEventWriter(logPath);
    const result = await writer.append(makePartialEvent());
    expect(result.event_id).toMatch(UUID_V4_REGEX);
  });

  // -------------------------------------------------------------------------
  // Test 3: Timestamp is ISO 8601 with milliseconds
  // -------------------------------------------------------------------------

  it('generates ISO 8601 timestamps with millisecond precision', async () => {
    const writer = new AuditEventWriter(logPath);
    const result = await writer.append(makePartialEvent());
    expect(result.timestamp).toMatch(ISO_8601_MS_REGEX);
  });

  // -------------------------------------------------------------------------
  // Test 4: Hash fields empty in Phase 1
  // -------------------------------------------------------------------------

  it('sets hash and prev_hash to empty strings without hash chain', async () => {
    const writer = new AuditEventWriter(logPath);
    const result = await writer.append(makePartialEvent());
    expect(result.hash).toBe('');
    expect(result.prev_hash).toBe('');
  });

  // -------------------------------------------------------------------------
  // Test 5: Append multiple events
  // -------------------------------------------------------------------------

  it('appends multiple events as separate lines', async () => {
    const writer = new AuditEventWriter(logPath);

    for (let i = 0; i < 5; i++) {
      await writer.append(
        makePartialEvent({ request_id: `req-${i}` }),
      );
    }

    const events = readEventsFromFile(logPath);
    expect(events).toHaveLength(5);

    // Verify each has unique event_id
    const ids = events.map(e => e.event_id);
    expect(new Set(ids).size).toBe(5);
  });

  // -------------------------------------------------------------------------
  // Test 6: Append is atomic (each line is valid JSON)
  // -------------------------------------------------------------------------

  it('writes each event as a complete, valid JSON line', async () => {
    const writer = new AuditEventWriter(logPath);

    for (let i = 0; i < 10; i++) {
      await writer.append(makePartialEvent());
    }

    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);

    for (const line of lines) {
      // Each line must parse as valid JSON without errors
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  // -------------------------------------------------------------------------
  // Test 7: File never truncated
  // -------------------------------------------------------------------------

  it('never truncates the file on subsequent writes', async () => {
    const writer = new AuditEventWriter(logPath);

    // Write 3 events
    for (let i = 0; i < 3; i++) {
      await writer.append(makePartialEvent({ request_id: `batch1-${i}` }));
    }
    let events = readEventsFromFile(logPath);
    expect(events).toHaveLength(3);

    // Write 2 more events
    for (let i = 0; i < 2; i++) {
      await writer.append(makePartialEvent({ request_id: `batch2-${i}` }));
    }
    events = readEventsFromFile(logPath);
    expect(events).toHaveLength(5); // 5, not 2

    // Verify original events still present
    expect(events[0].request_id).toBe('batch1-0');
    expect(events[1].request_id).toBe('batch1-1');
    expect(events[2].request_id).toBe('batch1-2');
  });

  // -------------------------------------------------------------------------
  // Test 8: Concurrent writes serialized
  // -------------------------------------------------------------------------

  it('serializes concurrent writes without interleaving', async () => {
    const writer = new AuditEventWriter(logPath);

    // Spawn 10 async appends simultaneously
    const promises: Promise<AuditEvent>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        writer.append(makePartialEvent({ request_id: `concurrent-${i}` })),
      );
    }
    await Promise.all(promises);

    const events = readEventsFromFile(logPath);
    expect(events).toHaveLength(10);

    // All 10 events present with unique IDs
    const ids = new Set(events.map(e => e.event_id));
    expect(ids.size).toBe(10);

    // All request IDs present (order may vary)
    const requestIds = new Set(events.map(e => e.request_id));
    for (let i = 0; i < 10; i++) {
      expect(requestIds.has(`concurrent-${i}`)).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Test 9: fsync called after each write
  // -------------------------------------------------------------------------

  it('calls fsyncSync after each write', async () => {
    const fsyncSpy = jest.spyOn(fs, 'fsyncSync');
    const writer = new AuditEventWriter(logPath);

    await writer.append(makePartialEvent());
    expect(fsyncSpy).toHaveBeenCalled();

    const callCount = fsyncSpy.mock.calls.length;
    await writer.append(makePartialEvent());
    expect(fsyncSpy.mock.calls.length).toBeGreaterThan(callCount);

    fsyncSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 10: Write failure retry -- success on attempt 2
  // -------------------------------------------------------------------------

  it('retries on write failure and succeeds on second attempt', async () => {
    const writer = new AuditEventWriter(logPath);

    // Mock openSync to fail once, then succeed
    const originalOpenSync = fs.openSync;
    let callCount = 0;
    const openSpy = jest.spyOn(fs, 'openSync').mockImplementation((...args: any[]) => {
      callCount++;
      // Fail on first call to open the log file (not the lock file)
      // The lock file uses O_CREAT | O_EXCL, the log file uses O_APPEND
      const flags = args[1] as number;
      const isLogFile = (flags & fs.constants.O_APPEND) !== 0;
      if (isLogFile && callCount <= 2) {
        // First call is lock acquire (pass through), second is log open (fail)
        // Actually, let's track log-file opens specifically
        const err = new Error('EAGAIN') as NodeJS.ErrnoException;
        err.code = 'EAGAIN';
        throw err;
      }
      return originalOpenSync.apply(fs, args as any);
    });

    const result = await writer.append(makePartialEvent());

    // Event should still be written (on a retry)
    const events = readEventsFromFile(logPath);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(result.event_id).toBeDefined();

    openSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 11: Write failure retry -- all attempts fail
  // -------------------------------------------------------------------------

  it('buffers event and raises escalation when all retries fail', async () => {
    const writer = new AuditEventWriter(logPath);

    // Make the directory read-only so all writes fail
    const readOnlyDir = path.join(tmpDir, 'readonly');
    await fsp.mkdir(readOnlyDir);
    const readOnlyLogPath = path.join(readOnlyDir, 'events.jsonl');
    const failWriter = new AuditEventWriter(readOnlyLogPath);

    // Track escalation
    let escalationMessage = '';
    let escalationEvent: AuditEvent | null = null;
    failWriter.setEscalationCallback((msg, evt) => {
      escalationMessage = msg;
      escalationEvent = evt;
    });

    // Make directory read-only after writer creation
    await fsp.chmod(readOnlyDir, 0o444);

    const result = await failWriter.append(makePartialEvent());

    // Event should be buffered
    expect(failWriter.getPendingCount()).toBe(1);
    expect(failWriter.getPendingBuffer()[0]).toEqual(result);

    // Escalation should have been raised
    expect(escalationMessage).toContain('Audit event log write failure');
    expect(escalationEvent).not.toBeNull();

    // Restore permissions for cleanup
    await fsp.chmod(readOnlyDir, 0o755);
  });

  // -------------------------------------------------------------------------
  // Test 12: Buffered events flushed on next successful write
  // -------------------------------------------------------------------------

  it('flushes buffered events on next successful write', async () => {
    // Cause a real failure then recovery to test buffer flush.
    const badDir = path.join(tmpDir, 'baddir');
    await fsp.mkdir(badDir);
    const badLogPath = path.join(badDir, 'events.jsonl');
    const recoverableWriter = new AuditEventWriter(badLogPath);
    recoverableWriter.setEscalationCallback(() => {}); // suppress stderr

    // Make dir read-only to cause failure
    await fsp.chmod(badDir, 0o444);

    const failedEvent = await recoverableWriter.append(
      makePartialEvent({ request_id: 'will-be-buffered' }),
    );
    expect(recoverableWriter.getPendingCount()).toBe(1);

    // Restore permissions
    await fsp.chmod(badDir, 0o755);

    // Next write should succeed and flush the buffer
    const successEvent = await recoverableWriter.append(
      makePartialEvent({ request_id: 'success-event' }),
    );
    expect(recoverableWriter.getPendingCount()).toBe(0);

    // File should contain both events
    const events = readEventsFromFile(badLogPath);
    expect(events).toHaveLength(2);

    // The flushed buffered event should come first (written during flush)
    const requestIds = events.map(e => e.request_id);
    expect(requestIds).toContain('will-be-buffered');
    expect(requestIds).toContain('success-event');
  });

  // -------------------------------------------------------------------------
  // Test 13: Buffer ordering preserved
  // -------------------------------------------------------------------------

  it('preserves buffer ordering when flushing', async () => {
    const badDir = path.join(tmpDir, 'ordered');
    await fsp.mkdir(badDir);
    const orderedLogPath = path.join(badDir, 'events.jsonl');
    const writer = new AuditEventWriter(orderedLogPath);
    writer.setEscalationCallback(() => {}); // suppress stderr

    // Make dir read-only to buffer multiple events
    await fsp.chmod(badDir, 0o444);

    await writer.append(makePartialEvent({ request_id: 'buffered-1' }));
    await writer.append(makePartialEvent({ request_id: 'buffered-2' }));
    await writer.append(makePartialEvent({ request_id: 'buffered-3' }));
    expect(writer.getPendingCount()).toBe(3);

    // Restore permissions and write a new event to trigger flush
    await fsp.chmod(badDir, 0o755);

    await writer.append(makePartialEvent({ request_id: 'trigger-flush' }));
    expect(writer.getPendingCount()).toBe(0);

    const events = readEventsFromFile(orderedLogPath);
    expect(events).toHaveLength(4);

    // Buffered events should be in original order, before the trigger event
    expect(events[0].request_id).toBe('buffered-1');
    expect(events[1].request_id).toBe('buffered-2');
    expect(events[2].request_id).toBe('buffered-3');
    expect(events[3].request_id).toBe('trigger-flush');
  });

  // -------------------------------------------------------------------------
  // Test 14: Empty log file created on first write
  // -------------------------------------------------------------------------

  it('creates events.jsonl on first append if it does not exist', async () => {
    const newLogPath = path.join(tmpDir, 'subdir', 'events.jsonl');
    expect(fs.existsSync(newLogPath)).toBe(false);

    const writer = new AuditEventWriter(newLogPath);
    await writer.append(makePartialEvent());

    expect(fs.existsSync(newLogPath)).toBe(true);
    const events = readEventsFromFile(newLogPath);
    expect(events).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Hash chain integration
  // -------------------------------------------------------------------------

  describe('with HashChainComputer', () => {
    it('populates hash and prev_hash when hash chain is enabled', async () => {
      const mockHashChain: HashChainComputer = {
        computeHash: (_event, prevHash) => ({
          hash: 'computed-hash-abc',
          prev_hash: prevHash,
        }),
      };

      const writer = new AuditEventWriter(logPath, mockHashChain);

      const first = await writer.append(makePartialEvent());
      expect(first.hash).toBe('computed-hash-abc');
      expect(first.prev_hash).toBe(''); // First event, no previous

      const second = await writer.append(makePartialEvent());
      expect(second.hash).toBe('computed-hash-abc');
      expect(second.prev_hash).toBe('computed-hash-abc'); // Chained to first
    });
  });

  // -------------------------------------------------------------------------
  // Multiple writer instances (separate processes simulation)
  // -------------------------------------------------------------------------

  it('supports multiple writer instances writing to the same file', async () => {
    const writer1 = new AuditEventWriter(logPath);
    const writer2 = new AuditEventWriter(logPath);

    // Interleave writes from two instances
    await writer1.append(makePartialEvent({ agent: 'writer-1' }));
    await writer2.append(makePartialEvent({ agent: 'writer-2' }));
    await writer1.append(makePartialEvent({ agent: 'writer-1' }));
    await writer2.append(makePartialEvent({ agent: 'writer-2' }));

    const events = readEventsFromFile(logPath);
    expect(events).toHaveLength(4);

    // Each line is valid JSON
    for (const event of events) {
      expect(event.event_id).toMatch(UUID_V4_REGEX);
    }
  });
});

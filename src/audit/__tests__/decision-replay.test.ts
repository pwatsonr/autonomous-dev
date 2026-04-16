/**
 * Unit tests for DecisionReplay (SPEC-009-5-7, Task 21).
 *
 * Tests cover:
 *   3. replay filters by request_id
 *   - Returns events in chronological order
 *   - Returns empty array for unknown request IDs
 *   - Returns empty array for non-existent file
 *   - Skips malformed lines
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DecisionReplay, formatNarrative } from '../decision-replay';
import type { AuditEvent } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'decision-replay-test-'));
}

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    event_id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    event_type: 'gate_decision',
    timestamp: new Date().toISOString(),
    request_id: 'req-001',
    repository: 'test-repo',
    pipeline_phase: 'code_review',
    agent: 'test-agent',
    payload: { decision: 'approved' },
    hash: '',
    prev_hash: '',
    ...overrides,
  };
}

function writeEventsToFile(filePath: string, events: AuditEvent[]): void {
  const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DecisionReplay', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test Case 3: replay filters by request_id
  test('replay returns only events matching the request ID', async () => {
    const logPath = path.join(tmpDir, 'events.jsonl');
    const events: AuditEvent[] = [];

    // Create 10 events for 3 different requests
    for (let i = 0; i < 10; i++) {
      const requestId = `req-${(i % 3) + 1}`;
      events.push(
        makeEvent({
          request_id: requestId,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
        }),
      );
    }

    writeEventsToFile(logPath, events);
    const replay = new DecisionReplay(logPath);

    const req1Events = await replay.replay('req-1');
    const req2Events = await replay.replay('req-2');
    const req3Events = await replay.replay('req-3');

    // req-1 gets indices 0, 3, 6, 9 = 4 events
    expect(req1Events).toHaveLength(4);
    expect(req1Events.every(e => e.request_id === 'req-1')).toBe(true);

    // req-2 gets indices 1, 4, 7 = 3 events
    expect(req2Events).toHaveLength(3);
    expect(req2Events.every(e => e.request_id === 'req-2')).toBe(true);

    // req-3 gets indices 2, 5, 8 = 3 events
    expect(req3Events).toHaveLength(3);
  });

  // Events returned in chronological order
  test('replay returns events sorted by timestamp', async () => {
    const logPath = path.join(tmpDir, 'events.jsonl');

    // Write events out of chronological order
    const events = [
      makeEvent({
        request_id: 'req-1',
        timestamp: '2024-01-15T10:03:00.000Z',
      }),
      makeEvent({
        request_id: 'req-1',
        timestamp: '2024-01-15T10:01:00.000Z',
      }),
      makeEvent({
        request_id: 'req-1',
        timestamp: '2024-01-15T10:02:00.000Z',
      }),
    ];

    writeEventsToFile(logPath, events);
    const replay = new DecisionReplay(logPath);
    const result = await replay.replay('req-1');

    expect(result).toHaveLength(3);
    expect(result[0].timestamp).toBe('2024-01-15T10:01:00.000Z');
    expect(result[1].timestamp).toBe('2024-01-15T10:02:00.000Z');
    expect(result[2].timestamp).toBe('2024-01-15T10:03:00.000Z');
  });

  // Returns empty array for unknown request IDs
  test('replay returns empty array for unknown request ID', async () => {
    const logPath = path.join(tmpDir, 'events.jsonl');
    writeEventsToFile(logPath, [makeEvent({ request_id: 'req-1' })]);

    const replay = new DecisionReplay(logPath);
    const result = await replay.replay('req-unknown');

    expect(result).toEqual([]);
  });

  // Returns empty array when file does not exist
  test('replay returns empty array for non-existent file', async () => {
    const logPath = path.join(tmpDir, 'does-not-exist.jsonl');
    const replay = new DecisionReplay(logPath);
    const result = await replay.replay('req-1');

    expect(result).toEqual([]);
  });

  // Skips malformed lines
  test('replay skips malformed JSON lines', async () => {
    const logPath = path.join(tmpDir, 'events.jsonl');
    const validEvent = makeEvent({ request_id: 'req-1' });
    const content =
      JSON.stringify(validEvent) +
      '\n' +
      'not-valid-json\n' +
      JSON.stringify(makeEvent({ request_id: 'req-1' })) +
      '\n';
    fs.writeFileSync(logPath, content, 'utf-8');

    const replay = new DecisionReplay(logPath);
    const result = await replay.replay('req-1');

    expect(result).toHaveLength(2);
  });
});

describe('formatNarrative', () => {
  test('formats events as chronological narrative lines', () => {
    const events: AuditEvent[] = [
      makeEvent({
        timestamp: '2024-01-15T10:00:00.000Z',
        event_type: 'gate_decision',
        payload: { decision: 'approved' },
      }),
      makeEvent({
        timestamp: '2024-01-15T10:01:00.000Z',
        event_type: 'trust_level_changed',
        payload: { reason: 'Promoted to level 3' },
      }),
    ];

    const narrative = formatNarrative(events);

    expect(narrative).toContain('[2024-01-15T10:00:00.000Z] gate_decision: approved');
    expect(narrative).toContain(
      '[2024-01-15T10:01:00.000Z] trust_level_changed: Promoted to level 3',
    );
  });

  test('formats empty event list as empty string', () => {
    expect(formatNarrative([])).toBe('');
  });
});

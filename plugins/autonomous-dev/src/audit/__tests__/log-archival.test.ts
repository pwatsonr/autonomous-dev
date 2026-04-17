/**
 * Unit tests for LogArchival (SPEC-009-5-7, Task 21).
 *
 * Tests cover:
 *   - Archive partitions events by retention cutoff
 *   - Archive file and metadata sidecar written
 *   - Active log rewritten with remaining events
 *   - No-op when nothing to archive
 *   - listArchives returns archive metadata
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LogArchival } from '../log-archival';
import type { AuditEvent } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'log-archival-test-'));
}

function makeEvent(daysAgo: number, index: number): AuditEvent {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return {
    event_id: `evt-${index}`,
    event_type: 'gate_decision',
    timestamp: date.toISOString(),
    request_id: `req-${index}`,
    repository: 'test-repo',
    pipeline_phase: 'code_review',
    agent: 'test-agent',
    payload: { index },
    hash: '',
    prev_hash: '',
  };
}

function writeEventsToFile(filePath: string, events: AuditEvent[]): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf-8');
}

function readEventsFromFile(filePath: string): AuditEvent[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LogArchival', () => {
  let tmpDir: string;
  let logPath: string;
  let archivePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    logPath = path.join(tmpDir, 'events.jsonl');
    archivePath = path.join(tmpDir, 'archive');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('archives events older than retention period', async () => {
    // Events spanning 120 days: some old, some recent
    const events: AuditEvent[] = [];
    for (let i = 0; i < 12; i++) {
      events.push(makeEvent(i * 10, i)); // 0, 10, 20, ..., 110 days ago
    }
    // Sort by timestamp (oldest first)
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    writeEventsToFile(logPath, events);

    const archival = new LogArchival(logPath, archivePath, 90);
    const result = await archival.archive();

    // Events older than 90 days should be archived
    expect(result.archivedEventCount).toBeGreaterThan(0);
    expect(result.activeEventCount).toBeGreaterThan(0);
    expect(result.archivedEventCount + result.activeEventCount).toBe(12);

    // Archive file should exist
    expect(fs.existsSync(result.archiveFilePath)).toBe(true);

    // Active log should only have recent events
    const activeEvents = readEventsFromFile(logPath);
    expect(activeEvents).toHaveLength(result.activeEventCount);
  });

  test('metadata sidecar written with archive', async () => {
    const events = [makeEvent(120, 0), makeEvent(100, 1), makeEvent(10, 2)];
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    writeEventsToFile(logPath, events);

    const archival = new LogArchival(logPath, archivePath, 90);
    const result = await archival.archive();

    const metaPath = result.archiveFilePath + '.meta.json';
    expect(fs.existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(meta.eventCount).toBe(result.archivedEventCount);
    expect(meta.dateRange).toBeDefined();
    expect(meta.chainHeadHash).toBeDefined();
  });

  test('no-op when nothing to archive', async () => {
    // All events within retention period
    const events = [makeEvent(10, 0), makeEvent(5, 1), makeEvent(1, 2)];
    writeEventsToFile(logPath, events);

    const archival = new LogArchival(logPath, archivePath, 90);
    const result = await archival.archive();

    expect(result.archivedEventCount).toBe(0);
    expect(result.activeEventCount).toBe(3);
    expect(result.archiveFilePath).toBe('');
  });

  test('listArchives returns metadata for archived files', async () => {
    const events = [makeEvent(120, 0), makeEvent(100, 1), makeEvent(10, 2)];
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    writeEventsToFile(logPath, events);

    const archival = new LogArchival(logPath, archivePath, 90);
    await archival.archive();

    const archives = archival.listArchives();
    expect(archives).toHaveLength(1);
    expect(archives[0].eventCount).toBeGreaterThan(0);
    expect(archives[0].dateRange.from).toBeDefined();
    expect(archives[0].dateRange.to).toBeDefined();
  });

  test('listArchives returns empty for non-existent directory', () => {
    const archival = new LogArchival(logPath, '/non/existent/path', 90);
    const archives = archival.listArchives();
    expect(archives).toEqual([]);
  });
});

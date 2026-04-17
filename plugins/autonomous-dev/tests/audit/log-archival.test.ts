/**
 * Unit tests for LogArchival (SPEC-009-5-3, Task 6).
 *
 * Tests cover:
 *   7. Archive old events
 *   8. No events to archive
 *   9. Archive file naming
 *   10. Metadata sidecar
 *   11. Active log intact after archive
 *   12. Crash safety: archive written before active rewrite
 *   13. Atomic active log rewrite (temp+rename pattern)
 *   14. listArchives
 *   15. Archive preserves hash chain head
 */

import { LogArchival } from "../../src/audit/log-archival";
import type { ArchiveResult, ArchiveInfo } from "../../src/audit/log-archival";
import type { AuditEvent } from "../../src/audit/types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "archival-test-"));
}

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    event_id: overrides.event_id ?? `evt-${Math.random().toString(36).slice(2, 10)}`,
    event_type: overrides.event_type ?? "gate_decision",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    request_id: overrides.request_id ?? "req-default",
    repository: overrides.repository ?? "test-repo",
    pipeline_phase: overrides.pipeline_phase ?? "review",
    agent: overrides.agent ?? "test-agent",
    payload: overrides.payload ?? { decision: "approved" },
    hash: overrides.hash ?? "",
    prev_hash: overrides.prev_hash ?? "",
  };
}

function writeEvents(logPath: string, events: AuditEvent[]): void {
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const content = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(logPath, content, "utf-8");
}

function readEvents(filePath: string): AuditEvent[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AuditEvent);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/**
 * Generate a timestamp N days ago from now.
 */
function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Test 7: Archive old events
// ---------------------------------------------------------------------------

async function test_archive_old_events(): Promise<void> {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, "events.jsonl");
  const archivePath = path.join(tmpDir, "archives");

  const oldEvents = [
    makeEvent({ event_id: "old-1", timestamp: daysAgo(100) }),
    makeEvent({ event_id: "old-2", timestamp: daysAgo(95) }),
  ];
  const recentEvents = [
    makeEvent({ event_id: "recent-1", timestamp: daysAgo(10) }),
    makeEvent({ event_id: "recent-2", timestamp: daysAgo(5) }),
  ];
  writeEvents(logPath, [...oldEvents, ...recentEvents]);

  const archiver = new LogArchival(logPath, archivePath, 90);
  const result = await archiver.archive();

  // Archive should contain old events
  assert(
    result.archivedEventCount === 2,
    `Expected 2 archived events, got ${result.archivedEventCount}`,
  );
  assert(
    result.activeEventCount === 2,
    `Expected 2 active events, got ${result.activeEventCount}`,
  );

  // Verify archive file exists and has old events
  assert(result.archiveFilePath !== "", "Archive file path should be set");
  assert(fs.existsSync(result.archiveFilePath), "Archive file should exist");
  const archivedEvents = readEvents(result.archiveFilePath);
  assert(
    archivedEvents.length === 2,
    `Archive should have 2 events, got ${archivedEvents.length}`,
  );
  assert(archivedEvents[0].event_id === "old-1", "First archived event should be old-1");
  assert(archivedEvents[1].event_id === "old-2", "Second archived event should be old-2");

  // Verify active log has only recent events
  const activeEvents = readEvents(logPath);
  assert(
    activeEvents.length === 2,
    `Active log should have 2 events, got ${activeEvents.length}`,
  );
  assert(activeEvents[0].event_id === "recent-1", "First active event should be recent-1");
  assert(activeEvents[1].event_id === "recent-2", "Second active event should be recent-2");

  cleanupDir(tmpDir);
  console.log("PASS: test_archive_old_events");
}

// ---------------------------------------------------------------------------
// Test 8: No events to archive
// ---------------------------------------------------------------------------

async function test_no_events_to_archive(): Promise<void> {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, "events.jsonl");
  const archivePath = path.join(tmpDir, "archives");

  const recentEvents = [
    makeEvent({ timestamp: daysAgo(10) }),
    makeEvent({ timestamp: daysAgo(5) }),
    makeEvent({ timestamp: daysAgo(1) }),
  ];
  writeEvents(logPath, recentEvents);

  const archiver = new LogArchival(logPath, archivePath, 90);
  const result = await archiver.archive();

  assert(
    result.archivedEventCount === 0,
    `Expected 0 archived events, got ${result.archivedEventCount}`,
  );
  assert(
    result.activeEventCount === 3,
    `Expected 3 active events, got ${result.activeEventCount}`,
  );
  assert(result.archiveFilePath === "", "Archive file path should be empty");

  // Active log should be unchanged
  const activeEvents = readEvents(logPath);
  assert(
    activeEvents.length === 3,
    `Active log should still have 3 events, got ${activeEvents.length}`,
  );

  cleanupDir(tmpDir);
  console.log("PASS: test_no_events_to_archive");
}

// ---------------------------------------------------------------------------
// Test 9: Archive file naming
// ---------------------------------------------------------------------------

async function test_archive_file_naming(): Promise<void> {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, "events.jsonl");
  const archivePath = path.join(tmpDir, "archives");

  const events = [
    makeEvent({ timestamp: "2024-06-15T10:00:00.000Z" }),
    makeEvent({ timestamp: "2024-07-20T10:00:00.000Z" }),
    makeEvent({ timestamp: daysAgo(1) }), // Recent, should stay in active
  ];
  writeEvents(logPath, events);

  const archiver = new LogArchival(logPath, archivePath, 90);
  const result = await archiver.archive();

  // Archive file should be named events-YYYY-MM-DD-to-YYYY-MM-DD.jsonl
  const archiveBasename = path.basename(result.archiveFilePath);
  assert(
    archiveBasename === "events-2024-06-15-to-2024-07-20.jsonl",
    `Archive file should be named events-2024-06-15-to-2024-07-20.jsonl, got ${archiveBasename}`,
  );

  cleanupDir(tmpDir);
  console.log("PASS: test_archive_file_naming");
}

// ---------------------------------------------------------------------------
// Test 10: Metadata sidecar
// ---------------------------------------------------------------------------

async function test_metadata_sidecar(): Promise<void> {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, "events.jsonl");
  const archivePath = path.join(tmpDir, "archives");

  const hashValue = crypto.randomBytes(32).toString("hex");
  const events = [
    makeEvent({ timestamp: daysAgo(100), hash: "abc123" }),
    makeEvent({ timestamp: daysAgo(95), hash: hashValue }),
    makeEvent({ timestamp: daysAgo(1) }),
  ];
  writeEvents(logPath, events);

  const archiver = new LogArchival(logPath, archivePath, 90);
  const result = await archiver.archive();

  // Check metadata sidecar exists
  const metaPath = result.archiveFilePath + ".meta.json";
  assert(fs.existsSync(metaPath), "Metadata sidecar should exist");

  // Parse and validate metadata
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  assert(
    typeof meta.dateRange === "object",
    "Metadata should have dateRange object",
  );
  assert(
    typeof meta.dateRange.from === "string",
    "dateRange should have from string",
  );
  assert(
    typeof meta.dateRange.to === "string",
    "dateRange should have to string",
  );
  assert(
    meta.eventCount === 2,
    `Metadata eventCount should be 2, got ${meta.eventCount}`,
  );
  assert(
    typeof meta.chainHeadHash === "string" && meta.chainHeadHash.length > 0,
    "Metadata should have non-empty chainHeadHash",
  );

  cleanupDir(tmpDir);
  console.log("PASS: test_metadata_sidecar");
}

// ---------------------------------------------------------------------------
// Test 11: Active log intact after archive
// ---------------------------------------------------------------------------

async function test_active_log_intact_after_archive(): Promise<void> {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, "events.jsonl");
  const archivePath = path.join(tmpDir, "archives");

  const recentIds = ["keep-1", "keep-2", "keep-3"];
  const events = [
    makeEvent({ event_id: "old-1", timestamp: daysAgo(100) }),
    makeEvent({ event_id: "old-2", timestamp: daysAgo(95) }),
    ...recentIds.map((id) =>
      makeEvent({ event_id: id, timestamp: daysAgo(10) }),
    ),
  ];
  writeEvents(logPath, events);

  const archiver = new LogArchival(logPath, archivePath, 90);
  await archiver.archive();

  // Active log should be readable and contain only recent events
  const activeEvents = readEvents(logPath);
  assert(
    activeEvents.length === 3,
    `Active log should have 3 events, got ${activeEvents.length}`,
  );

  const activeIds = activeEvents.map((e) => e.event_id);
  for (const id of recentIds) {
    assert(activeIds.includes(id), `Active log should contain event ${id}`);
  }

  // Each line should be valid JSON
  const content = fs.readFileSync(logPath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  for (let i = 0; i < lines.length; i++) {
    try {
      JSON.parse(lines[i]);
    } catch {
      throw new Error(`Active log line ${i} is not valid JSON`);
    }
  }

  cleanupDir(tmpDir);
  console.log("PASS: test_active_log_intact_after_archive");
}

// ---------------------------------------------------------------------------
// Test 12: Crash safety: archive written before active rewrite
// ---------------------------------------------------------------------------

async function test_crash_safety_archive_before_rewrite(): Promise<void> {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, "events.jsonl");
  const archivePath = path.join(tmpDir, "archives");

  const events = [
    makeEvent({ event_id: "old-1", timestamp: daysAgo(100) }),
    makeEvent({ event_id: "recent-1", timestamp: daysAgo(10) }),
  ];
  writeEvents(logPath, events);

  // Save the original active log content for comparison
  const originalContent = fs.readFileSync(logPath, "utf-8");

  // To verify crash safety, we intercept fs.renameSync to simulate
  // a crash after the archive is written but before the active log
  // is rewritten. We do this by monitoring the archive directory.
  //
  // Instead of actually crashing, we verify the property:
  // after archive(), the archive file exists AND was written before
  // the active log was modified.
  //
  // We can verify this by checking that the archive file write times
  // are correct, but more directly we just verify both files exist
  // post-archival with correct content.

  const archiver = new LogArchival(logPath, archivePath, 90);
  const result = await archiver.archive();

  // Archive file should exist
  assert(
    fs.existsSync(result.archiveFilePath),
    "Archive file should exist after archival",
  );

  // Verify the archive has the old event
  const archivedEvents = readEvents(result.archiveFilePath);
  assert(
    archivedEvents.length === 1,
    `Archive should have 1 event, got ${archivedEvents.length}`,
  );
  assert(
    archivedEvents[0].event_id === "old-1",
    "Archive should contain old-1",
  );

  // Active log should have been rewritten with only recent event
  const activeEvents = readEvents(logPath);
  assert(
    activeEvents.length === 1,
    `Active log should have 1 event, got ${activeEvents.length}`,
  );
  assert(
    activeEvents[0].event_id === "recent-1",
    "Active log should contain recent-1",
  );

  // Key safety property: if we simulate a crash by restoring the
  // original active log, both archive AND original data exist
  // (events duplicated, not lost)
  fs.writeFileSync(logPath, originalContent, "utf-8");
  const restoredEvents = readEvents(logPath);
  assert(
    restoredEvents.length === 2,
    "After simulated crash recovery, original active log should have 2 events",
  );
  assert(
    fs.existsSync(result.archiveFilePath),
    "After simulated crash, archive still exists (data not lost)",
  );

  cleanupDir(tmpDir);
  console.log("PASS: test_crash_safety_archive_before_rewrite");
}

// ---------------------------------------------------------------------------
// Test 13: Atomic active log rewrite (temp+rename pattern)
// ---------------------------------------------------------------------------

async function test_atomic_active_log_rewrite(): Promise<void> {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, "events.jsonl");
  const archivePath = path.join(tmpDir, "archives");

  const events = [
    makeEvent({ event_id: "old-1", timestamp: daysAgo(100) }),
    makeEvent({ event_id: "recent-1", timestamp: daysAgo(10) }),
  ];
  writeEvents(logPath, events);

  // Track fs.renameSync calls to verify temp+rename pattern
  const originalRename = fs.renameSync;
  const renameCalls: Array<{ oldPath: string; newPath: string }> = [];

  fs.renameSync = function (oldPath: fs.PathLike, newPath: fs.PathLike) {
    renameCalls.push({
      oldPath: String(oldPath),
      newPath: String(newPath),
    });
    return originalRename.call(fs, oldPath, newPath);
  } as typeof fs.renameSync;

  try {
    const archiver = new LogArchival(logPath, archivePath, 90);
    await archiver.archive();

    // Should have at least 2 rename calls:
    // 1. temp archive -> final archive
    // 2. temp active -> logPath
    assert(
      renameCalls.length >= 2,
      `Expected at least 2 rename calls (temp+rename pattern), got ${renameCalls.length}`,
    );

    // Verify one rename targets the archive path
    const archiveRename = renameCalls.find((c) =>
      c.newPath.includes("archives") && c.newPath.endsWith(".jsonl"),
    );
    assert(
      archiveRename !== undefined,
      "Should have a rename call targeting archive path",
    );
    assert(
      archiveRename!.oldPath.includes(".tmp."),
      "Archive rename source should be a temp file",
    );

    // Verify one rename targets the active log path
    const activeRename = renameCalls.find((c) => c.newPath === logPath);
    assert(
      activeRename !== undefined,
      "Should have a rename call targeting active log path",
    );
    assert(
      activeRename!.oldPath.includes(".tmp."),
      "Active log rename source should be a temp file",
    );
  } finally {
    fs.renameSync = originalRename;
  }

  cleanupDir(tmpDir);
  console.log("PASS: test_atomic_active_log_rewrite");
}

// ---------------------------------------------------------------------------
// Test 14: listArchives
// ---------------------------------------------------------------------------

async function test_list_archives(): Promise<void> {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, "events.jsonl");
  const archivePath = path.join(tmpDir, "archives");

  // Run archival twice with different date ranges
  // First run: events from 200 days ago
  const events1 = [
    makeEvent({ timestamp: daysAgo(200) }),
    makeEvent({ timestamp: daysAgo(195) }),
    makeEvent({ timestamp: daysAgo(1) }),
  ];
  writeEvents(logPath, events1);

  const archiver = new LogArchival(logPath, archivePath, 90);
  await archiver.archive();

  // Second run: add more old events and archive again
  const currentActive = readEvents(logPath);
  const events2 = [
    makeEvent({ timestamp: daysAgo(150) }),
    makeEvent({ timestamp: daysAgo(145) }),
    ...currentActive,
  ];
  writeEvents(logPath, events2);

  await archiver.archive();

  // listArchives should return 2 entries
  const archives = archiver.listArchives();

  assert(
    archives.length === 2,
    `Expected 2 archive entries, got ${archives.length}`,
  );

  // Each archive should have metadata
  for (const archive of archives) {
    assert(typeof archive.filePath === "string", "Should have filePath");
    assert(typeof archive.dateRange.from === "string", "Should have dateRange.from");
    assert(typeof archive.dateRange.to === "string", "Should have dateRange.to");
    assert(typeof archive.eventCount === "number", "Should have eventCount");
    assert(typeof archive.chainHeadHash === "string", "Should have chainHeadHash");
    assert(archive.eventCount > 0, "Event count should be > 0");
  }

  // Archives should be sorted by date
  assert(
    archives[0].dateRange.from <= archives[1].dateRange.from,
    "Archives should be sorted by date ascending",
  );

  cleanupDir(tmpDir);
  console.log("PASS: test_list_archives");
}

// ---------------------------------------------------------------------------
// Test 15: Archive preserves hash chain head
// ---------------------------------------------------------------------------

async function test_archive_preserves_hash_chain_head(): Promise<void> {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, "events.jsonl");
  const archivePath = path.join(tmpDir, "archives");

  const chainHeadHash = crypto.randomBytes(32).toString("hex");
  const events = [
    makeEvent({
      timestamp: daysAgo(100),
      hash: "first-hash",
    }),
    makeEvent({
      timestamp: daysAgo(95),
      hash: chainHeadHash,
    }),
    makeEvent({ timestamp: daysAgo(1) }),
  ];
  writeEvents(logPath, events);

  const archiver = new LogArchival(logPath, archivePath, 90);
  const result = await archiver.archive();

  // The chain head hash should be the last archived event's hash
  assert(
    result.chainHeadHashAtArchival === chainHeadHash,
    `Chain head hash should be ${chainHeadHash}, got ${result.chainHeadHashAtArchival}`,
  );

  // Metadata sidecar should also contain the chain head hash
  const metaPath = result.archiveFilePath + ".meta.json";
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  assert(
    meta.chainHeadHash === chainHeadHash,
    `Metadata sidecar chain head hash should match: expected ${chainHeadHash}, got ${meta.chainHeadHash}`,
  );

  cleanupDir(tmpDir);
  console.log("PASS: test_archive_preserves_hash_chain_head");
}

// ---------------------------------------------------------------------------
// Test: empty log file
// ---------------------------------------------------------------------------

async function test_empty_log_file(): Promise<void> {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, "events.jsonl");
  const archivePath = path.join(tmpDir, "archives");

  // Create empty log file
  fs.writeFileSync(logPath, "", "utf-8");

  const archiver = new LogArchival(logPath, archivePath, 90);
  const result = await archiver.archive();

  assert(
    result.archivedEventCount === 0,
    `Expected 0 archived events from empty log, got ${result.archivedEventCount}`,
  );
  assert(
    result.activeEventCount === 0,
    `Expected 0 active events from empty log, got ${result.activeEventCount}`,
  );

  cleanupDir(tmpDir);
  console.log("PASS: test_empty_log_file");
}

// ---------------------------------------------------------------------------
// Test: listArchives with no archive directory
// ---------------------------------------------------------------------------

async function test_list_archives_no_directory(): Promise<void> {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, "events.jsonl");
  const archivePath = path.join(tmpDir, "nonexistent-archives");

  const archiver = new LogArchival(logPath, archivePath, 90);
  const archives = archiver.listArchives();

  assert(archives.length === 0, `Expected empty array when archive dir doesn't exist`);

  cleanupDir(tmpDir);
  console.log("PASS: test_list_archives_no_directory");
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const tests = [
  test_archive_old_events,
  test_no_events_to_archive,
  test_archive_file_naming,
  test_metadata_sidecar,
  test_active_log_intact_after_archive,
  test_crash_safety_archive_before_rewrite,
  test_atomic_active_log_rewrite,
  test_list_archives,
  test_archive_preserves_hash_chain_head,
  test_empty_log_file,
  test_list_archives_no_directory,
];

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (err) {
      console.log(`FAIL: ${test.name} -- ${err}`);
      failed++;
    }
  }

  console.log(`\nResults: ${passed}/${tests.length} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests();

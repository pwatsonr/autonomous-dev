/**
 * Unit tests for DecisionReplay (SPEC-009-5-3, Task 5).
 *
 * Tests cover:
 *   1. Replay single request
 *   2. Chronological order
 *   3. Unknown request returns empty
 *   4. Large log streaming (line-by-line, not full load)
 *   5. All event types included
 *   6. Format narrative
 */

import { DecisionReplay, formatNarrative } from "../../src/audit/decision-replay";
import type { AuditEvent } from "../../src/audit/types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "replay-test-"));
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

// ---------------------------------------------------------------------------
// Test 1: Replay single request
// ---------------------------------------------------------------------------

async function test_replay_single_request(): Promise<void> {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, "events.jsonl");

  const events = [
    makeEvent({ request_id: "req-1", timestamp: "2025-01-01T00:00:01.000Z" }),
    makeEvent({ request_id: "req-2", timestamp: "2025-01-01T00:00:02.000Z" }),
    makeEvent({ request_id: "req-1", timestamp: "2025-01-01T00:00:03.000Z" }),
    makeEvent({ request_id: "req-2", timestamp: "2025-01-01T00:00:04.000Z" }),
    makeEvent({ request_id: "req-1", timestamp: "2025-01-01T00:00:05.000Z" }),
  ];
  writeEvents(logPath, events);

  const replay = new DecisionReplay(logPath);
  const result = await replay.replay("req-1");

  assert(result.length === 3, `Expected 3 events for req-1, got ${result.length}`);
  for (const e of result) {
    assert(e.request_id === "req-1", `Expected request_id req-1, got ${e.request_id}`);
  }

  cleanupDir(tmpDir);
  console.log("PASS: test_replay_single_request");
}

// ---------------------------------------------------------------------------
// Test 2: Chronological order
// ---------------------------------------------------------------------------

async function test_chronological_order(): Promise<void> {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, "events.jsonl");

  // Write events for req-1 interleaved with req-2, out of timestamp order
  const events = [
    makeEvent({ request_id: "req-1", timestamp: "2025-01-01T00:00:03.000Z" }),
    makeEvent({ request_id: "req-2", timestamp: "2025-01-01T00:00:02.000Z" }),
    makeEvent({ request_id: "req-1", timestamp: "2025-01-01T00:00:01.000Z" }),
    makeEvent({ request_id: "req-2", timestamp: "2025-01-01T00:00:04.000Z" }),
    makeEvent({ request_id: "req-1", timestamp: "2025-01-01T00:00:05.000Z" }),
  ];
  writeEvents(logPath, events);

  const replay = new DecisionReplay(logPath);
  const result = await replay.replay("req-1");

  assert(result.length === 3, `Expected 3 events, got ${result.length}`);

  // Verify chronological order
  assert(
    result[0].timestamp === "2025-01-01T00:00:01.000Z",
    `First event timestamp should be 01, got ${result[0].timestamp}`,
  );
  assert(
    result[1].timestamp === "2025-01-01T00:00:03.000Z",
    `Second event timestamp should be 03, got ${result[1].timestamp}`,
  );
  assert(
    result[2].timestamp === "2025-01-01T00:00:05.000Z",
    `Third event timestamp should be 05, got ${result[2].timestamp}`,
  );

  cleanupDir(tmpDir);
  console.log("PASS: test_chronological_order");
}

// ---------------------------------------------------------------------------
// Test 3: Unknown request returns empty
// ---------------------------------------------------------------------------

async function test_unknown_request_returns_empty(): Promise<void> {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, "events.jsonl");

  const events = [
    makeEvent({ request_id: "req-1" }),
    makeEvent({ request_id: "req-2" }),
  ];
  writeEvents(logPath, events);

  const replay = new DecisionReplay(logPath);
  const result = await replay.replay("nonexistent");

  assert(result.length === 0, `Expected empty array, got ${result.length} events`);

  cleanupDir(tmpDir);
  console.log("PASS: test_unknown_request_returns_empty");
}

// ---------------------------------------------------------------------------
// Test 4: Large log streaming
// ---------------------------------------------------------------------------

async function test_large_log_streaming(): Promise<void> {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, "events.jsonl");

  // Generate 10,000 events across multiple request IDs
  const events: AuditEvent[] = [];
  for (let i = 0; i < 10000; i++) {
    const requestId = `req-${i % 100}`; // 100 distinct request IDs
    const ts = new Date(2025, 0, 1, 0, 0, 0, i).toISOString();
    events.push(
      makeEvent({
        request_id: requestId,
        timestamp: ts,
        event_id: `evt-${i}`,
      }),
    );
  }
  writeEvents(logPath, events);

  const replay = new DecisionReplay(logPath);
  const result = await replay.replay("req-0");

  // 10,000 events / 100 request IDs = 100 events per request
  assert(
    result.length === 100,
    `Expected 100 events for req-0 from 10,000-event log, got ${result.length}`,
  );

  // Verify all results are for the correct request
  for (const e of result) {
    assert(e.request_id === "req-0", `All events should be for req-0`);
  }

  // Verify chronological order
  for (let i = 1; i < result.length; i++) {
    assert(
      result[i].timestamp >= result[i - 1].timestamp,
      `Events should be in chronological order at index ${i}`,
    );
  }

  cleanupDir(tmpDir);
  console.log("PASS: test_large_log_streaming");
}

// ---------------------------------------------------------------------------
// Test 5: All event types included
// ---------------------------------------------------------------------------

async function test_all_event_types_included(): Promise<void> {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, "events.jsonl");

  const events = [
    makeEvent({
      request_id: "req-1",
      event_type: "trust_level_changed",
      timestamp: "2025-01-01T00:00:01.000Z",
    }),
    makeEvent({
      request_id: "req-1",
      event_type: "gate_decision",
      timestamp: "2025-01-01T00:00:02.000Z",
    }),
    makeEvent({
      request_id: "req-1",
      event_type: "escalation_raised",
      timestamp: "2025-01-01T00:00:03.000Z",
    }),
    makeEvent({
      request_id: "req-1",
      event_type: "autonomous_decision",
      timestamp: "2025-01-01T00:00:04.000Z",
    }),
    makeEvent({
      request_id: "req-1",
      event_type: "kill_issued",
      timestamp: "2025-01-01T00:00:05.000Z",
    }),
  ];
  writeEvents(logPath, events);

  const replay = new DecisionReplay(logPath);
  const result = await replay.replay("req-1");

  assert(result.length === 5, `Expected 5 events of different types, got ${result.length}`);

  const types = result.map((e) => e.event_type);
  assert(types.includes("trust_level_changed"), "Should include trust_level_changed");
  assert(types.includes("gate_decision"), "Should include gate_decision");
  assert(types.includes("escalation_raised"), "Should include escalation_raised");
  assert(types.includes("autonomous_decision"), "Should include autonomous_decision");
  assert(types.includes("kill_issued"), "Should include kill_issued");

  cleanupDir(tmpDir);
  console.log("PASS: test_all_event_types_included");
}

// ---------------------------------------------------------------------------
// Test 6: Format narrative
// ---------------------------------------------------------------------------

async function test_format_narrative(): Promise<void> {
  const events: AuditEvent[] = [
    makeEvent({
      timestamp: "2025-01-01T00:00:01.000Z",
      event_type: "gate_decision",
      payload: { decision: "approved code review" },
    }),
    makeEvent({
      timestamp: "2025-01-01T00:00:02.000Z",
      event_type: "escalation_raised",
      payload: { reason: "confidence too low" },
    }),
    makeEvent({
      timestamp: "2025-01-01T00:00:03.000Z",
      event_type: "autonomous_decision",
      payload: { decision: "proceed with deployment" },
    }),
  ];

  const narrative = formatNarrative(events);
  const lines = narrative.split("\n");

  assert(lines.length === 3, `Expected 3 narrative lines, got ${lines.length}`);

  // Each line should have the format: [timestamp] event_type: summary
  assert(
    lines[0].includes("[2025-01-01T00:00:01.000Z]"),
    "First line should contain timestamp",
  );
  assert(
    lines[0].includes("gate_decision"),
    "First line should contain event_type",
  );
  assert(
    lines[0].includes("approved code review"),
    "First line should contain decision payload",
  );

  assert(
    lines[1].includes("escalation_raised"),
    "Second line should contain event_type",
  );
  assert(
    lines[1].includes("confidence too low"),
    "Second line should contain reason payload",
  );

  assert(
    lines[2].includes("autonomous_decision"),
    "Third line should contain event_type",
  );
  assert(
    lines[2].includes("proceed with deployment"),
    "Third line should contain decision payload",
  );

  console.log("PASS: test_format_narrative");
}

// ---------------------------------------------------------------------------
// Test: missing log file returns empty
// ---------------------------------------------------------------------------

async function test_missing_log_file_returns_empty(): Promise<void> {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, "nonexistent.jsonl");

  const replay = new DecisionReplay(logPath);
  const result = await replay.replay("req-1");

  assert(result.length === 0, `Expected empty array for missing file, got ${result.length}`);

  cleanupDir(tmpDir);
  console.log("PASS: test_missing_log_file_returns_empty");
}

// ---------------------------------------------------------------------------
// Test: malformed lines skipped
// ---------------------------------------------------------------------------

async function test_malformed_lines_skipped(): Promise<void> {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, "events.jsonl");

  // Write a mix of valid and malformed lines
  const validEvent = makeEvent({
    request_id: "req-1",
    timestamp: "2025-01-01T00:00:01.000Z",
  });
  const content = [
    JSON.stringify(validEvent),
    "this is not valid json",
    "",
    JSON.stringify(
      makeEvent({
        request_id: "req-1",
        timestamp: "2025-01-01T00:00:02.000Z",
      }),
    ),
  ].join("\n");
  fs.writeFileSync(logPath, content + "\n", "utf-8");

  const replay = new DecisionReplay(logPath);
  const result = await replay.replay("req-1");

  assert(result.length === 2, `Expected 2 valid events, got ${result.length}`);

  cleanupDir(tmpDir);
  console.log("PASS: test_malformed_lines_skipped");
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const tests = [
  test_replay_single_request,
  test_chronological_order,
  test_unknown_request_returns_empty,
  test_large_log_streaming,
  test_all_event_types_included,
  test_format_narrative,
  test_missing_log_file_returns_empty,
  test_malformed_lines_skipped,
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

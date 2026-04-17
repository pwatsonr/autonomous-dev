import { AuditLogger, createAuditLogger } from '../../src/agent-factory/audit';
import { AuditEvent } from '../../src/agent-factory/types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Unit tests for audit logger (SPEC-005-1-3, Task 8).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
}

function makeEvent(overrides?: Partial<AuditEvent>): AuditEvent {
  return {
    timestamp: overrides?.timestamp ?? new Date().toISOString(),
    event_type: overrides?.event_type ?? 'tool_call_blocked',
    agent_name: overrides?.agent_name ?? 'test-agent',
    details: overrides?.details ?? { tool: 'Bash', reason: 'Not authorized' },
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function cleanup(logPath: string, tmpDir: string): void {
  try {
    if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
    if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir, { recursive: true } as any);
  } catch {
    // best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Test: append single event
// ---------------------------------------------------------------------------

function test_append_single_event(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const logger = new AuditLogger(logPath);

  const event = makeEvent();
  logger.log(event);
  logger.close();

  const content = fs.readFileSync(logPath, 'utf-8').trim();
  const lines = content.split('\n');
  assert(lines.length === 1, `Expected 1 line, got ${lines.length}`);

  const parsed = JSON.parse(lines[0]);
  assert(parsed.event_type === 'tool_call_blocked', 'event_type should match');
  assert(parsed.agent_name === 'test-agent', 'agent_name should match');
  assert(parsed.details.tool === 'Bash', 'details.tool should match');
  assert(typeof parsed.timestamp === 'string', 'timestamp should be a string');

  cleanup(logPath, tmpDir);
  console.log('PASS: test_append_single_event');
}

// ---------------------------------------------------------------------------
// Test: append multiple events
// ---------------------------------------------------------------------------

function test_append_multiple_events(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const logger = new AuditLogger(logPath);

  logger.log(makeEvent({ event_type: 'tool_call_blocked' }));
  logger.log(makeEvent({ event_type: 'path_access_blocked' }));
  logger.log(makeEvent({ event_type: 'agent_frozen' }));
  logger.close();

  const content = fs.readFileSync(logPath, 'utf-8').trim();
  const lines = content.split('\n');
  assert(lines.length === 3, `Expected 3 lines, got ${lines.length}`);

  // Each line should be parseable JSON
  for (let i = 0; i < lines.length; i++) {
    const parsed = JSON.parse(lines[i]);
    assert(typeof parsed.event_type === 'string', `Line ${i} should have event_type`);
    assert(typeof parsed.timestamp === 'string', `Line ${i} should have timestamp`);
  }

  cleanup(logPath, tmpDir);
  console.log('PASS: test_append_multiple_events');
}

// ---------------------------------------------------------------------------
// Test: creates file on first write
// ---------------------------------------------------------------------------

function test_creates_file_on_first_write(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'subdir', 'audit.log');

  assert(!fs.existsSync(logPath), 'File should not exist before first write');

  const logger = new AuditLogger(logPath);
  logger.log(makeEvent());
  logger.close();

  assert(fs.existsSync(logPath), 'File should exist after first write');

  const content = fs.readFileSync(logPath, 'utf-8').trim();
  const parsed = JSON.parse(content);
  assert(parsed.event_type === 'tool_call_blocked', 'Event should be written');

  cleanup(logPath, tmpDir);
  console.log('PASS: test_creates_file_on_first_write');
}

// ---------------------------------------------------------------------------
// Test: never truncates
// ---------------------------------------------------------------------------

function test_never_truncates(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');

  // Write pre-existing content
  fs.writeFileSync(logPath, '{"existing":"data"}\n');

  const logger = new AuditLogger(logPath);
  logger.log(makeEvent({ event_type: 'agent_loaded' }));
  logger.close();

  const content = fs.readFileSync(logPath, 'utf-8').trim();
  const lines = content.split('\n');
  assert(lines.length === 2, `Expected 2 lines (existing + new), got ${lines.length}`);

  // First line is the pre-existing content
  const existingLine = JSON.parse(lines[0]);
  assert(existingLine.existing === 'data', 'Pre-existing content should be preserved');

  // Second line is the new event
  const newLine = JSON.parse(lines[1]);
  assert(newLine.event_type === 'agent_loaded', 'New event should be appended');

  cleanup(logPath, tmpDir);
  console.log('PASS: test_never_truncates');
}

// ---------------------------------------------------------------------------
// Test: valid JSON per line
// ---------------------------------------------------------------------------

function test_valid_json_per_line(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const logger = new AuditLogger(logPath);

  const eventTypes: Array<AuditEvent['event_type']> = [
    'tool_call_blocked',
    'path_access_blocked',
    'integrity_check_failed',
    'agent_frozen',
    'agent_unfrozen',
  ];

  for (const eventType of eventTypes) {
    logger.log(makeEvent({ event_type: eventType }));
  }
  logger.close();

  const content = fs.readFileSync(logPath, 'utf-8').trim();
  const lines = content.split('\n');

  assert(lines.length === eventTypes.length, `Expected ${eventTypes.length} lines`);

  for (let i = 0; i < lines.length; i++) {
    let parsed: any;
    try {
      parsed = JSON.parse(lines[i]);
    } catch (err) {
      throw new Error(`Line ${i} is not valid JSON: ${lines[i]}`);
    }

    assert(typeof parsed.timestamp === 'string', `Line ${i}: timestamp must be string`);
    assert(typeof parsed.event_type === 'string', `Line ${i}: event_type must be string`);
    assert(typeof parsed.details === 'object', `Line ${i}: details must be object`);
  }

  cleanup(logPath, tmpDir);
  console.log('PASS: test_valid_json_per_line');
}

// ---------------------------------------------------------------------------
// Test: timestamp is ISO 8601
// ---------------------------------------------------------------------------

function test_timestamp_is_iso8601(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const logger = new AuditLogger(logPath);

  logger.log(makeEvent());
  logger.close();

  const content = fs.readFileSync(logPath, 'utf-8').trim();
  const parsed = JSON.parse(content);

  // ISO 8601 pattern: YYYY-MM-DDTHH:mm:ss.sssZ
  const iso8601Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;
  assert(
    iso8601Pattern.test(parsed.timestamp),
    `Timestamp '${parsed.timestamp}' should match ISO 8601 pattern`,
  );

  // Verify it's a valid date
  const date = new Date(parsed.timestamp);
  assert(!isNaN(date.getTime()), 'Timestamp should be a valid date');

  cleanup(logPath, tmpDir);
  console.log('PASS: test_timestamp_is_iso8601');
}

// ---------------------------------------------------------------------------
// Test: createAuditLogger factory
// ---------------------------------------------------------------------------

function test_create_audit_logger_factory(): void {
  const tmpDir = makeTmpDir();
  const logger = createAuditLogger(tmpDir);

  const expectedPath = path.join(tmpDir, 'data', 'agent-audit.log');
  assert(
    logger.getLogPath() === path.resolve(expectedPath),
    `Log path should be ${expectedPath}, got ${logger.getLogPath()}`,
  );

  // Write an event to verify the factory-created logger works
  logger.log(makeEvent());
  logger.close();

  assert(fs.existsSync(expectedPath), 'Log file should be created at expected path');

  cleanup(expectedPath, tmpDir);
  console.log('PASS: test_create_audit_logger_factory');
}

// ---------------------------------------------------------------------------
// Test: getLogPath returns resolved path
// ---------------------------------------------------------------------------

function test_get_log_path(): void {
  const logger = new AuditLogger('/tmp/test-audit.log');
  assert(logger.getLogPath() === '/tmp/test-audit.log', 'getLogPath should return resolved path');

  console.log('PASS: test_get_log_path');
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const tests = [
  test_append_single_event,
  test_append_multiple_events,
  test_creates_file_on_first_write,
  test_never_truncates,
  test_valid_json_per_line,
  test_timestamp_is_iso8601,
  test_create_audit_logger_factory,
  test_get_log_path,
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  try {
    test();
    passed++;
  } catch (err) {
    console.log(`FAIL: ${test.name} -- ${err}`);
    failed++;
  }
}

console.log(`\nResults: ${passed}/${tests.length} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

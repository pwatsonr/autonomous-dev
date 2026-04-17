/**
 * Tests for Scrubbing Audit Logger — SPEC-007-2-2, Task 5.
 *
 * Validates audit log entry format, per-type redaction counts,
 * processing time accuracy, and timeout logging.
 *
 * Test cases TC-2-2-09 and TC-2-2-10.
 */

import { ScrubAuditLogger, InMemoryAuditLogger } from '../../src/safety/scrub-audit';
import type {
  ScrubAuditEntry,
  ScrubContext,
  ScrubResult,
} from '../../src/safety/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<ScrubContext> = {}): ScrubContext {
  return {
    runId: 'RUN-20260408-1430',
    service: 'api-gateway',
    source: 'opensearch',
    lineCount: 50,
    ...overrides,
  };
}

function makeScrubResult(overrides: Partial<ScrubResult> = {}): ScrubResult {
  return {
    text: 'scrubbed text',
    redaction_count: 0,
    redactions: [],
    validation_passed: true,
    scrub_failed_fields: [],
    processing_time_ms: 45,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TC-2-2-09: Audit log format
// ---------------------------------------------------------------------------

describe('TC-2-2-09: Audit log format', () => {
  test('audit entry matches TDD section 3.4.5 JSON format', () => {
    const backend = new InMemoryAuditLogger();
    const logger = new ScrubAuditLogger(backend);

    const result = makeScrubResult({
      redaction_count: 49,
      redactions: [
        // 12 emails
        ...Array.from({ length: 12 }, (_, i) => ({
          type: 'email',
          position: i * 10,
          original_length: 15,
          patternName: 'email',
        })),
        // 34 IPs
        ...Array.from({ length: 34 }, (_, i) => ({
          type: 'ip',
          position: 200 + i * 10,
          original_length: 12,
          patternName: 'ipv4',
        })),
        // 2 secrets
        ...Array.from({ length: 2 }, (_, i) => ({
          type: 'secret',
          position: 600 + i * 10,
          original_length: 40,
          patternName: 'aws_access_key',
        })),
        // 1 JWT
        {
          type: 'jwt',
          position: 700,
          original_length: 100,
          patternName: 'jwt',
        },
      ],
      processing_time_ms: 45,
      validation_passed: true,
      scrub_failed_fields: [],
    });

    const context = makeContext();
    logger.logScrub(result, context);

    expect(backend.entries).toHaveLength(1);
    const entry = backend.entries[0];

    // Verify all required fields
    expect(entry.run_id).toBe('RUN-20260408-1430');
    expect(entry.service).toBe('api-gateway');
    expect(entry.source).toBe('opensearch');
    expect(entry.lines_processed).toBe(50);
    expect(entry.redactions).toEqual({
      email: 12,
      ip: 34,
      secret: 2,
      jwt: 1,
    });
    expect(entry.processing_time_ms).toBe(45);
    expect(entry.validation_passed).toBe(true);
    expect(entry.scrub_failed_fields).toEqual([]);
    expect(typeof entry.timestamp).toBe('string');
    // Timestamp should be ISO 8601
    expect(() => new Date(entry.timestamp)).not.toThrow();
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
  });

  test('audit entry JSON is serializable', () => {
    const backend = new InMemoryAuditLogger();
    const logger = new ScrubAuditLogger(backend);

    const result = makeScrubResult({
      redactions: [
        { type: 'email', position: 0, original_length: 15 },
      ],
      redaction_count: 1,
    });

    logger.logScrub(result, makeContext());

    const json = JSON.stringify(backend.entries[0]);
    const parsed = JSON.parse(json) as ScrubAuditEntry;

    expect(parsed.run_id).toBe('RUN-20260408-1430');
    expect(parsed.redactions).toEqual({ email: 1 });
  });

  test('audit entry with scrub_failed_fields', () => {
    const backend = new InMemoryAuditLogger();
    const logger = new ScrubAuditLogger(backend);

    const result = makeScrubResult({
      validation_passed: false,
      scrub_failed_fields: ['message'],
    });

    logger.logScrub(result, makeContext());

    const entry = backend.entries[0];
    expect(entry.validation_passed).toBe(false);
    expect(entry.scrub_failed_fields).toEqual(['message']);
  });

  test('per-type redaction counts aggregate correctly', () => {
    const backend = new InMemoryAuditLogger();
    const logger = new ScrubAuditLogger(backend);

    const result = makeScrubResult({
      redactions: [
        { type: 'email', position: 0, original_length: 15 },
        { type: 'email', position: 20, original_length: 18 },
        { type: 'phone', position: 40, original_length: 12 },
        { type: 'secret', position: 60, original_length: 40 },
        { type: 'email', position: 80, original_length: 16 },
      ],
      redaction_count: 5,
    });

    logger.logScrub(result, makeContext());

    expect(backend.entries[0].redactions).toEqual({
      email: 3,
      phone: 1,
      secret: 1,
    });
  });

  test('empty redactions produces empty counts object', () => {
    const backend = new InMemoryAuditLogger();
    const logger = new ScrubAuditLogger(backend);

    const result = makeScrubResult({ redactions: [], redaction_count: 0 });
    logger.logScrub(result, makeContext());

    expect(backend.entries[0].redactions).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// TC-2-2-10: Audit processing time
// ---------------------------------------------------------------------------

describe('TC-2-2-10: Audit processing time', () => {
  test('processing_time_ms is recorded from ScrubResult', () => {
    const backend = new InMemoryAuditLogger();
    const logger = new ScrubAuditLogger(backend);

    const result = makeScrubResult({ processing_time_ms: 45 });
    logger.logScrub(result, makeContext());

    expect(backend.entries[0].processing_time_ms).toBe(45);
  });

  test('processing_time_ms is a number', () => {
    const backend = new InMemoryAuditLogger();
    const logger = new ScrubAuditLogger(backend);

    const result = makeScrubResult({ processing_time_ms: 123.456 });
    logger.logScrub(result, makeContext());

    expect(typeof backend.entries[0].processing_time_ms).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Timeout logging
// ---------------------------------------------------------------------------

describe('ScrubAuditLogger.logTimeout', () => {
  test('logs error message and audit entry for timeout', () => {
    const backend = new InMemoryAuditLogger();
    const logger = new ScrubAuditLogger(backend);

    const context = makeContext();
    logger.logTimeout(context, 30_000);

    // Error message logged
    expect(backend.errors).toHaveLength(1);
    expect(backend.errors[0]).toContain('api-gateway/opensearch');
    expect(backend.errors[0]).toContain('30000ms');
    expect(backend.errors[0]).toContain('Data discarded');

    // Audit entry written
    expect(backend.entries).toHaveLength(1);
    const entry = backend.entries[0];
    expect(entry.validation_passed).toBe(false);
    expect(entry.scrub_failed_fields).toEqual(['*']);
    expect(entry.processing_time_ms).toBe(30_000);
    expect(entry.redactions).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// InMemoryAuditLogger
// ---------------------------------------------------------------------------

describe('InMemoryAuditLogger', () => {
  test('stores entries and errors', () => {
    const logger = new InMemoryAuditLogger();

    const entry: ScrubAuditEntry = {
      run_id: 'test',
      service: 'svc',
      source: 'src',
      lines_processed: 1,
      redactions: {},
      processing_time_ms: 10,
      validation_passed: true,
      scrub_failed_fields: [],
      timestamp: new Date().toISOString(),
    };

    logger.appendJson(entry);
    logger.error('test error');

    expect(logger.entries).toHaveLength(1);
    expect(logger.errors).toHaveLength(1);
  });

  test('clear() removes all entries and errors', () => {
    const logger = new InMemoryAuditLogger();

    logger.appendJson({
      run_id: 'test',
      service: 'svc',
      source: 'src',
      lines_processed: 1,
      redactions: {},
      processing_time_ms: 10,
      validation_passed: true,
      scrub_failed_fields: [],
      timestamp: new Date().toISOString(),
    });
    logger.error('error');

    logger.clear();

    expect(logger.entries).toHaveLength(0);
    expect(logger.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multiple logScrub calls
// ---------------------------------------------------------------------------

describe('Multiple audit entries', () => {
  test('each scrub invocation produces a separate entry', () => {
    const backend = new InMemoryAuditLogger();
    const logger = new ScrubAuditLogger(backend);

    logger.logScrub(
      makeScrubResult({ processing_time_ms: 10 }),
      makeContext({ runId: 'RUN-1' }),
    );
    logger.logScrub(
      makeScrubResult({ processing_time_ms: 20 }),
      makeContext({ runId: 'RUN-2' }),
    );
    logger.logScrub(
      makeScrubResult({ processing_time_ms: 30 }),
      makeContext({ runId: 'RUN-3' }),
    );

    expect(backend.entries).toHaveLength(3);
    expect(backend.entries[0].run_id).toBe('RUN-1');
    expect(backend.entries[1].run_id).toBe('RUN-2');
    expect(backend.entries[2].run_id).toBe('RUN-3');
  });
});

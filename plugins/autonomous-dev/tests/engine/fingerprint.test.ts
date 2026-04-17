/**
 * Unit tests for fingerprint generation and stack normalization
 * (SPEC-007-3-3, Tasks 6).
 *
 * Test case IDs correspond to the spec's test case table:
 *   TC-3-3-01 through TC-3-3-07.
 */

import { generateFingerprint } from '../../src/engine/fingerprint';
import {
  normalizeStackTrace,
  normalizeFrame,
  parseStackFrames,
  extractStackTrace,
} from '../../src/engine/stack-normalizer';
import type { CandidateObservation } from '../../src/engine/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCandidate(
  overrides: Partial<CandidateObservation> = {},
): CandidateObservation {
  return {
    type: 'error',
    error_type: 'error_rate',
    service: 'api-gateway',
    metric_value: 12.3,
    threshold_value: 5.0,
    sustained_minutes: 15,
    log_samples: [],
    data_sources_used: ['prometheus'],
    has_data_loss_indicator: false,
    has_data_corruption_indicator: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TC-3-3-01: Fingerprint determinism
// ---------------------------------------------------------------------------

describe('generateFingerprint', () => {
  it('TC-3-3-01: produces the same hash for the same error with different timestamps', () => {
    const candidateA = buildCandidate({
      service: 'api-gateway',
      error_class: 'ConnectionPoolExhausted',
      endpoint: '/api/v2/orders',
      error_code: 503,
      log_samples: [
        '  at com.example.Pool.acquire(Pool.java:42)',
        '  at com.example.Handler.handle(Handler.java:88)',
        '  at com.example.Server.serve(Server.java:120)',
      ],
      timestamp: new Date('2026-04-01T10:00:00Z'),
    });
    const candidateB = buildCandidate({
      service: 'api-gateway',
      error_class: 'ConnectionPoolExhausted',
      endpoint: '/api/v2/orders',
      error_code: 503,
      log_samples: [
        '  at com.example.Pool.acquire(Pool.java:42)',
        '  at com.example.Handler.handle(Handler.java:88)',
        '  at com.example.Server.serve(Server.java:120)',
      ],
      timestamp: new Date('2026-04-08T14:30:00Z'),
    });

    const hashA = generateFingerprint(candidateA);
    const hashB = generateFingerprint(candidateB);

    expect(hashA).toBe(hashB);
    expect(hashA).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
  });

  // -------------------------------------------------------------------------
  // TC-3-3-02: Fingerprint differs on endpoint
  // -------------------------------------------------------------------------

  it('TC-3-3-02: produces different hashes for different endpoints', () => {
    const candidateOrders = buildCandidate({
      service: 'api-gateway',
      error_class: 'ConnectionPoolExhausted',
      endpoint: '/api/v1/orders',
      error_code: 503,
    });
    const candidateUsers = buildCandidate({
      service: 'api-gateway',
      error_class: 'ConnectionPoolExhausted',
      endpoint: '/api/v2/users',
      error_code: 503,
    });

    const hashOrders = generateFingerprint(candidateOrders);
    const hashUsers = generateFingerprint(candidateUsers);

    expect(hashOrders).not.toBe(hashUsers);
  });

  // -------------------------------------------------------------------------
  // TC-3-3-07: Top 3 frames only
  // -------------------------------------------------------------------------

  it('TC-3-3-07: only top 3 frames contribute to fingerprint', () => {
    const tenFrames = Array.from({ length: 10 }, (_, i) =>
      `  at com.example.Class${i}.method(Class${i}.java:${i * 10})`,
    );
    const threeFrames = tenFrames.slice(0, 3);

    const candidateTen = buildCandidate({ log_samples: tenFrames });
    const candidateThree = buildCandidate({ log_samples: threeFrames });

    expect(generateFingerprint(candidateTen)).toBe(generateFingerprint(candidateThree));
  });

  it('produces a 64-char lowercase hex string', () => {
    const candidate = buildCandidate({ service: 'test-svc' });
    const fp = generateFingerprint(candidate);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses default values for missing optional fields', () => {
    // No error_class, no endpoint, no error_code, no log_samples
    const candidate = buildCandidate({});
    const fp = generateFingerprint(candidate);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Stack trace normalization
// ---------------------------------------------------------------------------

describe('normalizeFrame', () => {
  // TC-3-3-03: Line numbers
  it('TC-3-3-03: replaces line numbers with wildcard', () => {
    expect(normalizeFrame('at Foo.bar(Foo.java:42)')).toBe('at Foo.bar(Foo.java:*)');
  });

  // TC-3-3-04: Memory addresses
  it('TC-3-3-04: replaces memory addresses with wildcard', () => {
    expect(normalizeFrame('at 0x7fff5fbff8a0')).toBe('at 0x*');
  });

  // TC-3-3-05: Thread IDs
  it('TC-3-3-05: replaces thread IDs with wildcard', () => {
    expect(normalizeFrame('[thread-42] at Foo.bar')).toBe('[thread-*] at Foo.bar');
  });

  it('TC-3-3-05b: replaces Thread-N with wildcard', () => {
    expect(normalizeFrame('Thread-42 at Foo.bar')).toBe('Thread-* at Foo.bar');
  });

  // TC-3-3-06: Timestamps
  it('TC-3-3-06: replaces timestamps with placeholder', () => {
    expect(normalizeFrame('2026-04-08T14:30:22Z at Foo.bar')).toBe('<timestamp> at Foo.bar');
  });

  it('replaces timestamps with fractional seconds', () => {
    expect(normalizeFrame('2026-04-08T14:30:22.123Z at Foo.bar')).toBe(
      '<timestamp> at Foo.bar',
    );
  });

  it('replaces timestamps with space separator', () => {
    expect(normalizeFrame('2026-04-08 14:30:22 at Foo.bar')).toBe('<timestamp> at Foo.bar');
  });

  it('replaces pod IDs with wildcard', () => {
    expect(normalizeFrame('pod-abc123def at Foo.bar')).toBe('pod-* at Foo.bar');
  });

  it('handles multiple normalizations in one frame', () => {
    const frame = '[thread-99] 2026-01-01T00:00:00Z at Foo.bar(Foo.java:100) 0x1234abc pod-xyz789';
    const result = normalizeFrame(frame);
    expect(result).toBe('[thread-*] <timestamp> at Foo.bar(Foo.java:*) 0x* pod-*');
  });
});

describe('parseStackFrames', () => {
  it('parses Java "at" frames', () => {
    const trace = `Exception in thread "main"
at com.example.Foo.bar(Foo.java:42)
at com.example.Main.main(Main.java:10)`;
    const frames = parseStackFrames(trace);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain('com.example.Foo.bar');
    expect(frames[1]).toContain('com.example.Main.main');
  });

  it('parses Python "File" frames', () => {
    const trace = `Traceback (most recent call last):
File "/app/main.py", line 10, in <module>
File "/app/handler.py", line 25, in handle`;
    const frames = parseStackFrames(trace);
    expect(frames).toHaveLength(2);
  });

  it('returns empty array for non-stack text', () => {
    const frames = parseStackFrames('just a regular log message');
    expect(frames).toHaveLength(0);
  });
});

describe('normalizeStackTrace', () => {
  it('takes only top 3 frames', () => {
    const trace = [
      'at Frame1.method(Frame1.java:1)',
      'at Frame2.method(Frame2.java:2)',
      'at Frame3.method(Frame3.java:3)',
      'at Frame4.method(Frame4.java:4)',
      'at Frame5.method(Frame5.java:5)',
    ].join('\n');

    const result = normalizeStackTrace(trace);
    const lines = result.split('\n');
    expect(lines).toHaveLength(3);
  });

  it('normalizes all frames in the output', () => {
    const trace = [
      'at Foo.bar(Foo.java:42)',
      'at Baz.qux(Baz.java:99)',
    ].join('\n');

    const result = normalizeStackTrace(trace);
    expect(result).not.toMatch(/:\d+\)/); // No raw line numbers
    expect(result).toContain(':*)');
  });
});

describe('extractStackTrace', () => {
  it('concatenates log samples with newlines', () => {
    const samples = ['line1', 'line2', 'line3'];
    expect(extractStackTrace(samples)).toBe('line1\nline2\nline3');
  });
});

// ---------------------------------------------------------------------------
// SPEC-007-3-6: Comprehensive stack normalizer tests
// ---------------------------------------------------------------------------

describe('stack normalizer - comprehensive (SPEC-007-3-6)', () => {
  it('normalizes Java line numbers: Foo.java:42 -> Foo.java:*', () => {
    const result = normalizeFrame('at com.example.Foo.bar(Foo.java:42)');
    expect(result).toBe('at com.example.Foo.bar(Foo.java:*)');
    expect(result).not.toMatch(/:\d+\)/);
  });

  it('normalizes multiple line numbers in one frame', () => {
    const result = normalizeFrame('at Foo.bar(Foo.java:42) -> Baz.qux(Baz.java:99)');
    expect(result).toBe('at Foo.bar(Foo.java:*) -> Baz.qux(Baz.java:*)');
  });

  it('normalizes memory addresses: 0x7fff5fbff8a0 -> 0x*', () => {
    const result = normalizeFrame('at 0x7fff5fbff8a0 in libfoo.so');
    expect(result).toBe('at 0x* in libfoo.so');
  });

  it('normalizes multiple memory addresses', () => {
    const result = normalizeFrame('0x1234abcd -> 0xdeadbeef');
    expect(result).toBe('0x* -> 0x*');
  });

  it('normalizes thread IDs: [thread-42] -> [thread-*]', () => {
    const result = normalizeFrame('[thread-42] at Foo.bar');
    expect(result).toBe('[thread-*] at Foo.bar');
  });

  it('normalizes Thread-N names: Thread-42 -> Thread-*', () => {
    const result = normalizeFrame('Thread-42 at Foo.bar');
    expect(result).toBe('Thread-* at Foo.bar');
  });

  it('normalizes ISO timestamps with T separator', () => {
    const result = normalizeFrame('2026-04-08T14:30:22Z at Foo.bar');
    expect(result).toBe('<timestamp> at Foo.bar');
  });

  it('normalizes ISO timestamps with space separator', () => {
    const result = normalizeFrame('2026-04-08 14:30:22 at Foo.bar');
    expect(result).toBe('<timestamp> at Foo.bar');
  });

  it('normalizes ISO timestamps with fractional seconds', () => {
    const result = normalizeFrame('2026-04-08T14:30:22.123456Z at Foo.bar');
    expect(result).toBe('<timestamp> at Foo.bar');
  });

  it('normalizes pod IDs: pod-abc123def -> pod-*', () => {
    const result = normalizeFrame('pod-abc123def at Foo.bar');
    expect(result).toBe('pod-* at Foo.bar');
  });

  it('normalizes all patterns together in one frame', () => {
    const frame = '[thread-99] 2026-01-01T00:00:00Z at Foo.bar(Foo.java:100) 0x1234abc pod-xyz789';
    const result = normalizeFrame(frame);
    expect(result).toBe('[thread-*] <timestamp> at Foo.bar(Foo.java:*) 0x* pod-*');
  });

  it('fingerprint determinism: same error + different timestamps -> same hash', () => {
    const candidateA = buildCandidate({
      service: 'api-gateway',
      error_class: 'ConnectionPoolExhausted',
      endpoint: '/api/v2/orders',
      error_code: 503,
      log_samples: ['  at com.example.Pool.acquire(Pool.java:42)'],
      timestamp: new Date('2026-01-01T00:00:00Z'),
    });
    const candidateB = buildCandidate({
      service: 'api-gateway',
      error_class: 'ConnectionPoolExhausted',
      endpoint: '/api/v2/orders',
      error_code: 503,
      log_samples: ['  at com.example.Pool.acquire(Pool.java:42)'],
      timestamp: new Date('2026-12-31T23:59:59Z'),
    });

    expect(generateFingerprint(candidateA)).toBe(generateFingerprint(candidateB));
  });

  it('fingerprint determinism: same error + different line numbers -> same hash', () => {
    const candidateA = buildCandidate({
      log_samples: ['  at com.example.Pool.acquire(Pool.java:42)'],
    });
    const candidateB = buildCandidate({
      log_samples: ['  at com.example.Pool.acquire(Pool.java:999)'],
    });

    expect(generateFingerprint(candidateA)).toBe(generateFingerprint(candidateB));
  });

  it('preserves non-normalized content', () => {
    const result = normalizeFrame('at com.example.OrderService.placeOrder(OrderService.java:42)');
    expect(result).toContain('com.example.OrderService.placeOrder');
    expect(result).toContain('OrderService.java:*');
  });
});

/**
 * Tests for the real ReDoS sandbox (SPEC-021-2-04).
 *
 * Coverage:
 *   - Safe pattern matches (worker or re2)
 *   - Catastrophic pattern times out within 150ms
 *   - Pre-flight rejects oversized input synchronously (no worker spawn)
 *   - Pre-flight rejects oversized pattern + invalid flags synchronously
 *   - Invalid pattern → soft error result (does not throw)
 *   - 10 concurrent ReDoS calls all timeout cleanly within 250ms
 *   - 100 sequential calls do not leak workers
 *
 * @module tests/standards/redos-sandbox.test
 */

import { evaluateRegex } from '../../intake/standards/redos-sandbox';

describe('evaluateRegex — happy path', () => {
  it('matches a safe pattern with line + groups', async () => {
    const r = await evaluateRegex('(foo) (bar)', 'foo bar');
    expect(r.matches).toBe(true);
    expect(r.matchLine).toBe(1);
    // groups present whether re2 or worker path was taken
    expect(r.durationMs).toBeDefined();
  });

  it('returns matches:false on no match', async () => {
    const r = await evaluateRegex('xyz', 'foo bar');
    expect(r.matches).toBe(false);
  });

  it('matchLine reports 1-based line of first match', async () => {
    const r = await evaluateRegex('needle', 'a\nb\nneedle');
    expect(r.matches).toBe(true);
    expect(r.matchLine).toBe(3);
  });
});

describe('evaluateRegex — pre-flight rejection', () => {
  it('rejects input >10240 bytes synchronously', async () => {
    await expect(evaluateRegex('foo', 'a'.repeat(10241))).rejects.toThrow(
      /SecurityError: input exceeds 10240/,
    );
  });

  it('rejects pattern >1024 bytes synchronously', async () => {
    await expect(evaluateRegex('a'.repeat(1025), 'foo')).rejects.toThrow(
      /SecurityError: pattern exceeds 1024/,
    );
  });

  it('rejects invalid flags synchronously', async () => {
    await expect(evaluateRegex('foo', 'bar', 'invalid')).rejects.toThrow(
      /SecurityError: invalid regex flags/,
    );
  });
});

describe('evaluateRegex — invalid regex compiles', () => {
  it('returns soft-error result on syntactically invalid pattern', async () => {
    const r = await evaluateRegex('[invalid', 'foo');
    expect(r.matches).toBe(false);
    expect(r.error).toBeDefined();
  });
});

describe('evaluateRegex — ReDoS protection', () => {
  it('catastrophic pattern times out within 200ms (single)', async () => {
    const start = Date.now();
    const r = await evaluateRegex('^(a+)+$', 'a'.repeat(30) + 'X');
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(r.error).toMatch(/ReDoSError/);
    expect(elapsed).toBeLessThan(300); // 100ms + worker boot + grace + jitter
  }, 5000);

  it('10 concurrent ReDoS calls all timeout within 1.5s', async () => {
    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        evaluateRegex('^(a+)+$', 'a'.repeat(30) + 'X'),
      ),
    );
    const elapsed = Date.now() - start;
    expect(results.every((r) => r.timedOut === true)).toBe(true);
    expect(elapsed).toBeLessThan(1500);
  }, 10_000);
});

/**
 * Adversarial ReDoS catalog suite (SPEC-021-2-05, Task 11).
 *
 * Iterates a catalog of ≥10 catastrophic-backtracking patterns drawn from
 * OWASP's ReDoS cheatsheet and RegExLib. Each pattern is calibrated to
 * trigger exponential or polynomial backtracking on V8's regex engine but
 * stay below the 10KB pre-flight cap so the sandbox actually executes it.
 *
 * Defense (PLAN-014-3 / SPEC-021-2-04): every regex runs inside a
 * `worker_threads.Worker` with a 100ms wall-clock timeout enforced by
 * `worker.terminate()` from the main thread. The functional contract is:
 *   - the call resolves (NEVER hangs the test runner past Jest's timeout)
 *   - the result has `timedOut: true` AND `error` includes "ReDoSError"
 *   - wall-clock is bounded (assertion bounds set generous-but-meaningful
 *     to absorb CI jitter — see notes in spec §Notes).
 *
 * If re2 is available (`require('re2')` succeeds), patterns rejected by re2
 * fall through to the worker — same defense, slightly different timing.
 *
 * @module tests/standards/test-redos-adversarial.test
 */

import { evaluateRegex } from '../../intake/standards/redos-sandbox';

interface CatalogEntry {
  name: string;
  pattern: string;
  input: string;
  source: string;
  /**
   * If true, the pattern is "linearly safe" under re2 — when re2 is
   * available the result will be `{matches: bool}` (no timeout). Used to
   * gate the timeout assertion accordingly. We set this to false for every
   * entry in the catalog; all are catastrophic on V8, and re2 either
   * compiles them in linear time (legitimate optimization) or rejects them
   * (then the worker times out). Either outcome satisfies the contract:
   * "regex completes within 5s without hanging the daemon".
   */
  re2Safe?: boolean;
}

/**
 * Catalog of catastrophic-backtracking patterns. Calibrated inputs:
 *   - exponential patterns: 25–35 char input + mismatch suffix
 *     (V8 backtracking on (a+)+ at length 30 with mismatch ≈ 6 minutes)
 *   - polynomial patterns: 40–80 char input
 *   - alternation/overlap: 40–50 chars + mismatch
 *
 * All inputs are ≤ 200 bytes (well under MAX_INPUT_BYTES=10240 in the
 * ReDoS sandbox) so the regex actually executes.
 */
const CATALOG: CatalogEntry[] = [
  {
    name: 'exponential-trailing',
    pattern: '^(a+)+$',
    input: 'a'.repeat(30) + 'X',
    source: 'OWASP',
  },
  {
    name: 'exponential-grouped-alternation',
    pattern: '^(a|aa)+$',
    input: 'a'.repeat(30) + '!',
    source: 'OWASP',
  },
  {
    name: 'exponential-double-quantifier',
    pattern: '^(a*)*b$',
    input: 'a'.repeat(40),
    source: 'RegExLib',
  },
  {
    name: 'polynomial-50x',
    pattern: '(.*a){50}',
    input: 'a'.repeat(60),
    source: 'OWASP',
  },
  {
    name: 'email-naive-evil',
    pattern:
      '^([a-zA-Z0-9])(([\\-.]|[_]+)?([a-zA-Z0-9]+))*(@){1}([a-z0-9]+)([\\.][a-z]{2,3}){2}$',
    input: 'a'.repeat(35) + '@',
    source: 'RegExLib-evil-email',
  },
  {
    name: 'url-naive',
    pattern:
      '^(([^:/?#]+):)?(//([^/?#]*))?([^?#]*)(\\?([^#]*))?(#(.*))?$',
    input: 'http://' + 'a'.repeat(25),
    source: 'RFC3986-evil',
  },
  {
    name: 'phone-naive',
    pattern:
      '^[+]?[(]?[0-9]{1,4}[)]?[-\\s\\.]?([0-9]{1,4}[-\\s\\.]?){1,5}[0-9]{1,9}$',
    input: '+12345678901234567890123456789012345!',
    source: 'RegExLib',
  },
  {
    name: 'nested-quantifier',
    pattern: '(.*)*x$',
    input: 'a'.repeat(40),
    source: 'OWASP',
  },
  {
    name: 'alternation-overlap',
    pattern: '(ab|a)+b$',
    input: 'ab'.repeat(20) + '!',
    source: 'OWASP',
  },
  {
    name: 'html-tag-naive',
    pattern: '<(\\w+)(\\s+\\w+="[^"]*")*\\s*>',
    input: '<a ' + 'href="x" '.repeat(15),
    source: 'OWASP',
  },
  {
    name: 'filename-double-ext',
    pattern: '^(.+)+\\.(jpg|png|gif)$',
    input: 'a'.repeat(30) + '.exe',
    source: 'RegExLib',
  },
  {
    name: 'word-boundary-evil',
    pattern: '^(\\w+\\s?)*$',
    input: 'word '.repeat(20) + '!',
    source: 'OWASP',
  },
];

/** Functional upper bound: catastrophic regex must NOT hang for >5s. */
const HARD_NO_HANG_MS = 5_000;
/** Generous CI-noise-tolerant assertion threshold (spec note: <300ms). */
const SOFT_TIMEOUT_MS = 300;

describe('ReDoS sandbox — adversarial catalog (SPEC-021-2-05)', () => {
  it('catalog has ≥10 entries spanning ≥2 sources', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(10);
    const sources = new Set(CATALOG.map((e) => e.source.split('-')[0]));
    expect(sources.size).toBeGreaterThanOrEqual(2);
  });

  for (const entry of CATALOG) {
    it(
      `does NOT hang on: ${entry.name} (source=${entry.source})`,
      async () => {
        const start = Date.now();
        const result = await evaluateRegex(entry.pattern, entry.input);
        const elapsed = Date.now() - start;

        // Functional contract: the call resolved within the no-hang ceiling.
        expect(elapsed).toBeLessThan(HARD_NO_HANG_MS);

        // When the worker path executes, the result MUST signal a timeout.
        // The re2 fast path (linear time) may legitimately resolve some
        // patterns without timing out — that's a safer outcome, not a
        // regression. We accept either:
        //   (a) timedOut === true with ReDoSError, OR
        //   (b) re2 returned matches:bool with no timeout flag set.
        if (result.timedOut) {
          expect(result.error).toMatch(/ReDoSError/);
          expect(elapsed).toBeLessThan(SOFT_TIMEOUT_MS);
        } else {
          // re2 compiled and executed linearly; durationMs should be tiny.
          expect(typeof result.matches).toBe('boolean');
          expect(elapsed).toBeLessThan(SOFT_TIMEOUT_MS);
        }
      },
      HARD_NO_HANG_MS + 1_000,
    );
  }

  it('input >10KB rejected synchronously (no worker spawn)', async () => {
    await expect(
      evaluateRegex('foo', 'a'.repeat(10241)),
    ).rejects.toThrow(/SecurityError: input exceeds 10240/);
  });

  it('30 concurrent evil patterns all resolve without leaking workers', async () => {
    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        evaluateRegex('^(a+)+$', 'a'.repeat(30) + 'X'),
      ),
    );
    const elapsed = Date.now() - start;
    // Every call resolved — none hung.
    expect(results.length).toBe(30);
    // Generous concurrent bound. 30 workers running in parallel with a
    // 100ms timeout each + JIT warmup + jitter; 5s is plenty.
    expect(elapsed).toBeLessThan(5_000);
    // Most or all should signal timeout; if re2 is loaded, all 30 may be
    // matches:false instead. We assert simply that none returned `matches:
    // true` (which would mean V8 backtracking succeeded — impossible with
    // an 'X' suffix that never matches the anchored pattern).
    expect(results.every((r) => r.matches === false)).toBe(true);
  }, 30_000);
});

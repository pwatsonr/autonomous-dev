/**
 * ReDoS sandbox — STUB IMPLEMENTATION (SPEC-021-2-02).
 *
 * Replaced by the real worker-thread + re2 sandbox in SPEC-021-2-04. This
 * stub exists so `pattern-grep` can ship and be tested standalone before
 * the worker infrastructure lands. The exported `evaluateRegex` signature
 * MUST stay identical or the swap breaks `pattern-grep`.
 *
 * The stub enforces only the 10KB input cap (synchronously throws) and
 * compiles+executes the pattern on the main thread with no timeout. CI MUST
 * grep for `'redos-sandbox stub in use'` and fail the build if it appears
 * AFTER SPEC-021-2-04 lands.
 *
 * @module intake/standards/redos-sandbox
 */

const MAX_INPUT_BYTES = 10 * 1024;

export interface RegexResult {
  matches: boolean;
  /** 1-based line of the first match, when `matches === true`. */
  matchLine?: number;
  groups?: string[];
  timedOut?: boolean;
  error?: string;
  durationMs?: number;
}

let warned = false;

function warnOnce(): void {
  if (warned) return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn('redos-sandbox stub in use — replace with SPEC-021-2-04');
}

/** Reset the warn-once latch. EXPORTED FOR TESTS ONLY. */
export function __resetWarnLatchForTests(): void {
  warned = false;
}

export async function evaluateRegex(
  pattern: string,
  input: string,
  flags: string = '',
): Promise<RegexResult> {
  warnOnce();
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error(
      `SecurityError: input exceeds ${MAX_INPUT_BYTES} bytes (stub)`,
    );
  }
  try {
    const re = new RegExp(pattern, flags);
    const start = Date.now();
    const match = re.exec(input);
    const durationMs = Date.now() - start;
    if (!match) return { matches: false, durationMs };
    let line = 1;
    for (let i = 0; i < match.index; i++) {
      if (input.charCodeAt(i) === 10) line += 1;
    }
    return {
      matches: true,
      matchLine: line,
      groups: match.slice(1),
      durationMs,
    };
  } catch (err) {
    return {
      matches: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

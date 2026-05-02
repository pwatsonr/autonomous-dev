/**
 * ReDoS sandbox — REAL IMPLEMENTATION (SPEC-021-2-04).
 *
 * Replaces the SPEC-021-2-02 stub. Every user-supplied regex against
 * untrusted input runs inside a `worker_threads.Worker` with a hard 100ms
 * wall-clock timeout enforced by the main-thread setTimeout +
 * worker.terminate() pair. A worker-side timer cannot fire while the V8
 * regex engine is actively backtracking — terminate() from the parent is
 * the only way to interrupt the regex VM at a safepoint.
 *
 * Optional re2 fast path: when `require('re2')` succeeds at module load
 * (re2 is declared in optionalDependencies so npm install proceeds without
 * a C++ toolchain), `evaluateRegex` test-compiles the pattern with re2 and,
 * on success, executes the match on the main thread (linear time, ~5ms for
 * safe patterns vs ~50ms via the worker). When re2 is absent or rejects
 * the pattern (re2 doesn't support every PCRE feature), we fall back to
 * the worker.
 *
 * Pre-flight validation runs synchronously on the main thread:
 *   - input  ≤ 10240 bytes
 *   - pattern ≤ 1024 bytes
 *   - flags ⊆ [gimsuy]
 * Pre-flight throws synchronously (before any worker spawn) so a fork-bomb
 * caller cannot DoS the daemon by streaming oversized inputs.
 *
 * Implementation note re: PLAN-021-2 path mapping. The pre-flagged path
 * mapping suggested re-exporting from `intake/security/regex-sandbox.ts`
 * (the PLAN-014-3 sandbox under `plugins/autonomous-dev-portal/`). That
 * implementation uses Bun-specific `import.meta.resolve` for the worker
 * URL which doesn't load cleanly under Node + ts-jest. To avoid coupling
 * the standards module to the portal's runtime substrate, we ship a
 * Node-native equivalent here. TODO: consolidate when the portal sandbox
 * is repackaged for Node.
 *
 * @module intake/standards/redos-sandbox
 */

import { Worker } from 'node:worker_threads';
import { resolve as resolvePath } from 'node:path';

const MAX_INPUT_BYTES = 10 * 1024;
const MAX_PATTERN_BYTES = 1024;
const TIMEOUT_MS = 100;
/** Grace window after terminate() to allow the late `exit` event. */
const HARD_KILL_GRACE_MS = 50;
const VALID_FLAGS_RE = /^[gimsuy]*$/;

export interface RegexResult {
  matches: boolean;
  /** 1-based line of the first match, when `matches === true`. */
  matchLine?: number;
  groups?: string[];
  timedOut?: boolean;
  error?: string;
  durationMs?: number;
}

// Optional re2 fast path. The `require` is wrapped to survive missing
// native bindings on minimal CI containers without a C++ toolchain.
type Re2Ctor = new (pattern: string, flags?: string) => {
  exec: (input: string) => RegExpExecArray | null;
};
let re2: Re2Ctor | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  re2 = require('re2') as Re2Ctor;
} catch {
  re2 = null;
}

/** Reset re2 binding. EXPORTED FOR TESTS ONLY. */
export function __setRe2ForTests(value: Re2Ctor | null): void {
  re2 = value;
}

/** Reset whatever warn-once latch may exist (no-op now; preserved for API parity). */
export function __resetWarnLatchForTests(): void {
  // No warn-once latch in the real implementation. Symbol kept so tests
  // written against the SPEC-021-2-02 stub continue to compile.
}

// Worker file is .cjs because package.json declares "type": "module" — Node
// would otherwise interpret a .js worker file as ESM and reject the
// `require()` calls that node:worker_threads relies on. The .cjs extension
// is the documented Node escape hatch for CommonJS files in an ESM package.
const WORKER_PATH = resolvePath(__dirname, 'regex-worker.cjs');

function lineOf(input: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (input.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export async function evaluateRegex(
  pattern: string,
  input: string,
  flags: string = '',
): Promise<RegexResult> {
  // 1) Pre-flight (synchronous throws).
  if (typeof input !== 'string') {
    throw new Error('SecurityError: input must be a string');
  }
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error(
      `SecurityError: input exceeds ${MAX_INPUT_BYTES} bytes (got ${Buffer.byteLength(
        input,
        'utf8',
      )})`,
    );
  }
  if (typeof pattern !== 'string') {
    throw new Error('SecurityError: pattern must be a string');
  }
  if (Buffer.byteLength(pattern, 'utf8') > MAX_PATTERN_BYTES) {
    throw new Error(
      `SecurityError: pattern exceeds ${MAX_PATTERN_BYTES} bytes`,
    );
  }
  if (typeof flags !== 'string' || !VALID_FLAGS_RE.test(flags)) {
    throw new Error(`SecurityError: invalid regex flags "${flags}"`);
  }

  // 2) Optional re2 fast path.
  if (re2) {
    try {
      const compiled = new re2(pattern, flags);
      const start = Date.now();
      const match = compiled.exec(input);
      const durationMs = Date.now() - start;
      if (!match) return { matches: false, durationMs };
      return {
        matches: true,
        matchLine: lineOf(input, match.index),
        groups: match.slice(1),
        durationMs,
      };
    } catch {
      // re2 doesn't accept this pattern (e.g. lookbehind in old binding) —
      // fall through to the worker.
    }
  }

  // 3) Worker fallback.
  return runInWorker(pattern, flags, input);
}

function runInWorker(
  pattern: string,
  flags: string,
  input: string,
): Promise<RegexResult> {
  return new Promise<RegexResult>((resolveResult) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { pattern, flags, input },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });

    let settled = false;
    const settle = (r: RegexResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      // terminate() is async + idempotent. We don't await — the message
      // we already received is what matters; the OS reaps the worker.
      void worker.terminate();
      resolveResult(r);
    };

    const timer = setTimeout(() => {
      settle({
        matches: false,
        timedOut: true,
        error: 'ReDoSError: regex execution exceeded 100ms',
      });
    }, TIMEOUT_MS);

    // Defensive: if terminate() doesn't free the worker fast enough,
    // ensure we still resolve at TIMEOUT + grace.
    const graceTimer = setTimeout(() => {
      if (!settled) {
        settle({
          matches: false,
          timedOut: true,
          error: 'ReDoSError: regex execution exceeded 100ms',
        });
      }
    }, TIMEOUT_MS + HARD_KILL_GRACE_MS);
    graceTimer.unref?.();

    worker.on('message', (msg: RegexResult) => {
      settle(msg);
    });
    worker.on('error', (err: Error) => {
      settle({ matches: false, error: `Worker error: ${err.message}` });
    });
    worker.on('exit', (code) => {
      if (settled) return;
      if (code === 0) {
        settle({ matches: false });
      } else {
        settle({ matches: false, error: `Worker exited code ${code}` });
      }
    });
  });
}

# SPEC-021-2-04: ReDoS Sandbox + runEvaluator Orchestrator + Evaluators CLI

## Metadata
- **Parent Plan**: PLAN-021-2
- **Tasks Covered**: Task 7 (ReDoS sandbox), Task 9 (runEvaluator orchestrator), Task 10 (evaluators CLI)
- **Estimated effort**: 9 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-021-2-04-redos-sandbox-runner-cli.md`

## Description

Replace the `redos-sandbox.ts` stub from SPEC-021-2-02 with the real worker-thread isolation, then build the unified `runEvaluator()` orchestrator that any consumer (rule-set-enforcement-reviewer, future plans) calls to evaluate a rule, and finally expose `evaluators list` and `evaluators add` CLI subcommands.

Three pieces, one delivery:

1. **ReDoS sandbox** (`src/standards/redos-sandbox.ts` + `src/standards/regex-worker.js`): every regex against untrusted input runs inside a `worker_threads.Worker`. Hard 100ms wall-clock timeout enforced by `setTimeout` + `worker.terminate()` on the main thread (worker-side timers cannot interrupt regex execution because the regex engine holds the worker's event loop). 10KB input cap rejected on the main thread before the worker is spawned. Optional `re2` dependency: when `require('re2')` succeeds at module load, `evaluateRegex()` test-compiles the pattern with `re2` first; if compilation succeeds, `re2` (linear-time engine) executes the match directly on the main thread, bypassing the worker entirely. If `re2` is unavailable or rejects the pattern (re2 doesn't support all PCRE features), fall back to the worker.

2. **`runEvaluator()` orchestrator** (`src/standards/runner.ts`): the single entry point any caller uses. Takes `(rule, files, ctx)`, resolves the rule's `evaluator` field via `EvaluatorRegistry.get(...)`, dispatches to the in-process built-in handler OR `runCustomEvaluator()` from the sandbox, wraps result errors in `EvaluatorRunError` with the rule ID, returns `EvaluatorResult` (with `rule_id` injected into each finding).

3. **Evaluators CLI** (`src/cli/commands/evaluators.ts`): two subcommands. `autonomous-dev evaluators list` prints a table (name, type, path) of all registered evaluators. `autonomous-dev evaluators add <abs-path>` requires admin auth (delegated to the existing PRD-009 / TDD-009 admin helper), appends the path to `extensions.evaluators_allowlist`, persists the config file atomically, and sends SIGUSR1 to the daemon to trigger `EvaluatorRegistry.reload()`.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/standards/redos-sandbox.ts` | Replace | Was a stub in SPEC-021-2-02; this spec ships the real worker + re2 path |
| `plugins/autonomous-dev/src/standards/regex-worker.js` | Create | Worker entrypoint; ships as JS (not TS) so it loads without compile step |
| `plugins/autonomous-dev/src/standards/runner.ts` | Create | `runEvaluator(rule, files, ctx)` orchestrator |
| `plugins/autonomous-dev/src/standards/types.ts` | Modify | Add `RegexResult`, `EvaluatorRunOptions` types if not yet present |
| `plugins/autonomous-dev/src/cli/commands/evaluators.ts` | Create | `evaluators list` and `evaluators add` subcommand handlers |
| `plugins/autonomous-dev/src/cli/index.ts` | Modify | Wire the new subcommand into the existing CLI dispatcher |
| `plugins/autonomous-dev/package.json` | Modify | Declare `re2` as `optionalDependencies` |
| `plugins/autonomous-dev/tests/standards/redos-sandbox.test.ts` | Create | Worker timeout, re2 path, input-cap rejection, concurrent calls |
| `plugins/autonomous-dev/tests/standards/runner.test.ts` | Create | Built-in dispatch, custom dispatch, error wrapping, rule_id injection |
| `plugins/autonomous-dev/tests/cli/evaluators.test.ts` | Create | `list` columns; `add` admin-only; SIGUSR1 trigger |

## Implementation Details

### Constants (`redos-sandbox.ts`)

```typescript
const MAX_INPUT_BYTES   = 10 * 1024;     // 10 KB
const TIMEOUT_MS        = 100;
const HARD_KILL_GRACE_MS = 50;           // grace after terminate() before resolving
const MAX_PATTERN_BYTES  = 1024;         // 1 KB - prevents pathological pattern compile time
const VALID_FLAGS_RE     = /^[gimsuy]*$/;
```

### `redos-sandbox.ts` (real implementation)

```typescript
import { Worker } from 'node:worker_threads';
import { resolve as resolvePath } from 'node:path';

export interface RegexResult {
  matches: boolean;
  matchLine?: number;       // 1-based, populated when matches=true
  groups?: string[];
  timedOut?: boolean;
  error?: string;
  durationMs?: number;
}

let re2: typeof RegExp | null = null;
try {
  // Optional dep — module load failure must not crash the daemon.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  re2 = require('re2');
} catch {
  re2 = null;
}

const WORKER_PATH = resolvePath(__dirname, 'regex-worker.js');

export async function evaluateRegex(
  pattern: string,
  input: string,
  flags: string = '',
): Promise<RegexResult> {
  // 1) Pre-flight validation on the main thread.
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error(`SecurityError: input exceeds ${MAX_INPUT_BYTES} bytes (got ${Buffer.byteLength(input, 'utf8')})`);
  }
  if (Buffer.byteLength(pattern, 'utf8') > MAX_PATTERN_BYTES) {
    throw new Error(`SecurityError: pattern exceeds ${MAX_PATTERN_BYTES} bytes`);
  }
  if (!VALID_FLAGS_RE.test(flags)) {
    throw new Error(`SecurityError: invalid regex flags "${flags}"`);
  }

  // 2) Try the re2 fast path (linear time, runs on main thread).
  if (re2) {
    try {
      const compiled = new (re2 as any)(pattern, flags);
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
      // re2 doesn't support all PCRE features (e.g., lookbehind in older versions).
      // Fall through to worker.
    }
  }

  // 3) Worker-thread fallback.
  return runInWorker(pattern, flags, input);
}

function runInWorker(pattern: string, flags: string, input: string): Promise<RegexResult> {
  return new Promise((resolveResult) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { pattern, flags, input },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    let settled = false;
    const settle = (r: RegexResult) => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => undefined);
      resolveResult(r);
    };
    const timer = setTimeout(() => {
      settle({ matches: false, timedOut: true, error: 'ReDoSError: regex execution exceeded 100ms' });
    }, TIMEOUT_MS);
    worker.on('message', (msg: RegexResult) => {
      clearTimeout(timer);
      settle(msg);
    });
    worker.on('error', (err) => {
      clearTimeout(timer);
      settle({ matches: false, error: `Worker error: ${err.message}` });
    });
    worker.on('exit', (code) => {
      clearTimeout(timer);
      if (!settled && code !== 0) {
        settle({ matches: false, error: `Worker exited code ${code}` });
      }
    });
  });
}

function lineOf(input: string, offset: number): number {
  // 1-based line number for `offset` in `input`.
  let line = 1;
  for (let i = 0; i < offset; i++) if (input.charCodeAt(i) === 10) line++;
  return line;
}
```

### `regex-worker.js` (worker entrypoint, JS for direct load)

```javascript
const { parentPort, workerData } = require('node:worker_threads');

if (!parentPort) {
  process.exit(1);
}

try {
  const { pattern, flags, input } = workerData;
  const re = new RegExp(pattern, flags);
  const start = Date.now();
  const match = re.exec(input);
  const durationMs = Date.now() - start;
  if (!match) {
    parentPort.postMessage({ matches: false, durationMs });
  } else {
    let line = 1;
    for (let i = 0; i < match.index; i++) if (input.charCodeAt(i) === 10) line++;
    parentPort.postMessage({
      matches: true,
      matchLine: line,
      groups: Array.from(match).slice(1),
      durationMs,
    });
  }
} catch (err) {
  parentPort.postMessage({ matches: false, error: err.message });
}
```

The worker MUST NOT install its own internal timeout; the main-thread `setTimeout + terminate()` pair is the single source of truth. A worker-side timer cannot fire while the regex engine is actively backtracking — `terminate()` from the parent is the only mechanism that can interrupt the V8 regex VM.

### `runner.ts` (`runEvaluator` orchestrator)

```typescript
import { Rule } from './types';                       // from PLAN-021-1
import { EvaluatorRegistry } from './evaluator-registry';
import { runCustomEvaluator } from './sandbox';
import { EvaluatorRunError } from './errors';
import { EvaluatorResult, EvaluatorContext, Finding } from './evaluators/types';

export interface EvaluatorRunOptions {
  registry: EvaluatorRegistry;
  allowlist: string[];        // for custom evaluator dispatch
  ctx: EvaluatorContext;
}

export async function runEvaluator(
  rule: Rule,
  filePaths: string[],
  opts: EvaluatorRunOptions,
): Promise<EvaluatorResult> {
  const start = Date.now();
  let result: EvaluatorResult;
  try {
    const entry = opts.registry.get(rule.evaluator);
    if (entry.kind === 'builtin') {
      result = await entry.handler(filePaths, rule.args ?? {}, opts.ctx);
    } else {
      result = await runCustomEvaluator(
        entry.absolutePath,
        filePaths,
        rule.args ?? {},
        { allowlist: opts.allowlist },
      );
    }
  } catch (err) {
    throw new EvaluatorRunError(rule.id, err as Error);
  }

  // Inject rule_id into every finding so downstream consumers can attribute.
  const findings: Finding[] = result.findings.map((f) => ({ ...f, rule_id: rule.id }));
  return {
    passed: result.passed,
    findings,
    duration_ms: Date.now() - start,
  };
}
```

The orchestrator does NOT swallow errors. `EvaluatorNotFoundError`, `SecurityError`, `SandboxTimeoutError`, `SandboxMemoryError` are all wrapped as `EvaluatorRunError(rule.id, cause)` so callers can attribute failures to the offending rule. The original error is preserved as `cause`.

### `evaluators` CLI (`src/cli/commands/evaluators.ts`)

```typescript
import { EvaluatorRegistry } from '../../standards/evaluator-registry';
import { requireAdmin } from '../../auth/admin';        // existing helper from PRD-009/TDD-009
import { readConfig, writeConfig } from '../../config'; // existing helper from TDD-007
import { sendDaemonSignal } from '../../daemon/client'; // existing helper

export async function evaluatorsList(opts: { registry: EvaluatorRegistry }) {
  const rows = opts.registry.list().map((e) => ({
    name: e.name,
    type: e.kind,
    path: e.kind === 'builtin' ? '<built-in>' : e.absolutePath,
  }));
  // Print ASCII table. Columns: NAME (max 30), TYPE (8), PATH (rest).
  printTable(['NAME', 'TYPE', 'PATH'], rows.map((r) => [r.name, r.type, r.path]));
  return 0;
}

export async function evaluatorsAdd(absPath: string) {
  await requireAdmin();   // exits 1 with auth error if not admin
  if (!absPath.startsWith('/')) {
    process.stderr.write(`error: path must be absolute (got "${absPath}")\n`);
    return 2;
  }
  const cfg = await readConfig();
  cfg.extensions ??= {};
  cfg.extensions.evaluators_allowlist ??= [];
  if (cfg.extensions.evaluators_allowlist.includes(absPath)) {
    process.stdout.write(`already in allowlist: ${absPath}\n`);
    return 0;
  }
  cfg.extensions.evaluators_allowlist.push(absPath);
  await writeConfig(cfg);                  // atomic temp+rename
  await sendDaemonSignal('SIGUSR1');       // trigger registry.reload()
  process.stdout.write(`added: ${absPath}\nsent SIGUSR1 to daemon for reload.\n`);
  return 0;
}
```

CLI dispatch wiring (`src/cli/index.ts`): add a case for `evaluators` that takes the next argv as the subcommand and forwards. `evaluators list` calls `evaluatorsList({registry: getRegistry()})`; `evaluators add <path>` calls `evaluatorsAdd(argv[1])`.

### `package.json` (modify)

```json
{
  "optionalDependencies": {
    "re2": "^1.21.0"
  }
}
```

`re2` is a native binding (~5MB, requires C++ build tooling at install). Listing as optional means npm/pnpm install proceeds even when the platform can't build it; the sandbox falls back to worker-thread mode. Document this in the README.

## Acceptance Criteria

- [ ] Stub `evaluateRegex` from SPEC-021-2-02 is REPLACED by the worker-thread implementation; old stub file is removed; the warning string `'redos-sandbox stub in use'` no longer appears anywhere in the codebase.
- [ ] `evaluateRegex('foo', 'foo bar')` resolves with `{matches: true, matchLine: 1, durationMs < 50}` either via re2 fast path (when available) or worker fallback.
- [ ] `evaluateRegex('^(a+)+$', 'a'.repeat(30) + 'X')` resolves with `{matches: false, timedOut: true, error: 'ReDoSError: regex execution exceeded 100ms'}` within 150ms wall clock (100ms + grace).
- [ ] `evaluateRegex('foo', 'a'.repeat(10241))` THROWS synchronously with `"SecurityError: input exceeds 10240 bytes"` BEFORE any worker is spawned (verified by spying on the `Worker` constructor).
- [ ] `evaluateRegex('a'.repeat(1025), 'foo')` throws synchronously with `"SecurityError: pattern exceeds 1024 bytes"`.
- [ ] `evaluateRegex('foo', 'bar', 'invalid')` throws synchronously with `"SecurityError: invalid regex flags"`.
- [ ] `evaluateRegex('[invalid', 'foo')` resolves with `{matches: false, error: <regex compile error>}` — does NOT throw; the worker (or re2) catches and reports.
- [ ] When `re2` is installed, a safe pattern resolves in <5ms (re2 path); when `re2` is absent, the same pattern resolves via worker in <50ms (verified by stubbing `require('re2')` to throw and re-running).
- [ ] 10 concurrent `evaluateRegex` calls with the catastrophic pattern all resolve `timedOut: true` within 250ms total wall clock.
- [ ] After 100 sequential `evaluateRegex` calls, `process._getActiveHandles()` shows no leaked workers (verified at end of test).
- [ ] `runEvaluator(rule, files, opts)` with a built-in evaluator name dispatches to the in-process handler and returns its `EvaluatorResult` with `duration_ms` populated and every finding's `rule_id === rule.id`.
- [ ] `runEvaluator(rule, files, opts)` with a custom evaluator name dispatches via `runCustomEvaluator`; the same `rule_id` injection happens.
- [ ] Any error thrown during evaluator dispatch (`EvaluatorNotFoundError`, `SecurityError`, `SandboxTimeoutError`) is re-thrown as `EvaluatorRunError` with `ruleId === rule.id` and `cause` set to the original error.
- [ ] `pattern-grep` (from SPEC-021-2-02) integrated end-to-end with the real ReDoS sandbox: a fixture standards.yaml rule with `uses_pattern: '^(a+)+$'` against a file containing `'aaaaaa…X'` returns `passed: false` with a finding whose message references the timeout (not a match).
- [ ] `autonomous-dev evaluators list` prints exactly 5 built-in rows (when no custom configured) with columns `NAME`, `TYPE`, `PATH`. Built-in rows show `PATH = <built-in>`. Custom rows show the absolute path.
- [ ] `autonomous-dev evaluators add /abs/path/eval.sh` (admin auth succeeds) appends the path to `extensions.evaluators_allowlist` in the config file (verified by re-reading), then sends SIGUSR1 to the daemon (verified by mocking `sendDaemonSignal`). Exit code 0.
- [ ] `autonomous-dev evaluators add /abs/path/eval.sh` (already in allowlist) prints `"already in allowlist"` and exits 0 without writing the config or sending a signal.
- [ ] `autonomous-dev evaluators add ./relative-path` exits 2 with stderr message containing `"path must be absolute"`.
- [ ] `autonomous-dev evaluators add /abs/path/eval.sh` without admin auth exits 1 with the standard admin-required error message (delegated to `requireAdmin`).
- [ ] Test coverage ≥ 95% for `redos-sandbox.ts` and `runner.ts`; ≥ 90% for `evaluators.ts` (CLI argv-parsing branches).

## Dependencies

- **Blocked by**: SPEC-021-2-02 (provides the stub being replaced; provides `pattern-grep` which becomes the main consumer of the real sandbox), SPEC-021-2-03 (`EvaluatorRegistry`, `runCustomEvaluator`, `errors.ts`).
- **Consumed by**: SPEC-021-2-05 (adversarial tests target the real ReDoS sandbox; perf benchmarks target `runEvaluator` and the sandbox dispatch).
- **External code**:
  - `re2` (optional npm): linear-time regex engine. Installation requires C++ toolchain. When unavailable, the worker-thread fallback ensures functional parity.
  - `node:worker_threads` (built-in, no dep).
- **Existing helpers** (assume present from prior plans; no scope changes here):
  - `requireAdmin()` from PRD-009/TDD-009.
  - `readConfig()` / `writeConfig()` from TDD-007.
  - `sendDaemonSignal()` from PLAN-001-X (signals/IPC).

## Notes

- **Why workers, not the `vm` module**: `vm.runInContext` shares the event loop with the main thread; a catastrophic regex still blocks every other request. Only `worker_threads` provide true preemption via `terminate()`. The 1-2ms preemption granularity (V8 safepoints) is well within the 100ms budget.
- **Why a separate `regex-worker.js` (not `.ts`)**: Workers load via filesystem path. Shipping `.ts` would require a TS loader inside the worker. Shipping `.js` keeps the worker boot path zero-dependency. The worker is small (~30 lines); maintenance cost of duplicating the lookup logic between `.ts` and `.js` is acceptable.
- **Why `re2` is optional, not required**: `re2` is a native module; install fails on minimal containers without `g++`. Making it required would block adoption. Worker-thread fallback delivers the same security guarantees; the perf cost (~50ms vs ~5ms for safe patterns) is acceptable for the standards evaluation use case (rules run a few times per review, not a few hundred times per second).
- **Why no `rule_id` injection in the evaluator itself**: Evaluators are stateless and don't know about rule identity. The orchestrator owns the rule context and is the natural place to attach attribution.
- **CLI: `evaluators remove` is intentionally NOT in this spec.** Removing an evaluator from the allowlist requires editing the config file directly today; an admin command is deferred until the audit-log infrastructure (TDD-009) can record the removal cause. Operators can edit `~/.claude/autonomous-dev.json` and SIGUSR1 the daemon themselves.
- **SIGUSR1 wiring**: This spec ASSUMES the daemon already handles SIGUSR1 → `registry.reload()` (provided by the existing signal handler infrastructure plus SPEC-021-2-03's `reload()` method). If that wiring is missing, this spec's CLI sends a no-op signal — flag the gap during code review.
- **Grace period after `terminate()`**: The `HARD_KILL_GRACE_MS = 50` constant is documented but not currently used; it exists for a future enhancement where the sandbox awaits worker exit before resolving. Today, `terminate()` returns synchronously and the main resolve fires immediately. Tests should not depend on the constant.

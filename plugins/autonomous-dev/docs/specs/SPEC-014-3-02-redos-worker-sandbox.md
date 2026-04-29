# SPEC-014-3-02: ReDoS Defense via Worker-Thread Regex Sandbox

## Metadata
- **Parent Plan**: PLAN-014-3
- **Tasks Covered**: TASK-004 (RegexSandbox)
- **Estimated effort**: 3 hours

## Description
The portal accepts user-supplied regex (rule patterns, log filters, evaluator predicates). A pathological pattern like `(a+)+$` against `aaaa…aaaaX` causes catastrophic backtracking that pegs the event loop for seconds, denying service to every concurrent request. This spec implements `RegexSandbox` — a class that runs each `regex.test()` in a dedicated `worker_thread`, enforces a hard 100ms wall-clock timeout via `worker.terminate()`, and rejects any input larger than 10KB at the boundary before the worker is even spawned. The main thread never executes user-supplied regex directly. This spec deliberately raises the input cap from the plan's 1KB draft to 10KB to support realistic log-line filtering, while keeping the timeout at 100ms — the worker is killable, the input size only affects setup cost.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/security/regex-sandbox.ts` | Create | RegexSandbox class, main thread |
| `src/security/regex-worker.ts` | Create | Worker entrypoint, compiled to JS for runtime load |
| `src/security/types.ts` | Modify | Add `RegexTask`, `RegexResult` interfaces |

## Implementation Details

### Constants

```
MAX_INPUT_SIZE      = 10 * 1024     // 10 KB
DEFAULT_TIMEOUT_MS  = 100
MAX_PATTERN_SIZE    = 512           // bytes
HARD_KILL_GRACE_MS  = 50            // grace after terminate() before rejecting promise
```

### `RegexSandbox` Class

```
interface RegexTask {
  pattern: string
  flags: string
  input: string
}

interface RegexResult {
  matches: boolean
  groups?: string[]
  error?: string
  timedOut?: boolean
  executionTime?: number
}

class RegexSandbox {
  test(pattern: string, input: string, flags?: string): Promise<RegexResult>
}
```

- `test(pattern, input, flags = '')` behavior:
  1. **Pre-flight validation (main thread):**
     - `pattern` length must be ≤ `MAX_PATTERN_SIZE` (512 bytes). Else throw `SecurityError("Pattern too long")`.
     - `input` length (UTF-16 code units, i.e., `String.prototype.length`) must be ≤ `MAX_INPUT_SIZE` (10240). Else throw `SecurityError("Input too large: ${input.length} bytes (max: 10240)")`.
     - `flags` MUST match `/^[gimsuy]*$/`. Else throw `SecurityError("Invalid regex flags")`.
  2. **Spawn worker** with `new Worker(workerScriptPath, { workerData: { pattern, flags, input } })`. The path resolves to the compiled `regex-worker.js`. Use `eager: false` (default) — don't keep workers alive across calls; the spawn cost is part of the security budget.
  3. **Race the worker against a timer:**
     - Set `setTimeout(() => { worker.terminate(); resolveTimeoutResult(); }, DEFAULT_TIMEOUT_MS)`.
     - On `worker.message`, clear the timer, call `worker.terminate()` (idempotent), resolve with the result.
     - On `worker.error`, clear the timer, reject with `SecurityError("Worker error: ${err.message}")`.
     - On `worker.exit(code)` where `code !== 0` and no message arrived, resolve with `{matches: false, error: "Worker exited code ${code}"}`.
  4. **Timeout result shape:** `{ matches: false, timedOut: true, error: "Regex execution timed out (>100ms)" }`. Do NOT throw — the caller distinguishes `timedOut: true` from execution errors and records metrics.
- The sandbox MUST NOT cache or pool workers in this spec. Pooling is a deferred optimization (see Notes).

### `regex-worker.ts` (Worker Entrypoint)

The worker script is its own file so it can be compiled and shipped in `dist/`. It runs only inside a worker thread:

1. Import `parentPort`, `workerData` from `node:worker_threads`. If `parentPort` is null (loaded directly), exit 1 immediately.
2. Read `pattern, flags, input` from `workerData`.
3. Inside a `try`:
   - Construct `regex = new RegExp(pattern, flags)`. Constructor throws on invalid pattern → reach catch.
   - Record `start = Date.now()`.
   - Call `result = regex.exec(input)`. (Note: `exec` returns the first match or null; this is sufficient — the API is `test`-style.)
   - Compute `executionTime = Date.now() - start`.
   - `parentPort.postMessage({ matches: result !== null, groups: result?.slice(1) || [], executionTime })`.
4. On any thrown error: `parentPort.postMessage({ matches: false, error: err.message })`. Do NOT log to stderr — keep the worker silent.
5. The worker MUST NOT install its own internal timeout — the main-thread `setTimeout + terminate()` is the single source of truth. A worker-side timer cannot interrupt regex execution because the regex engine holds the event loop.

### Termination Semantics

- `worker.terminate()` sends `SIGKILL` semantics; the regex engine is interrupted at the next safepoint (V8 honors this). Catastrophic backtracking is interrupted within 1-2ms.
- If `terminate()` is called and a `message` event is already in-flight (extremely rare race), the message is delivered after the resolved-with-timeout state. The `setTimeout` cleared-flag pattern (single resolve) prevents double-resolution.

### Suspicious Pattern Heuristic — REMOVED

The plan's `isSuspiciousPattern()` heuristic is intentionally **not** included in this spec. Heuristics produce false positives on legitimate patterns (e.g. `(\w+)+\.txt`) and false negatives on ReDoS-by-design patterns. The hard timeout is the contract; pre-screening is a redundant complication. If future telemetry shows specific patterns repeatedly timing out, add a deny-list at that point.

## Acceptance Criteria

- [ ] `sandbox.test('(a+)+$', 'a'.repeat(50) + 'X')` resolves with `{matches: false, timedOut: true}` in ≤ 150ms (100ms budget + 50ms grace)
- [ ] `sandbox.test('hello', 'hello world')` resolves with `{matches: true}` in < 50ms
- [ ] `sandbox.test('.*', 'a'.repeat(10241))` throws `SecurityError` with message containing `"Input too large"` BEFORE spawning a worker
- [ ] `sandbox.test('a'.repeat(513), 'foo')` throws `SecurityError("Pattern too long")` BEFORE spawning a worker
- [ ] `sandbox.test('[invalid', 'foo')` resolves with `{matches: false, error: <regex compile error message>}` (worker catches and returns it)
- [ ] `sandbox.test('hi', 'hi', 'invalid-flags')` throws `SecurityError("Invalid regex flags")`
- [ ] Concurrent calls: 10 simultaneous `test()` calls each with the catastrophic pattern all resolve `timedOut: true` within 200ms total wall-clock
- [ ] Memory: each worker thread uses ≤ 50MB resident, verified via `process.resourceUsage` or `worker.resourceLimits` instrumentation in the test suite
- [ ] Worker thread is fully terminated after every call — no leaked workers visible via `process._getActiveHandles()` after a 100-iteration test
- [ ] The worker file `regex-worker.ts` does NOT import any project modules other than `node:worker_threads` (verified by `grep` in test)
- [ ] `npm run lint:security` and `npm test -- --testPathPattern=regex-sandbox` pass

## Dependencies

- Node.js `worker_threads` (built-in, no npm dependency).
- The compiled worker file must ship in `dist/security/regex-worker.js`. Update `package.json` `files` array if needed.
- Consumed by:
  - SPEC-014-3-04 adversarial tests
  - Future portal rule-engine specs (out of scope here)

## Interface Contract for Consumers

Callers integrate the sandbox at any boundary that accepts user-supplied regex:

```
// Caller pattern (do this):
const result = await sandbox.test(userPattern, candidate, userFlags);
if (result.timedOut) {
  metrics.increment("regex.timeout");
  return { matched: false, reason: "pattern_too_complex" };
}
if (result.error) {
  return { matched: false, reason: "invalid_pattern" };
}
return { matched: result.matches };
```

Consumers MUST distinguish three outcomes — match, timeout, error — and never re-throw the timeout case as an exception. Timeout is a normal control-flow result that yields a user-visible "pattern too complex" message; errors are user-visible "invalid pattern" messages. SecurityErrors thrown from `test()` itself (size/flag pre-flight) bubble as 400-class API errors.

The `RegexSandbox` instance is safe to share across the process. It holds no per-call state beyond what's passed into `test()`. Construction is cheap; consumers should still keep a single instance in module scope to make code-review easier.

## Notes

- **Why workers, not `vm` module**: `vm.runInContext` shares the event loop with the main thread. Catastrophic regex still blocks every other request. Only worker_threads provide true preemption via `terminate()`.
- **Why 10KB and not 1KB**: The plan's 1KB draft is too small for log-filtering use cases (a stack trace easily exceeds 1KB). 10KB is enough for one log line plus context, and the timeout is the real DoS protection — input size only bounds compilation/startup cost, which is constant in `n`.
- **Worker pool deferred**: Spinning a worker per call costs ~10ms. A pool of 4 idle workers would amortize this to near-zero, but introduces lifecycle complexity (worker recycle on N calls, leaked-state risk). Defer to a perf-focused follow-up plan.
- **Coordination with sandbox-exec / unshare**: The plan also describes a separate `EvaluatorSandbox` (TASK-005) for arbitrary code execution. That is OUT OF SCOPE for this spec — only regex defense is covered here. A future PLAN-014-3-followup will spec the evaluator sandbox.
- **No `RegExp.prototype.test` direct calls**: The codebase MUST be audited so all regex against untrusted input flows through `RegexSandbox`. Add a lint rule (`no-restricted-syntax`) targeting `.test(` on identifiers named `userPattern` etc., as a follow-up.

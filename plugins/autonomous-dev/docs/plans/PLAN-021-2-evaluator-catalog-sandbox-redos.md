# PLAN-021-2: Evaluator Catalog + Subprocess Sandbox + ReDoS Defense

## Metadata
- **Parent TDD**: TDD-021-standards-dsl-auto-detection
- **Estimated effort**: 5 days
- **Dependencies**: []
- **Blocked by**: [PLAN-021-1]
- **Priority**: P0

## Objective
Deliver the runtime evaluation layer for engineering standards: the built-in evaluator catalog (framework-detector, endpoint-scanner, sql-injection-detector, dependency-checker, pattern-grep), the custom-evaluator subprocess sandbox per TDD §7 (execFile, empty env, ro-fs, no-net, 30s wall clock, 256MB memory cap), and the ReDoS defense per TDD §10 (worker-thread sandbox with 100ms timeout for all `uses_pattern` and `excludes_pattern` regexes). Linux uses `unshare --net --mount` and `prlimit`; macOS uses `sandbox-exec`. Custom evaluators must appear in the `extensions.evaluators_allowlist` config; the daemon refuses to invoke any evaluator outside the allowlist.

## Scope
### In Scope
- Built-in evaluator catalog at `src/standards/evaluators/`:
  - `framework-detector.ts`: inspects `package.json`, `requirements.txt`, `pyproject.toml` for declared frameworks; handles aliases (e.g., `next` → React-based)
  - `endpoint-scanner.ts`: greps for HTTP route declarations (`app.get('/health')`, `@router.get('/health')`, `@app.route('/health')`); language-aware
  - `sql-injection-detector.ts`: pattern matches unsafe string-format SQL (`f"SELECT ... {var}"`, `"SELECT ... " + var`, `String.format(sql, args)`)
  - `dependency-checker.ts`: verifies a dependency exists in `package.json`/`requirements.txt`/`pyproject.toml`
  - `pattern-grep.ts`: generic regex match for `uses_pattern`/`excludes_pattern` assertions; runs through ReDoS sandbox
- `EvaluatorRegistry` at `src/standards/evaluator-registry.ts` that maps evaluator names to their implementations; built-in evaluators registered at startup, custom evaluators registered from the allowlist
- Custom evaluator subprocess sandbox per TDD §7 at `src/standards/sandbox.ts`:
  - `execFile` with strict options: `timeout: 30_000`, `maxBuffer: 10 * 1024 * 1024`, `env: {}`, `cwd: '/tmp/eval-sandbox'`
  - Linux extras: `unshare --net --mount`, `prlimit --as=268435456`
  - macOS extras: `sandbox-exec` profile denying network, restricting filesystem
  - Allowlist enforcement: refuse to execute evaluators not in `extensions.evaluators_allowlist`
- ReDoS defense per TDD §10 at `src/standards/redos-sandbox.ts`:
  - Worker-thread isolation via `worker_threads`
  - 100ms hard timeout
  - Input length cap of 10KB (rejected before reaching the worker)
  - Worker resource limit: 64MB heap
  - Test-compile via `re2` (linear-time engine) when available; falls back to worker-thread
- `extensions.evaluators_allowlist` config field in `~/.claude/autonomous-dev.json` per TDD §17: list of allowed evaluator paths; runtime addition requires admin
- CLI `autonomous-dev evaluators list` (built-in + allowlisted custom) and `evaluators add <path>` (admin-only) commands
- Custom evaluator contract per TDD §7: shell script taking `<file_paths> --args '<json>'`, emitting JSON to stdout with `passed` and `findings[]`, exit 0/1/2 per the documented codes
- `runEvaluator(name, files, args)` orchestrator at `src/standards/runner.ts` that picks the right code path (built-in vs sandboxed custom) and returns `EvaluatorResult`
- Performance: evaluator registry startup < 50ms; sandbox process launch < 200ms p95; ReDoS sandbox < 50ms p95 for safe patterns
- Unit tests per evaluator (TDD §14: 50+ fixtures covering each evaluator's behavior)
- Adversarial tests for ReDoS: catastrophic-backtracking patterns must time out cleanly within 100ms (no daemon hang)
- Sandbox escape tests: try to network connect, write outside cwd, exceed memory — all must be blocked

### Out of Scope
- Standards artifact schema / DSL / inheritance resolver / auto-detection scanner -- delivered by PLAN-021-1
- Standards-aware author agent prompts -- PLAN-021-3
- Standards-meta-reviewer governance agent -- PLAN-021-3
- Fix-recipe schema -- PLAN-021-3
- The reviewer that consumes evaluator results (rule-set-enforcement-reviewer) -- PLAN-020-1
- Plugin chaining -- TDD-022
- Distribution mechanism for custom evaluators (bundled with plugin vs separate package) -- TDD-021 §18 open question, deferred

## Tasks

1. **Implement built-in `framework-detector`** -- `src/standards/evaluators/framework-detector.ts` reads dependency manifests and matches against the requested framework. Handles aliases (e.g., `next` resolves to React). Returns `{passed: bool, findings: []}` per the standard interface.
   - Files to create: `plugins/autonomous-dev/src/standards/evaluators/framework-detector.ts`
   - Acceptance criteria: For a `package.json` with `dependencies.fastapi`, the evaluator with `framework_match: "fastapi"` returns `passed: true`. For a `package.json` with `dependencies.flask`, the same evaluator returns `passed: false` with a finding pointing at line 1 of `package.json`. Handles missing dependency manifests gracefully (returns passed:false with "no dependency manifest found"). Tests cover Node, Python, and missing-manifest cases.
   - Estimated effort: 3h

2. **Implement built-in `endpoint-scanner`** -- `src/standards/evaluators/endpoint-scanner.ts` greps for HTTP route declarations matching the requested path. Language-aware: scans `.py` for `@app.route('/X')` and `@router.X('/path')`, scans `.ts/.js` for `app.X('/path')` and `router.X('/path')`, scans `.go` for `mux.HandleFunc("/X", ...)`.
   - Files to create: `plugins/autonomous-dev/src/standards/evaluators/endpoint-scanner.ts`
   - Acceptance criteria: For a Python file with `@app.get('/health')`, the evaluator with `exposes_endpoint: '/health'` returns `passed: true`. For a TS file without any `/health` route, returns `passed: false` with a finding indicating the missing endpoint. Tests cover all three languages.
   - Estimated effort: 3h

3. **Implement built-in `sql-injection-detector`** -- `src/standards/evaluators/sql-injection-detector.ts` scans for unsafe string-format SQL patterns: f-strings, `.format()`, string concatenation, `String.format()`, `MessageFormat.format()`. Cross-language coverage.
   - Files to create: `plugins/autonomous-dev/src/standards/evaluators/sql-injection-detector.ts`
   - Acceptance criteria: For a Python file with `f"SELECT * FROM users WHERE id = {user_id}"`, the evaluator returns `passed: false` with a critical finding. For a Java file with `String.format("SELECT ... %s", id)` followed by `.format()` chain, similarly fails. For a clean parameterized query, returns `passed: true`. Tests cover at least 10 distinct unsafe patterns and 5 safe patterns.
   - Estimated effort: 4h

4. **Implement built-in `dependency-checker`** -- `src/standards/evaluators/dependency-checker.ts` verifies a named dependency exists in the appropriate manifest. Supports `dependency_present: "fastapi"` for Python, `dependency_present: "react"` for Node, etc.
   - Files to create: `plugins/autonomous-dev/src/standards/evaluators/dependency-checker.ts`
   - Acceptance criteria: For `dependency_present: "axios"` against a `package.json` containing axios, returns `passed: true`. Without axios, returns `passed: false` with a finding pointing at the manifest. Handles dev-dependencies via a config flag. Tests cover both runtime and dev deps.
   - Estimated effort: 2h

5. **Implement built-in `pattern-grep`** -- `src/standards/evaluators/pattern-grep.ts` runs the `uses_pattern` or `excludes_pattern` regex from the rule against changed files. ALL regex execution goes through the ReDoS sandbox (task 7).
   - Files to create: `plugins/autonomous-dev/src/standards/evaluators/pattern-grep.ts`
   - Acceptance criteria: For `uses_pattern: "TODO\\(\\w+\\)"`, the evaluator returns `passed: true` only if the pattern matches at least once in the changed files. For `excludes_pattern: ".*\\.format\\(.*query"`, returns `passed: true` only if NO file contains the pattern. The regex executes in the worker-thread sandbox; a catastrophic pattern times out within 100ms. Tests cover both modes plus the ReDoS guard.
   - Estimated effort: 3h

6. **Implement custom-evaluator subprocess sandbox** -- `src/standards/sandbox.ts` per TDD §7 with `runCustomEvaluator(evaluatorPath, filePaths, args)`. Verifies the path is in the allowlist; uses `execFile` with the documented options. On Linux, wraps in `unshare --net --mount` + `prlimit --as`. On macOS, wraps in `sandbox-exec`. On other platforms, falls back to `execFile`-only with a documented warning.
   - Files to create: `plugins/autonomous-dev/src/standards/sandbox.ts`, `plugins/autonomous-dev/bin/sandbox-profiles/macos-sandbox.sb`
   - Acceptance criteria: Path not in allowlist throws `SecurityError`. Allowlisted evaluator runs and returns parsed JSON output. Process exceeding 30s is killed with timeout error. Process exceeding 256MB memory is killed (Linux: prlimit, macOS: ulimit). Network connection from inside the evaluator fails (Linux: unshare, macOS: sandbox-exec). Write outside `/tmp/eval-sandbox` fails. Tests use a fixture evaluator that attempts each escape and verify all are blocked.
   - Estimated effort: 6h

7. **Implement ReDoS sandbox** -- `src/standards/redos-sandbox.ts` per TDD §10 with `evaluateRegex(pattern, input)` that runs the regex in a `worker_threads.Worker`. 100ms hard timeout via `setTimeout` + `worker.terminate()`. Input length cap of 10KB. Falls back to `re2` (linear-time engine) when available — install `re2` as an optional dependency.
   - Files to create: `plugins/autonomous-dev/src/standards/redos-sandbox.ts`, `plugins/autonomous-dev/src/standards/regex-worker.js`
   - Acceptance criteria: Safe pattern `/foo/.test("foo bar")` returns `true` in <50ms. Catastrophic pattern `/^(a+)+$/.test("a".repeat(30) + "X")` is killed within 100ms with `ReDoSError`. Input >10KB is rejected with "Input exceeds 10KB cap" before reaching the worker. When `re2` is available, the test-compile path bypasses the worker for known-safe patterns. Tests cover both paths and at least 5 catastrophic-backtracking fixtures.
   - Estimated effort: 5h

8. **Implement `EvaluatorRegistry`** -- `src/standards/evaluator-registry.ts` registers built-in evaluators at startup and accepts custom evaluators from `extensions.evaluators_allowlist`. Provides `get(name)` to dispatch a rule's `evaluator` field to the right implementation.
   - Files to create: `plugins/autonomous-dev/src/standards/evaluator-registry.ts`
   - Acceptance criteria: After startup, registry has all 5 built-in evaluators. Adding a custom evaluator via config (and SIGUSR1 reload) makes it available. `get('framework-detector')` returns the built-in. `get('not-registered')` throws `EvaluatorNotFoundError`. Tests cover registration, lookup, and reload.
   - Estimated effort: 2h

9. **Implement orchestrator `runEvaluator()`** -- `src/standards/runner.ts` provides the unified entry point: takes a rule, looks up the evaluator, dispatches to built-in or custom, returns the result. Handles all error cases (evaluator not found, sandbox failure, timeout) gracefully.
   - Files to create: `plugins/autonomous-dev/src/standards/runner.ts`
   - Acceptance criteria: Invoking with a rule whose evaluator is built-in runs the in-process implementation. Invoking with a custom evaluator path goes through the sandbox. Errors are wrapped in `EvaluatorRunError` with the rule ID and original cause. Tests cover both paths plus error wrapping.
   - Estimated effort: 2h

10. **Implement `evaluators list` and `evaluators add` CLI subcommands** -- `evaluators list` prints all registered evaluators (built-in + custom). `evaluators add <path>` (admin-only) adds a custom evaluator path to the allowlist and triggers SIGUSR1 reload.
    - Files to create: `plugins/autonomous-dev/src/cli/commands/evaluators.ts`
    - Acceptance criteria: `evaluators list` shows columns: name, type (built-in|custom), path. `evaluators add /usr/local/bin/my-evaluator` (with admin auth) adds the path and triggers reload. Without admin, exits 1 with auth error. Tests cover both commands.
    - Estimated effort: 2h

11. **Adversarial tests** -- Comprehensive tests exercising sandbox-escape attempts and ReDoS patterns. Each must be blocked.
    - Files to create: `plugins/autonomous-dev/tests/standards/test-sandbox-escape.test.ts`, `test-redos-adversarial.test.ts`
    - Acceptance criteria: Network attempt (TCP connect) fails. File write outside cwd fails. Memory exhaustion (alloc 1GB) fails. Process spawn from inside the sandbox fails. ENV var leak (try to read `process.env`) returns empty. ReDoS patterns from a published catalog (e.g., RegExLib) all timeout within 100ms.
    - Estimated effort: 4h

12. **Performance benchmarks** -- `tests/perf/test-evaluator-perf.bench.ts` measuring: evaluator-registry startup time (<50ms), sandbox process launch (<200ms p95), ReDoS sandbox eval (<50ms p95 for safe patterns), built-in evaluator throughput (>100 evaluations/sec for typical inputs).
    - Files to create: `plugins/autonomous-dev/tests/perf/test-evaluator-perf.bench.ts`
    - Acceptance criteria: All targets met on a CI runner. Captured as a workflow artifact.
    - Estimated effort: 2h

## Dependencies & Integration Points

**Exposes to other plans:**
- `EvaluatorRegistry` and `runEvaluator()` consumed by the rule-set-enforcement-reviewer (PLAN-020-1) and any future plan that evaluates standards.
- Sandbox patterns (`execFile` + `unshare`/`sandbox-exec`) reusable for any future plugin that runs untrusted code (e.g., custom hook implementations may adopt the same sandbox).
- ReDoS sandbox reusable for any future regex-execution context (e.g., user-supplied patterns in the portal).
- `extensions.evaluators_allowlist` config pattern for any future allowlist-style operator control.

**Consumes from other plans:**
- **PLAN-021-1** (blocking): `Rule`, `Predicate`, `Assertion` types; `standards.yaml` loading. Without these, evaluators have nothing to run against.
- TDD-007 / PLAN-007-X: existing config infrastructure for the `extensions` config namespace.
- PRD-009 / TDD-009: admin authorization helper for `evaluators add`.

## Testing Strategy

- **Unit tests per evaluator (tasks 1-5):** ≥95% coverage. Each evaluator tested with 5+ positive and 5+ negative cases.
- **Sandbox tests (task 11):** Comprehensive escape-attempt coverage. Each blocked attempt is documented in the test name.
- **ReDoS adversarial (task 11):** Catalog of 10+ catastrophic-backtracking patterns; all must time out within 100ms.
- **Performance benchmarks (task 12):** Capture and assert thresholds for each operation.
- **Cross-platform tests:** Linux-specific tests for `unshare`/`prlimit` skipped on macOS and vice versa, but both platforms run their respective test suites in CI.
- **Integration test:** End-to-end rule evaluation: load a fixture standards.yaml, run each rule's evaluator, verify the verdict matches expected. Mix of built-in + custom (sandboxed) evaluators.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Sandbox-escape vulnerability allows custom evaluator to read secrets / network exfiltrate | Low | Critical -- security breach | Defense in depth: empty env (no secrets), `unshare --net` (no network on Linux), `sandbox-exec` deny-network (macOS), allowlist for evaluator paths. Adversarial test suite (task 11) covers known escape patterns. Security audit before promoting custom evaluators to general availability. |
| `re2` is not available on all platforms (it's a native binding); ReDoS sandbox falls back to worker-thread which is slower | Medium | Low -- 50ms vs 5ms for safe patterns | Document as an optional dependency. Worker-thread fallback is functionally equivalent; perf hit is acceptable. Long-term: bundle `re2` for major platforms or use `ag` / `ripgrep` as an alternative. |
| `unshare --net --mount` requires Linux user namespace support, fails on some kernels | Medium | Medium -- sandbox degrades to weaker isolation on those systems | Detect support at startup; if `unshare` unavailable, log a warning and fall back to `execFile`-only. Document the limitation in the operator guide. Recommend kernel ≥4.x. |
| `sandbox-exec` is deprecated on macOS and may be removed in future releases | High | Medium -- macOS sandbox breaks | Alternative: `bwrap` (bubblewrap) on macOS via Homebrew; or move custom evaluators to Linux-only execution. Documented as a known limitation. Long-term: containerize evaluators via Docker / Podman. |
| Catastrophic-backtracking pattern in a built-in evaluator (e.g., sql-injection-detector) hangs the daemon | Low | High -- single bad input crashes the daemon | All built-in regex execution goes through the ReDoS sandbox (task 7). 100ms hard timeout prevents hang. The detector's regexes are reviewed for backtracking risk; tests include adversarial inputs to each detector. |
| `prlimit --as=268435456` doesn't catch memory leaks via mmap (only counts resident memory) | Low | Medium -- evaluator can OOM the daemon | Use `prlimit --rss` AND `--as` for double protection. Linux `cgroups v2` would be more robust but requires root; out of scope for v0.2. Documented as a known minor edge case. |

## Definition of Done

- [ ] All 5 built-in evaluators (framework-detector, endpoint-scanner, sql-injection-detector, dependency-checker, pattern-grep) work and have ≥95% unit test coverage
- [ ] Custom evaluator subprocess sandbox enforces: empty env, ro-fs, no-net, 30s timeout, 256MB memory cap
- [ ] Sandbox supports Linux (unshare + prlimit) and macOS (sandbox-exec); other platforms documented as weaker
- [ ] ReDoS sandbox kills catastrophic-backtracking patterns within 100ms
- [ ] Input length cap (10KB) prevents oversized regex inputs
- [ ] `re2` test-compile path works when `re2` is installed; falls back to worker-thread otherwise
- [ ] `EvaluatorRegistry` registers built-ins at startup and supports custom-evaluator allowlist
- [ ] `runEvaluator()` orchestrator dispatches to built-in or sandbox correctly
- [ ] `evaluators list` and `evaluators add` CLI subcommands work; `add` requires admin auth
- [ ] Adversarial test suite covers sandbox escapes (network, fs, memory, process, env) and ReDoS patterns
- [ ] Performance benchmarks meet targets: registry startup <50ms, sandbox launch <200ms p95, ReDoS eval <50ms p95
- [ ] Cross-platform CI runs Linux-specific and macOS-specific test subsets correctly
- [ ] No regressions in PLAN-021-1 functionality
- [ ] Operator guide documents sandbox capabilities, limitations, and the allowlist contribution process

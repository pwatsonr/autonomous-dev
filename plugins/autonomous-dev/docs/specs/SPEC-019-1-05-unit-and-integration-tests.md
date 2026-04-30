# SPEC-019-1-05: Unit and Integration Tests for Hook Engine

## Metadata
- **Parent Plan**: PLAN-019-1
- **Tasks Covered**: Task 9 (unit tests for discovery, registry, executor), Task 10 (integration test: discovery + reload)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-1-05-unit-and-integration-tests.md`

## Description
Lock in PLAN-019-1's correctness with three focused unit-test files (one per class) and one end-to-end integration test that exercises the full discovery → registry → reload → CLI flow against a temporary plugin directory. Together they enforce the acceptance criteria of SPEC-019-1-02, SPEC-019-1-03, and SPEC-019-1-04, plus the `≥90% coverage` and `< 500ms reload` budgets from PLAN-019-1's Definition of Done. Tests must be deterministic (no `~/.claude/plugins/` access; everything runs against `os.tmpdir()` subdirectories) and parallelizable.

A schema-validation unit test for the `hook-manifest-v1.json` schema (SPEC-019-1-01) is also included here so all manifest-shape assertions live in one suite.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/hooks/test-schema.test.ts` | Create | Hook manifest JSON Schema unit tests |
| `plugins/autonomous-dev/tests/hooks/test-discovery.test.ts` | Create | PluginDiscovery unit tests |
| `plugins/autonomous-dev/tests/hooks/test-registry.test.ts` | Create | HookRegistry unit tests |
| `plugins/autonomous-dev/tests/hooks/test-executor.test.ts` | Create | HookExecutor unit tests |
| `plugins/autonomous-dev/tests/integration/test-plugin-reload.test.ts` | Create | End-to-end discovery + reload + CLI |
| `plugins/autonomous-dev/tests/helpers/plugin-fixtures.ts` | Create | Shared helpers: temp-dir copy, manifest mutate, daemon spawn |
| `plugins/autonomous-dev/tests/helpers/schema-validator.ts` | Create | Minimal hand-rolled validator (no AJV dependency) |

## Implementation Details

### Test Runner

The repo uses `vitest` (per PLAN-001-1). All test files use `describe` / `it` / `expect` with no global setup beyond what's in `vitest.config.ts`. Each file's tests run in isolated temp directories created in `beforeEach` and removed in `afterEach`.

### `tests/helpers/plugin-fixtures.ts`

Exports:
- `async copyFixturesTo(destDir: string, names: string[]): Promise<void>` — copies `tests/fixtures/plugins/<name>/` trees into `destDir`.
- `async mutateManifest(path: string, mutator: (m: any) => void): Promise<void>` — read JSON, apply mutator, write back.
- `async createTempPluginDir(): Promise<string>` — `os.mkdtemp(path.join(os.tmpdir(), 'ad-plugins-'))` and returns the path.
- `async cleanupTempDir(dir: string): Promise<void>` — `fs.rm(dir, { recursive: true, force: true })`.
- `async spawnDaemon(pluginDir: string): Promise<{ pid: number; stop: () => Promise<void> }>` — boots the daemon with `AUTONOMOUS_DEV_PLUGIN_DIR=<pluginDir>` env var; resolves once the socket appears at `~/.autonomous-dev/daemon.sock`; returns a `stop()` that sends SIGTERM and awaits exit.

### `tests/helpers/schema-validator.ts`

A minimal, dependency-free validator that conforms to the `(m: unknown) => DiscoveryError[]` signature SPEC-019-1-02 expects. Checks only:
- top-level `id`, `name`, `version`, `hooks` are present and of the right primitive type;
- each `hooks[i]` has `id`, `hook_point`, `entry_point`, `priority`, `failure_mode`;
- `hook_point` is one of the 10 valid strings;
- `failure_mode` is one of `block|warn|ignore`;
- `priority` is a number 0..1000.

This avoids dragging AJV into PLAN-019-1's tests; PLAN-019-2 will swap in the real AJV-backed validator and re-run the same suite.

### `tests/hooks/test-schema.test.ts`

Uses Node's `JSON.parse` on the schema file plus a tiny home-grown match helper (or the schema-validator helper above) — NOT AJV — to lock in a few critical schema invariants:

- `parses cleanly` — schema is valid JSON.
- `accepts the embedded example` — `examples[0]` round-trips.
- `rejects missing id` — fixture `malformed/hooks.json` produces an error at `/id`.
- `rejects invalid failure_mode` — manifest with `failure_mode: 'panic'` produces an enum error.
- `rejects extra top-level field` — manifest with `author: 'foo'` is rejected.
- `rejects priority 1500` — out-of-range integer.
- `rejects version '1.0'` — not semver.

### `tests/hooks/test-discovery.test.ts`

`describe('PluginDiscovery')`:
- `scan returns empty for non-existent rootDir`
- `scan returns one DiscoveryResult per <plugin>/hooks.json found, in lex order`
- `scan with simple+multi-hook+malformed yields 3 results, 2 ok 1 error`
- `malformed result has code SCHEMA_ERROR with pointer /id`
- `scan skips files at top level (not directories)`
- `scan skips hidden directories (name starts with .)`
- `scan with 50 fixture plugins completes in < 100ms (perf assertion)` — generated programmatically in `beforeAll`
- `scan does NOT require/execute any plugin entry-point file` — `vi.spyOn(Module, 'require')` (or equivalent) shows zero calls into fixture entry-points
- `parseManifest on bad JSON returns one PARSE_ERROR`
- `validateManifest delegates to injected validator` — uses a mock validator returning a known error list and asserts identity
- `path canonicalization rejects symlink escape` — create a symlink in temp dir pointing to `..`, assert the resulting candidate is skipped with IO_ERROR
- `Unicode plugin directory name (héllo-plugin) is discovered` — round-trip the manifest's `id`

### `tests/hooks/test-registry.test.ts`

`describe('HookRegistry')`:
- `empty registry: getHooksForPoint returns empty array`
- `single plugin registers all its hooks`
- `priority ordering: 100/50/75 → list order [100,75,50]`
- `tie ordering: two priority-50 hooks preserve registration order`
- `unregister removes all hooks from named plugin and returns count`
- `unregister of unknown id returns 0`
- `clear empties every list; size returns 0`
- `snapshot is deep-frozen (Object.isFrozen on map and arrays)`
- `mutating snapshot array throws (frozen)`
- `stability sweep: 100 hooks at random priorities preserve insertion order at every priority value`
- `resolvedEntryPoint is absolute and normalized`

### `tests/hooks/test-executor.test.ts`

`describe('HookExecutor')`:
- `executeHooks for empty point returns invocations:[]`
- `two hooks at priorities 100 and 50 invoke in order [100, 50]`
- `every invocation receives the same context reference`
- `synchronous hook return value lands in invocations[i].result`
- `synchronous throw is caught: status='error', error=message, iteration continues`
- `rejected Promise is caught the same as a sync throw`
- `async hook (setTimeout 10ms) is awaited`
- `durationMs is positive for every invocation`
- `snapshot stability: clearing the registry from inside hook 0 does not affect iteration over hooks [1, 2]`
- `sequential execution: timestamps recorded by hooks are monotonic non-overlapping`
- `entry-point cache: invoking same hook twice triggers fs.readFile zero times the second invocation` — spy on `fs.readFile`

### `tests/integration/test-plugin-reload.test.ts`

A single end-to-end scenario with multiple assertions:

`describe('plugin reload integration')` → `it('lists plugins, reloads after removal, reflects change')`:

1. Create temp plugin dir; copy fixtures `simple`, `multi-hook` into it.
2. Spawn the daemon with `AUTONOMOUS_DEV_PLUGIN_DIR=<tempDir>`.
3. Run `autonomous-dev plugin list --json` via child_process; parse output.
4. Assert: `simple` appears once; `multi-hook` appears 3 times (one per hook).
5. Mid-flight test: invoke a hook on `multi-hook` (via a test-only IPC command or directly through the executor in-process — whichever is cleaner) that sleeps 300ms.
6. While that hook is in flight, send SIGUSR1 to the daemon (`kill -USR1 <pid>`).
7. Assert: the in-flight call still returns its expected result (snapshot stability).
8. Remove `multi-hook` from the temp dir.
9. Send a second SIGUSR1.
10. Wait for the reload log line (poll the daemon's log file with a 1s timeout) OR — preferably — call `autonomous-dev plugin reload` which is synchronous w.r.t. the IPC response.
11. Run `autonomous-dev plugin list --json` again.
12. Assert: only `simple` remains (1 row).
13. Assert: total reload time (between the SIGUSR1 send and the IPC response or log line) is < 500ms.
14. Stop the daemon; clean up temp dir.

The test must be deterministic: no `sleep N` waits — every wait is a poll-with-timeout helper.

## Acceptance Criteria

- [ ] All 5 test files exist and `vitest run` completes with zero failures.
- [ ] Coverage report (`vitest run --coverage`) shows ≥ 90% line coverage on `src/hooks/discovery.ts`, `src/hooks/registry.ts`, `src/hooks/executor.ts`.
- [ ] No test reads or writes `~/.claude/plugins/` or `~/.autonomous-dev/` outside of the integration test's spawned daemon (which uses an env-var-overridden plugin dir; the socket path may still be the canonical one but the daemon must clean up its socket on shutdown).
- [ ] Every test cleans up its temp directory in `afterEach`/`afterAll`. No test pollutes another's state.
- [ ] The 50-plugin perf test in `test-discovery.test.ts` passes with `<100ms` p95 over 5 runs on local SSD; the test reports the actual ms in its output for visibility.
- [ ] The integration test's reload-window assertion (`< 500ms`) passes with margin (target p95 over 5 runs).
- [ ] The integration test does not use any `setTimeout`-based wait longer than 50ms; all waits are poll-with-deadline helpers.
- [ ] All tests are independent: running any single test file in isolation produces the same pass/fail outcome as running the full suite.
- [ ] Schema tests in `test-schema.test.ts` cover all 7 documented invariants (parses, accepts example, rejects 5 invalid shapes).
- [ ] No use of AJV in any test file (deferred to PLAN-019-2). The schema-validator helper is < 50 lines.
- [ ] Test fixtures from SPEC-019-1-02 (`simple`, `multi-hook`, `malformed`) are referenced by both unit and integration tests; no duplicate fixture trees.
- [ ] `vitest run --reporter=verbose` shows descriptive test names that map 1:1 to the bullet lists in the Implementation Details section above.
- [ ] Linting (`npm run lint`) and type-check (`npm run typecheck`) pass against all new test files.

## Dependencies

- SPEC-019-1-01, SPEC-019-1-02, SPEC-019-1-03, SPEC-019-1-04 — all consumed.
- `vitest` (already in repo per PLAN-001-1).
- Node ≥ 18 (`fs.mkdtemp`, `fs.rm` recursive).
- Fixture plugins from SPEC-019-1-02 are required to exist on disk before these tests run.
- No new npm dev-dependencies introduced.

## Notes

- The schema test suite lives here (not in SPEC-019-1-01) because tests are SPEC-019-1-05's job by convention; the schema file itself is created in SPEC-019-1-01.
- The 50-plugin perf test is the only test that may be marked `.skipIf(process.env.CI === 'true')` if CI hardware is unreliable; the perf budget is informational on shared CI runners but enforced on the maintainer's local SSD per PLAN-019-1's risk register.
- Spawning the daemon in the integration test requires careful socket cleanup: the test's `afterAll` must `unlinkSync('~/.autonomous-dev/daemon.sock')` if the daemon failed to clean up on its own. This is a known race during test teardown.
- The integration test deliberately exercises the CLI path (`autonomous-dev plugin list/reload` as child processes) rather than calling the IPC client in-process, because the CLI is the operator-facing surface and any regression there is more important to catch than a silent IPC contract change.
- If `vitest`'s parallelism causes socket-path collisions across test files, set `test.fileParallelism: false` for `tests/integration/` only; unit tests can stay parallel.
- Future plans (PLAN-019-2/3/4) will extend this suite. The structure here (one file per class + one integration scenario) is the template they should follow.

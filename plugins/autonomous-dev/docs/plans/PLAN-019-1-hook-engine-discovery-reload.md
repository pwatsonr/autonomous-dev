# PLAN-019-1: Hook Engine Core + Plugin Manifest Discovery + Reload

## Metadata
- **Parent TDD**: TDD-019-extension-hook-system
- **Estimated effort**: 5 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0

## Objective
Deliver the foundational hook execution engine and plugin discovery layer for the autonomous-dev extension system. This plan implements the on-disk plugin manifest format (`hooks.json`), startup-time discovery that walks `~/.claude/plugins/` for installed plugins, the in-memory hook registry that maps hook points to ordered hook handlers, the SIGUSR1-triggered reload semantics that allow hot-swapping plugins without daemon restart, and the core hook-invocation interface used by all 10 hook points (intake-pre-validate, prd-pre-author, ..., rule-evaluation). Schema validation, trust enforcement, reviewer slots, sequential execution, and audit logging are delivered by sibling plans.

## Scope
### In Scope
- `HookPoint` enum at `src/hooks/types.ts` covering the 10 hook points listed in TDD §9: `intake-pre-validate`, `prd-pre-author`, `tdd-pre-author`, `code-pre-write`, `code-post-write`, `review-pre-score`, `review-post-score`, `deploy-pre`, `deploy-post`, `rule-evaluation`
- `HookManifest` interface and JSON schema at `schemas/hook-manifest-v1.json` per TDD §13.1: required fields `id`, `name`, `version`, `hooks[]` where each hook entry has `id`, `hook_point`, `entry_point`, `priority`, `failure_mode`, optional `reviewer_slot`, `dependencies`, `capabilities`
- `PluginDiscovery` class at `src/hooks/discovery.ts` that scans `~/.claude/plugins/*/hooks.json` at startup, parses each manifest, validates against the schema (defers full validation pipeline to PLAN-019-2), and adds valid hooks to the registry
- `HookRegistry` class at `src/hooks/registry.ts` that maintains an in-memory map `Map<HookPoint, HookEntry[]>` ordered by priority; provides `getHooksForPoint(point)`, `register(plugin, hook)`, `unregister(plugin)` methods
- `HookExecutor` class at `src/hooks/executor.ts` with the core `executeHooks(point, context)` method that iterates the registry's entries in priority order, invokes each hook's entry-point function, captures structured output, and returns an aggregated result. (Sequential execution semantics in detail are PLAN-019-4's scope; this plan provides the basic loop.)
- SIGUSR1 signal handler in `bin/supervisor-loop.sh` that triggers `PluginDiscovery.reload()` per TDD §13.2: re-scans `~/.claude/plugins/`, replaces the registry atomically, logs the diff (added/removed/changed hooks)
- `bin/autonomous-dev-cli plugin list` subcommand that prints the current registry contents (hook point, plugin id, plugin version, priority, failure-mode)
- `bin/autonomous-dev-cli plugin reload` subcommand that sends SIGUSR1 to the running daemon
- Comprehensive logging: every plugin discovery (success/failure), every reload, every hook invocation logged at INFO level with plugin id and hook point
- Unit tests for: `HookManifest` schema validation, `PluginDiscovery` against fixture plugins, `HookRegistry` priority ordering, SIGUSR1 reload diff computation
- Integration test: install three fixture plugins, start daemon, verify `plugin list` shows all three; SIGUSR1 with one plugin removed; verify `plugin list` reflects the change

### Out of Scope
- Schema validation pipeline (AJV setup, custom formats, validation stats) -- PLAN-019-2
- Plugin trust / allowlist / signature verification / agent-meta-reviewer integration -- PLAN-019-3
- Reviewer-slot mechanics (multi-reviewer minimum enforcement, fingerprinting) -- PLAN-019-4
- Sequential execution detail (priority ordering, context propagation, failure-mode behavior) -- PLAN-019-4
- Audit log -- PLAN-019-4
- Sandbox execution (worker_threads, capability enforcement) -- consumes from PRD-001 sandbox; this plan delegates execution to a placeholder until that plan lands
- Plugin marketplace, dynamic registration via API, cross-plugin communication -- TDD-019 §17 open questions, deferred

## Tasks

1. **Author `HookPoint` enum and `HookManifest` types** -- Create `src/hooks/types.ts` with the `HookPoint` enum (10 members), `HookManifest` interface, `HookEntry` interface (one per hook within a manifest), `FailureMode` enum (`block`, `warn`, `ignore`), and the `Capability` flag set (`filesystem-write`, `network`, `child-processes`, `privileged-env`).
   - Files to create: `plugins/autonomous-dev/src/hooks/types.ts`
   - Acceptance criteria: TypeScript strict mode compiles. All 10 hook points are exported. `HookManifest` field set matches TDD §13.1. JSDoc references TDD §9 for the hook-point catalog.
   - Estimated effort: 2h

2. **Author `hook-manifest-v1.json` schema** -- Create the JSON Schema (Draft 2020-12) for `HookManifest` covering: required top-level fields, hook entry shape, capability enum, failure-mode enum, semver pattern for `version`, kebab-case pattern for `id`. Use `additionalProperties: false` at every level.
   - Files to create: `plugins/autonomous-dev/schemas/hook-manifest-v1.json`
   - Acceptance criteria: Schema validates a fixture from `tests/fixtures/plugins/valid-plugin/hooks.json`. Missing `id` fails with a clear error. Invalid `failure_mode` value (`'panic'`) fails with enum error. Extra top-level field fails. Schema includes a worked example in the `examples` field.
   - Estimated effort: 2h

3. **Implement `PluginDiscovery` class** -- Create `src/hooks/discovery.ts` with a class that has `scan(rootDir)`, `parseManifest(path)`, `validateManifest(manifest)` methods. The scan walks `<rootDir>/*/hooks.json`, parses each, validates against the schema, and returns a list of `{plugin, errors[]}` results. Validation here is structural (schema only); trust/security validation is layered in by PLAN-019-3.
   - Files to create: `plugins/autonomous-dev/src/hooks/discovery.ts`
   - Acceptance criteria: Scanning a directory with two valid plugins and one with a malformed `hooks.json` returns three results, two `success`, one `failure` with structured error pointing at the malformed field. Symlinks are followed (so plugins installed via npm link work). Unicode plugin names are handled. Scan completes in <100ms for 50 plugins.
   - Estimated effort: 4h

4. **Implement `HookRegistry` class** -- Create `src/hooks/registry.ts` with `Map<HookPoint, HookEntry[]>` storage, `register(plugin, hook)`, `unregister(plugin)`, `getHooksForPoint(point)`, `clear()`, and `snapshot()`. The `register` method inserts hooks in priority order (descending: highest priority runs first). Multiple hooks at the same priority preserve insertion order (stable sort).
   - Files to create: `plugins/autonomous-dev/src/hooks/registry.ts`
   - Acceptance criteria: Registering three hooks with priorities 100, 50, 75 at the same hook point produces order [100, 75, 50]. `unregister(pluginId)` removes all hooks from that plugin in O(n). `snapshot()` returns a deep-frozen view safe for concurrent readers. Unit tests cover: empty registry, single plugin, multi-plugin, priority ordering, ties, unregister.
   - Estimated effort: 3h

5. **Implement `HookExecutor` class skeleton** -- Create `src/hooks/executor.ts` with an `executeHooks(point, context)` method that iterates the registry's entries for `point`, dynamically `require`s each plugin's `entry_point` module, calls it with `context`, captures the return value, and aggregates into a `HookExecutionResult`. Failure-mode behavior is delegated to PLAN-019-4 (this plan implements only the happy path + a no-op for failures).
   - Files to create: `plugins/autonomous-dev/src/hooks/executor.ts`
   - Acceptance criteria: For a hook point with two registered hooks, both are invoked in priority order with the same context. Each hook's return value is captured. If a hook throws, the error is caught and recorded, but iteration continues (PLAN-019-4 will add the gating semantics). Hooks are invoked sequentially (no parallelism). Unit test exercises a fixture plugin with a synchronous hook function.
   - Estimated effort: 3h

6. **Wire SIGUSR1 reload into daemon** -- Modify `bin/supervisor-loop.sh` to install a SIGUSR1 trap that invokes `node bin/reload-plugins.js` (a small shim that calls `PluginDiscovery.reload()` against the running registry via a Unix domain socket). The reload swaps the registry atomically and logs the diff.
   - Files to modify: `plugins/autonomous-dev/bin/supervisor-loop.sh`, plus a new `plugins/autonomous-dev/bin/reload-plugins.js`
   - Acceptance criteria: Sending `kill -USR1 <daemon-pid>` triggers a reload visible in the daemon log. The log entry shows the diff (e.g., `+ added: hooks=[{plugin=foo, point=intake-pre-validate}]`). In-flight hook executions complete with the OLD registry; new executions use the NEW registry. Multiple rapid SIGUSR1s are coalesced (debounced 100ms).
   - Estimated effort: 4h

7. **Add `plugin list` and `plugin reload` CLI subcommands** -- Extend the CLI dispatcher with `autonomous-dev plugin list` (prints registry contents in a tabular format) and `autonomous-dev plugin reload` (sends SIGUSR1 to the daemon and waits for confirmation in the log).
   - Files to modify: `plugins/autonomous-dev/src/cli/commands/plugin.ts` (create the subcommand group)
   - Acceptance criteria: `plugin list` shows columns: Plugin ID, Version, Hook Point, Priority, Failure Mode. `--json` flag emits machine-readable output. `plugin reload` exits 0 only after the daemon log confirms the reload completed; exits 1 on timeout.
   - Estimated effort: 2h

8. **Create fixture plugins for tests** -- Author three minimal plugin fixtures under `tests/fixtures/plugins/`: a valid plugin with one hook, a valid plugin with three hooks at different priorities, and an invalid plugin with a malformed manifest. Each fixture has a real entry-point JS file.
   - Files to create: `plugins/autonomous-dev/tests/fixtures/plugins/{simple,multi-hook,malformed}/hooks.json` and `*.js` entry points
   - Acceptance criteria: Fixture plugins are valid Node modules. Their entry-point functions echo the input context (so tests can assert what was passed). The malformed manifest has a clear single error (e.g., missing `id`) so tests can lock in the error message.
   - Estimated effort: 2h

9. **Unit tests** -- `tests/hooks/test-discovery.test.ts`, `test-registry.test.ts`, `test-executor.test.ts` covering all critical paths from tasks 3, 4, 5. Use the fixture plugins from task 8.
   - Files to create: three test files under `plugins/autonomous-dev/tests/hooks/`
   - Acceptance criteria: All tests pass. Coverage ≥90% on the three new classes. Tests are deterministic (no real `~/.claude/plugins/` access; everything in temp dirs).
   - Estimated effort: 4h

10. **Integration test: discovery + reload** -- `tests/integration/test-plugin-reload.test.ts` that copies fixture plugins into a temp dir, starts the daemon pointing at that dir (via env var `AUTONOMOUS_DEV_PLUGIN_DIR`), invokes `plugin list` via the CLI, removes one fixture, sends SIGUSR1, waits for the reload log line, invokes `plugin list` again, asserts the removed plugin is gone.
    - Files to create: `plugins/autonomous-dev/tests/integration/test-plugin-reload.test.ts`
    - Acceptance criteria: Test passes deterministically. The reload happens in <500ms (per TDD §16 perf target). The daemon doesn't crash during the reload; in-flight requests continue normally.
    - Estimated effort: 3h

## Dependencies & Integration Points

**Exposes to other plans:**
- `HookPoint`, `HookManifest`, `HookEntry`, `FailureMode`, `Capability` types consumed by PLAN-019-2/3/4.
- `HookRegistry` and `HookExecutor` interfaces extended by PLAN-019-2 (validation), PLAN-019-3 (trust gates), PLAN-019-4 (sequential execution detail).
- `PluginDiscovery` reused by future plugin marketplace tooling.
- SIGUSR1 reload pattern documented for future signal-driven daemon operations.

**Consumes from other plans:**
- TDD-001 / PLAN-001-2: existing supervisor loop and signal-handling pattern.
- TDD-001 / PLAN-001-3: existing logging pipeline (the discovery and reload events route through it).
- PRD-001 sandbox capability: deferred for execution (this plan invokes hooks in-process; sandbox isolation is layered by a future plan that wraps `HookExecutor.executeHooks()`).

## Testing Strategy

- **Unit tests (task 9):** Schema validation, discovery, registry, executor — ≥90% coverage on new classes.
- **Integration test (task 10):** End-to-end discovery + SIGUSR1 reload using fixture plugins in a temp dir.
- **Performance test:** Benchmark scan of 50 plugins; assert <100ms per the perf target. Add as part of `npm test:perf` so it runs in CI.
- **Manual smoke:** Install a real fixture plugin into `~/.claude/plugins/`, restart daemon, verify it appears in `plugin list`. Modify the manifest, send SIGUSR1, verify the change is reflected.
- **Failure-injection tests:** Malformed JSON, missing entry-point file, circular plugin dependencies (deferred to PLAN-019-2 since trust mechanics handle it). For now, malformed JSON results in the plugin being skipped with an error logged.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Plugin discovery walks symlinks into infinite loops or accesses files outside `~/.claude/plugins/` | Medium | High -- security and reliability concerns | Discovery scans only `<rootDir>/*/hooks.json` (one level deep, no recursion). Symlinks are followed but not into the manifest's parent (so a malicious plugin can't symlink into `/etc/passwd`). Path canonicalization rejects any path outside `<rootDir>`. |
| SIGUSR1 reload races with in-flight hook execution, causing crashes | Medium | High -- daemon instability | Registry uses copy-on-write semantics: the executor reads a snapshot at the start of each hook-point invocation. New registry replaces the old atomically; old snapshots remain valid until GC'd. In-flight executions complete with their snapshot. |
| Plugin entry-point code throws synchronously and crashes the daemon | High | High -- single bad plugin takes down everything | The executor wraps every hook invocation in `try/catch`. PLAN-019-4 implements full failure-mode semantics (block/warn/ignore). This plan's no-op default treats any throw as a logged warning, never a crash. Sandbox isolation (worker_threads) lands in a follow-up coordinated with PRD-001. |
| Registry priority ordering is non-deterministic for ties, causing unpredictable behavior | Low | Medium -- intermittent test failures | The sort is stable (`Array.prototype.sort` in Node ≥12 is stable). Ties preserve insertion order. Documented in `HookRegistry.register()` JSDoc. Unit test asserts stability across 100 random insertions. |
| `bin/reload-plugins.js` uses Unix domain socket that doesn't exist on Windows | Low | Low -- macOS/Linux only is fine for now | Daemon is documented as POSIX-only (no Windows support). The socket path is `~/.autonomous-dev/daemon.sock`. Windows compatibility is captured as a future open question. |
| 50-plugin scan target (<100ms) is unrealistic on slow disks (e.g., network-mounted home dir) | Medium | Low -- discovery is slow but not wrong | Discovery is async (concurrent file reads via `Promise.all`). Cold cache may exceed the budget; warm cache is well within. Document the perf target as p95 on local SSD. Operators with NFS home dirs are advised to symlink `~/.claude/plugins/` to a local volume. |

## Definition of Done

- [ ] `HookPoint` enum covers all 10 points from TDD §9
- [ ] `HookManifest` JSON schema validates fixture plugins and rejects malformed ones with clear errors
- [ ] `PluginDiscovery` scans the plugin directory in <100ms for 50 plugins
- [ ] `HookRegistry` maintains stable priority ordering; `unregister()` removes all hooks from a plugin
- [ ] `HookExecutor.executeHooks()` invokes registered hooks sequentially in priority order
- [ ] SIGUSR1 reload swaps the registry atomically; in-flight executions are unaffected
- [ ] `autonomous-dev plugin list` and `plugin reload` subcommands work and have JSON output mode
- [ ] Three fixture plugins (simple, multi-hook, malformed) exist and are referenced by tests
- [ ] Unit tests pass with ≥90% coverage on `discovery.ts`, `registry.ts`, `executor.ts`
- [ ] Integration test demonstrates discovery + reload end-to-end using fixture plugins
- [ ] Performance benchmark confirms 50-plugin scan <100ms on local SSD
- [ ] Daemon doesn't crash when a plugin's entry-point throws (basic guard; full failure-mode in PLAN-019-4)
- [ ] All shell scripts pass shellcheck; all TypeScript passes `--strict`

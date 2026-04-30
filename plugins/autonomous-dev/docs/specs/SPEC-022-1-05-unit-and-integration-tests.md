# SPEC-022-1-05: Unit and Integration Tests for the Chaining Engine

## Metadata
- **Parent Plan**: PLAN-022-1
- **Tasks Covered**: Task 10 (unit tests for artifact registry, dependency graph, cycle detection, executor), Task 11 (integration test: full three-plugin chain execution)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-022-1-05-unit-and-integration-tests.md`

## Description
Lock in PLAN-022-1's correctness with four focused unit-test files (one per primitive: artifact registry, dependency graph, cycle detection, chain executor) and one end-to-end integration test that exercises the full discovery → graph build → chain execution → artifact persistence flow against three fixture plugins. Together they enforce the acceptance criteria of SPEC-022-1-02, SPEC-022-1-03, and SPEC-022-1-04, plus the `≥95% coverage` and `<50ms p95 cycle detection on 100 plugins` budgets from PLAN-022-1's Definition of Done.

A schema-validation unit test for `plugin-manifest-v2.json` and the two artifact schemas (`security-findings/1.0.json`, `code-patches/1.0.json`) is also included here so all schema-shape assertions live in one place. Tests must be deterministic (no `~/.claude/plugins/` access; everything runs against `os.tmpdir()` subdirectories), parallelizable across files, and cleanup-correct.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/chains/test-schemas.test.ts` | Create | Manifest v2 + artifact schema validation |
| `plugins/autonomous-dev/tests/chains/test-artifact-registry.test.ts` | Create | Loading, validation, persistence |
| `plugins/autonomous-dev/tests/chains/test-dependency-graph.test.ts` | Create | Graph construction, getProducers/getConsumers, edge generation |
| `plugins/autonomous-dev/tests/chains/test-cycle-detection.test.ts` | Create | Tarjan SCC + Kahn topological sort, ≥5 cycle topologies |
| `plugins/autonomous-dev/tests/chains/test-executor.test.ts` | Create | ChainExecutor sequencing, error skip-cascade, validation gates |
| `plugins/autonomous-dev/tests/integration/test-chain-execution.test.ts` | Create | End-to-end three-plugin chain via daemon |
| `plugins/autonomous-dev/tests/helpers/chain-fixtures.ts` | Create | Shared helpers: temp request dir, manifest builder, graph builder |

## Implementation Details

### Test Runner

Repo uses `vitest`. All test files use `describe` / `it` / `expect`. Each file isolates state in `beforeEach` (temp dirs created via `os.mkdtemp`) and tears down in `afterEach`. No global setup beyond `vitest.config.ts`.

### `tests/helpers/chain-fixtures.ts`

Exports:
- `async createTempRequestDir(): Promise<string>` — returns `os.mkdtemp(path.join(os.tmpdir(), 'ad-chain-'))`.
- `async cleanupTempDir(dir: string): Promise<void>` — recursive remove, idempotent.
- `buildManifest(opts): HookManifest` — constructs a v2 manifest with sane defaults; opts: `{id, produces?, consumes?, hooks?}`.
- `buildGraphFrom(manifests: HookManifest[]): DependencyGraph` — instantiates `DependencyGraph` and calls `addPlugin` for each.
- `buildExecutor(graph, artifacts, opts?): ChainExecutor` — wires up a `ChainExecutor` with stub `manifestLookup` and `chainHookSelector` from a provided manifest array.
- `async loadArtifactSchemas(): Promise<ArtifactRegistry>` — boots an `ArtifactRegistry` against the repo's `schemas/artifacts/` directory.

### `tests/chains/test-schemas.test.ts`

`describe('plugin-manifest-v2.json')`:
- `parses cleanly` — `JSON.parse` of the schema file.
- `accepts the embedded examples[0]` — round-trip via tiny hand-rolled validator (or AJV if PLAN-019-2 is merged).
- `accepts a v1-shaped manifest with no produces/consumes` — backward compat.
- `rejects produces[].format = 'xml'` (enum violation).
- `rejects consumes[] missing artifact_type` (`/required` error).
- `rejects extra top-level field 'category'` (`additionalProperties: false`).
- `rejects produces[].schema_version of '1'` (pattern violation).

`describe('security-findings/1.0.json')`:
- `parses cleanly`, `$schema = draft/2020-12/schema`, `$id` set.
- `validates the canonical example` (from `tests/fixtures/artifacts/security-findings.example.json`).
- `rejects payload missing scan_id`.
- `rejects finding with severity 'urgent'`.
- `rejects extra top-level field`.
- `additionalProperties: false at every object level` — static walk.

`describe('code-patches/1.0.json')`:
- Mirror security-findings tests: parse, accept canonical, reject missing `patch_id`, reject `confidence: 1.5`, reject extras.

### `tests/chains/test-artifact-registry.test.ts`

`describe('ArtifactRegistry')`:
- `loadSchemas registers both shipped types`
- `loadSchemas returns errors for a malformed schema file (synthesized in temp dir) but loads the others`
- `validate returns isValid:true for canonical security-findings example`
- `validate returns isValid:false with pointer at /findings/0/severity for an enum violation`
- `validate of unknown type returns isValid:false with 'unknown artifact type'`
- `persist writes file at <requestRoot>/.autonomous-dev/artifacts/<type>/<scanId>.json with mode 0600`
- `persist creates parent directories if absent (mkdir recursive)`
- `persist uses temp file then rename (no .tmp.* file remains after)`
- `persist with simulated rename failure unlinks the temp file (no stranded .tmp.*)` — mock `fs.rename` via `vi.spyOn` to throw once
- `persist rejects scanId containing '..'` — throws, no file written
- `persist rejects scanId containing '/'`
- `load round-trips a persisted artifact deep-equal`
- `load throws 'artifact not found' on ENOENT`
- `knownTypes returns lex-sorted list`
- `loadSchemas called twice replaces the cache (no duplicates)`

### `tests/chains/test-dependency-graph.test.ts`

`describe('DependencyGraph')`:
- `empty graph: getEdges/getNodes/topologicalSort all empty`
- `single plugin with no consumes: 1 node, 0 edges`
- `producer + consumer: 1 edge with correct artifactType + schemaVersion`
- `two producers + one consumer: 2 edges`
- `one producer + two consumers: 2 edges`
- `self-edge prune: plugin produces and consumes same type → no edge, but node remains`
- `consumer range '^2.0' against '1.0' producer: 0 edges (range mismatch)`
- `getProducers returns lex-sorted by pluginId`
- `getConsumers returns lex-sorted`
- `multi-edge: same producer-consumer pair across two artifact types → both ChainEdges in getEdges()`
- `isolated plugin (no produces, no consumes) appears in getNodes() and topologicalSort()`
- `addPlugin idempotent on same plugin: edges/nodes unchanged on re-add`

### `tests/chains/test-cycle-detection.test.ts`

`describe('cycle detection')`:
- `acyclic linear A→B→C: detectCycles returns []; topologicalSort returns ['A','B','C']`
- `acyclic diamond A→B,A→C,B→D,C→D: topologicalSort returns ['A','B','C','D']`
- `2-cycle A→B,B→A: detectCycles returns one SCC ['A','B','A'] (or deterministically ['B','A','B']); topologicalSort throws CycleError`
- `3-cycle A→B→C→A: detectCycles returns ['A','B','C','A']`
- `5-cycle A→B→C→D→E→A: detectCycles returns SCC of length 6`
- `self-loop (injected via direct adj manipulation): detectCycles returns [['A','A']]`
- `two disjoint cycles A→B→A and C→D→C: detectCycles returns 2 SCCs`
- `mixed: DAG with one back-edge becomes one SCC; topologicalSort throws`
- `CycleError.message contains ' -> ' separators`
- `CycleError.cyclePath is frozen (Object.isFrozen returns true; mutation throws in strict mode)`
- `CycleError thrown from topologicalSort has cyclePath equal to first SCC from detectCycles`

`describe('topological sort determinism')`:
- `running topologicalSort 10 times on the same DAG returns the identical array`
- `lex tie-break: in a graph with multiple in-degree-zero nodes, output starts with the lex-smallest`

`describe('cycle detection performance')`:
- `synthesized 100-plugin DAG: detectCycles completes < 50ms p95 over 5 runs` — generated programmatically in `beforeAll`
- `synthesized 100-plugin DAG with one injected cycle: detectCycles completes < 50ms p95 over 5 runs and finds the cycle`
- `5000-node linear chain: detectCycles does NOT throw 'Maximum call stack size exceeded'` (iterative-stack proof)

### `tests/chains/test-executor.test.ts`

`describe('ChainExecutor')`:
- `executeChain with valid seed + one downstream consumer: returns ok:true with 2 steps in topological order`
- `seed artifact failing schema validation: returns ok:false with 1 step (validation error); no downstream invocation`
- `executeChain on 3-plugin chain (A→B→C): all three steps in order, each persisted artifact on disk`
- `mid-chain plugin throws: that step status='error'; downstream reachable plugins status='skipped' with 'upstream error in <P>'`
- `parallel-branch plugin (NOT downstream of failed plugin) still runs: status='ok'`
- `downstream consumer with no upstream producer in this chain run: status='skipped' with 'no upstream producer in this chain run'`
- `produced payload failing its produced-schema validation: step status='error' with validation messages; skip-cascade activates`
- `each successful step's durationMs > 0`
- `total chain time = sum(step durations) ± 5ms (sequential, no parallelism)`
- `each persisted artifact exists at <requestRoot>/.autonomous-dev/artifacts/<type>/<scanId>.json`
- `console.info called once per step with prefix 'chain:'` — `vi.spyOn(console, 'info')`

### `tests/integration/test-chain-execution.test.ts`

A single end-to-end scenario:

`describe('chain execution integration')` → `it('runs a 3-plugin chain end-to-end and persists all artifacts')`:

1. Create temp request dir + temp plugin dir.
2. Drop three fixture plugin trees into the plugin dir:
   - `security-reviewer/`: produces `security-findings@1.0`. Hook returns the canonical fixture payload.
   - `code-fixer/`: consumes `^1.0` of `security-findings`, produces `code-patches@1.0`. Hook reads `context.inputs['security-findings']` and returns a canonical patches payload.
   - `audit-logger/`: consumes `^1.0` of `code-patches`. Hook writes a sentinel file `<requestRoot>/.autonomous-dev/audit-ran` to prove it executed; returns no produces.
3. Spawn the daemon with `AUTONOMOUS_DEV_PLUGIN_DIR=<tempPluginDir>`.
4. Trigger the chain via either:
   - Direct call to the executor's IPC endpoint (preferred — most testable), OR
   - The phase-end event hook that the daemon already emits when a request advances; for THIS spec a test-only IPC command `{command: 'chain-trigger', pluginId: 'security-reviewer', requestRoot, scanId, payload}` is added (gated behind `NODE_ENV === 'test'`).
5. Assert: response has `ok: true` and 3 steps in order `['security-reviewer', 'code-fixer', 'audit-logger']`.
6. Assert: file `<requestRoot>/.autonomous-dev/artifacts/security-findings/<scanId>.json` exists; JSON.parse equals the canonical security-findings payload.
7. Assert: file `<requestRoot>/.autonomous-dev/artifacts/code-patches/<patchId>.json` exists.
8. Assert: file `<requestRoot>/.autonomous-dev/audit-ran` exists (proves the third plugin ran).
9. Negative path: re-run with a `code-fixer` that throws. Assert `audit-logger` step has `status: 'skipped'` and message contains `upstream error in code-fixer`. The audit-ran sentinel from step 8 is from the FIRST run; for the negative path use a fresh temp request dir and assert the sentinel does NOT exist.
10. Stop the daemon; clean up temp dirs.

Test must be deterministic: no `setTimeout` waits longer than 50ms; all waits are poll-with-deadline helpers (reuse `tests/helpers/plugin-fixtures.ts` from SPEC-019-1-05 if its helpers are exported).

## Acceptance Criteria

- [ ] All 6 test files exist; `vitest run tests/chains tests/integration` completes with zero failures.
- [ ] Coverage report (`vitest run --coverage`) shows ≥ 95% line coverage on `src/chains/artifact-registry.ts`, `src/chains/dependency-graph.ts`, `src/chains/executor.ts`, and ≥ 90% on `src/chains/cycle-error.ts` and `src/cli/commands/chains.ts`.
- [ ] No test reads or writes `~/.claude/plugins/` or `~/.autonomous-dev/` outside the spawned daemon's controlled paths.
- [ ] Every test cleans up its temp directory in `afterEach`/`afterAll`. No test pollutes another's state.
- [ ] The 100-plugin perf assertions in `test-cycle-detection.test.ts` pass with `< 50ms p95` over 5 runs on local SSD; the test reports actual ms in its output.
- [ ] The 5000-node iterative-stack assertion does NOT throw `RangeError: Maximum call stack size exceeded`.
- [ ] The integration test does not use any `setTimeout`-based wait longer than 50ms; all waits are poll-with-deadline helpers.
- [ ] All tests are independent: running any single test file in isolation produces the same pass/fail outcome as running the full suite.
- [ ] Cycle-detection test suite covers ≥ 5 distinct cycle topologies (2-cycle, 3-cycle, 5-cycle, self-loop, two-disjoint-cycles), per PLAN-022-1's testing strategy.
- [ ] Schema test suite covers all three schemas (manifest v2 + 2 artifact schemas), with at least 4 negative cases per schema.
- [ ] Integration test verifies all 3 fixture plugins ran in order AND the audit-ran sentinel proves the chain reached the end (positive path) AND the sentinel is absent on the negative path.
- [ ] Linting (`npm run lint`) and type-check (`npm run typecheck`) pass against all new test files.
- [ ] Test names map 1:1 to the bullet lists in this spec's Implementation Details (`vitest run --reporter=verbose` produces the expected catalog).

## Dependencies

- SPEC-022-1-01, SPEC-022-1-02, SPEC-022-1-03, SPEC-022-1-04 — all consumed.
- SPEC-019-1-05's helpers (`spawnDaemon`, `createTempPluginDir`, etc.) — reused; export from `tests/helpers/plugin-fixtures.ts` if not already exported.
- `vitest` (already in repo).
- AJV 2020 + ajv-formats (used by `ArtifactRegistry`; tests instantiate it via the registry).
- Node ≥ 18 (`fs.mkdtemp`, `fs.rm` recursive, `performance.now`).
- No new npm dev-dependencies introduced.

## Notes

- The schema-validation tests live HERE (not in SPEC-022-1-01 or SPEC-022-1-02) because tests are SPEC-022-1-05's job by convention; the schema files themselves are created in their respective specs.
- The 100-plugin and 5000-node performance tests may be tagged `.skipIf(process.env.CI === 'true')` if CI hardware is unreliable; the perf budget is enforced on the maintainer's local SSD per PLAN-022-1's risk register.
- The integration test deliberately exercises the chain-trigger path through the daemon (rather than calling `ChainExecutor.executeChain` in-process) to catch IPC + serialization regressions in the same suite.
- The test-only `chain-trigger` IPC command is gated behind `NODE_ENV === 'test'` to ensure it is never reachable in production. The gate lives in `src/hooks/ipc-server.ts` next to the existing dispatcher switch.
- Integration test isolation: each daemon spawn uses a unique socket path derived from the temp dir (`<tempDir>/daemon.sock` rather than `~/.autonomous-dev/daemon.sock`) when `AUTONOMOUS_DEV_SOCKET_PATH` env var is set; the `spawnDaemon` helper from SPEC-019-1-05 should accept this override. If it does not yet, this spec adds the env-var read to `ipc-server.ts` (5-line change documented in test-helpers).
- The AJV-based schema tests assume PLAN-019-2 has merged (AJV available in the repo). If reordering is required, the schema tests fall back to a tiny hand-rolled validator (≤ 50 lines) reused from SPEC-019-1-05's `tests/helpers/schema-validator.ts`.
- The negative-path integration sub-scenario (mid-chain throw) verifies the skip-cascade end-to-end. Future plans (PLAN-022-2's full failure-mode taxonomy) will extend this with `block`/`warn`/`ignore` differentiation; for PLAN-022-1 the simple skip-on-error is the contract.
- Future plans (PLAN-022-2/3) will extend this suite. The structure here (one file per primitive + one integration scenario) is the template they should follow, mirroring the convention established by SPEC-019-1-05.

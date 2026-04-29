# PLAN-022-1: Plugin Manifest Extensions + Artifact Schemas + Chain Executor + Cycle Detection

## Metadata
- **Parent TDD**: TDD-022-plugin-chaining-engine
- **Estimated effort**: 5 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0

## Objective
Deliver the foundational plugin chaining engine: the `produces`/`consumes` plugin manifest extensions per TDD §5, the artifact schema registry (security-findings, code-patches, plus the framework for additional types), the chain executor that performs topological sort and sequential execution per TDD §7, and the cycle-detection algorithm per TDD §8 that runs at daemon startup. Resource limits, standards integration, trust enforcement, security, and audit log are layered in by sibling plans.

## Scope
### In Scope
- `ProducesDeclaration` and `ConsumesDeclaration` TypeScript interfaces and JSON schema extensions in `plugin-manifest-v2.json` (extends PLAN-019-1's v1 schema with `produces[]` and `consumes[]` fields)
- Manifest validation: every `consumes` artifact_type must have at least one matching `produces` from another plugin in the registry; orphan consumers are rejected at registration time
- Artifact schema registry at `schemas/artifacts/<artifact-type>/<version>.json` with two initial types: `security-findings/1.0.json` (per TDD §6) and `code-patches/1.0.json` (per TDD §6 lines onward)
- `ArtifactRegistry` class at `src/chains/artifact-registry.ts` that loads schemas at startup and exposes `validate(artifactType, version, payload)` returning `ValidationResult`
- File-based artifact persistence at `<request>/.autonomous-dev/artifacts/<artifact-type>/<scan-id>.json` with atomic writes (temp + rename) per the existing two-phase commit pattern
- `DependencyGraph` class at `src/chains/dependency-graph.ts` that builds a directed graph from registered plugins' `produces`/`consumes` declarations; nodes are plugin IDs, edges are artifact-type dependencies
- `topologicalSort(graph)` that returns plugins in execution order (producers before consumers); detects cycles and throws `CycleError` with the cycle path for debugging
- `ChainExecutor` class at `src/chains/executor.ts` per TDD §7: runs the topological order sequentially, loads upstream artifacts via the registry, invokes each plugin with the artifact context, and persists downstream artifacts. Errors propagate to skip downstream consumers (full failure-mode semantics in PLAN-022-2).
- `cycle-detection.ts` per TDD §8: Tarjan's strongly connected components algorithm for cycle detection at startup, plus a debug helper `findCycle(graph, plugin)` that returns the shortest cycle through a given plugin
- CLI `autonomous-dev chains list` (prints registered chain edges in tabular form) and `chains graph [--format dot|mermaid]` (emits the dependency graph for visualization)
- Unit tests for: manifest validation (orphan consumer detection), artifact schema validation (positive/negative for both types), topological sort (linear chain, branching, missing producers), cycle detection (cycle in 2/3/N nodes), executor sequencing (artifact passed correctly downstream)
- Integration test: register three fixture plugins forming a chain (producer → middle → consumer), trigger the chain via a phase-end event, verify all three plugins ran in order and the final artifact is on disk

### Out of Scope
- Resource limits (chain length, timeouts, artifact size caps) -- PLAN-022-2
- Standards-to-fix flow integration with rule-set-enforcement-reviewer -- PLAN-022-2
- Plugin trust integration / privileged-chain authorization -- PLAN-022-2
- Inter-plugin data flow security (artifact sanitization, schema strictness) -- PLAN-022-3
- Audit log integration -- PLAN-022-3
- Parallel execution within chain levels (NG-2202) — sequential by design
- Hot-reload / dynamic chain reconfiguration (NG-2203)
- Cross-request artifact sharing (NG-2204) — request-isolated by design
- Patch application without approval (NG-2206) — chain produces artifacts; application is human-gated
- Branching/conditional chains (NG-2207) — linear chains only

## Tasks

1. **Extend plugin-manifest schema to v2** -- Update `schemas/plugin-manifest-v2.json` (or create as a sibling of v1) with optional `produces[]` and `consumes[]` arrays per TDD §5. Each declaration validates against `ProducesDeclaration`/`ConsumesDeclaration` shapes. Include version compatibility rule: schema_version on consume must be in semver compat range of producer's schema_version.
   - Files to create: `plugins/autonomous-dev/schemas/plugin-manifest-v2.json`
   - Acceptance criteria: Schema validates the TDD §5 examples (security-reviewer, code-fixer, rule-set-enforcement-reviewer). Missing `artifact_type` fails. Non-semver `schema_version` fails. `format` outside the enum (`json|yaml|text`) fails. Extension is backward-compatible: v1 manifests without `produces`/`consumes` continue to validate.
   - Estimated effort: 3h

2. **Implement manifest validation for orphan consumers** -- During plugin discovery (PLAN-019-1's `PluginDiscovery`), after all manifests are parsed, run a cross-reference check: every `consumes.artifact_type` must have at least one matching `produces.artifact_type` (with compatible schema_version) from another registered plugin. Orphan consumers are rejected with a clear error.
   - Files to modify: `plugins/autonomous-dev/src/hooks/discovery.ts` (extend with `validateChainConsistency()`)
   - Acceptance criteria: Three plugins where plugin C consumes `widgets` but no plugin produces `widgets` results in C being rejected with "no producer found for artifact_type 'widgets'". When a producer for `widgets` is added, C is accepted on next reload. Test covers single missing producer, multiple missing, version-incompatible producer.
   - Estimated effort: 3h

3. **Author artifact schemas** -- Create `schemas/artifacts/security-findings/1.0.json` per TDD §6 (full schema with $defs for SecurityFinding and FindingsSummary) and `schemas/artifacts/code-patches/1.0.json` (the analogous schema for patches with confidence, file path, before/after, requires_approval). Both follow JSON Schema 2020-12.
   - Files to create: two JSON schema files under `plugins/autonomous-dev/schemas/artifacts/`
   - Acceptance criteria: Both schemas validate canonical example artifacts. Missing required fields fail. `additionalProperties: false` at every level. Schemas declare `$id` and `$schema`. Tests use TDD §6's example payloads.
   - Estimated effort: 3h

4. **Implement `ArtifactRegistry`** -- Create `src/chains/artifact-registry.ts` with `loadSchemas(rootDir)` that walks `schemas/artifacts/<type>/<version>.json` and pre-compiles validators. `validate(type, version, payload)` returns `ValidationResult`. `persist(requestId, type, scanId, payload)` writes to disk via the two-phase commit pattern.
   - Files to create: `plugins/autonomous-dev/src/chains/artifact-registry.ts`
   - Acceptance criteria: Loading the schemas dir registers both initial types. `validate('security-findings', '1.0', payload)` returns isValid for a TDD §6 example. `persist` writes to `<request>/.autonomous-dev/artifacts/security-findings/<scan-id>.json`. Atomic write uses temp file + rename. Tests cover registration, validation, persist.
   - Estimated effort: 3h

5. **Implement `DependencyGraph`** -- Create `src/chains/dependency-graph.ts` with `addPlugin(plugin)`, `getEdges()`, `getProducers(artifactType)`, `getConsumers(artifactType)` methods. Graph is directed: producers → consumers. Stored as adjacency list.
   - Files to create: `plugins/autonomous-dev/src/chains/dependency-graph.ts`
   - Acceptance criteria: Adding 5 plugins with various produces/consumes relationships produces the right edges. `getProducers('security-findings')` returns all plugins that declare it. Tests cover empty graph, single plugin, multi-plugin, multi-producer-for-same-type.
   - Estimated effort: 2h

6. **Implement cycle detection (Tarjan SCC)** -- Add `detectCycles()` to `DependencyGraph` per TDD §8 using Tarjan's algorithm for strongly connected components. Returns `CycleError` with the cycle path (plugin IDs in order) if any SCC has >1 node. Also detects self-loops.
   - Files to modify: `plugins/autonomous-dev/src/chains/dependency-graph.ts`
   - Acceptance criteria: Three plugins forming A→B→C is acyclic (passes). A→B→A is a cycle (fails with `CycleError: ['A', 'B', 'A']`). A→A is a self-loop (fails with `CycleError: ['A', 'A']`). Test cases enumerate small cycle sizes and one larger 5-node cycle.
   - Estimated effort: 4h

7. **Implement `topologicalSort()`** -- Add `topologicalSort()` to `DependencyGraph` using Kahn's algorithm. Returns `string[]` of plugin IDs in execution order. Throws if graph has cycles (uses task 6's detector first).
   - Files to modify: `plugins/autonomous-dev/src/chains/dependency-graph.ts`
   - Acceptance criteria: Linear chain A→B→C produces `['A', 'B', 'C']`. Diamond A→B, A→C, B→D, C→D produces a valid topological order (e.g., `['A', 'B', 'C', 'D']` or `['A', 'C', 'B', 'D']`). Cycle throws before sort. Test verifies all valid orderings for a 5-node DAG.
   - Estimated effort: 2h

8. **Implement `ChainExecutor`** -- Create `src/chains/executor.ts` per TDD §7 with `executeChain(triggeringPlugin, requestState)` method. Logic: get topological order, iterate from `triggeringPlugin` downstream, for each consumer load upstream artifacts via `ArtifactRegistry`, invoke the plugin (via existing hook executor or a chain-specific spawn helper), persist the downstream artifact.
   - Files to create: `plugins/autonomous-dev/src/chains/executor.ts`
   - Acceptance criteria: Triggered with a producer plugin that just emitted `security-findings`, the executor finds downstream consumers (e.g., `code-fixer`), invokes them in order, and persists their `code-patches` output. Errors in one plugin skip downstream consumers (logged; full failure-mode semantics in PLAN-022-2). Tests cover single-step chain, two-step chain, error propagation.
   - Estimated effort: 5h

9. **Implement `chains list` and `chains graph` CLI** -- `chains list` prints all registered chain edges in tabular form (producer → consumer, artifact-type, version). `chains graph [--format dot|mermaid]` emits the graph in Graphviz or Mermaid syntax for visualization.
   - Files to create: `plugins/autonomous-dev/src/cli/commands/chains-graph.ts`
   - Acceptance criteria: `chains list` shows all edges in the current registry. `chains graph --format dot` emits a valid `.dot` file (renders via Graphviz). `chains graph --format mermaid` emits a Mermaid `graph TB ...` block. Tests cover empty graph and 5-plugin graph.
   - Estimated effort: 2h

10. **Unit tests** -- `tests/chains/test-artifact-registry.test.ts`, `test-dependency-graph.test.ts`, `test-cycle-detection.test.ts`, `test-executor.test.ts` covering all paths from tasks 4-8. Use fixture plugins.
    - Files to create: four test files under `plugins/autonomous-dev/tests/chains/`
    - Acceptance criteria: All tests pass. Coverage ≥95% on `artifact-registry.ts`, `dependency-graph.ts`, `executor.ts`. Cycle-detection tests cover at least 5 distinct cycle topologies.
    - Estimated effort: 4h

11. **Integration test: full chain execution** -- `tests/integration/test-chain-execution.test.ts` that registers three fixture plugins (security-reviewer producing security-findings, code-fixer consuming and producing code-patches, an end-of-chain consumer just verifying), triggers the chain via a phase-end event, asserts all three plugins ran in order and the final artifact is on disk.
    - Files to create: `plugins/autonomous-dev/tests/integration/test-chain-execution.test.ts`
    - Acceptance criteria: Test passes deterministically. Plugins run in topological order. Each artifact validates against its schema. Errors in mid-chain plugin skip the end-of-chain consumer (verified separately).
    - Estimated effort: 3h

## Dependencies & Integration Points

**Exposes to other plans:**
- `ProducesDeclaration`, `ConsumesDeclaration`, `ArtifactRegistry`, `DependencyGraph`, `ChainExecutor` consumed by PLAN-022-2 (resource limits, standards integration), PLAN-022-3 (security, audit), and any future chain-related plan.
- Artifact schema registry pattern reusable for any future artifact type beyond security-findings and code-patches.
- Topological-sort and cycle-detection algorithms reusable for any future DAG-based system in autonomous-dev.

**Consumes from other plans:**
- **PLAN-019-1** (existing on main): plugin manifest schema v1 and `PluginDiscovery`. This plan extends both with chain-related fields.
- TDD-002 / PLAN-002-1: existing two-phase commit pattern for atomic artifact persistence.
- TDD-021 / PLAN-021-3: `fix-recipe-v1.json` schema (the `code-patches` schema in this plan is informed by but not the same as fix-recipes; a future plan may unify them).

## Testing Strategy

- **Unit tests (task 10):** Schema validation, dependency graph operations, cycle detection, topological sort, executor sequencing. ≥95% coverage.
- **Integration test (task 11):** End-to-end three-plugin chain execution.
- **Cycle detection adversarial:** Test cases with at least 5 cycle topologies (2-cycle, 3-cycle, self-loop, mutually-recursive pair, large cycle).
- **Manifest validation:** Negative cases for orphan consumers, version-incompatible chains, malformed declarations.
- **Performance:** Benchmark topological sort and cycle detection on a 100-plugin graph; assert <50ms p95.
- **Backward compatibility:** Existing v1 manifests (no `produces`/`consumes`) continue to load via the v1 schema unchanged.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Cycle detection misses subtle indirect cycles (e.g., A→B→C→A through three plugins) | Low | High -- chain hangs at runtime | Tarjan's SCC algorithm correctly detects all cycles regardless of length. Adversarial test suite (task 6) covers cycles of length 2, 3, 5, 10. |
| Orphan-consumer detection fails when producer plugin is loaded after consumer (load-order dependency) | Medium | Medium -- false rejection | Validation runs AFTER all plugins are parsed, before any are registered. Test covers reverse-order load. |
| Artifact files accumulate at `<request>/.autonomous-dev/artifacts/`, filling disk over many requests | Medium | Low -- request cleanup already handles this | Existing PRD-007 cleanup retention removes request directories after configured window. Chain artifacts are subject to the same retention. Per-artifact size cap in PLAN-022-2 prevents single artifact from blowing up. |
| Schema-version compatibility check (semver compat range) is too permissive (e.g., `^1.0.0` consumer accepts `2.0.0` producer) | Low | Medium -- broken chains at runtime | Semver compatibility uses caret semantics: consumer's `^1.0` accepts `1.x.y` producer but rejects `2.x`. Major version bumps break compatibility intentionally. Documented in JSDoc. |
| `ChainExecutor` invokes a plugin synchronously, blocking the daemon for slow plugins | High | Medium -- chain latency adds to daemon iteration | Sequential execution is intentional (NG-2202). Per-plugin timeout enforcement in PLAN-022-2 caps the impact. Long-running chains run in a worker pool, not the main loop. |
| Dependency graph mutates during reload, causing in-flight chain executions to see inconsistent state | Low | High -- partial chain execution | Like PLAN-019-1's hook registry, the graph uses copy-on-write semantics. In-flight executions see the snapshot at the start; reloads atomically replace. |

## Definition of Done

- [ ] `plugin-manifest-v2.json` extends v1 with `produces[]` and `consumes[]` (backward compat preserved)
- [ ] Manifest validation rejects orphan consumers with clear errors
- [ ] `security-findings/1.0.json` and `code-patches/1.0.json` schemas exist and validate canonical examples
- [ ] `ArtifactRegistry` loads schemas and supports validate + persist
- [ ] `DependencyGraph` correctly builds the producer→consumer DAG
- [ ] Cycle detection (Tarjan SCC) catches all cycles in adversarial tests
- [ ] Topological sort (Kahn) produces valid ordering for DAGs
- [ ] `ChainExecutor` runs plugins in topological order, persists downstream artifacts
- [ ] Errors in mid-chain plugins skip downstream consumers (basic; full failure-mode in PLAN-022-2)
- [ ] `chains list` and `chains graph` CLI subcommands work with both formats
- [ ] Unit tests pass with ≥95% coverage on new modules
- [ ] Integration test demonstrates three-plugin chain execution
- [ ] No regressions in PLAN-019-1's plugin discovery or hook system

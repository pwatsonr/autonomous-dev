# SPEC-022-1-04: ChainExecutor and `chains list` / `chains graph` CLI Subcommands

## Metadata
- **Parent Plan**: PLAN-022-1
- **Tasks Covered**: Task 8 (`ChainExecutor` class), Task 9 (`autonomous-dev chains list` and `chains graph` CLI subcommands)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-022-1-04-chain-executor-and-chains-cli.md`

## Description
Wire the three primitives from SPEC-022-1-01/02/03 into something the daemon can actually run. `ChainExecutor` consumes the topological order from `DependencyGraph`, walks downstream from a triggering plugin, loads upstream artifacts via `ArtifactRegistry`, invokes each consumer plugin via the existing hook executor (SPEC-019-1-03), and persists each downstream artifact. The CLI subcommands give operators a way to inspect the chain topology offline (`chains list` for tabular edges, `chains graph` for Graphviz/Mermaid output).

This spec implements ONLY the happy-path executor plus minimal failure handling (an error in a mid-chain plugin logs and skips downstream consumers; full failure-mode taxonomy lands in PLAN-022-2). Resource limits (per-chain timeout, max chain depth, per-artifact size cap) are out of scope and are PLAN-022-2's responsibility.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/chains/executor.ts` | Create | `ChainExecutor` class |
| `plugins/autonomous-dev/src/chains/index.ts` | Modify | Re-export `ChainExecutor`, `ChainExecutionResult` |
| `plugins/autonomous-dev/src/cli/commands/chains.ts` | Create | `chains` subcommand group with `list` and `graph` |
| `plugins/autonomous-dev/src/cli/dispatcher.ts` | Modify | Register `chains` route |
| `plugins/autonomous-dev/src/hooks/ipc-server.ts` | Modify | Add `chains-list` and `chains-graph` IPC commands |
| `plugins/autonomous-dev/src/hooks/ipc-client.ts` | Modify | (No code change required — protocol is data-only.) |

## Implementation Details

### `src/chains/executor.ts`

```ts
import type { DependencyGraph } from './dependency-graph';
import type { ArtifactRegistry } from './artifact-registry';
import type { HookExecutor } from '../hooks/executor';
import type { HookManifest } from '../hooks/types';

export interface ChainStep {
  pluginId: string;
  /** Artifact types this plugin consumed (loaded from disk). */
  consumed: Array<{ artifactType: string; scanId: string }>;
  /** Artifact types this plugin produced (persisted to disk). */
  produced: Array<{ artifactType: string; scanId: string; filePath: string }>;
  status: 'ok' | 'error' | 'skipped';
  /** Populated when status='error'. */
  error?: string;
  durationMs: number;
}

export interface ChainExecutionResult {
  triggeringPluginId: string;
  /** Initial scan id of the triggering plugin's emitted artifact, if any. */
  triggerScanId?: string;
  /** Steps in execution order (producers before consumers). */
  steps: ChainStep[];
  /** True iff every step is 'ok' or the chain naturally terminated (no consumers downstream). */
  ok: boolean;
}

export interface RequestState {
  /** Absolute path to the request's working directory. Artifacts persist under <root>/.autonomous-dev/artifacts/. */
  requestRoot: string;
  /** Stable id used as the default scanId when a plugin omits one. */
  requestId: string;
}

export class ChainExecutor {
  constructor(
    private readonly graph: DependencyGraph,
    private readonly artifacts: ArtifactRegistry,
    private readonly hookExecutor: HookExecutor,
    /** Resolves a pluginId to its full HookManifest (the chain consumer needs the produces[] list). */
    private readonly manifestLookup: (pluginId: string) => HookManifest | undefined,
    /** Maps a pluginId to its primary chain hook entry (the function we invoke). Returns undefined if the plugin has no chain hook. */
    private readonly chainHookSelector: (pluginId: string) => { resolvedEntryPoint: string } | undefined,
  ) {}

  /**
   * Execute the chain rooted at `triggeringPluginId`. The triggering plugin is
   * assumed to have ALREADY produced its artifact (passed in as `seedArtifact`).
   * Walks downstream consumers in topological order, invoking each.
   */
  async executeChain(
    triggeringPluginId: string,
    state: RequestState,
    seedArtifact: { artifactType: string; scanId: string; payload: unknown },
  ): Promise<ChainExecutionResult> { /* ... */ }
}
```

#### `executeChain` behavior

1. Validate that `seedArtifact.payload` passes `artifacts.validate(seedArtifact.artifactType, '<producer's schema_version>', payload)`. On failure → return `ok: false` with one `ChainStep` recording the validation error against `triggeringPluginId`. Do not invoke any downstream plugin.
2. Persist the seed artifact via `artifacts.persist(state.requestRoot, seedArtifact.artifactType, seedArtifact.scanId, payload)`. Record step `{pluginId: triggeringPluginId, produced: [...], status: 'ok'}`.
3. Compute the full topological order of the graph: `order = graph.topologicalSort()`.
4. Find the position of `triggeringPluginId` in `order`. Walk every plugin AFTER it in `order` (these are potential downstream consumers).
5. For each downstream plugin `P`:
   - Look up `manifest = manifestLookup(P)`. If `manifest === undefined`, skip with `status: 'skipped'` and a note (graph node was a placeholder).
   - Determine which `consumes[]` entries `P` declares can be satisfied by artifacts already produced in this chain (i.e., for each `consumes[i].artifact_type`, find producers earlier in this chain's `steps` whose schemaVersion satisfies the range; the most-recent producer's `scanId` wins). If P consumes an artifact type that no upstream step produced, skip P with `status: 'skipped'`, message `'no upstream producer in this chain run for artifact_type X'` (this is normal — P may live on a different branch).
   - Load each consumed artifact via `artifacts.load(state.requestRoot, type, scanId)`. Build `context = { request: state, inputs: { [artifactType]: payload } }`.
   - Look up `chainHookSelector(P)`. If undefined, skip with status `'skipped'`. Else, invoke via `hookExecutor.invokeOne(...)` (or an equivalent direct require + call — the cleanest path is an internal helper that mirrors `HookExecutor.invokeOne` from SPEC-019-1-03). Capture the return value.
   - Validate the returned object against P's `produces[i].artifact_type / schema_version` for each declared producer. If validation fails: `status: 'error'`, error message names the validation failures. Continue to NEXT plugin (no further downstream of this failed plugin runs — see step 6).
   - Persist each produced artifact. Record `produced[]` in the step.
6. Skip-cascade rule: if a plugin `P` returns `status: 'error'`, mark every later plugin in `order` whose dependency chain (computed via `graph.adj` reachability from `P`) reaches it with `status: 'skipped'` and message `'upstream error in <P>'`. Plugins NOT downstream of P continue normally.
7. Return `{triggeringPluginId, triggerScanId: seedArtifact.scanId, steps, ok: steps.every(s => s.status !== 'error')}`.

Logging: emit one INFO line per step: `chain: <triggering> -> <P> (<status>, ${durationMs}ms)`. On error or skip, the message includes the reason.

### `src/cli/commands/chains.ts`

Two subcommands under `chains`:

**`autonomous-dev chains list [--json]`**:
- Sends IPC request `{command: 'chains-list'}`.
- Daemon handler returns `payload: ChainEdge[]` from `graph.getEdges()`.
- Default render: a table with columns `Producer | Consumer | Artifact Type | Schema Version`, sorted by `(producer, consumer, artifactType)`.
- `--json`: prints the raw payload array.
- Empty graph: prints `(no chain edges registered)` (or `[]` with `--json`).
- Daemon not running: exit 1, message on stderr (same convention as SPEC-019-1-04's `plugin list`).

**`autonomous-dev chains graph [--format dot|mermaid]`**:
- Default `--format dot`.
- Sends IPC request `{command: 'chains-graph', format: 'dot' | 'mermaid'}`.
- Daemon handler reads `graph.getEdges()` + `graph.getNodes()` and formats:

  **DOT** (Graphviz):
  ```
  digraph chains {
    rankdir=LR;
    node [shape=box, style=rounded];
    "security-reviewer";
    "code-fixer";
    "security-reviewer" -> "code-fixer" [label="security-findings@1.0"];
  }
  ```

  **Mermaid**:
  ```
  graph TB
    security-reviewer["security-reviewer"]
    code-fixer["code-fixer"]
    security-reviewer -- "security-findings@1.0" --> code-fixer
  ```

  Plugin IDs that are not safe Mermaid identifiers (contain `-`, etc.) are wrapped: Mermaid `node["label"]` syntax handles dashes via the bracketed label.
- Returns the rendered string in `payload`. CLI prints it raw (no JSON wrapper).
- Empty graph: emits a valid empty DOT (`digraph chains { }`) or Mermaid (`graph TB`) so downstream tooling does not break.

### IPC server changes (`src/hooks/ipc-server.ts`)

Extend the existing switch in the request dispatcher with two new cases:

```ts
case 'chains-list':
  return { status: 'ok', payload: graph.getEdges() };
case 'chains-graph':
  return { status: 'ok', payload: renderGraph(graph, request.format ?? 'dot') };
```

`renderGraph` is a small pure function (≤ 50 lines) co-located with the IPC server (or extracted to `src/chains/render.ts` if that reads cleaner). Export `renderGraph(graph, format)` either way for unit testability.

The IPC `IpcRequest` interface from SPEC-019-1-04 must widen to include the new commands and the optional `format` field — minor type union additions, no runtime change.

## Acceptance Criteria

### ChainExecutor

- [ ] `executeChain` with a triggering plugin that produced a valid `security-findings` artifact and one downstream `code-fixer` consumer returns `ok: true` with 2 steps; both steps have `status: 'ok'`; the second step's `produced[0]` references a `code-patches` artifact persisted on disk.
- [ ] `executeChain` walks plugins in topological order: a 3-step chain (producer A → middle B → consumer C) records steps in exactly that order.
- [ ] If the seed artifact fails schema validation, `executeChain` returns `ok: false` with a single step recording the validation error; no downstream invocation occurs.
- [ ] If a mid-chain plugin throws, its step has `status: 'error'`; every downstream plugin REACHABLE from it has `status: 'skipped'` with an `'upstream error in X'` message.
- [ ] A downstream plugin on a parallel branch (NOT reachable from the failed plugin) still runs normally.
- [ ] A downstream plugin whose `consumes[].artifact_type` was not produced by any upstream step in THIS chain run is skipped with `'no upstream producer in this chain run'`; the chain continues to other independent consumers.
- [ ] When a downstream plugin returns a payload that fails ITS produced-artifact schema validation, that step records `status: 'error'` with the validation messages; downstream plugins are skip-cascaded.
- [ ] Each successful step's `durationMs` is positive; total chain time equals sum of step durations within ±5ms (sequential, no parallelism).
- [ ] Each persisted artifact is on disk at `<requestRoot>/.autonomous-dev/artifacts/<type>/<scanId>.json` after `executeChain` returns.
- [ ] Logs include one `chain:` line per step (verified by capturing console.info).

### CLI: `chains list`

- [ ] `autonomous-dev chains list` against a daemon with security-reviewer + code-fixer fixtures prints exactly one row: `security-reviewer | code-fixer | security-findings | 1.0`.
- [ ] `--json` output parses cleanly and is an array of `ChainEdge` objects with the documented fields.
- [ ] Empty graph: prints `(no chain edges registered)` and exits 0; `--json` emits `[]`.
- [ ] Sort order is `(producer, consumer, artifactType)` ascending lex.
- [ ] Daemon not running: exits 1 with `daemon is not running` on stderr.

### CLI: `chains graph`

- [ ] `chains graph --format dot` against the 2-plugin fixture emits a string starting with `digraph chains {` and containing both node declarations and one labeled edge.
- [ ] The DOT output is renderable by Graphviz (`echo "<output>" | dot -Tsvg > /dev/null` exits 0). Verified by a test that pipes through `dot` if available; skipped (not failed) if Graphviz is not installed locally.
- [ ] `chains graph --format mermaid` emits a string starting with `graph TB` and containing both node declarations and one labeled edge.
- [ ] Empty graph + `--format dot` emits `digraph chains {\n}\n` (still valid DOT).
- [ ] Empty graph + `--format mermaid` emits `graph TB\n` (still valid Mermaid).
- [ ] Default format is `dot` when `--format` is omitted.
- [ ] Invalid `--format xml` exits 1 with a clear message: `unsupported format 'xml' (use dot or mermaid)`.
- [ ] `renderGraph` is a pure function: same input graph produces identical output across 10 calls.

### IPC

- [ ] IPC request `{command: 'chains-list'}` returns `status: 'ok'` with `payload` matching `graph.getEdges()` byte-for-byte (after JSON round-trip).
- [ ] IPC request `{command: 'chains-graph', format: 'dot'}` returns `status: 'ok'` with `payload` being the rendered string.
- [ ] IPC request with an unknown command returns `status: 'error'` (existing behavior unchanged).

## Dependencies

- SPEC-022-1-01 (`HookManifest` v2, `produces`/`consumes`) — consumed.
- SPEC-022-1-02 (`ArtifactRegistry`, `validate` + `persist` + `load`) — consumed.
- SPEC-022-1-03 (`DependencyGraph`, `topologicalSort`, `CycleError`) — consumed.
- SPEC-019-1-03 (`HookExecutor`, `RegisteredHook`) — consumed for invocation pattern.
- SPEC-019-1-04 (IPC server, CLI dispatcher) — extended.
- No new npm packages.
- TDD-022 §7 (chain executor design) — read-only reference.

## Notes

- The `chainHookSelector` callback exists so this spec doesn't dictate WHICH hook of a multi-hook plugin acts as the chain entry point. PLAN-022-2 will formalize this (likely "hook with `reviewer_slot: chain-consumer'" or a new manifest field). For PLAN-022-1, the bootstrap code injects a selector that picks the first hook of the plugin (good enough for fixture testing).
- The skip-cascade is computed via reachability in `graph.adj`. For a 100-plugin graph this is at worst O(N + E) per failed plugin; expected scale makes it negligible.
- The executor does NOT yet handle parallel execution within a topological "level" (NG-2202 in the plan). Sequential is intentional and trivially correct.
- Per-chain-run isolation: each call to `executeChain` operates on a fresh `steps[]`. The `ArtifactRegistry`'s persistence is request-scoped (artifacts go under `<requestRoot>/.autonomous-dev/artifacts/`), so concurrent chains for different requests cannot collide.
- The Mermaid rendering chooses `graph TB` (top-bottom) for readability of typical chains. Operators who prefer left-to-right can post-process the output; we do not add a `--direction` flag in this spec.
- The DOT output uses `rankdir=LR` because that matches the chain mental model (producer on the left, consumer on the right). This is a deliberate asymmetry with the Mermaid default; the rationale is that Mermaid renders LR as too wide in most viewers.
- The CLI commands are READ-ONLY against the daemon's in-memory graph. No subcommand mutates state. This matches `plugin list` from SPEC-019-1-04 and is the convention for "list/inspect" commands across the project.
- An offline/no-daemon mode for `chains list/graph` (read manifests directly from disk, build graph in-process) is a future enhancement; for now the daemon is the single source of truth and must be running for the CLI to produce output.

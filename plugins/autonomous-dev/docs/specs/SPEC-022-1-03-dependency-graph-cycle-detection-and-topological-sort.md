# SPEC-022-1-03: DependencyGraph, Cycle Detection (Tarjan SCC), and Topological Sort (Kahn)

## Metadata
- **Parent Plan**: PLAN-022-1
- **Tasks Covered**: Task 5 (`DependencyGraph` build), Task 6 (cycle detection via Tarjan SCC), Task 7 (`topologicalSort` via Kahn)
- **Estimated effort**: 8 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-022-1-03-dependency-graph-cycle-detection-and-topological-sort.md`

## Description
Implement the directed-graph data structure that the chain executor (SPEC-022-1-04) consumes: nodes are plugin IDs, edges go from producer to consumer for each `(artifact_type, schema_version)` overlap. Add Tarjan's Strongly Connected Components algorithm for cycle detection at daemon startup (per TDD-022 §8) and Kahn's algorithm for topological sort (producers before consumers). Both algorithms have well-known textbook implementations; this spec pins down the input/output shapes, the `CycleError` payload, and an exhaustive set of cycle and DAG fixtures so correctness is locked in.

This spec is pure algorithm and data-structure: no filesystem I/O, no network, no plugin loading. The graph consumes already-parsed `HookManifest` objects (from SPEC-022-1-01) and produces `string[]` orderings or throws. It does NOT execute hooks (SPEC-022-1-04) and does NOT validate orphan consumers (SPEC-022-1-01 already did that).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/chains/dependency-graph.ts` | Create | `DependencyGraph` class with `addPlugin`, `getEdges`, `getProducers`, `getConsumers`, `detectCycles`, `topologicalSort` |
| `plugins/autonomous-dev/src/chains/cycle-error.ts` | Create | `CycleError` class with structured cycle path |
| `plugins/autonomous-dev/src/chains/index.ts` | Modify | Add `export * from './dependency-graph'; export * from './cycle-error';` |

## Implementation Details

### `src/chains/cycle-error.ts`

```ts
/**
 * Thrown when the dependency graph contains a cycle.
 * `cyclePath` is the ordered list of plugin IDs forming the cycle, with the
 * first node REPEATED at the end so callers can render `A -> B -> C -> A`.
 */
export class CycleError extends Error {
  public readonly cyclePath: readonly string[];
  constructor(cyclePath: readonly string[]) {
    super(`dependency cycle detected: ${cyclePath.join(' -> ')}`);
    this.name = 'CycleError';
    this.cyclePath = Object.freeze([...cyclePath]);
  }
}
```

### `src/chains/dependency-graph.ts`

```ts
import type { HookManifest } from '../hooks/types';
import { CycleError } from './cycle-error';

export interface ChainEdge {
  from: string;        // producer plugin id
  to: string;          // consumer plugin id
  artifactType: string;
  schemaVersion: string; // producer's schema_version
}

export class DependencyGraph {
  /** Adjacency list: from -> Set of to. Pure plugin-id graph. */
  private readonly adj = new Map<string, Set<string>>();
  /** Edge metadata keyed by `${from}->${to}` (Set of edge records to handle multi-artifact edges). */
  private readonly edgeMeta = new Map<string, ChainEdge[]>();
  /** Producer index: artifactType -> Map<pluginId, schemaVersion>. */
  private readonly producers = new Map<string, Map<string, string>>();
  /** Consumer index: artifactType -> Set<pluginId>. */
  private readonly consumers = new Map<string, Set<string>>();
  /** All node ids (covers isolated plugins with no edges). */
  private readonly nodes = new Set<string>();

  /**
   * Register a plugin's produces/consumes. Call after orphan validation.
   * Self-edges (plugin produces and consumes same artifact_type) are
   * deliberately PRUNED at insertion (a plugin doesn't trigger itself).
   */
  addPlugin(manifest: HookManifest): void { /* ... */ }

  getEdges(): ChainEdge[] { /* flatten edgeMeta values */ }
  getProducers(artifactType: string): Array<{ pluginId: string; schemaVersion: string }> { /* ... */ }
  getConsumers(artifactType: string): string[] { /* ... */ }
  getNodes(): string[] { /* sorted */ }

  /**
   * Tarjan's SCC. Returns an empty array if acyclic.
   * Otherwise returns one or more SCCs of size >= 2 (or self-loops),
   * each formatted with the first node repeated at the end.
   */
  detectCycles(): string[][] { /* ... */ }

  /**
   * Kahn's algorithm. Throws CycleError (with the FIRST cycle from detectCycles)
   * if the graph is not a DAG. Otherwise returns plugin IDs in execution order.
   */
  topologicalSort(): string[] { /* ... */ }
}
```

#### `addPlugin` behavior

1. Add `manifest.id` to `nodes`.
2. For each `produces[i]`: insert into `producers.get(artifact_type)` map as `{pluginId: manifest.id, schemaVersion: produces[i].schema_version}` (overwrites if same plugin re-registers).
3. For each `consumes[i]` (skipping `optional: true` entries when no producer is yet known — though the orphan check from SPEC-022-1-01 has already filtered these): insert into `consumers.get(artifact_type)` set.
4. After all plugins added (caller responsibility — invoke `addPlugin` for every plugin first, THEN call `topologicalSort` or `detectCycles`), the graph builds edges lazily on first read OR eagerly here:
   - For each artifact type with producers AND consumers: for each producer × consumer pair where producer.id !== consumer.id (self-edge prune), insert edge `(producer.id → consumer.id)` if the consumer's `consumes[].schema_version` is satisfied by the producer's `schema_version` (re-use `satisfiesRange` from SPEC-022-1-01).
   - Add to `adj` and `edgeMeta`.

For simplicity, edges are rebuilt eagerly inside `addPlugin` after each call. This is O(P × C) per type per insertion but P, C are small (typical chain has < 10 plugins per artifact type); the simplicity wins.

#### `detectCycles` (Tarjan SCC)

Standard iterative Tarjan:

1. Initialize `index = 0`, `stack = []`, `onStack = Set`, `indices = Map<node, number>`, `lowlink = Map<node, number>`, `result = string[][] = []`.
2. For every unvisited node, run `strongconnect(node)`:
   - Set `indices.set(v, index); lowlink.set(v, index); index++`.
   - Push `v` onto `stack`, `onStack.add(v)`.
   - For each successor `w` in `adj.get(v) ?? []`:
     - If `w` not in `indices`: recurse, then `lowlink.set(v, min(lowlink.get(v), lowlink.get(w)))`.
     - Else if `onStack.has(w)`: `lowlink.set(v, min(lowlink.get(v), indices.get(w)))`.
   - If `lowlink.get(v) === indices.get(v)`: pop from stack until we re-pop `v`; the popped set is one SCC.
   - If the SCC has size > 1, OR size === 1 AND that single node has a self-edge (in `adj.get(v)?.has(v)`): record it. Append the first node a second time so callers see the loop.
3. To avoid stack overflow on adversarial graphs (10k+ nodes), implement iteratively with an explicit work stack. For PLAN-022-1's expected scale (≤ 100 plugins) recursion is safe, but iterative is required by the perf budget in the plan's testing strategy.

Returns `string[][]`. Each inner array is one SCC, ordered by first-discovery time within the SCC, with the first element repeated at the end. Empty outer array means acyclic.

#### `topologicalSort` (Kahn)

1. First call `detectCycles()`; if the result is non-empty, throw `new CycleError(result[0])`.
2. Compute `inDegree` for every node: `inDegree.set(node, 0)` for all nodes; then for each edge in `adj`, increment `inDegree.get(to)`.
3. Initialize `queue` with every node whose `inDegree === 0`. Use a deterministic ordering: sort by node id (lex) when multiple nodes have in-degree 0 simultaneously, so the output is reproducible.
4. While queue non-empty: shift `n`, push to `result`. For each successor `m`: decrement `inDegree.get(m)`; if it hits 0, insert into queue at the lex-sorted position.
5. If `result.length !== nodes.size`: throw `CycleError` (defensive — should not happen if `detectCycles` was correct).
6. Return `result`.

Determinism note: Kahn's algorithm has many valid orderings; we pin the order by always pulling the lex-smallest available node. This makes tests stable.

## Acceptance Criteria

### Graph construction

- [ ] An empty graph has `getEdges() === []`, `getNodes() === []`, `topologicalSort() === []`, `detectCycles() === []`.
- [ ] Adding a single plugin with one produces and no consumes adds one node, zero edges.
- [ ] Producer P1 (`produces: security-findings@1.0`) + Consumer C1 (`consumes: ^1.0 of security-findings`) → `getEdges()` contains exactly one edge `{from: 'P1', to: 'C1', artifactType: 'security-findings', schemaVersion: '1.0'}`.
- [ ] Two producers (P1, P2) for the same artifact type + one consumer (C1) → 2 edges (`P1→C1`, `P2→C1`).
- [ ] Producer P1 + two consumers (C1, C2) of same artifact → 2 edges (`P1→C1`, `P1→C2`).
- [ ] Plugin that both produces AND consumes the same artifact type → self-edge is PRUNED (edge count unchanged; node still appears).
- [ ] `getProducers('security-findings')` returns `[{pluginId: 'P1', schemaVersion: '1.0'}, {pluginId: 'P2', schemaVersion: '1.0'}]` sorted by pluginId.
- [ ] `getConsumers('security-findings')` returns `['C1', 'C2']` sorted.
- [ ] A consumer's range `^2.0` against a `1.0` producer creates NO edge (range mismatch).
- [ ] An isolated plugin (no produces, no consumes) appears in `getNodes()` and shows in `topologicalSort()` output.

### Topological sort (acyclic)

- [ ] Linear chain `A→B→C` → `topologicalSort() === ['A', 'B', 'C']`.
- [ ] Diamond `A→B, A→C, B→D, C→D` → `topologicalSort()` returns a valid topological order with `A` first and `D` last; given lex tie-break: `['A', 'B', 'C', 'D']`.
- [ ] 5-node DAG `A→B, A→C, B→D, C→D, D→E` → returns `['A', 'B', 'C', 'D', 'E']` (deterministic via lex tie-break).
- [ ] Two disconnected DAGs (e.g., `A→B` and `X→Y`) → returns all four nodes; relative order within each component is preserved; lex tie-break interleaves: `['A', 'X', 'B', 'Y']`.
- [ ] An isolated node `Z` with no edges still appears in the output (in lex position).

### Cycle detection

- [ ] Self-loop (one plugin, edge to itself — possible only if pruning is bypassed; we test by direct `adj` injection) → `detectCycles()` returns `[['A', 'A']]`.
- [ ] 2-cycle `A→B, B→A` → `detectCycles()` returns one SCC, formatted as `['A', 'B', 'A']` (or `['B', 'A', 'B']` deterministically; pin the choice in tests).
- [ ] 3-cycle `A→B→C→A` → `detectCycles()` returns one SCC of `['A', 'B', 'C', 'A']`.
- [ ] 5-cycle `A→B→C→D→E→A` → `detectCycles()` returns one SCC of length 6 (5 nodes + repeated first).
- [ ] Two disjoint cycles `A→B→A` and `C→D→C` → `detectCycles()` returns 2 SCCs.
- [ ] DAG with one back-edge (turning it into a cycle) → exactly one SCC of size ≥ 2.
- [ ] `topologicalSort()` on a cyclic graph throws `CycleError`; `error.cyclePath` is non-empty and equals the first SCC from `detectCycles()`.
- [ ] `CycleError.message` contains the cycle rendered with `' -> '` separators.
- [ ] `CycleError.cyclePath` is `Object.freeze`d (mutation throws in strict mode).

### Performance

- [ ] On a synthesized 100-plugin graph (chain of 50 producer-consumer pairs + 1 cycle injected at random positions in adversarial test), `detectCycles()` completes in < 50ms p95 over 5 runs (per PLAN-022-1 testing strategy).
- [ ] On a 100-plugin DAG, `topologicalSort()` completes in < 50ms p95.
- [ ] Tarjan implementation is iterative (no recursion); verified by stress test of a 5000-node linear chain that does NOT throw `Maximum call stack size exceeded`.

### Determinism

- [ ] Running `topologicalSort()` on the same graph 10 times produces the same array each time (deterministic via lex tie-break).
- [ ] Running `detectCycles()` on the same cyclic graph 10 times produces the same SCC list (start node of each cycle is deterministic).

## Dependencies

- SPEC-022-1-01 (`HookManifest` v2 with `produces`/`consumes`, `satisfiesRange`) — imported.
- SPEC-022-1-02 — independent; this spec does not touch artifact registry.
- No npm packages (algorithms are textbook; no Tarjan library used).
- TDD-022 §8 (cycle detection requirement) — read-only reference.

## Notes

- Self-edge pruning at `addPlugin` is intentional: in the chain semantics a plugin emitting an artifact does NOT re-trigger itself on its own emission (avoids infinite loops by construction at the model level). If the operator authors a manifest where one plugin produces and consumes the same artifact, they get the inert behavior, not a runtime cycle. This matches TDD-022 §8's "self-emit isolation" rule.
- `topologicalSort` calls `detectCycles` as a guard. The duplicated work (one SCC pass + one Kahn pass) is fine at the expected graph sizes; for very large graphs a future spec could short-circuit Kahn's natural cycle detection (in-degrees never hitting zero). Documented but not optimized here.
- Lex tie-break for Kahn's queue is what makes the output reproducible for test assertions. The natural choice (FIFO insertion order) would depend on the order `addPlugin` was called, which is fragile.
- The graph is mutable through `addPlugin`. Callers (the daemon's chain bootstrap) call it once per plugin during scan, then never mutate. The class does not expose `removePlugin` here; reload (per SPEC-019-1-04 pattern) builds a fresh graph and swaps. `clear()` is intentionally NOT exposed; to reset, instantiate a new graph.
- Multi-edges (same `from`-`to` pair with different `artifactType`) are stored as multiple `ChainEdge` records in `edgeMeta`, but `adj` keeps only one logical edge for cycle/sort purposes. `getEdges()` returns the full multi-edge view for CLI rendering (SPEC-022-1-04's `chains list`).
- `CycleError` is its own class so callers can `instanceof CycleError` and react (the executor logs and aborts; the CLI prints the cycle and exits 2).
- The 5000-node linear-chain stress test is the iterative-stack proof. Recursive Tarjan would blow the JS stack at ~10k frames depending on engine; iterative is unambiguously safer.

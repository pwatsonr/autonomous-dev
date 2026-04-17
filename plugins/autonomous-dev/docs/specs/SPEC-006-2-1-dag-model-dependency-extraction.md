# SPEC-006-2-1: DAG Data Model and Dependency Extraction

## Metadata
- **Parent Plan**: PLAN-006-2
- **Tasks Covered**: Task 1, Task 2, Task 3
- **Estimated effort**: 13 hours

## Description

Define the complete DAG data model (nodes, edges, clusters) and implement the three dependency extraction strategies (explicit declarations, file-overlap analysis, interface contracts). Build the DAG from extracted dependencies, then validate it using Kahn's algorithm for cycle detection and Tarjan's SCC for cycle reporting, followed by transitive reduction of redundant edges.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/parallel/types.ts` | **Modify** | Add DAG-related interfaces |
| `src/parallel/dag-constructor.ts` | **Create** | Dependency extraction, DAG building, validation |
| `tests/parallel/dag-constructor.test.ts` | **Create** | Unit tests for DAG operations |

## Implementation Details

### 1. DAG type definitions (`src/parallel/types.ts`)

```typescript
export interface DAGNode {
  specName: string;
  specPath: string;
  complexity: 'small' | 'medium' | 'large';
  estimatedMinutes: number;       // small=5, medium=15, large=30
  priority: number;               // base + critical path bonus + dependency bonus
  basePriority: number;           // priority before bonuses
  inDegree: number;               // count of incoming edges (dependencies)
  outDegree: number;              // count of outgoing edges (dependents)
  cluster: number;                // assigned cluster index, -1 if unassigned
  filesModified: string[];        // declared file modification list from spec
  interfacesProduced: string[];   // interface names this spec produces
  interfacesConsumed: string[];   // interface names this spec consumes
  dependsOn: string[];            // explicit dependency declarations
}

export type DependencyType = 'explicit' | 'file-overlap' | 'interface-contract';

export interface DAGEdge {
  from: string;   // specName of the dependency (must complete first)
  to: string;     // specName of the dependent
  type: DependencyType;
  reason: string; // human-readable explanation
}

export interface DAGCluster {
  index: number;
  nodes: string[];       // specNames in this cluster
  dependsOnClusters: number[];  // cluster indices that must complete before this one
}

export interface DependencyDAG {
  requestId: string;
  nodes: Map<string, DAGNode>;
  edges: DAGEdge[];
  reducedEdges: DAGEdge[];   // after transitive reduction
  originalEdges: DAGEdge[];  // before reduction (audit log)
  clusters: DAGCluster[];
  criticalPath: string[];    // ordered specNames on the longest path
  validated: boolean;
}
```

### 2. Spec metadata schema (input to DAG constructor)

Each spec must provide metadata that the DAG constructor consumes. Define the expected schema:

```typescript
export interface SpecMetadata {
  name: string;                     // unique spec name
  path: string;                     // file path to spec
  complexity: 'small' | 'medium' | 'large';
  dependsOn?: string[];             // explicit dependency declarations
  filesModified?: string[];         // files this spec will modify
  interfacesProduced?: string[];    // interfaces this spec exports
  interfacesConsumed?: string[];    // interfaces this spec imports
  estimatedMinutes?: number;        // override for default complexity-based estimate
}
```

### 3. Dependency extraction (`src/parallel/dag-constructor.ts`)

**Explicit dependencies**:
```typescript
function extractExplicitDependencies(specs: SpecMetadata[]): DAGEdge[] {
  const edges: DAGEdge[] = [];
  const specNames = new Set(specs.map(s => s.name));

  for (const spec of specs) {
    for (const dep of spec.dependsOn ?? []) {
      if (!specNames.has(dep)) {
        throw new UnknownDependencyError(spec.name, dep);
      }
      edges.push({
        from: dep,
        to: spec.name,
        type: 'explicit',
        reason: `${spec.name} declares explicit dependency on ${dep}`,
      });
    }
  }
  return edges;
}
```

**File-overlap dependencies**:
```typescript
function extractFileOverlapDependencies(specs: SpecMetadata[]): DAGEdge[] {
  const edges: DAGEdge[] = [];
  // Build map: filePath -> [specNames that modify it]
  const fileToSpecs = new Map<string, string[]>();

  for (const spec of specs) {
    for (const file of spec.filesModified ?? []) {
      const list = fileToSpecs.get(file) ?? [];
      list.push(spec.name);
      fileToSpecs.set(file, list);
    }
  }

  // For each file modified by 2+ specs, create edges between all pairs
  for (const [file, specNames] of fileToSpecs) {
    if (specNames.length < 2) continue;
    // Create edges for all pairs (lower alphabetical -> higher for determinism)
    for (let i = 0; i < specNames.length; i++) {
      for (let j = i + 1; j < specNames.length; j++) {
        edges.push({
          from: specNames[i],
          to: specNames[j],
          type: 'file-overlap',
          reason: `Both ${specNames[i]} and ${specNames[j]} modify ${file}`,
        });
      }
    }
  }
  return edges;
}
```

**Interface contract dependencies**:
```typescript
function extractInterfaceContractDependencies(specs: SpecMetadata[]): DAGEdge[] {
  const edges: DAGEdge[] = [];
  // Build map: interfaceName -> producer specName
  const producerMap = new Map<string, string>();
  for (const spec of specs) {
    for (const iface of spec.interfacesProduced ?? []) {
      if (producerMap.has(iface)) {
        throw new DuplicateInterfaceProducerError(iface, producerMap.get(iface)!, spec.name);
      }
      producerMap.set(iface, spec.name);
    }
  }

  // For each consumer, create edge from producer -> consumer
  for (const spec of specs) {
    for (const iface of spec.interfacesConsumed ?? []) {
      const producer = producerMap.get(iface);
      if (!producer) {
        throw new UnresolvedInterfaceError(spec.name, iface);
      }
      if (producer === spec.name) continue; // self-dependency
      edges.push({
        from: producer,
        to: spec.name,
        type: 'interface-contract',
        reason: `${spec.name} consumes interface "${iface}" produced by ${producer}`,
      });
    }
  }
  return edges;
}
```

**Priority: explicit > heuristic**. When an explicit `dependsOn` exists between two specs, any file-overlap edge between them is suppressed (the explicit edge takes precedence). Interface-contract edges coexist with explicit edges since they carry distinct semantic information.

### 4. DAG construction and validation

```typescript
export function buildDAG(requestId: string, specs: SpecMetadata[]): DependencyDAG {
  // 1. Create nodes
  const nodes = new Map<string, DAGNode>();
  for (const spec of specs) {
    nodes.set(spec.name, {
      specName: spec.name,
      specPath: spec.path,
      complexity: spec.complexity,
      estimatedMinutes: spec.estimatedMinutes ?? defaultEstimate(spec.complexity),
      priority: 0,
      basePriority: 0,
      inDegree: 0,
      outDegree: 0,
      cluster: -1,
      filesModified: spec.filesModified ?? [],
      interfacesProduced: spec.interfacesProduced ?? [],
      interfacesConsumed: spec.interfacesConsumed ?? [],
      dependsOn: spec.dependsOn ?? [],
    });
  }

  // 2. Extract all edges
  const explicitEdges = extractExplicitDependencies(specs);
  const fileEdges = extractFileOverlapDependencies(specs);
  const ifaceEdges = extractInterfaceContractDependencies(specs);

  // 3. Merge and deduplicate: explicit overrides file-overlap for same pair
  const allEdges = mergeEdges(explicitEdges, fileEdges, ifaceEdges);

  // 4. Compute in-degree and out-degree
  for (const edge of allEdges) {
    nodes.get(edge.to)!.inDegree++;
    nodes.get(edge.from)!.outDegree++;
  }

  // 5. Validate: cycle detection via Kahn's algorithm
  const { sorted, hasCycle } = kahnsTopologicalSort(nodes, allEdges);
  if (hasCycle) {
    const sccs = tarjanSCC(nodes, allEdges);
    const cycleDesc = sccs
      .filter(scc => scc.length > 1)
      .map(scc => scc.join(' -> ') + ' -> ' + scc[0])
      .join('; ');
    throw new CyclicDependencyError(`Cycle detected: ${cycleDesc}`);
  }

  // 6. Transitive reduction
  const reducedEdges = transitiveReduction(sorted, allEdges);

  return {
    requestId,
    nodes,
    edges: reducedEdges,
    reducedEdges,
    originalEdges: allEdges,
    clusters: [],        // assigned in SPEC-006-2-2
    criticalPath: [],    // computed in SPEC-006-2-2
    validated: true,
  };
}
```

### 5. Kahn's algorithm

```typescript
function kahnsTopologicalSort(
  nodes: Map<string, DAGNode>,
  edges: DAGEdge[]
): { sorted: string[]; hasCycle: boolean } {
  const inDegree = new Map<string, number>();
  for (const [name] of nodes) inDegree.set(name, 0);
  for (const edge of edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  // Build adjacency list
  const adj = new Map<string, string[]>();
  for (const [name] of nodes) adj.set(name, []);
  for (const edge of edges) adj.get(edge.from)!.push(edge.to);

  // Initialize queue with zero in-degree nodes
  const queue: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }
  queue.sort(); // deterministic ordering

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of adj.get(node)!) {
      const newDeg = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) {
        queue.push(neighbor);
        queue.sort(); // maintain deterministic order
      }
    }
  }

  return { sorted, hasCycle: sorted.length !== nodes.size };
}
```

### 6. Tarjan's SCC (for cycle reporting)

```typescript
function tarjanSCC(
  nodes: Map<string, DAGNode>,
  edges: DAGEdge[]
): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const sccs: string[][] = [];

  const adj = new Map<string, string[]>();
  for (const [name] of nodes) adj.set(name, []);
  for (const edge of edges) adj.get(edge.from)!.push(edge.to);

  function strongconnect(v: string) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v)!) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  for (const [name] of nodes) {
    if (!indices.has(name)) strongconnect(name);
  }
  return sccs;
}
```

### 7. Transitive reduction

```typescript
function transitiveReduction(sorted: string[], edges: DAGEdge[]): DAGEdge[] {
  // Build adjacency set for reachability
  const adj = new Map<string, Set<string>>();
  for (const name of sorted) adj.set(name, new Set());
  for (const edge of edges) adj.get(edge.from)!.add(edge.to);

  // For each edge A->C, check if there exists a path A->...->C through other edges
  // If so, the edge is redundant and should be removed
  const reduced: DAGEdge[] = [];

  for (const edge of edges) {
    // BFS/DFS from edge.from, excluding direct edge to edge.to
    const reachable = bfsExcludingDirect(edge.from, edge.to, adj);
    if (!reachable) {
      reduced.push(edge); // keep: no alternative path
    }
  }

  return reduced;
}

function bfsExcludingDirect(
  from: string,
  target: string,
  adj: Map<string, Set<string>>
): boolean {
  // Can we reach `target` from `from` without using the direct from->target edge?
  const visited = new Set<string>();
  const queue: string[] = [];

  for (const neighbor of adj.get(from)!) {
    if (neighbor !== target) {
      queue.push(neighbor);
      visited.add(neighbor);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === target) return true;
    for (const neighbor of adj.get(current)!) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return false;
}
```

## Acceptance Criteria

1. All DAG types (`DAGNode`, `DAGEdge`, `DAGCluster`, `DependencyDAG`) are exported from `types.ts`.
2. `extractExplicitDependencies` throws `UnknownDependencyError` if a declared dependency references a non-existent spec.
3. `extractFileOverlapDependencies` creates edges for all pairs of specs modifying the same file.
4. `extractInterfaceContractDependencies` throws `DuplicateInterfaceProducerError` if two specs produce the same interface.
5. `extractInterfaceContractDependencies` throws `UnresolvedInterfaceError` if a consumed interface has no producer.
6. Explicit edges suppress file-overlap edges for the same spec pair.
7. `buildDAG` with the TDD 2.3 worked example (A->B, C independent) produces a validated DAG with correct edges.
8. Kahn's algorithm detects cycles (returns `hasCycle: true` when not all nodes are visited).
9. Tarjan's SCC reports the exact nodes involved in a cycle.
10. `CyclicDependencyError` message is human-readable: `"Cycle detected: A -> B -> A"`.
11. Transitive reduction removes A->C when A->B->C exists, preserving A->B and B->C.
12. Original (unreduced) edges are preserved in `dag.originalEdges` for auditing.
13. DAG output is deterministic for the same input.
14. Orphan nodes (no edges) are valid and produce a DAG with `validated: true`.

## Test Cases

```
// dag-constructor.test.ts

describe('extractExplicitDependencies', () => {
  it('creates edge from dependency to dependent', () => {
    const specs = [
      { name: 'track-a', dependsOn: [] },
      { name: 'track-b', dependsOn: ['track-a'] },
    ];
    const edges = extractExplicitDependencies(specs);
    expect(edges).toEqual([{ from: 'track-a', to: 'track-b', type: 'explicit', reason: expect.any(String) }]);
  });
  it('throws on unknown dependency', () => {
    const specs = [{ name: 'track-a', dependsOn: ['nonexistent'] }];
    expect(() => extractExplicitDependencies(specs)).toThrow(UnknownDependencyError);
  });
});

describe('extractFileOverlapDependencies', () => {
  it('creates edges for overlapping file modifications', () => {
    const specs = [
      { name: 'track-a', filesModified: ['src/shared.ts'] },
      { name: 'track-b', filesModified: ['src/shared.ts'] },
      { name: 'track-c', filesModified: ['src/other.ts'] },
    ];
    const edges = extractFileOverlapDependencies(specs);
    expect(edges.length).toBe(1);
    expect(edges[0].from).toBe('track-a');
    expect(edges[0].to).toBe('track-b');
  });
});

describe('extractInterfaceContractDependencies', () => {
  it('creates producer->consumer edge', () => {
    const specs = [
      { name: 'track-a', interfacesProduced: ['UserService'] },
      { name: 'track-b', interfacesConsumed: ['UserService'] },
    ];
    const edges = extractInterfaceContractDependencies(specs);
    expect(edges[0]).toEqual({ from: 'track-a', to: 'track-b', type: 'interface-contract', reason: expect.any(String) });
  });
  it('throws on duplicate producer', () => {
    const specs = [
      { name: 'track-a', interfacesProduced: ['UserService'] },
      { name: 'track-b', interfacesProduced: ['UserService'] },
    ];
    expect(() => extractInterfaceContractDependencies(specs)).toThrow(DuplicateInterfaceProducerError);
  });
});

describe('buildDAG', () => {
  it('TDD 2.3 worked example: A->B dependency, C independent', () => {
    const specs = [
      { name: 'track-a', complexity: 'medium', dependsOn: [], filesModified: ['src/a.ts'] },
      { name: 'track-b', complexity: 'medium', dependsOn: ['track-a'], filesModified: ['src/b.ts'] },
      { name: 'track-c', complexity: 'small', dependsOn: [], filesModified: ['src/c.ts'] },
    ];
    const dag = buildDAG('req-001', specs);
    expect(dag.validated).toBe(true);
    expect(dag.edges.length).toBe(1);
    expect(dag.edges[0]).toMatchObject({ from: 'track-a', to: 'track-b' });
    expect(dag.nodes.get('track-c')!.inDegree).toBe(0);
    expect(dag.nodes.get('track-c')!.outDegree).toBe(0);
  });

  it('detects 2-node cycle', () => {
    const specs = [
      { name: 'track-a', dependsOn: ['track-b'] },
      { name: 'track-b', dependsOn: ['track-a'] },
    ];
    expect(() => buildDAG('req-001', specs)).toThrow(CyclicDependencyError);
  });

  it('detects 3-node cycle', () => {
    const specs = [
      { name: 'track-a', dependsOn: ['track-c'] },
      { name: 'track-b', dependsOn: ['track-a'] },
      { name: 'track-c', dependsOn: ['track-b'] },
    ];
    expect(() => buildDAG('req-001', specs)).toThrow(/cycle/i);
  });

  it('performs transitive reduction', () => {
    // A->B, B->C, and redundant A->C
    const specs = [
      { name: 'track-a', dependsOn: [] },
      { name: 'track-b', dependsOn: ['track-a'] },
      { name: 'track-c', dependsOn: ['track-a', 'track-b'] },
    ];
    const dag = buildDAG('req-001', specs);
    // A->C should be removed since A->B->C exists
    expect(dag.reducedEdges.find(e => e.from === 'track-a' && e.to === 'track-c')).toBeUndefined();
    expect(dag.reducedEdges.find(e => e.from === 'track-a' && e.to === 'track-b')).toBeDefined();
    expect(dag.reducedEdges.find(e => e.from === 'track-b' && e.to === 'track-c')).toBeDefined();
    // Original preserved
    expect(dag.originalEdges.find(e => e.from === 'track-a' && e.to === 'track-c')).toBeDefined();
  });

  it('handles single-node DAG', () => {
    const dag = buildDAG('req-001', [{ name: 'only', complexity: 'small' }]);
    expect(dag.validated).toBe(true);
    expect(dag.nodes.size).toBe(1);
    expect(dag.edges.length).toBe(0);
  });

  it('handles fully independent nodes (wide fan-out)', () => {
    const specs = Array.from({ length: 5 }, (_, i) => ({ name: `track-${i}`, complexity: 'small' }));
    const dag = buildDAG('req-001', specs);
    expect(dag.edges.length).toBe(0);
    expect(dag.nodes.size).toBe(5);
  });

  it('handles diamond: A->B, A->C, B->D, C->D', () => {
    const specs = [
      { name: 'a', dependsOn: [] },
      { name: 'b', dependsOn: ['a'] },
      { name: 'c', dependsOn: ['a'] },
      { name: 'd', dependsOn: ['b', 'c'] },
    ];
    const dag = buildDAG('req-001', specs);
    expect(dag.validated).toBe(true);
    expect(dag.edges.length).toBe(4); // no transitive reduction possible in diamond
  });

  it('explicit dependency suppresses file-overlap edge', () => {
    const specs = [
      { name: 'track-a', dependsOn: [], filesModified: ['src/shared.ts'] },
      { name: 'track-b', dependsOn: ['track-a'], filesModified: ['src/shared.ts'] },
    ];
    const dag = buildDAG('req-001', specs);
    // Only one edge, typed 'explicit'
    expect(dag.originalEdges.length).toBe(1);
    expect(dag.originalEdges[0].type).toBe('explicit');
  });

  it('is deterministic for same input', () => {
    const specs = [
      { name: 'track-a', dependsOn: [] },
      { name: 'track-b', dependsOn: ['track-a'] },
      { name: 'track-c', dependsOn: [] },
    ];
    const dag1 = buildDAG('req-001', specs);
    const dag2 = buildDAG('req-001', specs);
    expect(dag1.edges).toEqual(dag2.edges);
    expect(dag1.clusters).toEqual(dag2.clusters);
  });
});
```

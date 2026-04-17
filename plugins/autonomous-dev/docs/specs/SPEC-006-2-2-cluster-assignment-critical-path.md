# SPEC-006-2-2: Cluster Assignment and Critical Path Computation

## Metadata
- **Parent Plan**: PLAN-006-2
- **Tasks Covered**: Task 4, Task 5
- **Estimated effort**: 6 hours

## Description

Implement the cluster assignment algorithm that groups DAG nodes into sequential execution layers (clusters) using a modified topological sort, and the critical path computation that finds the longest weighted path through the DAG to prioritize scheduling of bottleneck tracks.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/parallel/dag-constructor.ts` | **Modify** | Add `assignClusters()` and `computeCriticalPath()` |
| `tests/parallel/dag-constructor.test.ts` | **Modify** | Add cluster and critical path tests |

## Implementation Details

### 1. Cluster assignment algorithm

Implements the `AssignClusters(dag)` algorithm from TDD 3.2.4: a layer-by-layer topological sort where each layer becomes a cluster of nodes that can execute in parallel.

```typescript
export function assignClusters(dag: DependencyDAG): void {
  // Work on reduced edges for scheduling purposes
  const edges = dag.reducedEdges;

  // Build in-degree map from reduced edges (not the node's stored inDegree which uses original edges)
  const inDegree = new Map<string, number>();
  for (const [name] of dag.nodes) inDegree.set(name, 0);
  for (const edge of edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  // Build adjacency list
  const adj = new Map<string, string[]>();
  for (const [name] of dag.nodes) adj.set(name, []);
  for (const edge of edges) adj.get(edge.from)!.push(edge.to);

  const clusters: DAGCluster[] = [];
  const remaining = new Set(dag.nodes.keys());
  let clusterIndex = 0;

  while (remaining.size > 0) {
    // Collect all nodes with in-degree 0 (within remaining set)
    const ready: string[] = [];
    for (const name of remaining) {
      if (inDegree.get(name)! === 0) {
        ready.push(name);
      }
    }

    if (ready.length === 0) {
      // Should never happen if DAG is validated (no cycles)
      throw new Error('Internal error: no zero in-degree nodes but remaining nodes exist');
    }

    // Sort for determinism
    ready.sort();

    // Determine which prior clusters this cluster depends on
    const dependsOnClusters = new Set<number>();
    for (const name of ready) {
      // Check incoming edges (from original edges) to find predecessor clusters
      for (const edge of edges) {
        if (edge.to === name) {
          const predCluster = dag.nodes.get(edge.from)!.cluster;
          if (predCluster >= 0) dependsOnClusters.add(predCluster);
        }
      }
    }

    const cluster: DAGCluster = {
      index: clusterIndex,
      nodes: ready,
      dependsOnClusters: Array.from(dependsOnClusters).sort(),
    };
    clusters.push(cluster);

    // Assign cluster to nodes and decrement downstream in-degrees
    for (const name of ready) {
      dag.nodes.get(name)!.cluster = clusterIndex;
      remaining.delete(name);

      for (const neighbor of adj.get(name)!) {
        inDegree.set(neighbor, inDegree.get(neighbor)! - 1);
      }
    }

    clusterIndex++;
  }

  dag.clusters = clusters;
}
```

### 2. Critical path computation

The critical path is the longest path through the DAG weighted by `estimatedMinutes`. Nodes on this path are the scheduling bottleneck.

```typescript
export function computeCriticalPath(dag: DependencyDAG): void {
  const edges = dag.reducedEdges;

  // Topological order (already validated, so Kahn's will succeed)
  const { sorted } = kahnsTopologicalSort(dag.nodes, edges);

  // Build adjacency list
  const adj = new Map<string, string[]>();
  for (const [name] of dag.nodes) adj.set(name, []);
  for (const edge of edges) adj.get(edge.from)!.push(edge.to);

  // Dynamic programming: longest path ending at each node
  const dist = new Map<string, number>();      // longest path distance to reach this node (inclusive)
  const pred = new Map<string, string | null>(); // predecessor on longest path

  for (const name of sorted) {
    dist.set(name, dag.nodes.get(name)!.estimatedMinutes);
    pred.set(name, null);
  }

  for (const u of sorted) {
    for (const v of adj.get(u)!) {
      const newDist = dist.get(u)! + dag.nodes.get(v)!.estimatedMinutes;
      if (newDist > dist.get(v)!) {
        dist.set(v, newDist);
        pred.set(v, u);
      }
    }
  }

  // Find the node with maximum distance (end of critical path)
  let maxDist = 0;
  let endNode = sorted[0];
  for (const [name, d] of dist) {
    if (d > maxDist) {
      maxDist = d;
      endNode = name;
    }
  }

  // Reconstruct critical path by following predecessors
  const path: string[] = [];
  let current: string | null = endNode;
  while (current !== null) {
    path.unshift(current);
    current = pred.get(current)!;
  }

  dag.criticalPath = path;

  // Apply priority bonuses (TDD 3.3.3)
  const criticalSet = new Set(path);
  for (const [name, node] of dag.nodes) {
    let priority = node.basePriority;

    // +10 for critical path nodes
    if (criticalSet.has(name)) {
      priority += 10;
    }

    // +5 per downstream dependent (out-degree from reduced edges)
    const outDegree = edges.filter(e => e.from === name).length;
    priority += outDegree * 5;

    node.priority = priority;
  }
}
```

### 3. Convenience function: full DAG pipeline

```typescript
export function buildAndScheduleDAG(requestId: string, specs: SpecMetadata[]): DependencyDAG {
  const dag = buildDAG(requestId, specs);
  assignClusters(dag);
  computeCriticalPath(dag);
  return dag;
}
```

## Acceptance Criteria

1. `assignClusters` assigns every node to exactly one cluster.
2. Nodes with no dependencies are all in cluster 0.
3. A node is only in cluster N if all its dependencies are in clusters < N.
4. Cluster ordering is deterministic for the same input (alphabetical tiebreaker within each cluster).
5. TDD 2.3 worked example: cluster 0 = [track-a, track-c], cluster 1 = [track-b].
6. Single-node DAG produces one cluster with one node.
7. Fully connected chain (A->B->C->D) produces N clusters of 1 node each.
8. Wide fan-out (all independent) produces one cluster with all nodes.
9. Diamond (A->B, A->C, B->D, C->D) produces 3 clusters: [A], [B, C], [D].
10. `computeCriticalPath` finds the longest weighted path.
11. Critical path nodes receive +10 priority bonus.
12. Nodes with high out-degree receive +5 per dependent.
13. `dag.criticalPath` contains the ordered node names on the longest path.

## Test Cases

```
// dag-constructor.test.ts (cluster assignment section)

describe('assignClusters', () => {
  it('TDD 2.3 example: A->B dep, C independent', () => {
    const dag = buildDAG('req-001', [
      { name: 'track-a', complexity: 'medium', dependsOn: [] },
      { name: 'track-b', complexity: 'medium', dependsOn: ['track-a'] },
      { name: 'track-c', complexity: 'small', dependsOn: [] },
    ]);
    assignClusters(dag);
    expect(dag.clusters.length).toBe(2);
    expect(dag.clusters[0].nodes).toEqual(['track-a', 'track-c']);
    expect(dag.clusters[1].nodes).toEqual(['track-b']);
  });

  it('single node -> 1 cluster', () => {
    const dag = buildDAG('req-001', [{ name: 'only', complexity: 'small' }]);
    assignClusters(dag);
    expect(dag.clusters.length).toBe(1);
    expect(dag.clusters[0].nodes).toEqual(['only']);
  });

  it('chain A->B->C->D -> 4 clusters', () => {
    const specs = [
      { name: 'a', dependsOn: [] },
      { name: 'b', dependsOn: ['a'] },
      { name: 'c', dependsOn: ['b'] },
      { name: 'd', dependsOn: ['c'] },
    ];
    const dag = buildDAG('req-001', specs);
    assignClusters(dag);
    expect(dag.clusters.length).toBe(4);
    expect(dag.clusters[0].nodes).toEqual(['a']);
    expect(dag.clusters[3].nodes).toEqual(['d']);
  });

  it('all independent -> 1 cluster', () => {
    const specs = Array.from({ length: 5 }, (_, i) => ({
      name: `t${i}`, complexity: 'small' as const, dependsOn: [],
    }));
    const dag = buildDAG('req-001', specs);
    assignClusters(dag);
    expect(dag.clusters.length).toBe(1);
    expect(dag.clusters[0].nodes.length).toBe(5);
  });

  it('diamond -> 3 clusters', () => {
    const specs = [
      { name: 'a', dependsOn: [] },
      { name: 'b', dependsOn: ['a'] },
      { name: 'c', dependsOn: ['a'] },
      { name: 'd', dependsOn: ['b', 'c'] },
    ];
    const dag = buildDAG('req-001', specs);
    assignClusters(dag);
    expect(dag.clusters.length).toBe(3);
    expect(dag.clusters[0].nodes).toEqual(['a']);
    expect(dag.clusters[1].nodes).toEqual(['b', 'c']);
    expect(dag.clusters[2].nodes).toEqual(['d']);
  });

  it('every node in exactly one cluster', () => {
    const specs = [
      { name: 'a', dependsOn: [] },
      { name: 'b', dependsOn: ['a'] },
      { name: 'c', dependsOn: [] },
      { name: 'd', dependsOn: ['b', 'c'] },
    ];
    const dag = buildDAG('req-001', specs);
    assignClusters(dag);
    const allNodes = dag.clusters.flatMap(c => c.nodes);
    expect(allNodes.length).toBe(4);
    expect(new Set(allNodes).size).toBe(4);
  });

  it('cluster dependsOnClusters is correct', () => {
    const specs = [
      { name: 'a', dependsOn: [] },
      { name: 'b', dependsOn: ['a'] },
    ];
    const dag = buildDAG('req-001', specs);
    assignClusters(dag);
    expect(dag.clusters[1].dependsOnClusters).toEqual([0]);
  });
});

describe('computeCriticalPath', () => {
  it('finds longest path by weight', () => {
    const specs = [
      { name: 'a', complexity: 'small', estimatedMinutes: 5 },     // path A->B = 20
      { name: 'b', complexity: 'medium', estimatedMinutes: 15, dependsOn: ['a'] },
      { name: 'c', complexity: 'large', estimatedMinutes: 30 },    // path C = 30
    ];
    const dag = buildDAG('req-001', specs);
    assignClusters(dag);
    computeCriticalPath(dag);
    // C alone = 30 > A->B = 5+15 = 20, so critical path is [c]
    expect(dag.criticalPath).toEqual(['c']);
  });

  it('multi-node critical path', () => {
    const specs = [
      { name: 'a', complexity: 'large', estimatedMinutes: 30 },
      { name: 'b', complexity: 'large', estimatedMinutes: 30, dependsOn: ['a'] },
      { name: 'c', complexity: 'small', estimatedMinutes: 5 },
    ];
    const dag = buildDAG('req-001', specs);
    assignClusters(dag);
    computeCriticalPath(dag);
    // A->B = 60 > C = 5
    expect(dag.criticalPath).toEqual(['a', 'b']);
  });

  it('applies +10 priority to critical path nodes', () => {
    const specs = [
      { name: 'a', complexity: 'large', estimatedMinutes: 30 },
      { name: 'b', complexity: 'large', estimatedMinutes: 30, dependsOn: ['a'] },
      { name: 'c', complexity: 'small', estimatedMinutes: 5 },
    ];
    const dag = buildDAG('req-001', specs);
    assignClusters(dag);
    computeCriticalPath(dag);
    expect(dag.nodes.get('a')!.priority).toBeGreaterThanOrEqual(10);
    expect(dag.nodes.get('b')!.priority).toBeGreaterThanOrEqual(10);
  });

  it('applies +5 per downstream dependent', () => {
    const specs = [
      { name: 'root', complexity: 'small', dependsOn: [] },
      { name: 'dep1', complexity: 'small', dependsOn: ['root'] },
      { name: 'dep2', complexity: 'small', dependsOn: ['root'] },
      { name: 'dep3', complexity: 'small', dependsOn: ['root'] },
    ];
    const dag = buildDAG('req-001', specs);
    assignClusters(dag);
    computeCriticalPath(dag);
    // root has 3 downstream => +15
    expect(dag.nodes.get('root')!.priority).toBeGreaterThanOrEqual(15);
  });
});
```

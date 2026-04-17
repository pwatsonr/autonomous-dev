# SPEC-006-2-4: DAG and Scheduler Comprehensive Tests

## Metadata
- **Parent Plan**: PLAN-006-2
- **Tasks Covered**: Task 8, Task 9
- **Estimated effort**: 9 hours

## Description

Comprehensive test suites for the DAG constructor (dependency extraction, cycle detection, transitive reduction, cluster assignment, critical path) and the Scheduler (dispatch ordering, resource throttling, cluster sequencing). Includes property-based tests, the TDD 2.3 worked example, and stress tests for large DAGs.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `tests/parallel/dag-constructor.test.ts` | **Modify** | Add property-based tests, stress tests, full worked example |
| `tests/parallel/scheduler.test.ts` | **Modify** | Add resource throttling, slot recalculation, edge case tests |

## Implementation Details

### 1. DAG Constructor property-based tests

Use a property-based testing library (e.g. `fast-check`) to verify invariants hold for arbitrarily generated inputs.

```typescript
import fc from 'fast-check';

describe('DAG property-based tests', () => {
  // Arbitrary: generate a list of specs with random dependencies (acyclic only)
  const acyclicSpecsArb = fc.integer({ min: 1, max: 20 }).chain(n => {
    // Generate n specs. Spec i can only depend on specs 0..i-1 (ensures acyclicity)
    return fc.tuple(
      ...Array.from({ length: n }, (_, i) =>
        fc.record({
          name: fc.constant(`spec-${i}`),
          complexity: fc.constantFrom('small', 'medium', 'large'),
          dependsOn: fc.subarray(
            Array.from({ length: i }, (_, j) => `spec-${j}`),
            { minLength: 0 }
          ),
        })
      )
    );
  });

  it('property: output DAG is always acyclic', () => {
    fc.assert(fc.property(acyclicSpecsArb, specs => {
      const dag = buildDAG('test', specs);
      // Verify Kahn's sort visits all nodes
      const { hasCycle } = kahnsTopologicalSort(dag.nodes, dag.edges);
      expect(hasCycle).toBe(false);
    }));
  });

  it('property: every node in exactly one cluster', () => {
    fc.assert(fc.property(acyclicSpecsArb, specs => {
      const dag = buildAndScheduleDAG('test', specs);
      const allNodes = dag.clusters.flatMap(c => c.nodes);
      expect(allNodes.length).toBe(specs.length);
      expect(new Set(allNodes).size).toBe(specs.length);
    }));
  });

  it('property: cluster ordering respects dependencies', () => {
    fc.assert(fc.property(acyclicSpecsArb, specs => {
      const dag = buildAndScheduleDAG('test', specs);
      for (const edge of dag.reducedEdges) {
        const fromCluster = dag.nodes.get(edge.from)!.cluster;
        const toCluster = dag.nodes.get(edge.to)!.cluster;
        expect(fromCluster).toBeLessThan(toCluster);
      }
    }));
  });

  it('property: transitive reduction preserves reachability', () => {
    fc.assert(fc.property(acyclicSpecsArb, specs => {
      const dag = buildAndScheduleDAG('test', specs);
      // For every original edge A->B, B is still reachable from A via reduced edges
      for (const origEdge of dag.originalEdges) {
        const reachable = bfsReachable(origEdge.from, dag.reducedEdges);
        expect(reachable.has(origEdge.to)).toBe(true);
      }
    }));
  });

  it('property: deterministic output', () => {
    fc.assert(fc.property(acyclicSpecsArb, specs => {
      const dag1 = buildAndScheduleDAG('test', specs);
      const dag2 = buildAndScheduleDAG('test', specs);
      expect(dag1.clusters.map(c => c.nodes)).toEqual(dag2.clusters.map(c => c.nodes));
      expect(dag1.criticalPath).toEqual(dag2.criticalPath);
    }));
  });
});
```

### 2. TDD 2.3 worked example end-to-end test

```typescript
describe('TDD 2.3 worked example', () => {
  const specs: SpecMetadata[] = [
    {
      name: 'track-a',
      path: 'specs/track-a.md',
      complexity: 'medium',
      estimatedMinutes: 15,
      dependsOn: [],
      filesModified: ['src/user-model.ts', 'src/user-service.ts'],
      interfacesProduced: ['UserService'],
    },
    {
      name: 'track-b',
      path: 'specs/track-b.md',
      complexity: 'medium',
      estimatedMinutes: 15,
      dependsOn: ['track-a'],
      filesModified: ['src/auth-controller.ts'],
      interfacesConsumed: ['UserService'],
    },
    {
      name: 'track-c',
      path: 'specs/track-c.md',
      complexity: 'small',
      estimatedMinutes: 5,
      dependsOn: [],
      filesModified: ['src/logger.ts'],
    },
  ];

  it('produces correct DAG structure', () => {
    const dag = buildAndScheduleDAG('req-001', specs);

    // Edges: track-a -> track-b (explicit + interface contract merged)
    expect(dag.reducedEdges.length).toBe(1);
    expect(dag.reducedEdges[0]).toMatchObject({ from: 'track-a', to: 'track-b' });

    // Clusters: [track-a, track-c] then [track-b]
    expect(dag.clusters.length).toBe(2);
    expect(dag.clusters[0].nodes).toContain('track-a');
    expect(dag.clusters[0].nodes).toContain('track-c');
    expect(dag.clusters[1].nodes).toEqual(['track-b']);

    // Critical path: track-a -> track-b (15+15=30 > track-c alone=5)
    expect(dag.criticalPath).toEqual(['track-a', 'track-b']);

    // Priority: track-a gets +10 (critical) + 5 (1 dependent) = +15
    expect(dag.nodes.get('track-a')!.priority).toBeGreaterThanOrEqual(15);
    expect(dag.nodes.get('track-b')!.priority).toBeGreaterThanOrEqual(10);
  });

  it('produces correct execution plan', () => {
    const dag = buildAndScheduleDAG('req-001', specs);
    const plan = scheduler.createExecutionPlan(dag);

    expect(plan.totalTracks).toBe(3);
    expect(plan.clusters.length).toBe(2);

    // Cluster 0: track-a dispatches before track-c (higher priority due to critical path)
    expect(plan.clusters[0].tracks[0].trackName).toBe('track-a');
    expect(plan.clusters[0].tracks[1].trackName).toBe('track-c');

    // Cluster 1: only track-b
    expect(plan.clusters[1].tracks[0].trackName).toBe('track-b');
  });
});
```

### 3. Stress tests

```typescript
describe('DAG stress tests', () => {
  it('handles 10 nodes with mixed dependencies', () => {
    const specs = generateChainDAG(10);
    const dag = buildAndScheduleDAG('stress-10', specs);
    expect(dag.validated).toBe(true);
    expect(dag.clusters.length).toBe(10); // chain = N clusters
  });

  it('handles 20 fully independent nodes', () => {
    const specs = Array.from({ length: 20 }, (_, i) => ({
      name: `spec-${i}`,
      path: `specs/spec-${i}.md`,
      complexity: 'small' as const,
      estimatedMinutes: 5,
    }));
    const dag = buildAndScheduleDAG('stress-20', specs);
    expect(dag.clusters.length).toBe(1);
    expect(dag.clusters[0].nodes.length).toBe(20);
  });

  it('handles 50-node diamond lattice', () => {
    // Create a lattice: 5 layers of 10 nodes each, each node depends on all in prev layer
    const specs: SpecMetadata[] = [];
    for (let layer = 0; layer < 5; layer++) {
      for (let i = 0; i < 10; i++) {
        const name = `l${layer}-n${i}`;
        const deps = layer === 0
          ? []
          : Array.from({ length: 10 }, (_, j) => `l${layer - 1}-n${j}`);
        specs.push({ name, path: `specs/${name}.md`, complexity: 'small', dependsOn: deps });
      }
    }
    const dag = buildAndScheduleDAG('stress-50', specs);
    expect(dag.validated).toBe(true);
    expect(dag.clusters.length).toBe(5);
  });

  it('completes DAG construction in < 1 second for 50 nodes', () => {
    const specs = generateRandomAcyclicDAG(50);
    const start = Date.now();
    buildAndScheduleDAG('perf-50', specs);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });
});
```

### 4. Scheduler edge case tests

```typescript
describe('Scheduler edge cases', () => {
  it('handles empty cluster gracefully', async () => {
    const result = await scheduler.executeCluster('req-001', {
      clusterIndex: 0,
      tracks: [],
    });
    expect(result.allSucceeded).toBe(true);
    expect(result.completed.length).toBe(0);
  });

  it('recalculates slots after each track completion', async () => {
    // max_tracks=2, 4 tracks. First 2 dispatch, then as each completes, next dispatches
    const dispatched: string[] = [];
    callbacks.onTrackDispatch = async (_, name) => { dispatched.push(name); };

    // Simulate sequential completions
    const promise = scheduler.executeCluster('req-001', clusterWith4Tracks);
    // t1, t2 dispatched immediately
    expect(dispatched.length).toBe(2);

    scheduler.notifyTrackComplete('req-001', dispatched[0], true);
    // t3 should now dispatch
    await tick();
    expect(dispatched.length).toBe(3);

    scheduler.notifyTrackComplete('req-001', dispatched[1], true);
    // t4 should now dispatch
    await tick();
    expect(dispatched.length).toBe(4);
  });

  it('handles track failure without blocking cluster', async () => {
    // 2 tracks; t1 fails, t2 succeeds -> cluster completes with partial failure
    const result = await scheduler.executeCluster('req-001', clusterWith2Tracks);
    scheduler.notifyTrackComplete('req-001', 't1', false);
    scheduler.notifyTrackComplete('req-001', 't2', true);
    const final = await result;
    expect(final.failed).toContain('t1');
    expect(final.completed).toContain('t2');
    expect(final.allSucceeded).toBe(false);
  });

  it('disk pressure changes mid-cluster reduce parallelism', async () => {
    // Start with normal pressure (3 tracks dispatched)
    // After t1 completes, pressure becomes 'warning' -> throttle to 1
    resourceMonitor.getDiskPressureLevel = () => 'normal';
    const dispatched: string[] = [];
    callbacks.onTrackDispatch = async (_, name) => {
      dispatched.push(name);
      if (name === 't1') {
        resourceMonitor.getDiskPressureLevel = () => 'warning';
        scheduler.notifyTrackComplete('req-001', 't1', true);
      }
    };
    // With warning: only 1 slot even though t2 and t3 are pending
  });
});
```

## Acceptance Criteria

1. Property-based tests verify: acyclicity, cluster completeness, cluster ordering, reachability after reduction, determinism.
2. TDD 2.3 worked example produces the exact expected DAG, clusters, critical path, and execution plan.
3. Stress tests pass for 10-node chain, 20-node independent, and 50-node lattice DAGs.
4. DAG construction for 50 nodes completes in under 1 second.
5. Scheduler correctly handles empty clusters, track failures, and mid-execution resource pressure changes.
6. Slot recalculation dispatches pending tracks immediately when slots free up.
7. All tests are deterministic (no flaky timing dependencies -- use explicit completion signals, not timeouts).

## Test Cases

See detailed test code in Implementation Details above. Summary:

| Test Category | Count | Focus |
|---------------|-------|-------|
| Property-based DAG | 5 | Invariant verification across random inputs |
| TDD 2.3 worked example | 2 | End-to-end correctness for canonical scenario |
| Stress tests | 4 | Scale, performance, complex topologies |
| Scheduler edge cases | 4 | Empty clusters, failures, dynamic pressure, slot recalc |
| Scheduler dispatch | 3 | Priority ordering, concurrent dispatch, cluster sequencing |
| Resource throttling | 3 | Warning/critical/disk-low scenarios |

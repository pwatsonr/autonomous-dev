// ============================================================================
// Tests for DAG Constructor — SPEC-006-2-1
// ============================================================================

import {
  buildDAG,
  assignClusters,
  computeCriticalPath,
  buildAndScheduleDAG,
  extractExplicitDependencies,
  extractFileOverlapDependencies,
  extractInterfaceContractDependencies,
  UnknownDependencyError,
  DuplicateInterfaceProducerError,
  UnresolvedInterfaceError,
  CyclicDependencyError,
} from '../../src/parallel/dag-constructor';
import { SpecMetadata } from '../../src/parallel/types';

// ============================================================================
// extractExplicitDependencies
// ============================================================================

describe('extractExplicitDependencies', () => {
  it('creates edge from dependency to dependent', () => {
    const specs: SpecMetadata[] = [
      { name: 'track-a', dependsOn: [] },
      { name: 'track-b', dependsOn: ['track-a'] },
    ];
    const edges = extractExplicitDependencies(specs);
    expect(edges).toEqual([
      { from: 'track-a', to: 'track-b', type: 'explicit', reason: expect.any(String) },
    ]);
  });

  it('throws on unknown dependency', () => {
    const specs: SpecMetadata[] = [{ name: 'track-a', dependsOn: ['nonexistent'] }];
    expect(() => extractExplicitDependencies(specs)).toThrow(UnknownDependencyError);
  });

  it('returns empty array when no specs have dependencies', () => {
    const specs: SpecMetadata[] = [
      { name: 'track-a' },
      { name: 'track-b' },
    ];
    const edges = extractExplicitDependencies(specs);
    expect(edges).toEqual([]);
  });

  it('handles multiple dependencies from a single spec', () => {
    const specs: SpecMetadata[] = [
      { name: 'track-a' },
      { name: 'track-b' },
      { name: 'track-c', dependsOn: ['track-a', 'track-b'] },
    ];
    const edges = extractExplicitDependencies(specs);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ from: 'track-a', to: 'track-c' });
    expect(edges[1]).toMatchObject({ from: 'track-b', to: 'track-c' });
  });
});

// ============================================================================
// extractFileOverlapDependencies
// ============================================================================

describe('extractFileOverlapDependencies', () => {
  it('creates edges for overlapping file modifications', () => {
    const specs: SpecMetadata[] = [
      { name: 'track-a', filesModified: ['src/shared.ts'] },
      { name: 'track-b', filesModified: ['src/shared.ts'] },
      { name: 'track-c', filesModified: ['src/other.ts'] },
    ];
    const edges = extractFileOverlapDependencies(specs);
    expect(edges.length).toBe(1);
    expect(edges[0].from).toBe('track-a');
    expect(edges[0].to).toBe('track-b');
  });

  it('creates edges for all pairs when 3+ specs share a file', () => {
    const specs: SpecMetadata[] = [
      { name: 'a', filesModified: ['shared.ts'] },
      { name: 'b', filesModified: ['shared.ts'] },
      { name: 'c', filesModified: ['shared.ts'] },
    ];
    const edges = extractFileOverlapDependencies(specs);
    // 3 specs => 3 pairs: a->b, a->c, b->c
    expect(edges.length).toBe(3);
  });

  it('returns empty when no files overlap', () => {
    const specs: SpecMetadata[] = [
      { name: 'track-a', filesModified: ['src/a.ts'] },
      { name: 'track-b', filesModified: ['src/b.ts'] },
    ];
    const edges = extractFileOverlapDependencies(specs);
    expect(edges).toEqual([]);
  });

  it('returns empty when no specs have filesModified', () => {
    const specs: SpecMetadata[] = [
      { name: 'track-a' },
      { name: 'track-b' },
    ];
    const edges = extractFileOverlapDependencies(specs);
    expect(edges).toEqual([]);
  });
});

// ============================================================================
// extractInterfaceContractDependencies
// ============================================================================

describe('extractInterfaceContractDependencies', () => {
  it('creates producer->consumer edge', () => {
    const specs: SpecMetadata[] = [
      { name: 'track-a', interfacesProduced: ['UserService'] },
      { name: 'track-b', interfacesConsumed: ['UserService'] },
    ];
    const edges = extractInterfaceContractDependencies(specs);
    expect(edges[0]).toEqual({
      from: 'track-a',
      to: 'track-b',
      type: 'interface-contract',
      reason: expect.any(String),
    });
  });

  it('throws on duplicate producer', () => {
    const specs: SpecMetadata[] = [
      { name: 'track-a', interfacesProduced: ['UserService'] },
      { name: 'track-b', interfacesProduced: ['UserService'] },
    ];
    expect(() => extractInterfaceContractDependencies(specs)).toThrow(
      DuplicateInterfaceProducerError,
    );
  });

  it('throws on unresolved interface', () => {
    const specs: SpecMetadata[] = [
      { name: 'track-a', interfacesConsumed: ['NonExistent'] },
    ];
    expect(() => extractInterfaceContractDependencies(specs)).toThrow(UnresolvedInterfaceError);
  });

  it('skips self-dependency when producer and consumer are the same spec', () => {
    const specs: SpecMetadata[] = [
      { name: 'track-a', interfacesProduced: ['InternalAPI'], interfacesConsumed: ['InternalAPI'] },
    ];
    const edges = extractInterfaceContractDependencies(specs);
    expect(edges).toEqual([]);
  });

  it('handles multiple interfaces', () => {
    const specs: SpecMetadata[] = [
      { name: 'track-a', interfacesProduced: ['ServiceA', 'ServiceB'] },
      { name: 'track-b', interfacesConsumed: ['ServiceA'] },
      { name: 'track-c', interfacesConsumed: ['ServiceB'] },
    ];
    const edges = extractInterfaceContractDependencies(specs);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ from: 'track-a', to: 'track-b' });
    expect(edges[1]).toMatchObject({ from: 'track-a', to: 'track-c' });
  });
});

// ============================================================================
// buildDAG — integration tests
// ============================================================================

describe('buildDAG', () => {
  it('TDD 2.3 worked example: A->B dependency, C independent', () => {
    const specs: SpecMetadata[] = [
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
    const specs: SpecMetadata[] = [
      { name: 'track-a', dependsOn: ['track-b'] },
      { name: 'track-b', dependsOn: ['track-a'] },
    ];
    expect(() => buildDAG('req-001', specs)).toThrow(CyclicDependencyError);
  });

  it('detects 3-node cycle', () => {
    const specs: SpecMetadata[] = [
      { name: 'track-a', dependsOn: ['track-c'] },
      { name: 'track-b', dependsOn: ['track-a'] },
      { name: 'track-c', dependsOn: ['track-b'] },
    ];
    expect(() => buildDAG('req-001', specs)).toThrow(/cycle/i);
  });

  it('performs transitive reduction', () => {
    // A->B, B->C, and redundant A->C
    const specs: SpecMetadata[] = [
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
    const specs: SpecMetadata[] = Array.from({ length: 5 }, (_, i) => ({
      name: `track-${i}`,
      complexity: 'small' as const,
    }));
    const dag = buildDAG('req-001', specs);
    expect(dag.edges.length).toBe(0);
    expect(dag.nodes.size).toBe(5);
  });

  it('handles diamond: A->B, A->C, B->D, C->D', () => {
    const specs: SpecMetadata[] = [
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
    const specs: SpecMetadata[] = [
      { name: 'track-a', dependsOn: [], filesModified: ['src/shared.ts'] },
      { name: 'track-b', dependsOn: ['track-a'], filesModified: ['src/shared.ts'] },
    ];
    const dag = buildDAG('req-001', specs);
    // Only one edge, typed 'explicit'
    expect(dag.originalEdges.length).toBe(1);
    expect(dag.originalEdges[0].type).toBe('explicit');
  });

  it('is deterministic for same input', () => {
    const specs: SpecMetadata[] = [
      { name: 'track-a', dependsOn: [] },
      { name: 'track-b', dependsOn: ['track-a'] },
      { name: 'track-c', dependsOn: [] },
    ];
    const dag1 = buildDAG('req-001', specs);
    const dag2 = buildDAG('req-001', specs);
    expect(dag1.edges).toEqual(dag2.edges);
    expect(dag1.clusters).toEqual(dag2.clusters);
  });

  it('sets correct estimatedMinutes from complexity defaults', () => {
    const specs: SpecMetadata[] = [
      { name: 'small-spec', complexity: 'small' },
      { name: 'medium-spec', complexity: 'medium' },
      { name: 'large-spec', complexity: 'large' },
    ];
    const dag = buildDAG('req-001', specs);
    expect(dag.nodes.get('small-spec')!.estimatedMinutes).toBe(5);
    expect(dag.nodes.get('medium-spec')!.estimatedMinutes).toBe(15);
    expect(dag.nodes.get('large-spec')!.estimatedMinutes).toBe(30);
  });

  it('uses estimatedMinutes override when provided', () => {
    const specs: SpecMetadata[] = [
      { name: 'custom', complexity: 'small', estimatedMinutes: 42 },
    ];
    const dag = buildDAG('req-001', specs);
    expect(dag.nodes.get('custom')!.estimatedMinutes).toBe(42);
  });

  it('preserves requestId in the output DAG', () => {
    const dag = buildDAG('my-request-123', [{ name: 'only' }]);
    expect(dag.requestId).toBe('my-request-123');
  });

  it('sets clusters to empty array and criticalPath to empty array', () => {
    const dag = buildDAG('req-001', [{ name: 'only' }]);
    expect(dag.clusters).toEqual([]);
    expect(dag.criticalPath).toEqual([]);
  });

  it('computes correct in-degree and out-degree', () => {
    const specs: SpecMetadata[] = [
      { name: 'a', dependsOn: [] },
      { name: 'b', dependsOn: ['a'] },
      { name: 'c', dependsOn: ['a'] },
      { name: 'd', dependsOn: ['b', 'c'] },
    ];
    const dag = buildDAG('req-001', specs);
    expect(dag.nodes.get('a')!.inDegree).toBe(0);
    expect(dag.nodes.get('a')!.outDegree).toBe(2);
    expect(dag.nodes.get('b')!.inDegree).toBe(1);
    expect(dag.nodes.get('b')!.outDegree).toBe(1);
    expect(dag.nodes.get('c')!.inDegree).toBe(1);
    expect(dag.nodes.get('c')!.outDegree).toBe(1);
    expect(dag.nodes.get('d')!.inDegree).toBe(2);
    expect(dag.nodes.get('d')!.outDegree).toBe(0);
  });

  it('interface-contract edges coexist with explicit edges', () => {
    const specs: SpecMetadata[] = [
      { name: 'track-a', dependsOn: [], interfacesProduced: ['MyAPI'] },
      { name: 'track-b', dependsOn: ['track-a'], interfacesConsumed: ['MyAPI'] },
    ];
    const dag = buildDAG('req-001', specs);
    // Both explicit and interface-contract edges should be present in originalEdges
    const explicitEdge = dag.originalEdges.find(e => e.type === 'explicit');
    const ifaceEdge = dag.originalEdges.find(e => e.type === 'interface-contract');
    expect(explicitEdge).toBeDefined();
    expect(ifaceEdge).toBeDefined();
  });

  it('CyclicDependencyError message is human-readable', () => {
    const specs: SpecMetadata[] = [
      { name: 'track-a', dependsOn: ['track-b'] },
      { name: 'track-b', dependsOn: ['track-a'] },
    ];
    try {
      buildDAG('req-001', specs);
      fail('Expected CyclicDependencyError');
    } catch (err) {
      expect(err).toBeInstanceOf(CyclicDependencyError);
      expect((err as Error).message).toMatch(/Cycle detected:/);
      expect((err as Error).message).toMatch(/track-a/);
      expect((err as Error).message).toMatch(/track-b/);
    }
  });
});

// ============================================================================
// assignClusters — SPEC-006-2-2
// ============================================================================

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
    const specs: SpecMetadata[] = [
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
    const specs: SpecMetadata[] = Array.from({ length: 5 }, (_, i) => ({
      name: `t${i}`, complexity: 'small' as const, dependsOn: [],
    }));
    const dag = buildDAG('req-001', specs);
    assignClusters(dag);
    expect(dag.clusters.length).toBe(1);
    expect(dag.clusters[0].nodes.length).toBe(5);
  });

  it('diamond -> 3 clusters', () => {
    const specs: SpecMetadata[] = [
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
    const specs: SpecMetadata[] = [
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
    const specs: SpecMetadata[] = [
      { name: 'a', dependsOn: [] },
      { name: 'b', dependsOn: ['a'] },
    ];
    const dag = buildDAG('req-001', specs);
    assignClusters(dag);
    expect(dag.clusters[1].dependsOnClusters).toEqual([0]);
  });
});

// ============================================================================
// computeCriticalPath — SPEC-006-2-2
// ============================================================================

describe('computeCriticalPath', () => {
  it('finds longest path by weight', () => {
    const specs: SpecMetadata[] = [
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
    const specs: SpecMetadata[] = [
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
    const specs: SpecMetadata[] = [
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
    const specs: SpecMetadata[] = [
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

// ============================================================================
// buildAndScheduleDAG — SPEC-006-2-2 convenience function
// ============================================================================

describe('buildAndScheduleDAG', () => {
  it('builds DAG with clusters and critical path in one call', () => {
    const specs: SpecMetadata[] = [
      { name: 'track-a', complexity: 'medium', dependsOn: [] },
      { name: 'track-b', complexity: 'medium', dependsOn: ['track-a'] },
      { name: 'track-c', complexity: 'small', dependsOn: [] },
    ];
    const dag = buildAndScheduleDAG('req-001', specs);
    // Clusters should be populated
    expect(dag.clusters.length).toBeGreaterThan(0);
    // Critical path should be populated
    expect(dag.criticalPath.length).toBeGreaterThan(0);
    // Validated
    expect(dag.validated).toBe(true);
  });

  it('produces same result as calling steps individually', () => {
    const specs: SpecMetadata[] = [
      { name: 'a', complexity: 'large', estimatedMinutes: 30, dependsOn: [] },
      { name: 'b', complexity: 'medium', estimatedMinutes: 15, dependsOn: ['a'] },
      { name: 'c', complexity: 'small', estimatedMinutes: 5, dependsOn: [] },
    ];

    // Individual steps
    const dagManual = buildDAG('req-001', specs);
    assignClusters(dagManual);
    computeCriticalPath(dagManual);

    // Convenience function
    const dagAuto = buildAndScheduleDAG('req-001', specs);

    expect(dagAuto.clusters).toEqual(dagManual.clusters);
    expect(dagAuto.criticalPath).toEqual(dagManual.criticalPath);
    for (const [name] of dagAuto.nodes) {
      expect(dagAuto.nodes.get(name)!.priority).toBe(dagManual.nodes.get(name)!.priority);
      expect(dagAuto.nodes.get(name)!.cluster).toBe(dagManual.nodes.get(name)!.cluster);
    }
  });
});

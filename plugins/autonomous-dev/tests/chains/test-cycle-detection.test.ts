/**
 * Cycle-detection + topological-sort tests for DependencyGraph
 * (SPEC-022-1-03 / SPEC-022-1-05).
 *
 * Covers ≥5 cycle topologies, CycleError shape, determinism, and the
 * 100-plugin perf budget + 5000-node iterative-stack proof.
 *
 * @module tests/chains/test-cycle-detection
 */

import { DependencyGraph } from '../../intake/chains/dependency-graph';
import { CycleError } from '../../intake/chains/cycle-error';
import { buildManifest } from '../helpers/chain-fixtures';
import type { HookManifest } from '../../intake/hooks/types';

/** Build a graph from a list of (producer, consumer, type) tuples. */
function buildFromEdges(
  pairs: Array<[string, string, string]>,
): DependencyGraph {
  const g = new DependencyGraph();
  // For each unique node, build a manifest that produces every type it
  // appears as `from` for and consumes every type it appears as `to` for.
  const produces = new Map<string, Set<string>>();
  const consumes = new Map<string, Set<string>>();
  const nodes = new Set<string>();
  for (const [from, to, t] of pairs) {
    nodes.add(from);
    nodes.add(to);
    if (!produces.has(from)) produces.set(from, new Set());
    if (!consumes.has(to)) consumes.set(to, new Set());
    produces.get(from)!.add(t);
    consumes.get(to)!.add(t);
  }
  const manifests: HookManifest[] = [];
  for (const id of nodes) {
    const p = [...(produces.get(id) ?? new Set())].map((t) => ({
      artifact_type: t,
      schema_version: '1.0',
      format: 'json' as const,
    }));
    const c = [...(consumes.get(id) ?? new Set())].map((t) => ({
      artifact_type: t,
      schema_version: '^1.0',
    }));
    manifests.push(buildManifest({ id, produces: p, consumes: c }));
  }
  // Sort manifests so addPlugin order is stable.
  manifests.sort((a, b) => a.id.localeCompare(b.id));
  for (const m of manifests) g.addPlugin(m);
  return g;
}

describe('cycle detection', () => {
  it("acyclic linear A→B→C: detectCycles returns []; topologicalSort returns ['A','B','C']", () => {
    const g = buildFromEdges([
      ['A', 'B', 'ab'],
      ['B', 'C', 'bc'],
    ]);
    expect(g.detectCycles()).toEqual([]);
    expect(g.topologicalSort()).toEqual(['A', 'B', 'C']);
  });

  it("acyclic diamond A→B,A→C,B→D,C→D: topologicalSort returns ['A','B','C','D']", () => {
    const g = buildFromEdges([
      ['A', 'B', 'ab'],
      ['A', 'C', 'ac'],
      ['B', 'D', 'bd'],
      ['C', 'D', 'cd'],
    ]);
    expect(g.detectCycles()).toEqual([]);
    expect(g.topologicalSort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('2-cycle A→B,B→A: detectCycles returns one SCC; topologicalSort throws CycleError', () => {
    const g = buildFromEdges([
      ['A', 'B', 'ab'],
      ['B', 'A', 'ba'],
    ]);
    const cycles = g.detectCycles();
    expect(cycles).toHaveLength(1);
    expect(cycles[0].length).toBeGreaterThanOrEqual(3); // [A,B,A] or similar
    expect(() => g.topologicalSort()).toThrow(CycleError);
  });

  it('3-cycle A→B→C→A: detectCycles returns ordered cycle path', () => {
    const g = buildFromEdges([
      ['A', 'B', 'ab'],
      ['B', 'C', 'bc'],
      ['C', 'A', 'ca'],
    ]);
    const cycles = g.detectCycles();
    expect(cycles).toHaveLength(1);
    expect(cycles[0].length).toBe(4); // [X,Y,Z,X]
    expect(cycles[0][0]).toBe(cycles[0][cycles[0].length - 1]);
  });

  it('5-cycle A→B→C→D→E→A: detectCycles returns SCC of length 6', () => {
    const g = buildFromEdges([
      ['A', 'B', 'ab'],
      ['B', 'C', 'bc'],
      ['C', 'D', 'cd'],
      ['D', 'E', 'de'],
      ['E', 'A', 'ea'],
    ]);
    const cycles = g.detectCycles();
    expect(cycles).toHaveLength(1);
    expect(cycles[0].length).toBe(6);
  });

  it('self-loop (injected via direct adj manipulation): detectCycles reports it', () => {
    const g = new DependencyGraph();
    // Use the test-only escape hatch.
    (g as unknown as { _addRawEdgeForTest: (a: string, b: string) => void })._addRawEdgeForTest(
      'A',
      'A',
    );
    const cycles = g.detectCycles();
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]).toEqual(['A', 'A']);
  });

  it('two disjoint cycles A→B→A and C→D→C: detectCycles returns 2 SCCs', () => {
    const g = buildFromEdges([
      ['A', 'B', 'ab'],
      ['B', 'A', 'ba'],
      ['C', 'D', 'cd'],
      ['D', 'C', 'dc'],
    ]);
    const cycles = g.detectCycles();
    expect(cycles.length).toBe(2);
  });

  it('mixed: DAG with one back-edge becomes one SCC; topologicalSort throws', () => {
    const g = buildFromEdges([
      ['A', 'B', 'ab'],
      ['B', 'C', 'bc'],
      ['C', 'B', 'cb'], // back-edge
    ]);
    expect(g.detectCycles().length).toBeGreaterThan(0);
    expect(() => g.topologicalSort()).toThrow(CycleError);
  });

  it("CycleError.message contains ' -> ' separators", () => {
    const g = buildFromEdges([
      ['A', 'B', 'ab'],
      ['B', 'A', 'ba'],
    ]);
    try {
      g.topologicalSort();
      throw new Error('expected CycleError');
    } catch (e) {
      expect(e).toBeInstanceOf(CycleError);
      expect((e as Error).message).toMatch(/ -> /);
    }
  });

  it('CycleError.cyclePath is frozen', () => {
    const err = new CycleError(['A', 'B', 'A']);
    expect(Object.isFrozen(err.cyclePath)).toBe(true);
  });

  it('CycleError thrown from topologicalSort has cyclePath equal to first SCC from detectCycles', () => {
    const g = buildFromEdges([
      ['A', 'B', 'ab'],
      ['B', 'A', 'ba'],
    ]);
    const cycles = g.detectCycles();
    try {
      g.topologicalSort();
      throw new Error('expected CycleError');
    } catch (e) {
      expect(e).toBeInstanceOf(CycleError);
      const ce = e as CycleError;
      expect([...ce.cyclePath]).toEqual(cycles[0]);
    }
  });
});

describe('topological sort determinism', () => {
  it('running topologicalSort 10 times on the same DAG returns the identical array', () => {
    const g = buildFromEdges([
      ['A', 'B', 'ab'],
      ['A', 'C', 'ac'],
      ['B', 'D', 'bd'],
      ['C', 'D', 'cd'],
    ]);
    const first = g.topologicalSort();
    for (let i = 0; i < 10; i++) {
      expect(g.topologicalSort()).toEqual(first);
    }
  });

  it('lex tie-break: in a graph with multiple in-degree-zero nodes, output starts with the lex-smallest', () => {
    const g = new DependencyGraph();
    g.addPlugin(buildManifest({ id: 'zebra' }));
    g.addPlugin(buildManifest({ id: 'apple' }));
    g.addPlugin(buildManifest({ id: 'mango' }));
    const order = g.topologicalSort();
    expect(order[0]).toBe('apple');
  });
});

describe('cycle detection performance', () => {
  it('synthesized 100-plugin DAG: detectCycles completes < 50ms p95 over 5 runs', () => {
    // Build a 100-node DAG: each node N produces type tN; node N+1 consumes
    // tN. That gives a 99-edge linear chain.
    const g = new DependencyGraph();
    for (let i = 0; i < 100; i++) {
      const id = `p${String(i).padStart(3, '0')}`;
      const produces = [
        { artifact_type: `t${i}`, schema_version: '1.0', format: 'json' as const },
      ];
      const consumes = i > 0 ? [{ artifact_type: `t${i - 1}`, schema_version: '^1.0' }] : undefined;
      g.addPlugin(buildManifest({ id, produces, consumes }));
    }
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      g.detectCycles();
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(0.95 * (samples.length - 1))];
    // eslint-disable-next-line no-console
    console.info(`detectCycles 100-plugin DAG p95: ${p95.toFixed(2)}ms`);
    expect(p95).toBeLessThan(50);
  });

  it('synthesized 100-plugin DAG with one injected cycle: detectCycles completes < 50ms p95 and finds the cycle', () => {
    const g = new DependencyGraph();
    for (let i = 0; i < 100; i++) {
      const id = `p${String(i).padStart(3, '0')}`;
      const produces = [
        { artifact_type: `t${i}`, schema_version: '1.0', format: 'json' as const },
      ];
      const consumes = i > 0 ? [{ artifact_type: `t${i - 1}`, schema_version: '^1.0' }] : undefined;
      g.addPlugin(buildManifest({ id, produces, consumes }));
    }
    // Inject a cycle by giving the LAST node a consume of t0 AND giving p000
    // a consume of t99 — wait, simpler: inject raw back-edge via test hatch.
    (
      g as unknown as { _addRawEdgeForTest: (a: string, b: string) => void }
    )._addRawEdgeForTest('p099', 'p000');
    const samples: number[] = [];
    let cyclesFound = 0;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const cycles = g.detectCycles();
      samples.push(performance.now() - t0);
      cyclesFound = cycles.length;
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(0.95 * (samples.length - 1))];
    expect(p95).toBeLessThan(50);
    expect(cyclesFound).toBeGreaterThan(0);
  });

  it('5000-node linear chain: detectCycles does NOT throw "Maximum call stack size exceeded"', () => {
    const g = new DependencyGraph();
    // Use raw-edge injection (faster than building 5000 manifests).
    for (let i = 0; i < 4999; i++) {
      (
        g as unknown as { _addRawEdgeForTest: (a: string, b: string) => void }
      )._addRawEdgeForTest(`n${i}`, `n${i + 1}`);
    }
    expect(() => g.detectCycles()).not.toThrow();
  });
});

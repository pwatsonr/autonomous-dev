/**
 * DependencyGraph — directed-graph data structure plus cycle detection
 * (Tarjan SCC) and topological sort (Kahn) for the chain engine
 * (SPEC-022-1-03, Tasks 5–7).
 *
 * Nodes are plugin IDs. Edges go from producer → consumer for each
 * (artifact_type, schema_version) overlap where the consumer's range is
 * satisfied by the producer's exact version.
 *
 * Self-edges are PRUNED at insertion (a plugin doesn't trigger itself).
 * Multi-edges (same `from`-`to` across multiple artifact types) are
 * recorded in `edgeMeta` for `getEdges()` rendering, but `adj` collapses
 * them to a single logical edge for cycle/sort purposes.
 *
 * Tarjan is implemented iteratively to survive the 5000-node linear-chain
 * stress test without overflowing the JS call stack.
 *
 * @module intake/chains/dependency-graph
 */

import type { HookManifest } from '../hooks/types';
import { satisfiesRange } from '../hooks/semver-compat';
import { CycleError } from './cycle-error';

export interface ChainEdge {
  /** Producer plugin id. */
  from: string;
  /** Consumer plugin id. */
  to: string;
  artifactType: string;
  /** Producer's exact schema_version (NOT the consumer's range). */
  schemaVersion: string;
}

interface ProducerEntry {
  pluginId: string;
  schemaVersion: string;
}

interface ConsumerEntry {
  pluginId: string;
  /** Consumer's declared range (caret-or-exact). */
  range: string;
}

export class DependencyGraph {
  /** Adjacency list: from → set of to. Pure plugin-id graph. */
  private readonly adj = new Map<string, Set<string>>();
  /** Edge metadata keyed by `${from}->${to}` (multi-edges per pair). */
  private readonly edgeMeta = new Map<string, ChainEdge[]>();
  /** Producer index: artifactType → list of producers. */
  private readonly producers = new Map<string, ProducerEntry[]>();
  /** Consumer index: artifactType → list of consumers (with ranges). */
  private readonly consumers = new Map<string, ConsumerEntry[]>();
  /** All node ids (covers isolated plugins with no edges). */
  private readonly nodes = new Set<string>();
  /** Track which (pluginId, artifactType) pairs we have already indexed
   *  as producers, to keep `addPlugin` idempotent. */
  private readonly producerKeys = new Set<string>();
  private readonly consumerKeys = new Set<string>();

  /**
   * Register a plugin's produces/consumes. Call once per plugin during
   * scan, then read-only operations (cycle/sort/edges) afterward.
   *
   * Self-edges are pruned at insertion. Idempotent on re-add: nodes/edges
   * are not duplicated.
   */
  addPlugin(manifest: HookManifest): void {
    const id = manifest.id;
    this.nodes.add(id);

    if (manifest.produces) {
      for (const p of manifest.produces) {
        const key = `${id}@@${p.artifact_type}@@${p.schema_version}`;
        if (this.producerKeys.has(key)) continue;
        this.producerKeys.add(key);
        const list = this.producers.get(p.artifact_type) ?? [];
        list.push({ pluginId: id, schemaVersion: p.schema_version });
        this.producers.set(p.artifact_type, list);
      }
    }
    if (manifest.consumes) {
      for (const c of manifest.consumes) {
        const key = `${id}@@${c.artifact_type}@@${c.schema_version}`;
        if (this.consumerKeys.has(key)) continue;
        this.consumerKeys.add(key);
        const list = this.consumers.get(c.artifact_type) ?? [];
        list.push({ pluginId: id, range: c.schema_version });
        this.consumers.set(c.artifact_type, list);
      }
    }

    // Eagerly (re)build edges for every artifact type the new plugin
    // touches. Cheap at expected scale (P × C ≤ ~100).
    const touched = new Set<string>();
    if (manifest.produces) for (const p of manifest.produces) touched.add(p.artifact_type);
    if (manifest.consumes) for (const c of manifest.consumes) touched.add(c.artifact_type);
    for (const type of touched) this.rebuildEdgesForType(type);
  }

  private rebuildEdgesForType(artifactType: string): void {
    const prods = this.producers.get(artifactType) ?? [];
    const cons = this.consumers.get(artifactType) ?? [];
    for (const p of prods) {
      for (const c of cons) {
        if (p.pluginId === c.pluginId) continue; // self-edge prune
        if (!satisfiesRange(p.schemaVersion, c.range)) continue;
        // Add to adjacency.
        let set = this.adj.get(p.pluginId);
        if (!set) {
          set = new Set();
          this.adj.set(p.pluginId, set);
        }
        set.add(c.pluginId);
        // Record edge metadata. Avoid duplicating identical (from,to,type,ver).
        const metaKey = `${p.pluginId}->${c.pluginId}`;
        const list = this.edgeMeta.get(metaKey) ?? [];
        const exists = list.some(
          (e) =>
            e.artifactType === artifactType &&
            e.schemaVersion === p.schemaVersion,
        );
        if (!exists) {
          list.push({
            from: p.pluginId,
            to: c.pluginId,
            artifactType,
            schemaVersion: p.schemaVersion,
          });
          this.edgeMeta.set(metaKey, list);
        }
      }
    }
  }

  /** All ChainEdges (multi-edges expanded), sorted (from, to, artifactType). */
  getEdges(): ChainEdge[] {
    const out: ChainEdge[] = [];
    for (const list of this.edgeMeta.values()) out.push(...list);
    out.sort((a, b) => {
      if (a.from !== b.from) return a.from.localeCompare(b.from);
      if (a.to !== b.to) return a.to.localeCompare(b.to);
      if (a.artifactType !== b.artifactType) {
        return a.artifactType.localeCompare(b.artifactType);
      }
      return a.schemaVersion.localeCompare(b.schemaVersion);
    });
    return out;
  }

  getProducers(
    artifactType: string,
  ): Array<{ pluginId: string; schemaVersion: string }> {
    const list = this.producers.get(artifactType) ?? [];
    return [...list].sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  }

  getConsumers(artifactType: string): string[] {
    const list = this.consumers.get(artifactType) ?? [];
    const ids = list.map((c) => c.pluginId);
    return [...new Set(ids)].sort();
  }

  /** All node ids, lex-sorted. */
  getNodes(): string[] {
    return [...this.nodes].sort();
  }

  /**
   * Test-only / advanced: inject a raw edge into the adjacency map. Bypasses
   * the self-edge prune. Used by test suites that need to verify
   * `detectCycles` correctly reports a self-loop. NOT exposed in the index.
   */
  _addRawEdgeForTest(from: string, to: string): void {
    this.nodes.add(from);
    this.nodes.add(to);
    let set = this.adj.get(from);
    if (!set) {
      set = new Set();
      this.adj.set(from, set);
    }
    set.add(to);
  }

  /**
   * Tarjan's SCC, iterative. Returns one or more SCCs (as `string[]` with
   * the first node repeated at the end), or `[]` for an acyclic graph.
   *
   * SCCs of size 1 with no self-loop are NOT reported; only SCCs that
   * indicate an actual cycle (size ≥ 2 OR self-loop) appear in the output.
   */
  detectCycles(): string[][] {
    const indices = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    let nextIndex = 0;
    const result: string[][] = [];

    // Iterative DFS frame.
    type Frame = {
      v: string;
      neighbors: string[];
      i: number;
    };

    const sortedNodes = [...this.nodes].sort();
    for (const start of sortedNodes) {
      if (indices.has(start)) continue;
      const work: Frame[] = [];
      // Visit start.
      const visit = (v: string): void => {
        indices.set(v, nextIndex);
        lowlink.set(v, nextIndex);
        nextIndex++;
        stack.push(v);
        onStack.add(v);
        const succ = [...(this.adj.get(v) ?? new Set<string>())].sort();
        work.push({ v, neighbors: succ, i: 0 });
      };
      visit(start);
      while (work.length > 0) {
        const top = work[work.length - 1];
        if (top.i < top.neighbors.length) {
          const w = top.neighbors[top.i];
          top.i++;
          if (!indices.has(w)) {
            visit(w);
            // After return, update lowlink of `top.v` from w.
            // The recursive return will be handled when w's frame pops.
          } else if (onStack.has(w)) {
            lowlink.set(top.v, Math.min(lowlink.get(top.v)!, indices.get(w)!));
          }
        } else {
          // All neighbors processed; pop.
          if (lowlink.get(top.v) === indices.get(top.v)) {
            // Root of SCC; pop stack until we re-pop top.v.
            const scc: string[] = [];
            while (true) {
              const w = stack.pop()!;
              onStack.delete(w);
              scc.push(w);
              if (w === top.v) break;
            }
            // Reverse so the first-discovery node appears first.
            scc.reverse();
            const isCycle =
              scc.length > 1 ||
              (scc.length === 1 && (this.adj.get(scc[0])?.has(scc[0]) ?? false));
            if (isCycle) {
              result.push([...scc, scc[0]]);
            }
          }
          const child = top.v;
          work.pop();
          if (work.length > 0) {
            // Standard Tarjan: on return from a recursive call, parent
            // takes min(parent.low, child.low).
            const parentV = work[work.length - 1].v;
            lowlink.set(
              parentV,
              Math.min(lowlink.get(parentV)!, lowlink.get(child)!),
            );
          }
        }
      }
    }
    return result;
  }

  /**
   * Kahn's algorithm with deterministic lex tie-break. Throws CycleError
   * (carrying the first SCC from `detectCycles`) if the graph is cyclic.
   */
  topologicalSort(): string[] {
    const cycles = this.detectCycles();
    if (cycles.length > 0) {
      throw new CycleError(cycles[0]);
    }
    const inDegree = new Map<string, number>();
    for (const n of this.nodes) inDegree.set(n, 0);
    for (const [, succ] of this.adj) {
      for (const w of succ) {
        inDegree.set(w, (inDegree.get(w) ?? 0) + 1);
      }
    }
    // Use a sorted array as a simple priority queue (lex tie-break on insert).
    const queue: string[] = [];
    for (const [n, d] of inDegree) {
      if (d === 0) queue.push(n);
    }
    queue.sort();
    const result: string[] = [];
    while (queue.length > 0) {
      const n = queue.shift()!;
      result.push(n);
      const succ = [...(this.adj.get(n) ?? new Set<string>())].sort();
      for (const m of succ) {
        const d = (inDegree.get(m) ?? 0) - 1;
        inDegree.set(m, d);
        if (d === 0) {
          // Insert lex-sorted.
          let idx = 0;
          while (idx < queue.length && queue[idx] < m) idx++;
          queue.splice(idx, 0, m);
        }
      }
    }
    if (result.length !== this.nodes.size) {
      // Defensive — detectCycles should have caught this.
      throw new CycleError(['<unknown>']);
    }
    return result;
  }
}

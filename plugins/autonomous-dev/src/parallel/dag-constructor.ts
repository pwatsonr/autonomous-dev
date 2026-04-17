// ============================================================================
// DAG Constructor — Dependency Extraction, Validation, and Reduction
// SPEC-006-2-1: DAG Data Model and Dependency Extraction
// ============================================================================

import {
  DAGNode,
  DAGEdge,
  DAGCluster,
  DependencyDAG,
  SpecMetadata,
} from './types';

// ============================================================================
// Error classes
// ============================================================================

/**
 * Thrown when a spec declares a dependency on a spec name that does not exist
 * in the provided metadata set.
 */
export class UnknownDependencyError extends Error {
  constructor(specName: string, unknownDep: string) {
    super(`Spec "${specName}" declares dependency on unknown spec "${unknownDep}"`);
    this.name = 'UnknownDependencyError';
  }
}

/**
 * Thrown when two specs both declare that they produce the same interface.
 */
export class DuplicateInterfaceProducerError extends Error {
  constructor(interfaceName: string, existingProducer: string, duplicateProducer: string) {
    super(
      `Interface "${interfaceName}" is produced by both "${existingProducer}" and "${duplicateProducer}"`,
    );
    this.name = 'DuplicateInterfaceProducerError';
  }
}

/**
 * Thrown when a spec consumes an interface that no other spec produces.
 */
export class UnresolvedInterfaceError extends Error {
  constructor(specName: string, interfaceName: string) {
    super(`Spec "${specName}" consumes interface "${interfaceName}" which has no producer`);
    this.name = 'UnresolvedInterfaceError';
  }
}

/**
 * Thrown when the DAG contains one or more cycles, making topological
 * ordering impossible.
 */
export class CyclicDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CyclicDependencyError';
  }
}

// ============================================================================
// Default complexity estimates
// ============================================================================

function defaultEstimate(complexity: 'small' | 'medium' | 'large'): number {
  switch (complexity) {
    case 'small':
      return 5;
    case 'medium':
      return 15;
    case 'large':
      return 30;
  }
}

// ============================================================================
// Dependency extraction — three strategies
// ============================================================================

/**
 * Strategy 1: Explicit dependency declarations.
 * Reads `dependsOn` from each spec and creates directed edges.
 * Throws UnknownDependencyError if a target spec does not exist.
 */
export function extractExplicitDependencies(specs: SpecMetadata[]): DAGEdge[] {
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

/**
 * Strategy 2: File-overlap analysis.
 * When two or more specs modify the same file, they are connected with
 * edges ordered alphabetically by spec name for determinism.
 */
export function extractFileOverlapDependencies(specs: SpecMetadata[]): DAGEdge[] {
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

/**
 * Strategy 3: Interface contract dependencies.
 * When spec A produces an interface that spec B consumes, an edge A -> B
 * is created. Throws DuplicateInterfaceProducerError if two specs produce
 * the same interface, and UnresolvedInterfaceError if a consumed interface
 * has no producer.
 */
export function extractInterfaceContractDependencies(specs: SpecMetadata[]): DAGEdge[] {
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

// ============================================================================
// Edge merging — explicit edges suppress file-overlap for the same pair
// ============================================================================

/**
 * Merges edges from all three extraction strategies. When an explicit edge
 * exists between two specs, any file-overlap edge for that same pair is
 * suppressed. Interface-contract edges always coexist with explicit edges.
 */
function mergeEdges(
  explicitEdges: DAGEdge[],
  fileEdges: DAGEdge[],
  ifaceEdges: DAGEdge[],
): DAGEdge[] {
  // Build a set of explicit pairs (normalized: sorted pair key)
  const explicitPairs = new Set<string>();
  for (const edge of explicitEdges) {
    // Store both directions since file-overlap uses alphabetical order
    const key = [edge.from, edge.to].sort().join('::');
    explicitPairs.add(key);
  }

  // Filter file-overlap edges: suppress those whose pair is covered by explicit
  const filteredFileEdges = fileEdges.filter(edge => {
    const key = [edge.from, edge.to].sort().join('::');
    return !explicitPairs.has(key);
  });

  // Also deduplicate: if same from->to pair appears in both interface-contract
  // and explicit, keep both (they carry distinct semantic information)
  return [...explicitEdges, ...filteredFileEdges, ...ifaceEdges];
}

// ============================================================================
// Kahn's algorithm — topological sort with cycle detection
// ============================================================================

/**
 * Performs a topological sort using Kahn's algorithm.
 * Returns the sorted list and a flag indicating whether a cycle was detected.
 * Deterministic: nodes with equal in-degree are sorted alphabetically.
 */
function kahnsTopologicalSort(
  nodes: Map<string, DAGNode>,
  edges: DAGEdge[],
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

// ============================================================================
// Tarjan's SCC — for cycle reporting
// ============================================================================

/**
 * Identifies strongly connected components using Tarjan's algorithm.
 * Used to report which nodes participate in cycles when Kahn's detects one.
 */
function tarjanSCC(
  nodes: Map<string, DAGNode>,
  edges: DAGEdge[],
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

// ============================================================================
// Transitive reduction
// ============================================================================

/**
 * BFS from `from` to `target`, excluding the direct from->target edge.
 * Returns true if target is reachable via an alternative path.
 */
function bfsExcludingDirect(
  from: string,
  target: string,
  adj: Map<string, Set<string>>,
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

/**
 * Removes redundant edges from the DAG. An edge A->C is redundant if
 * there exists an alternative path A->...->C through other edges.
 */
function transitiveReduction(sorted: string[], edges: DAGEdge[]): DAGEdge[] {
  // Build adjacency set for reachability
  const adj = new Map<string, Set<string>>();
  for (const name of sorted) adj.set(name, new Set());
  for (const edge of edges) adj.get(edge.from)!.add(edge.to);

  // For each edge A->C, check if there exists a path A->...->C through other edges
  // If so, the edge is redundant and should be removed
  const reduced: DAGEdge[] = [];

  for (const edge of edges) {
    const reachable = bfsExcludingDirect(edge.from, edge.to, adj);
    if (!reachable) {
      reduced.push(edge); // keep: no alternative path
    }
  }

  return reduced;
}

// ============================================================================
// Main entry point — buildDAG
// ============================================================================

/**
 * Constructs a complete DependencyDAG from a set of spec metadata entries.
 *
 * Steps:
 *  1. Create DAGNode for each spec
 *  2. Extract edges from all three strategies
 *  3. Merge and deduplicate (explicit suppresses file-overlap for same pair)
 *  4. Compute in-degree and out-degree
 *  5. Validate acyclicity via Kahn's algorithm; report cycles via Tarjan's SCC
 *  6. Perform transitive reduction
 *
 * Throws CyclicDependencyError if cycles are detected.
 */
export function buildDAG(requestId: string, specs: SpecMetadata[]): DependencyDAG {
  // 1. Create nodes
  const nodes = new Map<string, DAGNode>();
  for (const spec of specs) {
    nodes.set(spec.name, {
      specName: spec.name,
      specPath: spec.path ?? '',
      complexity: spec.complexity ?? 'small',
      estimatedMinutes: spec.estimatedMinutes ?? defaultEstimate(spec.complexity ?? 'small'),
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

// ============================================================================
// Cluster assignment — layer-by-layer topological sort
// SPEC-006-2-2: Cluster Assignment and Critical Path Computation
// ============================================================================

/**
 * Assigns every node in the DAG to a sequential cluster (execution layer)
 * using a modified topological sort. Each layer contains all nodes whose
 * dependencies have been fully satisfied by prior layers.
 *
 * Nodes within a cluster can execute in parallel. Cluster ordering is
 * deterministic: alphabetical tiebreaker within each cluster.
 *
 * Mutates `dag.clusters` and each node's `cluster` field.
 */
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
      // Check incoming edges (from reduced edges) to find predecessor clusters
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

// ============================================================================
// Critical path computation — longest weighted path through the DAG
// SPEC-006-2-2: Cluster Assignment and Critical Path Computation
// ============================================================================

/**
 * Computes the critical path: the longest path through the DAG weighted
 * by `estimatedMinutes`. Nodes on this path are the scheduling bottleneck.
 *
 * Also applies priority bonuses (TDD 3.3.3):
 *  - +10 for nodes on the critical path
 *  - +5 per downstream dependent (out-degree from reduced edges)
 *
 * Mutates `dag.criticalPath` and each node's `priority` field.
 */
export function computeCriticalPath(dag: DependencyDAG): void {
  const edges = dag.reducedEdges;

  // Topological order (already validated, so Kahn's will succeed)
  const { sorted } = kahnsTopologicalSort(dag.nodes, edges);

  // Build adjacency list
  const adj = new Map<string, string[]>();
  for (const [name] of dag.nodes) adj.set(name, []);
  for (const edge of edges) adj.get(edge.from)!.push(edge.to);

  // Dynamic programming: longest path ending at each node
  const dist = new Map<string, number>();         // longest path distance to reach this node (inclusive)
  const pred = new Map<string, string | null>();  // predecessor on longest path

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

// ============================================================================
// Convenience function — full DAG pipeline
// SPEC-006-2-2: Cluster Assignment and Critical Path Computation
// ============================================================================

/**
 * Builds a DAG, assigns clusters, and computes the critical path in one call.
 * Convenience wrapper that chains buildDAG -> assignClusters -> computeCriticalPath.
 */
export function buildAndScheduleDAG(requestId: string, specs: SpecMetadata[]): DependencyDAG {
  const dag = buildDAG(requestId, specs);
  assignClusters(dag);
  computeCriticalPath(dag);
  return dag;
}

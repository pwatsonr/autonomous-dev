/**
 * CycleError — thrown by `DependencyGraph.topologicalSort` when the graph
 * contains a cycle (SPEC-022-1-03, Task 6).
 *
 * `cyclePath` is the ordered list of plugin IDs forming the cycle, with the
 * first node REPEATED at the end so callers can render `A -> B -> C -> A`.
 *
 * @module intake/chains/cycle-error
 */

export class CycleError extends Error {
  public readonly cyclePath: readonly string[];
  constructor(cyclePath: readonly string[]) {
    super(`dependency cycle detected: ${cyclePath.join(' -> ')}`);
    this.name = 'CycleError';
    // Defensive copy + freeze so callers cannot mutate the path through
    // a leaked reference.
    this.cyclePath = Object.freeze([...cyclePath]);
  }
}

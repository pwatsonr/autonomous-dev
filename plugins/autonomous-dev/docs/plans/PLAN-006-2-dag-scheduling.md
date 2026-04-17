# PLAN-006-2: DAG Construction and Scheduling

## Metadata
- **Parent TDD**: TDD-006-parallel-execution
- **Estimated effort**: 5 days
- **Dependencies**: [PLAN-006-1-worktree-management]
- **Blocked by**: [PLAN-006-1-worktree-management] (needs WorktreeManager for slot availability and disk pressure queries)
- **Priority**: P0

## Objective

Implement the dependency DAG construction, validation, cluster assignment, and resource-aware scheduling system. This is the "brain" of the parallel execution engine -- it analyzes inter-spec dependencies, determines which tracks can execute concurrently, and dispatches work in the correct order while respecting system resource constraints.

## Scope

### In Scope
- DAG data model: `DependencyDAG`, `DAGNode`, `DAGEdge`, `DAGCluster` interfaces (TDD 3.2.2)
- Dependency extraction from three sources: explicit declarations, file-overlap analysis, interface contracts (TDD 3.2.1)
- Cycle detection via Kahn's algorithm with Tarjan's SCC for error reporting (TDD 3.2.3)
- Transitive reduction of redundant edges (TDD 3.2.3)
- Cluster assignment algorithm using modified topological sort (TDD 3.2.4)
- Critical path computation for priority scheduling (TDD 3.3.3)
- Mixed-mode scheduler: sequential clusters, parallel tracks within clusters (TDD 3.3.1)
- Resource-aware scheduling: disk pressure throttling, slot management, worktree count limits (TDD 3.3.2)
- Priority-based dispatch ordering within clusters (TDD 3.3.3)
- Scheduler coordination with WorktreeManager for slot queries

### Out of Scope
- Agent spawning and execution (PLAN-006-3)
- Merge-back operations after cluster completion (PLAN-006-4)
- Runtime dependency discovery during execution (TQ-3, deferred)
- Database migration sequencing (Phase 2 feature, TDD Section 10)

## Tasks

1. **Define DAG data model types** -- Create all TypeScript interfaces for the dependency graph representation.
   - Files to create/modify:
     - `src/parallel/types.ts` (modify -- add DAG types)
   - Acceptance criteria:
     - `DependencyDAG`, `DAGNode`, `DAGEdge`, `DAGCluster` interfaces match TDD 3.2.2
     - Nodes include `specName`, `specPath`, `complexity`, `estimatedMinutes`, `priority`, `inDegree`, `outDegree`, `cluster`
     - Edges include `from`, `to`, `type` (explicit/file-overlap/interface-contract), `reason`
     - DAG includes `requestId`, `nodes` (Map), `edges`, `clusters`, `criticalPath`, `validated`
   - Estimated effort: 2 hours

2. **Implement dependency extraction from specs** -- Parse spec documents to extract dependency information from all three sources.
   - Files to create/modify:
     - `src/parallel/dag-constructor.ts` (new)
   - Acceptance criteria:
     - `extractExplicitDependencies(specs)` reads `depends_on` metadata from each spec
     - `extractFileOverlapDependencies(specs)` compares declared file modification lists across specs and flags overlaps
     - `extractInterfaceContractDependencies(specs)` matches producer/consumer interface declarations
     - Priority order enforced: explicit declarations override heuristic analysis (TDD 3.2.1)
     - Returns a unified list of `DAGEdge` objects with type and reason annotations
   - Estimated effort: 5 hours

3. **Implement DAG construction and validation** -- Build the full DAG from extracted dependencies, then validate with cycle detection and transitive reduction.
   - Files to create/modify:
     - `src/parallel/dag-constructor.ts` (modify)
   - Acceptance criteria:
     - `buildDAG(requestId, specs)` constructs the complete `DependencyDAG`
     - Cycle detection via Kahn's algorithm: if topological sort does not visit all nodes, a cycle exists
     - Cycle reporting via Tarjan's algorithm: extracts the strongly connected component and produces human-readable error message (e.g., `Cycle detected: track-a -> track-b -> track-a`)
     - Transitive reduction removes redundant edges (A->C removed if A->B->C exists)
     - Original edges preserved in logs for auditability; reduced DAG used for scheduling
     - Orphan detection: nodes with no edges are valid but logged
     - Sets `dag.validated = true` on success
   - Estimated effort: 6 hours

4. **Implement cluster assignment algorithm** -- Assign DAG nodes to parallel execution clusters using modified topological sort.
   - Files to create/modify:
     - `src/parallel/dag-constructor.ts` (modify -- add cluster assignment)
   - Acceptance criteria:
     - Implements the `AssignClusters(dag)` algorithm from TDD 3.2.4
     - Iteratively collects nodes with in-degree 0, assigns to current cluster, decrements downstream in-degrees
     - Every node appears in exactly one cluster
     - Cluster ordering is deterministic for the same input
     - Works for edge cases: single node, fully connected chain, wide fan-out (all independent), diamond dependencies
   - Estimated effort: 3 hours

5. **Implement critical path computation** -- Calculate the longest path through the DAG for priority-based scheduling.
   - Files to create/modify:
     - `src/parallel/dag-constructor.ts` (modify -- add critical path)
   - Acceptance criteria:
     - `computeCriticalPath(dag)` finds the longest path using node `estimatedMinutes` as weights
     - Sets `dag.criticalPath` to the ordered list of spec names on the critical path
     - Nodes on the critical path receive +10 priority bonus (TDD 3.3.3)
     - Nodes with higher out-degree receive +5 priority per downstream dependent
   - Estimated effort: 3 hours

6. **Implement the Scheduler** -- Build the mixed-mode scheduler that processes clusters sequentially and dispatches tracks in parallel within each cluster.
   - Files to create/modify:
     - `src/parallel/scheduler.ts` (new)
   - Acceptance criteria:
     - `createExecutionPlan(dag, config)` produces an ordered plan of cluster executions
     - Within each cluster, tracks are sorted by priority (descending)
     - Slot calculation: `min(max_tracks, max_worktrees - active_count, cluster_size)`
     - Dispatches up to `available_slots` tracks simultaneously
     - When a track completes, recalculates available slots and dispatches next queued track
     - Cluster completes only when all its tracks finish
     - Scheduler emits callbacks for track dispatch and cluster completion (consumed by the engine orchestrator)
   - Estimated effort: 6 hours

7. **Implement resource-aware scheduling** -- Add disk pressure and resource monitoring to the scheduler dispatch logic.
   - Files to create/modify:
     - `src/parallel/scheduler.ts` (modify)
     - `src/parallel/resource-monitor.ts` (new)
   - Acceptance criteria:
     - ResourceMonitor queries WorktreeManager's `getDiskPressureLevel()` and `checkDiskUsage()`
     - When disk usage > 80% of hard limit: throttle to 1 concurrent track (TDD 3.3.2)
     - When disk usage > 100% of hard limit: block new worktrees entirely
     - When available disk < 1 GB: block and emit critical alert
     - Resource checks before each worktree creation, every 60 seconds during execution, and after each track completion
     - Checks worktree count against `max_worktrees` before dispatch
   - Estimated effort: 4 hours

8. **Unit tests for DAG construction** -- Test all DAG operations with comprehensive edge cases.
   - Files to create/modify:
     - `tests/parallel/dag-constructor.test.ts` (new)
   - Acceptance criteria:
     - Tests the 3-track worked example from TDD 2.3 (A->B dependency, C independent)
     - Tests cycle detection with 2-node and 3-node cycles
     - Tests transitive reduction (A->B->C with redundant A->C)
     - Tests single-node DAG, fully independent nodes, long chain, diamond pattern
     - Tests mixed dependency sources (explicit + file-overlap)
     - Tests explicit override of heuristic dependency
     - Property: for any valid input, produced DAG has no cycles
     - Property: every node appears in exactly one cluster
   - Estimated effort: 5 hours

9. **Unit tests for Scheduler** -- Test scheduling logic including resource-aware throttling.
   - Files to create/modify:
     - `tests/parallel/scheduler.test.ts` (new)
   - Acceptance criteria:
     - Tests basic dispatch: 3 independent tracks with max_tracks=3 all start simultaneously
     - Tests cluster sequencing: cluster 1 only starts after cluster 0 completes
     - Tests throttling: disk pressure reduces concurrent slots
     - Tests priority ordering: critical path nodes dispatch first
     - Tests slot recalculation after track completion
     - Tests edge case: cluster with more nodes than available slots queues excess
   - Estimated effort: 4 hours

## Dependencies & Integration Points

- **Upstream**: PLAN-006-1 provides `WorktreeManager.getDiskPressureLevel()`, `WorktreeManager.listWorktrees()`, and configuration types.
- **Downstream**: PLAN-006-3 (Agent Assignment) consumes the scheduler's dispatch callbacks to spawn agents.
- **Downstream**: PLAN-006-4 (Merge/Conflicts) is triggered by the scheduler's cluster completion callback.
- **Integration**: The Scheduler orchestrates the fan-out/merge-back loop -- it calls WorktreeManager (PLAN-006-1) to create worktrees, emits dispatch events for AgentSpawner (PLAN-006-3), and triggers MergeEngine (PLAN-006-4) at cluster boundaries.
- **Input**: Spec documents from the Decomposition Engine (PRD-003) are the primary input to the DAG Constructor.

## Testing Strategy

- **Unit tests**: DAG construction from mock spec metadata. Cluster assignment correctness. Critical path calculation. Scheduler dispatch order.
- **Property-based tests**: DAG validity (no cycles in output), cluster completeness (every node in exactly one cluster), deterministic output for same input.
- **Integration tests**: Full flow from specs through DAG to execution plan, verified against the TDD worked example.
- **Stress tests**: DAGs with 10+, 20+, 50+ nodes to verify algorithm performance and correctness at scale.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Heuristic file-overlap dependencies produce false positives | Medium | Medium -- unnecessary serialization reduces parallelism | Allow explicit `no_dependency` override; log all heuristic edges for review |
| Complex DAGs with many clusters reduce parallelism benefit | Low | Medium | Critical path analysis highlights bottlenecks; surface in progress reporting |
| Resource monitor polling interval (60s) too coarse for fast-filling disks | Low | Medium | Add reactive check on worktree creation; allow configurable interval |
| Spec format varies across decomposition engines | Medium | High | Define strict spec metadata schema; fail fast with clear error on missing fields |

## Definition of Done

- [ ] DAG Constructor parses specs, extracts dependencies from all three sources, builds validated DAG
- [ ] Cycle detection identifies and reports cycles with human-readable SCC output
- [ ] Transitive reduction removes redundant edges while preserving audit log
- [ ] Cluster assignment groups nodes correctly per modified topological sort
- [ ] Critical path computed with priority bonuses applied
- [ ] Scheduler dispatches tracks in correct order respecting cluster boundaries and concurrency limits
- [ ] Resource-aware throttling reduces parallelism under disk pressure
- [ ] TDD worked example (3-track, A->B dependency) produces expected clusters and schedule
- [ ] All unit and property-based tests pass
- [ ] Scheduler integrates with WorktreeManager for slot availability queries

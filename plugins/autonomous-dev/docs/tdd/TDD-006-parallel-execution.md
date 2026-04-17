# TDD-006: Parallel Execution Engine

| Field          | Value                                                        |
|----------------|--------------------------------------------------------------|
| **Title**      | Parallel Execution Engine                                    |
| **Version**    | 0.1.0                                                        |
| **Date**       | 2026-04-08                                                   |
| **Author**     | Staff Engineer                                               |
| **Status**     | Draft                                                        |
| **Plugin**     | autonomous-dev                                               |
| **Parent PRD** | PRD-004 (Parallel Execution Engine)                          |
| **Depends**    | PRD-001 (System Core), PRD-002 (Document Pipeline), PRD-003 (Agent Factory) |

---

## 1. Overview

This Technical Design Document describes the internal architecture and implementation of the Parallel Execution Engine for the `autonomous-dev` Claude Code plugin. The engine is responsible for taking a set of implementation specs -- produced by the Decomposition Engine (PRD-003) -- and executing them concurrently across isolated git worktrees on a single host, then merging results back into a coherent integration branch.

The core operating model is **fan-out / merge-back**:

1. The Decomposition Engine produces N specs from a plan.
2. The Parallel Execution Engine analyzes inter-spec dependencies and builds a DAG.
3. Independent specs fan out to isolated worktrees with dedicated agents.
4. As agents complete, the engine merges tracks back in DAG-topological order.
5. Integration tests validate the combined result.
6. The integration branch is ready for PR to main.

This document covers: worktree lifecycle management, dependency DAG construction and scheduling, agent-to-worktree assignment with isolation, merge-back strategy with conflict resolution, cross-track coordination, progress tracking, and crash recovery.

---

## 2. Architecture

### 2.1 High-Level Component Diagram

```
+-------------------------------------------------------------------+
|                     Parallel Execution Engine                      |
|                                                                    |
|  +------------------+    +------------------+    +--------------+  |
|  | DAG Constructor  |    |    Scheduler     |    |   Resource   |  |
|  |                  |--->|                  |<---| Monitor      |  |
|  | - parse specs    |    | - cluster/chain  |    | - disk usage |  |
|  | - detect deps    |    | - slot mgmt      |    | - concurrency|  |
|  | - validate       |    | - priority queue  |    | - thresholds |  |
|  +------------------+    +--------+---------+    +--------------+  |
|                                   |                                |
|                    +--------------+--------------+                 |
|                    |                             |                 |
|           +--------v---------+         +--------v---------+       |
|           | Worktree Manager |         |   Agent Spawner  |       |
|           |                  |         |                   |       |
|           | - create         |         | - assign spec     |       |
|           | - monitor        |         | - enforce budget  |       |
|           | - cleanup        |         | - retry policy    |       |
|           +------------------+         +-------------------+       |
|                                                                    |
|           +------------------+         +-------------------+       |
|           | Merge Engine     |         | Progress Tracker  |       |
|           |                  |         |                   |       |
|           | - DAG-order merge|         | - state machine   |       |
|           | - conflict class |         | - stall detection |       |
|           | - AI resolution  |         | - ETA calculation |       |
|           | - integration    |         | - event emission  |       |
|           +------------------+         +-------------------+       |
|                                                                    |
|           +------------------+                                     |
|           | State Persister  |                                     |
|           |                  |                                     |
|           | - crash recovery |                                     |
|           | - idempotent     |                                     |
|           |   resume         |                                     |
|           +------------------+                                     |
+-------------------------------------------------------------------+
```

### 2.2 Fan-Out / Merge-Back Flow

```
         main
           |
           v
    integration branch  (auto/req-abc123/integration)
           |
     +-----+-----+-----+         <-- Fan-Out: worktree per track
     |           |       |
   Track A    Track B  Track C    <-- Parallel agent execution
     |           |       |
     +-----+-----+-----+         <-- Merge-Back: DAG-ordered
           |
    integration branch            <-- Combined result
           |
     test suite run
           |
      PR -> main
```

### 2.3 Worked Example: 3-Track Execution with One Dependency

**Scenario:** A request decomposes into three specs:
- **Spec A** (`auth-service`): Build authentication middleware. No dependencies.
- **Spec B** (`user-api`): Build user API endpoints. Depends on Spec A (uses auth middleware).
- **Spec C** (`email-worker`): Build email notification worker. No dependencies.

**DAG:**
```
   A -------> B
   C          (independent)
```

**Parallel Clusters:**
- Cluster 0: {A, C} -- both have zero inbound edges, execute in parallel.
- Cluster 1: {B} -- depends on A, executes after Cluster 0 completes.

**Execution Timeline:**

```
Time ------>

t0: Create integration branch from main
    Create worktree for Track A (auto/req-abc123/track-auth-service)
    Create worktree for Track C (auto/req-abc123/track-email-worker)
    Spawn Agent-A in worktree-A
    Spawn Agent-C in worktree-C

t1: Agent-A executing... Agent-C executing...
    (parallel)

t2: Agent-C completes (testing + reviewing done)
    Agent-A still executing...

t3: Agent-A completes
    --- Cluster 0 complete ---

t4: Merge Track-A into integration (DAG order: A before C since B depends on A)
    Merge Track-C into integration
    Cleanup worktree-A, worktree-C

t5: Create worktree for Track B (auto/req-abc123/track-user-api)
    Branch from integration (now includes A's and C's changes)
    Spawn Agent-B in worktree-B

t6: Agent-B executes (has access to auth middleware from Track A)

t7: Agent-B completes
    Merge Track-B into integration
    Cleanup worktree-B

t8: Run full test suite on integration branch

t9: Tests pass -> Create PR: integration -> main
```

**Wall-clock savings:** Sequential would take t(A) + t(B) + t(C). Parallel takes max(t(A), t(C)) + t(B). If A, B, and C each take 10 minutes, sequential = 30 min, parallel = 20 min (33% reduction). Since B depends on A and cannot be parallelized, the theoretical maximum savings for this DAG is bounded by the critical path A -> B.

---

## 3. Detailed Design

### 3.1 Worktree Lifecycle Management

#### 3.1.1 Directory Layout

All worktrees live under `.worktrees/` at the repository root. This directory is added to `.gitignore` to prevent accidental commits. Each request gets its own subdirectory, and each track within that request gets its own worktree.

```
repo-root/
  .gitignore                           # includes .worktrees/
  .worktrees/
    req-abc123/
      track-auth-service/              # full checkout, linked worktree
        .git                           # symlink to main repo's git dir
        src/
        tests/
        package.json
        ...
      track-email-worker/
        .git
        src/
        tests/
        ...
    req-def456/
      track-dashboard-ui/
        ...
  .autonomous-dev/
    state/
      req-abc123.json                  # persisted execution state
      req-def456.json
    logs/
      req-abc123/
        track-auth-service.log         # agent execution log
        track-email-worker.log
        merge.log                      # merge-back log
    conflicts/
      req-abc123/
        conflict-001.json              # conflict resolution record
```

**Naming conventions:**
- Request directory: `req-{request-id}` where `request-id` is a short hash or user-supplied identifier.
- Track directory: `track-{track-name}` where `track-name` is a slugified version of the spec name (lowercase, hyphens, alphanumeric only).
- Both names are validated against the regex `^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$` to prevent filesystem issues.

#### 3.1.2 Branch Naming Strategy

All branches created by the engine follow the `auto/` prefix convention:

| Branch | Pattern | Example |
|--------|---------|---------|
| Integration branch | `auto/{request-id}/integration` | `auto/req-abc123/integration` |
| Track branch | `auto/{request-id}/{track-name}` | `auto/req-abc123/track-auth-service` |

The `auto/` prefix serves three purposes:
1. **Identification:** Any branch under `auto/` is engine-managed and can be cleaned up automatically.
2. **Collision avoidance:** Human developers are unlikely to create branches starting with `auto/`.
3. **Cleanup:** On startup, the engine can scan for orphaned `auto/` branches from crashed runs.

#### 3.1.3 Worktree Creation

**Preconditions:**
- Current worktree count < `parallel.max_worktrees`.
- Aggregate disk usage < `parallel.disk_hard_limit`.
- The integration branch exists (or is being created as part of this operation).

**Git command sequence for creating the integration branch and first worktree:**

```bash
# 1. Create integration branch from main (or configured base branch)
git branch auto/req-abc123/integration main

# 2. Create track branch from integration
git branch auto/req-abc123/track-auth-service auto/req-abc123/integration

# 3. Create worktree directory
mkdir -p .worktrees/req-abc123

# 4. Add worktree for the track branch
git worktree add .worktrees/req-abc123/track-auth-service auto/req-abc123/track-auth-service

# 5. Verify worktree is healthy
git -C .worktrees/req-abc123/track-auth-service status --porcelain
# Expected: empty output (clean worktree)
```

**For subsequent tracks in the same request:**

```bash
# Track branch already created from integration
git branch auto/req-abc123/track-email-worker auto/req-abc123/integration
git worktree add .worktrees/req-abc123/track-email-worker auto/req-abc123/track-email-worker
```

**For tracks in Cluster 1+ (after earlier clusters merged):**

```bash
# Integration branch now contains merged changes from Cluster 0
# Create Track B's branch from the updated integration
git branch auto/req-abc123/track-user-api auto/req-abc123/integration
git worktree add .worktrees/req-abc123/track-user-api auto/req-abc123/track-user-api
```

#### 3.1.4 Worktree Monitoring

The engine monitors each active worktree for:

| Check | Method | Frequency |
|-------|--------|-----------|
| Disk usage | `du -sb .worktrees/req-*/track-*` | Every 60 seconds |
| Git health | `git -C <path> status --porcelain` | Before and after agent execution |
| Worktree link validity | `git worktree list --porcelain` | On engine startup and every 5 minutes |
| Agent liveness | Check agent process/session status | Every 30 seconds |

If aggregate disk usage exceeds `parallel.disk_warning_threshold` (default 2 GB), a warning event is emitted. If it exceeds `parallel.disk_hard_limit` (default 5 GB), new worktree creation is blocked until usage drops.

#### 3.1.5 Worktree Cleanup

**Normal cleanup (after successful merge):**

```bash
# 1. Wait configurable delay for inspection (default: 300 seconds)
# 2. Remove worktree
git worktree remove .worktrees/req-abc123/track-auth-service

# 3. Delete the track branch (no longer needed)
git branch -D auto/req-abc123/track-auth-service

# 4. If all tracks for this request are done, remove the request directory
rmdir .worktrees/req-abc123 2>/dev/null  # only succeeds if empty
```

**Force cleanup (cancellation or crash recovery):**

```bash
# 1. Force-remove worktree even if dirty
git worktree remove --force .worktrees/req-abc123/track-auth-service

# 2. If that fails (corrupt state), manually clean up
rm -rf .worktrees/req-abc123/track-auth-service
git worktree prune

# 3. Delete the track branch
git branch -D auto/req-abc123/track-auth-service
```

**Full request cleanup (after integration PR merged or request cancelled):**

```bash
# 1. Remove all worktrees for the request
for wt in .worktrees/req-abc123/track-*; do
  git worktree remove --force "$wt" 2>/dev/null
done

# 2. Prune any dangling worktree references
git worktree prune

# 3. Remove request directory
rm -rf .worktrees/req-abc123

# 4. Delete all branches for this request
git branch --list 'auto/req-abc123/*' | xargs -r git branch -D

# 5. Archive state file (move from active to archive)
mv .autonomous-dev/state/req-abc123.json .autonomous-dev/archive/req-abc123.json
```

---

### 3.2 Dependency DAG Construction

#### 3.2.1 Dependency Sources

The DAG is constructed by analyzing the specs produced by the Decomposition Engine. Dependencies are identified from three sources:

1. **Explicit declarations:** Each spec may declare `depends_on: [spec-name, ...]` in its metadata.
2. **File-overlap analysis:** If Spec A and Spec B both declare they will modify the same file, and one produces output the other consumes, the engine infers a dependency. This is a heuristic -- overlapping files do not always imply a dependency, but they flag potential ordering needs.
3. **Interface contracts:** If Spec A declares it will export an interface (API, type, function) and Spec B declares it will import that interface, a dependency edge is inferred from A to B.

Priority order: explicit declarations override heuristic analysis. If Spec A explicitly declares no dependency on Spec B, no edge is created even if file overlap is detected (the merge engine will handle conflicts).

#### 3.2.2 DAG Representation

The DAG is stored as an adjacency list with per-node metadata:

```typescript
interface DependencyDAG {
  requestId: string;
  nodes: Map<string, DAGNode>;
  edges: DAGEdge[];
  clusters: DAGCluster[];        // computed after construction
  criticalPath: string[];         // computed after construction
  validated: boolean;
}

interface DAGNode {
  specName: string;               // e.g., "track-auth-service"
  specPath: string;               // path to spec file
  complexity: "small" | "medium" | "large";
  estimatedMinutes: number;       // from complexity heuristic
  priority: number;               // higher = schedule first in ties
  inDegree: number;               // computed: number of inbound edges
  outDegree: number;              // computed: number of outbound edges
  cluster: number;                // assigned parallel cluster index
}

interface DAGEdge {
  from: string;                   // spec name (upstream)
  to: string;                     // spec name (downstream)
  type: "explicit" | "file-overlap" | "interface-contract";
  reason: string;                 // human-readable explanation
}

interface DAGCluster {
  index: number;                  // 0, 1, 2, ... (execution order)
  nodes: string[];                // spec names in this cluster
  maxParallelism: number;         // how many can run simultaneously
}
```

#### 3.2.3 Cycle Detection and Validation

Before execution, the DAG is validated:

1. **Cycle detection:** Run Kahn's algorithm (topological sort via BFS). If the sort does not visit all nodes, a cycle exists. The engine reports the cycle by extracting the strongly connected component using Tarjan's algorithm, producing an error like: `Cycle detected: track-auth-service -> track-user-api -> track-auth-service. Cannot proceed.`

2. **Orphan detection:** Nodes with no edges at all are valid (fully independent) but logged as a note -- they can be scheduled in any cluster.

3. **Transitive reduction:** Redundant edges are removed. If A -> B -> C and A -> C, the direct A -> C edge is redundant and removed to simplify scheduling. The engine retains the original edges in the log for auditability but uses the reduced DAG for scheduling.

#### 3.2.4 Cluster Assignment Algorithm

After validation, nodes are assigned to parallel clusters using a modified topological sort:

```
Algorithm: AssignClusters(dag)
  Input: validated DAG with nodes and edges
  Output: dag.clusters populated

  1. Compute in-degree for each node.
  2. Initialize cluster_index = 0.
  3. While unassigned nodes remain:
     a. Collect all nodes with in-degree == 0 and not yet assigned.
     b. Create cluster[cluster_index] with these nodes.
     c. For each node in the cluster:
        - Mark as assigned.
        - For each outgoing edge (node -> downstream):
          - Decrement downstream.in_degree by 1.
     d. cluster_index++
  4. Return clusters.
```

**Example with our 3-track scenario:**

```
Initial in-degrees: A=0, B=1, C=0

Cluster 0: {A, C}  (both have in-degree 0)
  After removing A's edges: B.in_degree = 0
  After removing C's edges: (none)

Cluster 1: {B}     (in-degree now 0)

Result:
  Cluster 0: [track-auth-service, track-email-worker]  -- parallel
  Cluster 1: [track-user-api]                           -- after cluster 0
```

---

### 3.3 Scheduling Algorithm

#### 3.3.1 Mixed-Mode Scheduling

The scheduler processes clusters sequentially, but within each cluster, tracks execute in parallel up to the configured concurrency limit. This is the "parallel clusters + sequential chains" model described in FR-013.

```
Algorithm: Schedule(dag, config)
  Input: dag with clusters, config with max_tracks and max_worktrees
  Output: execution plan

  For each cluster in dag.clusters (in order):
    available_slots = min(
      config.parallel.max_tracks,
      config.parallel.max_worktrees - active_worktree_count,
      cluster.nodes.length
    )

    # Resource-aware reduction
    if disk_usage > 0.8 * config.parallel.disk_hard_limit:
      available_slots = min(available_slots, 1)  # throttle to 1
    elif disk_usage > 0.6 * config.parallel.disk_hard_limit:
      available_slots = max(1, available_slots - 1)  # reduce by 1

    # Sort by priority within the cluster (higher priority first)
    sorted_nodes = cluster.nodes.sort_by(node.priority, descending)

    # Dispatch up to available_slots in parallel
    # Remaining nodes queue and execute as slots free up
    ready_queue = sorted_nodes
    while ready_queue is not empty:
      batch = ready_queue.take(available_slots)
      for each node in batch:
        create_worktree(node)
        spawn_agent(node)
      wait_for_any_agent_completion()
      available_slots = recalculate_slots()

    # All tracks in this cluster complete
    # Merge-back (Section 3.5)
    merge_cluster(cluster)

    # Next cluster can now begin
```

#### 3.3.2 Resource-Aware Scheduling

The scheduler checks system resources before dispatching each track:

| Resource | Check | Threshold | Action |
|----------|-------|-----------|--------|
| Disk usage | `du -sb .worktrees/` | > 80% of `disk_hard_limit` | Throttle to 1 concurrent track |
| Disk usage | (same) | > 100% of `disk_hard_limit` | Block new worktrees entirely |
| Worktree count | Count active worktrees | >= `max_worktrees` | Queue until slot frees |
| Track count | Count executing tracks for this request | >= `max_tracks` | Queue within request |
| Available disk | `df -k <repo-root>` | < 1 GB free | Block and emit critical alert |

Resource checks are performed:
- Before each worktree creation.
- Every 60 seconds during execution.
- After each track completion (to update available capacity).

#### 3.3.3 Priority-Based Scheduling (P2)

When a cluster has more nodes than available slots, priority determines dispatch order:

1. **Critical path priority:** Nodes on the DAG critical path (longest path through the graph) get +10 priority.
2. **Out-degree priority:** Nodes with higher out-degree (more dependents waiting) get +5 per downstream dependent.
3. **Complexity ordering:** Larger specs start first so they do not become tail-latency bottlenecks.
4. **Explicit priority:** Specs can declare a `priority` field that acts as a tiebreaker.

---

### 3.4 Agent-to-Worktree Assignment and Isolation

#### 3.4.1 Assignment Model

The engine maintains a strict 1:1 mapping between agents and worktrees. An agent is a Claude Code session (subagent) spawned with a specific working directory and context.

```typescript
interface TrackAssignment {
  trackName: string;
  worktreePath: string;           // absolute path
  branchName: string;
  agentSessionId: string | null;  // set when agent spawns
  spec: SpecDocument;
  parentPlan: PlanDocument;
  parentTDD: TDDDocument;
  parentPRD: PRDDocument;
  turnBudget: number;
  turnsUsed: number;
  retryCount: number;             // 0 or 1
}
```

#### 3.4.2 Agent Spawning

When a track is scheduled for execution:

1. The engine creates the worktree (Section 3.1.3).
2. The engine prepares the agent context bundle:
   - The spec file for this track.
   - The parent plan, TDD, and PRD for broader context.
   - The configured turn budget based on spec complexity.
   - Any interface contracts this track must satisfy.
   - Any shared type definitions pre-committed to the integration branch.
3. The engine spawns a Claude Code subagent session with:
   - Working directory set to the worktree path.
   - The context bundle injected as the initial prompt.
   - Tool access restricted to filesystem operations within the worktree directory.

**Agent lifecycle within the worktree:**

```
Spawn -> Execute (write code) -> Self-Test (run tests) -> Self-Review (check quality) -> Commit -> Signal Complete
```

The agent is expected to commit its work to the track branch before signaling completion. The commit message should reference the spec and request ID:

```bash
# Agent commits within its worktree
git -C .worktrees/req-abc123/track-auth-service add -A
git -C .worktrees/req-abc123/track-auth-service commit -m "feat(auth): implement authentication middleware

Spec: track-auth-service
Request: req-abc123
Turns used: 42/60"
```

#### 3.4.3 Filesystem Isolation

Isolation is enforced at two levels:

**Level 1: Working directory scoping.** The agent is spawned with its CWD set to the worktree directory. Claude Code's filesystem tools resolve paths relative to CWD. The agent context instructs it that its working directory is the project root.

**Level 2: Path allowlist enforcement.** A hook (PostToolUse on file operations) validates that every file path accessed by the agent resolves to a location within the assigned worktree. Any access outside the worktree is blocked and logged as a security event.

```typescript
// PostToolUse hook for filesystem isolation
function validateFileAccess(toolUse: ToolUse, track: TrackAssignment): boolean {
  const resolvedPath = path.resolve(track.worktreePath, toolUse.params.path);
  if (!resolvedPath.startsWith(track.worktreePath)) {
    emitEvent({
      type: "security.isolation_violation",
      trackName: track.trackName,
      attemptedPath: toolUse.params.path,
      resolvedPath: resolvedPath,
      allowedRoot: track.worktreePath,
    });
    return false;  // block the tool call
  }
  return true;
}
```

**Level 3: Git isolation.** Each worktree has its own HEAD, index, and working tree. Git operations within one worktree do not affect another. The shared object store (default `git worktree` behavior) is acceptable because agents only add objects; they cannot corrupt another worktree's references.

#### 3.4.4 Turn Budget Enforcement

| Complexity | Default Budget | Override Source |
|------------|---------------|----------------|
| Small | 30 turns | `parallel.agent_turn_budget.small` |
| Medium | 60 turns | `parallel.agent_turn_budget.medium` |
| Large | 120 turns | `parallel.agent_turn_budget.large` |

When the turn count reaches 90% of the budget, the agent receives a warning in its context. When the budget is exhausted, the agent is terminated.

#### 3.4.5 Retry Policy

On agent failure (crash, budget exhaustion, test failures the agent cannot fix):

1. **First failure:** The engine retries exactly once with a fresh agent instance in the same worktree. The worktree is reset to the last good commit (or the branch head if no commits were made):
   ```bash
   git -C .worktrees/req-abc123/track-auth-service reset --hard HEAD
   git -C .worktrees/req-abc123/track-auth-service clean -fd
   ```
2. **Second failure:** The track is marked `escalated`. The engine emits an escalation event with the failure logs and continues with other tracks if possible.

---

### 3.5 Merge-Back Strategy

#### 3.5.1 Merge Order

Merge order follows the DAG topological sort. Within a cluster (all nodes at the same topological level), the merge order is:

1. Nodes with outgoing edges (other nodes depend on them) merge first.
2. Among equally-connected nodes, merge in alphabetical order for determinism.

For our worked example:
- Cluster 0: Merge Track-A first (Track-B depends on it), then Track-C.
- Cluster 1: Merge Track-B.

#### 3.5.2 Merge Sequence

For each track, the merge follows this exact git command sequence:

```bash
# 1. Switch to integration branch worktree (or use the main repo checkout)
git checkout auto/req-abc123/integration

# 2. Attempt merge with --no-commit to inspect before finalizing
git merge --no-commit --no-ff auto/req-abc123/track-auth-service

# 3. Check for conflicts
CONFLICT_COUNT=$(git diff --name-only --diff-filter=U | wc -l)

if [ "$CONFLICT_COUNT" -eq 0 ]; then
  # 4a. Clean merge: commit
  git commit -m "merge: integrate track-auth-service

Track: track-auth-service
Request: req-abc123
Conflict count: 0"

else
  # 4b. Conflicts detected: classify and resolve (Section 3.5.3)
  # ... conflict resolution process ...
  # After resolution:
  git add -A
  git commit -m "merge: integrate track-auth-service (conflicts resolved)

Track: track-auth-service
Request: req-abc123
Conflict count: $CONFLICT_COUNT
Resolution: auto|ai|human"
fi

# 5. Verify integration branch is clean
git status --porcelain
# Expected: empty
```

**Critical safety rule:** The engine never runs `git merge` with automatic commit. Every merge uses `--no-commit` so the engine can inspect, validate, and record the merge result before finalizing. If anything goes wrong, `git merge --abort` restores the integration branch to its pre-merge state.

```bash
# Abort if anything goes wrong during conflict resolution
git merge --abort
```

#### 3.5.3 Conflict Classification and Resolution

When `git merge --no-commit` reports conflicts, the engine classifies each conflicting file:

| Conflict Type | Detection | Resolution Strategy | Confidence |
|---------------|-----------|-------------------|------------|
| **Disjoint files** | Tracks modified different files; git auto-merged | Auto-resolve (already merged by git) | 1.0 |
| **Non-overlapping hunks** | Same file, different regions; git reports as conflict due to context overlap | Auto-resolve via `git checkout --theirs` or manual hunk extraction | 0.95 |
| **Overlapping hunks, compatible intent** | Same region, but specs describe complementary changes (e.g., both add imports) | AI-resolve: present both hunks + both specs to conflict resolution agent | 0.70-0.90 |
| **Overlapping hunks, conflicting intent** | Same region, specs describe contradictory changes | Escalate to human with structured conflict report | < 0.70 |
| **Structural conflict** | Both tracks reorganize the same file (move functions, rename modules) | Escalate to human | < 0.50 |

**Auto-resolve flow:**

```bash
# For non-overlapping hunks that git marked as conflict:
# Extract ours and theirs, merge manually
git show :2:<file>  > /tmp/ours.txt    # stage 2 = ours
git show :3:<file>  > /tmp/theirs.txt  # stage 3 = theirs
git show :1:<file>  > /tmp/base.txt    # stage 1 = merge base

# Apply both sets of changes to base (non-overlapping hunks)
# Custom merge tool: autonomous-dev merge resolver
# If successful:
git add <file>
```

**AI-resolve flow:**

The engine spawns a conflict resolution agent (a specialized Claude Code subagent) with:
- The base file, ours version, and theirs version.
- Both specs that produced the conflicting changes.
- The interface contracts relevant to the file.
- Instructions to produce a merged version and a confidence score.

```typescript
interface ConflictResolutionRequest {
  file: string;
  baseContent: string;
  oursContent: string;
  theirsContent: string;
  oursSpec: SpecDocument;
  theirsSpec: SpecDocument;
  interfaceContracts: InterfaceContract[];
}

interface ConflictResolutionResult {
  resolvedContent: string;
  confidence: number;           // 0.0 - 1.0
  reasoning: string;            // explanation of resolution
  strategy: "combined" | "ours-preferred" | "theirs-preferred" | "rewritten";
}
```

If the AI resolver's confidence exceeds `parallel.conflict_ai_confidence_threshold` (default: 0.85), the resolution is accepted. Otherwise, the conflict is escalated.

**Escalation report format:**

```json
{
  "type": "conflict_escalation",
  "requestId": "req-abc123",
  "file": "src/middleware/auth.ts",
  "trackA": "track-auth-service",
  "trackB": "track-user-api",
  "baseContent": "...",
  "trackAContent": "...",
  "trackBContent": "...",
  "trackASpecIntent": "Implement JWT validation middleware",
  "trackBSpecIntent": "Add user context extraction from auth token",
  "aiSuggestedResolution": "...",
  "aiConfidence": 0.72,
  "aiReasoning": "Both tracks modify the auth middleware chain. Track A adds JWT validation, Track B adds user context extraction. The ordering of middleware matters and is not specified in either spec."
}
```

#### 3.5.4 Conflict Resolution Log

Every conflict resolution is recorded for auditing and learning:

```typescript
interface ConflictRecord {
  id: string;
  requestId: string;
  file: string;
  trackA: string;
  trackB: string;
  conflictType: "disjoint" | "non-overlapping" | "overlapping-compatible" | "overlapping-conflicting" | "structural";
  resolutionStrategy: "auto" | "ai" | "human";
  aiConfidence: number | null;
  resolution: "accepted" | "rejected-by-tests" | "rejected-by-human";
  integrationTestsPassed: boolean;
  timestamp: string;
}
```

---

### 3.6 Integration Testing After Merge-Back

After all tracks in a request have been merged into the integration branch:

```bash
# 1. Checkout integration branch
git checkout auto/req-abc123/integration

# 2. Install dependencies (if applicable)
npm install  # or equivalent for the project

# 3. Run full test suite
npm test 2>&1 | tee .autonomous-dev/logs/req-abc123/integration-test.log
TEST_EXIT_CODE=$?

# 4. If tests fail, identify responsible track(s)
if [ "$TEST_EXIT_CODE" -ne 0 ]; then
  # Analyze failed test files against track-modified files
  # using git log and blame
fi
```

**Failure attribution algorithm:**

1. Parse test output to extract failing test file paths and line numbers.
2. For each failing test, run `git log --oneline auto/req-abc123/integration -- <test-file>` to identify which merge commit introduced changes to that test file.
3. For test failures caused by non-test code, run `git blame` on the failing lines to identify which track's merge commit introduced the offending code.
4. Map merge commits back to track names.
5. Send only the responsible tracks back for revision with:
   - The failure output.
   - The specific files and lines identified.
   - The integration branch state for the agent to test against.

**Revision loop:** A track sent back for revision is re-executed in a fresh worktree branched from the current integration branch (with all other tracks' changes present). This gives the agent visibility into the integrated codebase. The revision track goes through the same lifecycle: execute, test, review, merge. The maximum number of revision cycles is configurable (default: 2) before the entire request is escalated.

---

### 3.7 Cross-Track Communication

#### 3.7.1 Principle: No Mutable Shared State

Tracks do not communicate during execution. All cross-track data exchange happens through:
- **Pre-execution:** Shared constants/types committed to the integration branch before tracks begin.
- **Post-execution:** Merge-back and interface contract validation.

#### 3.7.2 Interface Contracts

During decomposition, the engine extracts interface contracts from specs:

```typescript
interface InterfaceContract {
  producer: string;               // track that creates the interface
  consumer: string;               // track that uses the interface
  contractType: "api-endpoint" | "function-signature" | "type-definition" | "event-schema" | "env-variable";
  definition: string;             // the expected interface shape
}
```

After merge-back, the engine validates contracts:

1. **Type definitions:** If Track A declares it exports `type User = { id: string; email: string }` and Track B imports `User`, the engine checks that the merged codebase contains a compatible definition.
2. **Function signatures:** If Track A exports `authenticate(token: string): Promise<User>` and Track B calls `authenticate(token)`, the engine verifies arity and type compatibility.
3. **API endpoints:** If Track A declares it will create `POST /api/auth/login` and Track B calls that endpoint, the engine verifies the route exists in the merged codebase.

Contract validation failures produce a reconciliation report sent to both tracks.

#### 3.7.3 Database Migrations

Database migrations are a special case because they are order-sensitive and cannot be parallelized. The Decomposition Engine must assign migrations using one of two strategies:

**Strategy A: Single migration track.** All schema changes are assigned to one dedicated track. Other tracks that need schema changes depend on this track.

**Strategy B: Sequenced migrations.** Each track that needs a migration declares the migration in its spec with a sequence number. The engine validates that no two tracks produce migrations with the same sequence number and that the sequence is contiguous. During merge-back, migration files are renumbered if necessary to maintain ordering.

```bash
# After merge-back, validate migration sequence
ls -1 migrations/ | sort -n
# Expected: 001_create_users.sql, 002_add_auth_tokens.sql, 003_add_email_queue.sql
# No gaps, no duplicates
```

---

### 3.8 Progress Tracking and Stall Detection

#### 3.8.1 Track State Machine

Each track follows this state machine (matching PRD Appendix C):

```
pending -> queued -> executing -> testing -> reviewing -> merging -> complete
                          |           |          |          |
                          +-----+-----+-----+----+-----+---+
                                |                 |
                                v                 v
                             failed          escalated
```

State transitions are recorded with timestamps:

```typescript
interface TrackState {
  trackName: string;
  status: "pending" | "queued" | "executing" | "testing" | "reviewing" | "merging" | "complete" | "failed" | "escalated";
  transitions: StateTransition[];
  currentPhaseStartedAt: string;  // ISO timestamp
  agentTurnsUsed: number;
  agentTurnBudget: number;
  retryCount: number;
  lastActivityAt: string;         // ISO timestamp of last detected activity
}

interface StateTransition {
  from: string;
  to: string;
  timestamp: string;
  reason: string;
}
```

#### 3.8.2 Stall Detection

The engine monitors `lastActivityAt` for each executing track. Activity is detected by:
- Agent tool calls (any tool invocation updates the timestamp).
- Git commits in the worktree (polled via `git -C <path> log -1 --format=%ct`).
- File modification timestamps within the worktree (polled via filesystem watch or periodic `find`).

If no activity is detected within `parallel.stall_timeout_minutes` (default: 15), the track is flagged:

1. **First stall alert:** Emit a warning event. The agent continues.
2. **Second stall alert (30 minutes total):** Terminate the agent. The track enters the retry flow (Section 3.4.5).

#### 3.8.3 Progress Reporting

**Per-track progress:**

```typescript
interface TrackProgress {
  trackName: string;
  status: string;
  phaseProgress: string;          // e.g., "executing (turn 23/60)"
  elapsedMinutes: number;
}
```

**Request-level progress:**

```typescript
interface RequestProgress {
  requestId: string;
  totalTracks: number;
  completedTracks: number;
  failedTracks: number;
  inProgressTracks: TrackProgress[];
  percentComplete: number;        // completedTracks / totalTracks * 100
  estimatedMinutesRemaining: number;
  currentCluster: number;
  totalClusters: number;
}
```

**Estimated time remaining:**

Calculated using a rolling average of completed track durations within the current request:

```
avg_track_duration = sum(completed_track_durations) / completed_count
remaining_tracks = total_tracks - completed_tracks - failed_tracks
estimated_remaining = avg_track_duration * remaining_tracks

# Adjust for parallelism
effective_remaining = estimated_remaining / min(remaining_tracks, max_tracks)
```

For the first cluster (no completed tracks yet), the estimate uses the complexity-based heuristic:
- Small: 5 minutes
- Medium: 15 minutes
- Large: 30 minutes

---

### 3.9 Crash Recovery

#### 3.9.1 State Persistence

The engine persists the complete execution state to disk after every state transition:

```typescript
interface PersistedExecutionState {
  version: 1;
  requestId: string;
  dag: DependencyDAG;
  tracks: Map<string, TrackState>;
  worktrees: Map<string, WorktreeInfo>;
  mergeResults: MergeResult[];
  conflictLog: ConflictRecord[];
  integrationBranch: string;
  baseBranch: string;
  createdAt: string;
  updatedAt: string;
  phase: "fan-out" | "merge-back" | "integration-testing" | "complete" | "failed";
}

interface WorktreeInfo {
  trackName: string;
  path: string;                   // absolute filesystem path
  branchName: string;
  created: boolean;
  removed: boolean;
  diskUsageBytes: number;
}
```

State is written atomically using write-to-temp-then-rename:

```bash
# Atomic state write
echo '<state-json>' > .autonomous-dev/state/req-abc123.json.tmp
mv .autonomous-dev/state/req-abc123.json.tmp .autonomous-dev/state/req-abc123.json
```

#### 3.9.2 Recovery on Startup

When the engine starts, it scans for in-flight requests:

```
Algorithm: RecoverOnStartup()

1. List all state files in .autonomous-dev/state/*.json
2. For each state file with phase != "complete" and phase != "failed":
   a. Load the persisted state.
   b. Validate worktree integrity:
      - For each worktree in state.worktrees where created=true and removed=false:
        - Check if the directory exists.
        - Check if `git worktree list` includes it.
        - Check if the branch exists.
      - If worktree exists and is clean: mark as recoverable.
      - If worktree exists but is dirty: reset to last commit.
      - If worktree is missing: mark for re-creation.
   c. Determine recovery action per track:
      - status=complete: no action (already merged or ready to merge).
      - status=merging: abort any in-progress merge, retry merge.
      - status=executing/testing/reviewing: the agent died mid-work.
        - If the worktree has commits beyond the branch point: mark the
          track as needing review (the partial work may be usable).
        - If no commits: re-queue the track for execution.
      - status=queued/pending: re-queue normally.
      - status=failed: check retry count. If retries < 1, re-queue. Else
        leave as failed.
      - status=escalated: leave as escalated.
   d. Resume execution from the determined recovery point.
```

#### 3.9.3 Agent Crash Recovery

When an agent dies mid-track (process crash, OOM, network failure):

1. The engine detects the agent is no longer running (heartbeat timeout or process exit).
2. The worktree is inspected:
   ```bash
   # Check for uncommitted work
   git -C .worktrees/req-abc123/track-auth-service status --porcelain

   # Check for commits beyond the branch point
   git -C .worktrees/req-abc123/track-auth-service log --oneline \
     auto/req-abc123/integration..HEAD
   ```
3. **If commits exist:** The partial work is preserved. The engine can either:
   - Spawn a new agent to continue from the last commit.
   - Mark the track as needing human review of partial work.
4. **If no commits and dirty state:** Reset and retry:
   ```bash
   git -C .worktrees/req-abc123/track-auth-service reset --hard HEAD
   git -C .worktrees/req-abc123/track-auth-service clean -fd
   ```
5. **If clean (no changes at all):** Re-queue the track from scratch.

#### 3.9.4 Orphaned Worktree Cleanup

On startup, the engine also scans for orphaned worktrees that have no corresponding state file:

```bash
# List all worktrees
git worktree list --porcelain | grep "^worktree " | sed 's/^worktree //'

# Compare against state files
# Any worktree under .worktrees/ not referenced in an active state file
# is considered orphaned and cleaned up after logging.
```

---

## 4. Data Models

### 4.1 Track State

```typescript
interface TrackState {
  trackName: string;
  specName: string;
  status: TrackStatus;
  worktreePath: string | null;
  branchName: string;
  agentSessionId: string | null;
  turnBudget: number;
  turnsUsed: number;
  retryCount: number;
  transitions: StateTransition[];
  currentPhaseStartedAt: string;
  lastActivityAt: string;
  createdAt: string;
  completedAt: string | null;
  failureReason: string | null;
  mergeCommitSha: string | null;
}

type TrackStatus =
  | "pending"
  | "queued"
  | "executing"
  | "testing"
  | "reviewing"
  | "merging"
  | "complete"
  | "failed"
  | "escalated";
```

### 4.2 DAG Representation

(See Section 3.2.2 for the full DAG types.)

### 4.3 Merge Result

```typescript
interface MergeResult {
  trackName: string;
  integrationBranch: string;
  trackBranch: string;
  mergeCommitSha: string | null;    // null if merge aborted
  conflictCount: number;
  conflicts: ConflictDetail[];
  resolutionStrategy: "clean" | "auto" | "ai" | "human" | "aborted";
  resolutionDurationMs: number;
  timestamp: string;
}

interface ConflictDetail {
  file: string;
  conflictType: string;
  resolution: string;
  confidence: number;
}
```

### 4.4 Execution State (top-level persisted object)

(See Section 3.9.1 for the full `PersistedExecutionState` type.)

---

## 5. Git Command Sequences

This section consolidates all git command sequences used by the engine into a single reference.

### 5.1 Request Initialization

```bash
# Create integration branch
git branch auto/req-abc123/integration main

# Optionally: pre-commit shared types to integration branch
git worktree add --detach /tmp/integration-setup auto/req-abc123/integration
cp shared-types.d.ts /tmp/integration-setup/src/shared-types.d.ts
git -C /tmp/integration-setup add src/shared-types.d.ts
git -C /tmp/integration-setup commit -m "chore: pre-commit shared type definitions for req-abc123"
git worktree remove /tmp/integration-setup
```

### 5.2 Track Worktree Setup

```bash
git branch auto/req-abc123/track-auth-service auto/req-abc123/integration
git worktree add .worktrees/req-abc123/track-auth-service auto/req-abc123/track-auth-service
```

### 5.3 Agent Work (within worktree)

```bash
# Agent operates entirely within the worktree
cd .worktrees/req-abc123/track-auth-service
# ... agent writes code, runs tests ...
git add -A
git commit -m "feat(auth): implement JWT validation middleware"
```

### 5.4 Merge-Back (single track)

```bash
git checkout auto/req-abc123/integration
git merge --no-commit --no-ff auto/req-abc123/track-auth-service
# Inspect: if conflicts, resolve per Section 3.5.3
# If clean or resolved:
git commit -m "merge: integrate track-auth-service into req-abc123"
```

### 5.5 Merge Abort (on failure)

```bash
git merge --abort
```

### 5.6 Worktree Cleanup

```bash
git worktree remove .worktrees/req-abc123/track-auth-service
git branch -D auto/req-abc123/track-auth-service
```

### 5.7 Full Request Cleanup

```bash
# Remove all worktrees for request
for wt in .worktrees/req-abc123/track-*; do
  git worktree remove --force "$wt" 2>/dev/null
done
git worktree prune
rm -rf .worktrees/req-abc123

# Remove all request branches
git for-each-ref --format='%(refname:short)' 'refs/heads/auto/req-abc123/*' \
  | xargs -r git branch -D
```

### 5.8 Crash Recovery: Worktree Health Check

```bash
# Is the worktree registered?
git worktree list --porcelain | grep -q ".worktrees/req-abc123/track-auth-service"

# Does the directory exist?
test -d .worktrees/req-abc123/track-auth-service

# Is the worktree clean?
git -C .worktrees/req-abc123/track-auth-service status --porcelain

# Any commits beyond branch point?
git -C .worktrees/req-abc123/track-auth-service log --oneline \
  auto/req-abc123/integration..HEAD

# Reset dirty worktree
git -C .worktrees/req-abc123/track-auth-service reset --hard HEAD
git -C .worktrees/req-abc123/track-auth-service clean -fd
```

---

## 6. Error Handling and Recovery

### 6.1 Error Classification

| Error Category | Examples | Recovery |
|---------------|----------|----------|
| **Transient agent failure** | Agent OOM, network timeout, turn budget exhaustion | Retry once with fresh agent in same worktree |
| **Persistent agent failure** | Agent produces wrong output on retry, test suite cannot pass | Escalate track; continue other tracks |
| **Merge conflict (trivial)** | Non-overlapping changes in same file | Auto-resolve |
| **Merge conflict (moderate)** | Overlapping changes with determinable intent | AI-resolve if confidence >= 0.85 |
| **Merge conflict (complex)** | Structural reorganization, conflicting intent | Escalate to human |
| **Integration test failure** | Combined code fails tests | Attribute to track(s), send back for revision |
| **Resource exhaustion** | Disk full, too many worktrees | Block new work, alert operator, wait for capacity |
| **Engine crash** | Process killed, machine restart | Resume from persisted state on restart |
| **Git corruption** | Worktree link broken, branch missing | Force cleanup and re-create from last known good state |

### 6.2 Rollback Procedures

**Rolling back a single track merge:**

```bash
# Find the merge commit
MERGE_SHA=$(git log --oneline --merges -1 --grep="track-auth-service" \
  auto/req-abc123/integration | cut -d' ' -f1)

# Revert the merge on integration branch
git checkout auto/req-abc123/integration
git revert -m 1 $MERGE_SHA
```

**Rolling back the entire integration branch to pre-merge state:**

```bash
# Find the commit before first merge
PRE_MERGE_SHA=$(git log --oneline auto/req-abc123/integration \
  --ancestry-path main..auto/req-abc123/integration | tail -1 | cut -d' ' -f1)

# Reset integration branch (destructive but safe since it is engine-managed)
git checkout auto/req-abc123/integration
git reset --hard $PRE_MERGE_SHA
```

### 6.3 Circuit Breakers

The engine implements circuit breakers to prevent cascading failures:

| Breaker | Trigger | Action |
|---------|---------|--------|
| Track retry breaker | Track fails 2 times (initial + 1 retry) | Escalate, do not retry again |
| Merge conflict breaker | > 5 unresolved conflicts in a single request | Pause merging, escalate entire request |
| Integration test breaker | 3 consecutive integration test failures after revisions | Abort request, escalate |
| Disk pressure breaker | Available disk < 500 MB | Emergency: kill all agents, pause engine |
| Revision loop breaker | Track revised > 2 times without passing integration tests | Escalate track permanently |

---

## 7. Security

### 7.1 Filesystem Isolation Between Tracks

- Each agent's filesystem access is limited to its assigned worktree directory.
- A PostToolUse hook validates all file paths resolve within the worktree boundary (Section 3.4.3).
- Agents cannot read the main working copy, other worktrees, or the `.autonomous-dev/` state directory.
- Agents cannot access `~/.claude/`, environment variables containing secrets, or paths outside the repository.

### 7.2 Branch Protection

- The engine never pushes to `main` or any protected branch directly.
- All engine-created branches use the `auto/` prefix, which can be restricted via branch protection rules.
- The integration branch is only merged to `main` via a pull request (not a direct push).

### 7.3 Agent Scope Enforcement

- Agents receive a tool allowlist: filesystem operations, git operations (within worktree only), test runners, and linters.
- Agents do not have access to: network calls (unless specifically enabled for test dependencies), process management, environment variable modification, or git operations that affect branches outside their track.

### 7.4 State File Integrity

- Persisted state files are written atomically (write-to-temp, then rename) to prevent corruption from partial writes.
- State files include a version field for schema migration on upgrades.
- State files are stored in `.autonomous-dev/state/` which is in `.gitignore` (runtime data, not committed).

---

## 8. Testing Strategy

### 8.1 Unit Tests

| Component | Test Focus |
|-----------|------------|
| DAG Constructor | Cycle detection, cluster assignment, transitive reduction, edge cases (single node, fully connected, long chains) |
| Scheduler | Slot management, resource-aware throttling, priority ordering, queue behavior |
| Conflict Classifier | Classification accuracy for each conflict type against known samples |
| State Persister | Atomic writes, schema versioning, corrupt file recovery |
| Stall Detector | Timeout calculation, activity tracking accuracy |
| Path Validator | Isolation enforcement: symlink traversal, `..` attacks, absolute paths outside worktree |

### 8.2 Integration Tests

| Scenario | Description |
|----------|-------------|
| 3-track independent | Fan out 3 independent specs, execute (with mock agents that write predetermined files), merge back, verify clean integration |
| 3-track with dependency | A -> B + C independent. Verify B only starts after A merges. Verify B's worktree contains A's changes. |
| Merge conflict (auto-resolve) | Two tracks modify different regions of same file. Verify auto-resolution. |
| Merge conflict (AI-resolve) | Two tracks modify overlapping regions. Mock AI resolver. Verify escalation when confidence is low. |
| Agent failure and retry | Simulate agent crash. Verify retry with fresh agent. Verify escalation on second failure. |
| Disk pressure throttling | Simulate high disk usage. Verify scheduler reduces parallelism. |
| Crash recovery | Kill engine mid-execution. Restart. Verify resume from persisted state. Verify no duplicate work. |
| Stall detection | Mock an agent that stops producing activity. Verify stall alert at configured timeout. |
| Full lifecycle | End-to-end: 5 specs with mixed dependencies, conflicts, one failure, recovery, and successful integration. |

### 8.3 Property-Based Tests

| Property | Description |
|----------|-------------|
| DAG validity | For any valid input, the produced DAG has no cycles and all nodes are reachable |
| Cluster completeness | Every node appears in exactly one cluster |
| Merge idempotency | Merging the same track twice does not change the integration branch |
| State persistence roundtrip | Serialize -> deserialize produces identical state |
| Isolation invariant | No agent operation produces a file outside its worktree (fuzz file paths) |

### 8.4 Chaos Tests (Phase 3)

- Kill random agents during execution and verify recovery.
- Corrupt state files and verify graceful degradation.
- Fill disk mid-execution and verify the engine halts gracefully.
- Remove worktree directories while agents are running and verify detection.

---

## 9. Trade-offs and Alternatives

### 9.1 Worktrees vs. Separate Clones

| Factor | Worktrees (chosen) | Separate Clones |
|--------|-------------------|-----------------|
| Disk usage | Low: shared object store | High: full copy per clone |
| Setup time | Fast: linked checkout | Slow: full clone |
| Isolation | Shared `.git/objects`, separate HEAD/index/worktree | Complete isolation |
| Corruption risk | Shared object store is a single point of failure | Independent |
| Git compatibility | Native `git worktree` support | Standard git |

**Decision:** Worktrees. The disk and time savings are significant (each clone of a 1 GB repo adds 1 GB; worktrees add only the working tree files, roughly 0.3-0.5x). The shared object store risk is mitigated by the fact that agents only add objects (write operations) and never run garbage collection. A corruption in the object store would affect all worktrees, but this is an extremely rare failure mode and is recoverable from the remote.

### 9.2 Incremental Merge vs. Batch Merge

| Factor | Incremental (merge as each track completes) | Batch (wait for cluster, then merge all) |
|--------|---------------------------------------------|------------------------------------------|
| Latency | Lower: dependent tracks can start sooner | Higher: must wait for slowest track in cluster |
| Complexity | Higher: must handle partial merge states | Lower: clear cluster boundaries |
| Conflict resolution | Easier: fewer concurrent merges | Harder: more changes merging at once |
| Rollback | More complex: partial merge states | Simpler: all-or-nothing per cluster |

**Decision:** Phase 1 uses batch merge (simpler, more predictable). Phase 3 adds incremental merge as an optimization. The scheduler already tracks per-track completion, so the incremental merge extension is a natural evolution.

### 9.3 Centralized Merge vs. Per-Track Merge Agent

| Factor | Centralized (engine merges) | Per-Track Merge Agent |
|--------|---------------------------|----------------------|
| Control | Engine has full control over merge order | Agents merge independently, need coordination |
| Consistency | Deterministic merge order | Race conditions possible |
| Complexity | Simpler orchestration | More distributed, harder to reason about |

**Decision:** Centralized merge. The merge order is determined by the DAG and must be deterministic. Delegating merges to agents introduces coordination complexity with no benefit.

### 9.4 Filesystem Isolation vs. Container Isolation

| Factor | Filesystem hooks (chosen) | Docker containers |
|--------|--------------------------|-------------------|
| Setup overhead | Minimal | Container build + orchestration |
| Resource cost | Low (shared OS) | Higher (container per agent) |
| Isolation strength | Medium (path validation) | Strong (kernel-level) |
| Complexity | Low | High (Docker dependency, networking) |
| Performance | Native filesystem speed | Potential I/O overhead |

**Decision:** Filesystem hooks for Phase 1-2. The path validation hook provides sufficient isolation for Claude Code agents, which are cooperative (they follow instructions). Container isolation could be added in a future phase if adversarial agent behavior becomes a concern, but this is a non-goal per PRD NG-1 (single host, no container orchestration).

---

## 10. Implementation Plan

### Phase 1: MVP (Weeks 1-4)

| Week | Deliverable | Requirements Covered |
|------|-------------|---------------------|
| 1 | Worktree Manager: create, list, cleanup, disk monitoring | FR-001 through FR-006, FR-008 |
| 1 | State Persister: atomic write, load, crash detection | NFR-004, NFR-010 |
| 2 | DAG Constructor: parse specs, build adjacency list, cycle detection | FR-010, FR-016 |
| 2 | Cluster assignment algorithm (no priority, no resource-awareness) | FR-011, FR-013 |
| 3 | Scheduler: dispatch tracks, slot management, basic concurrency | FR-006, FR-014 |
| 3 | Agent Spawner: worktree assignment, context injection, turn budget | FR-018 through FR-022 |
| 3 | Filesystem isolation hook | FR-004, FR-024, NFR-008 |
| 4 | Merge Engine: sequential merge-back, trivial auto-resolve | FR-026 through FR-030 |
| 4 | Progress Tracker: per-track status, basic events | FR-041, FR-042 |
| 4 | Integration test runner | FR-030 |

**Phase 1 exit criteria:** 3 independent specs execute in parallel, merge cleanly, and pass integration tests with >= 40% wall-clock reduction.

### Phase 2: Dependency-Aware Scheduling (Weeks 5-8)

| Week | Deliverable | Requirements Covered |
|------|-------------|---------------------|
| 5 | DAG-ordered merge (topological sort, dependency chain support) | FR-012, FR-027 |
| 5 | Mixed-mode scheduling (parallel clusters + sequential chains) | FR-013 |
| 6 | Resource-aware scheduling (disk monitoring, dynamic throttling) | FR-015 |
| 6 | AI conflict resolution agent | FR-032, FR-033, FR-034 |
| 7 | Integration test failure attribution | FR-031 |
| 7 | Stall detection and alerting | FR-044, FR-045 |
| 8 | Database migration sequencing | FR-037 |
| 8 | Complexity-based turn budgets, ETA calculation | FR-023, FR-043 |

**Phase 2 exit criteria:** 5-spec request with 2 dependent chains executes correctly, AI resolves at least one conflict, >= 55% wall-clock reduction.

### Phase 3: Production Hardening (Weeks 9-12)

| Week | Deliverable | Requirements Covered |
|------|-------------|---------------------|
| 9 | Interface contract validation | FR-038, FR-039, FR-040 |
| 9 | Agent execution logging and post-mortem | FR-025 |
| 10 | Incremental merge (merge as tracks complete) | FR-035 |
| 10 | Priority-based scheduling (critical path, out-degree) | FR-017 |
| 11 | Shallow/sparse worktree optimization for large repos | FR-009 |
| 11 | Full crash recovery with idempotent resume | NFR-010, NFR-011 |
| 12 | Dashboard view, chaos testing, performance benchmarks | FR-046 |

**Phase 3 exit criteria:** 10+ spec request with complex dependency graph, all success metrics met, clean recovery from injected failures.

---

## 11. Open Questions

| # | Question | Impact | Depends On | Status |
|---|----------|--------|------------|--------|
| TQ-1 | Should the Merge Engine operate in a dedicated worktree or the main working copy? Using a dedicated merge worktree avoids interfering with the developer's active work. Using the main checkout saves disk but risks conflict with local changes. | Determines whether merge operations need their own worktree allocation. | Developer workflow analysis | Open |
| TQ-2 | How should the engine handle `git worktree` lock files? Git creates `.git/worktrees/<name>/locked` to prevent concurrent operations. If an agent crashes while holding a lock, the worktree may be unusable until the lock is manually removed. | Affects crash recovery procedure (need to remove stale locks). | Testing with forced agent termination | Open |
| TQ-3 | Should the DAG Constructor support runtime dependency discovery? If Track A unexpectedly modifies a file that Track B also modifies (not predicted during decomposition), should the engine detect this and re-sequence? | Determines complexity of file-watching during execution. Related to PRD OQ-4. | Decomposition Engine accuracy analysis | Open |
| TQ-4 | What is the performance ceiling for `git worktree add` on large monorepos? If worktree creation takes > 10 seconds (NFR-001), sparse checkout becomes a P0 requirement, not P2. | Determines Phase 1 scope. Related to PRD OQ-2. | Benchmarking on target repositories | Open |
| TQ-5 | Should the AI conflict resolver operate within its own token budget or share the track's budget? A complex conflict resolution could consume significant tokens. | Determines budgeting model for conflict resolution. Related to PRD OQ-3. | Cost analysis of AI resolution | Open |
| TQ-6 | How should the engine coordinate with the System Core daemon (PRD-001) for process supervision? Should the engine register its agent processes with the daemon, or manage them independently? | Determines integration surface with PRD-001. | System Core TDD | Open |
| TQ-7 | Should the integration test suite run in its own worktree? Running tests on the integration branch requires a clean working copy. If the developer's main checkout is the integration branch, running tests there could interfere with their work. | Related to TQ-1. Likely yes -- dedicated worktree for integration testing. | Decision on TQ-1 | Open |
| TQ-8 | What is the maximum practical number of parallel tracks before git object store contention becomes a bottleneck? All worktrees share the same `.git/objects` directory; concurrent git operations may contend on the lock file. | Determines whether `max_worktrees=5` is safe or needs reduction. | Load testing with concurrent git operations | Open |

---

## Appendix A: Configuration Reference

All configuration lives under the `parallel` key in the autonomous-dev configuration file.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `parallel.max_worktrees` | integer | 5 | Maximum concurrent worktrees across all requests |
| `parallel.max_tracks` | integer | 3 | Maximum simultaneously executing tracks per request |
| `parallel.disk_warning_threshold_gb` | number | 2.0 | Warning threshold for aggregate worktree disk usage |
| `parallel.disk_hard_limit_gb` | number | 5.0 | Hard limit; blocks new worktree creation |
| `parallel.stall_timeout_minutes` | integer | 15 | Minutes without activity before track is flagged stalled |
| `parallel.agent_turn_budget.small` | integer | 30 | Turn budget for small-complexity specs |
| `parallel.agent_turn_budget.medium` | integer | 60 | Turn budget for medium-complexity specs |
| `parallel.agent_turn_budget.large` | integer | 120 | Turn budget for large-complexity specs |
| `parallel.conflict_ai_confidence_threshold` | number | 0.85 | Minimum AI confidence to accept conflict resolution |
| `parallel.worktree_cleanup_delay_seconds` | integer | 300 | Seconds to wait before removing completed worktrees |
| `parallel.max_revision_cycles` | integer | 2 | Maximum times a track can be sent back for revision |
| `parallel.merge_conflict_escalation_threshold` | integer | 5 | Max unresolved conflicts before entire request escalates |
| `parallel.integration_test_retry_limit` | integer | 3 | Max consecutive integration test failures before abort |
| `parallel.base_branch` | string | "main" | Branch to create integration branches from |
| `parallel.worktree_root` | string | ".worktrees" | Directory for worktrees, relative to repo root |
| `parallel.state_dir` | string | ".autonomous-dev/state" | Directory for persisted state files |

## Appendix B: Event Catalog

The engine emits structured events for all significant state changes. Events are consumed by the Progress Tracker, the System Core daemon, and external monitoring.

| Event | Payload | Emitted When |
|-------|---------|-------------|
| `track.state_changed` | `{requestId, trackName, from, to, timestamp}` | Any track state transition |
| `track.stalled` | `{requestId, trackName, lastActivityAt, stallDuration}` | Stall timeout exceeded |
| `worktree.created` | `{requestId, trackName, path, branchName}` | Worktree successfully created |
| `worktree.removed` | `{requestId, trackName, path}` | Worktree cleaned up |
| `worktree.disk_warning` | `{totalUsageBytes, threshold, worktreeCount}` | Disk usage exceeds warning threshold |
| `worktree.disk_critical` | `{totalUsageBytes, limit, worktreeCount}` | Disk usage exceeds hard limit |
| `merge.started` | `{requestId, trackName, integrationBranch}` | Merge-back begins for a track |
| `merge.conflict_detected` | `{requestId, trackName, file, conflictType}` | Merge conflict found |
| `merge.conflict_resolved` | `{requestId, trackName, file, strategy, confidence}` | Conflict resolved |
| `merge.completed` | `{requestId, trackName, commitSha, conflictCount}` | Track successfully merged |
| `merge.failed` | `{requestId, trackName, reason}` | Merge could not be completed |
| `integration.test_started` | `{requestId, integrationBranch}` | Integration test suite begins |
| `integration.test_passed` | `{requestId, duration}` | All tests pass |
| `integration.test_failed` | `{requestId, failedTests, attributedTracks}` | Tests fail with attribution |
| `agent.spawned` | `{requestId, trackName, sessionId, turnBudget}` | Agent assigned to worktree |
| `agent.completed` | `{requestId, trackName, turnsUsed}` | Agent signals completion |
| `agent.failed` | `{requestId, trackName, reason, retryCount}` | Agent failure |
| `agent.budget_warning` | `{requestId, trackName, turnsUsed, turnBudget}` | Agent at 90% of budget |
| `request.progress` | `{requestId, completed, total, percent, eta}` | Periodic progress update |
| `request.completed` | `{requestId, totalDuration, trackCount}` | All tracks merged and tests pass |
| `request.escalated` | `{requestId, reason, escalatedTracks}` | Request requires human intervention |
| `security.isolation_violation` | `{trackName, attemptedPath, allowedRoot}` | Agent attempted out-of-bounds access |

## Appendix C: Glossary

| Term | Definition |
|------|------------|
| **Track** | A single unit of parallel work corresponding to one spec, executed by one agent in one worktree. |
| **Cluster** | A group of tracks at the same topological level in the DAG, eligible for parallel execution. |
| **Integration branch** | The branch where all track results are merged together before PR to main. |
| **Fan-out** | The process of creating worktrees and dispatching agents for parallel execution. |
| **Merge-back** | The process of merging completed track branches into the integration branch. |
| **DAG** | Directed Acyclic Graph representing dependencies between specs/tracks. |
| **Stall** | A track that has not made progress (no new activity) for longer than the configured timeout. |
| **Escalation** | Routing a problem to a human operator because automated resolution failed. |
| **Turn budget** | The maximum number of LLM conversation turns an agent is allowed before termination. |
| **Interface contract** | A declared API, type, or schema boundary between two tracks that must be compatible after merge. |

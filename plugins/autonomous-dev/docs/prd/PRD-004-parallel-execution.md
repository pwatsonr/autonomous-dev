# PRD-004: Parallel Execution Engine

| Field       | Value                                      |
|-------------|--------------------------------------------|
| **Title**   | Parallel Execution Engine                  |
| **Version** | 0.1.0                                      |
| **Date**    | 2026-04-08                                 |
| **Author**  | pwatson                                    |
| **Status**  | Draft                                      |
| **Plugin**  | autonomous-dev                             |
| **Depends** | PRD-001 (Pipeline Core), PRD-002 (Agent Framework), PRD-003 (Decomposition Engine) |

---

## 1. Problem Statement

The autonomous-dev pipeline decomposes product requests through PRD, TDD, Plan, and Spec phases, ultimately producing multiple independent implementation tasks. Today, these tasks would execute sequentially in a single working copy, creating a bottleneck: a request that decomposes into five independent specs takes five times as long as one spec, even though the specs have no dependencies on each other.

Beyond throughput, sequential execution in a shared working copy creates interference problems. One agent's partially-committed changes can break another agent's assumptions, leading to cascading failures that are expensive to debug. The system needs strict isolation between concurrent execution tracks while preserving the ability to integrate results into a coherent whole.

The Parallel Execution Engine solves both problems. It manages concurrent work across isolated git worktrees, orchestrates fan-out decomposition into parallel tracks, handles merge-back integration with conflict resolution, and provides progress tracking across all active tracks. The core operating principle is **fan out, merge back**: at every decomposition step, independent tasks run as parallel agents in isolated worktrees, then results merge back through integration review.

---

## 2. Goals

- **G1**: Reduce wall-clock time for multi-spec requests by executing independent specs in parallel across isolated git worktrees.
- **G2**: Guarantee execution isolation so that no agent can observe or corrupt another agent's in-progress work.
- **G3**: Provide deterministic, DAG-ordered merge-back that produces clean integration branches with passing tests.
- **G4**: Automatically resolve trivial merge conflicts, apply AI-assisted resolution for moderate conflicts, and escalate truly complex conflicts to humans.
- **G5**: Enforce resource limits (disk, concurrency, turn budgets) so parallel execution cannot destabilize the host system.
- **G6**: Deliver real-time progress tracking across all parallel tracks within a request.

## 3. Non-Goals

- **NG1**: Distributed execution across multiple machines. This engine runs on a single host. Multi-host orchestration is a future concern.
- **NG2**: General-purpose CI/CD. The engine orchestrates agent-driven development tasks, not arbitrary build pipelines.
- **NG3**: Real-time collaboration between agents. Tracks are isolated by design; cross-track communication happens only through pre-defined interface contracts in specs.
- **NG4**: Git worktree management as a standalone tool. The worktree lifecycle is an internal implementation detail, not an exposed API.
- **NG5**: Support for non-git version control systems.

---

## 4. User Stories

### Worktree Lifecycle

| ID    | Story |
|-------|-------|
| US-01 | As the pipeline orchestrator, I want to create an isolated worktree for each parallel execution track so that agents operate on independent working copies without interference. |
| US-02 | As the pipeline orchestrator, I want worktrees automatically cleaned up after successful merge or cancellation so that disk space is not consumed indefinitely. |
| US-03 | As the pipeline orchestrator, I want to enforce a maximum number of concurrent worktrees so that the host filesystem is not exhausted by parallel checkouts. |
| US-04 | As a system operator, I want to see current disk usage of all active worktrees and receive alerts when usage exceeds a threshold so that I can intervene before disk pressure causes failures. |

### Fan-Out Decomposition

| ID    | Story |
|-------|-------|
| US-05 | As the decomposition engine, I want to submit N independent specs for parallel execution and receive a tracking handle so that I can monitor progress and collect results. |
| US-06 | As the pipeline orchestrator, I want dependency analysis to build a DAG of specs so that only truly independent specs are parallelized, while dependent specs are sequenced correctly. |
| US-07 | As the pipeline orchestrator, I want mixed-mode scheduling (parallel clusters + sequential chains) so that partially-dependent workloads are executed as efficiently as possible without violating ordering constraints. |
| US-08 | As a system operator, I want to configure the maximum number of parallel tracks (default 3) so that I can tune parallelism to match available host resources. |

### Agent-to-Worktree Assignment

| ID    | Story |
|-------|-------|
| US-09 | As the execution engine, I want each worktree to be assigned exactly one dedicated agent so that there is a clear 1:1 mapping between agent and working copy. |
| US-10 | As an executing agent, I want to receive my assigned spec plus the parent plan, TDD, and PRD as context so that I understand both my specific task and the broader system I am contributing to. |
| US-11 | As the execution engine, I want to enforce a configurable turn budget per agent so that runaway agents are terminated before consuming unbounded resources. |
| US-12 | As the execution engine, I want failed agents to retry exactly once and then escalate so that transient failures are recovered but persistent failures are not retried in a loop. |

### Merge-Back and Integration

| ID    | Story |
|-------|-------|
| US-13 | As the integration engine, I want to merge completed tracks back to the integration branch in DAG-determined order so that dependent changes layer correctly on top of their prerequisites. |
| US-14 | As the integration engine, I want to detect merge conflicts before committing (via `git merge --no-commit`) so that conflicts can be classified and routed to the appropriate resolution strategy. |
| US-15 | As the integration engine, I want trivial conflicts (different files, non-overlapping hunks) auto-resolved so that human intervention is only required for genuinely ambiguous cases. |
| US-16 | As the integration engine, I want AI-assisted conflict resolution for overlapping changes where the intent is unambiguous from the spec so that most semantic conflicts are resolved without human escalation. |
| US-17 | As the integration engine, I want to run the full test suite on the integration branch after all tracks are merged so that I can confirm the combined changes are correct. |
| US-18 | As the integration engine, I want integration test failures attributed to the specific track(s) that caused them so that only the responsible track is sent back for revision, not all tracks. |

### Cross-Track Coordination

| ID    | Story |
|-------|-------|
| US-19 | As the pipeline orchestrator, I want database migrations identified and sequenced during decomposition so that parallel tracks never produce conflicting schema changes. |
| US-20 | As the integration engine, I want interface contracts (APIs, shared types, event schemas) validated after merge so that Track A's producer and Track B's consumer are confirmed compatible. |

### Progress Tracking

| ID    | Story |
|-------|-------|
| US-21 | As a system operator, I want to see per-track status (pending, executing, testing, reviewing, complete, failed) in real time so that I can monitor execution progress. |
| US-22 | As a system operator, I want overall request progress expressed as a percentage with estimated time remaining so that I have a high-level view of when the request will complete. |
| US-23 | As the pipeline orchestrator, I want stalled track detection (no progress in N configurable minutes) so that hung agents are identified and escalated before they block the entire request. |

---

## 5. Functional Requirements

### 5.1 Worktree Lifecycle Management

| ID     | Priority | Requirement |
|--------|----------|-------------|
| FR-001 | P0 | The engine MUST create a new git worktree for each parallel execution track using `git worktree add`. |
| FR-002 | P0 | Worktree paths MUST follow the naming convention `.worktrees/{request-id}/track-{name}` relative to the repository root. |
| FR-003 | P0 | Each worktree MUST be created on a branch named `auto/{request-id}/{track-name}`, branched from the integration branch. |
| FR-004 | P0 | Worktrees MUST be fully isolated: an agent executing in one worktree MUST NOT have filesystem access to any other worktree. |
| FR-005 | P0 | The engine MUST remove worktrees (via `git worktree remove`) after successful merge-back or explicit cancellation. |
| FR-006 | P0 | The engine MUST enforce a configurable maximum number of concurrent worktrees (default: 5). Attempts to exceed this limit MUST queue until a slot becomes available. |
| FR-007 | P1 | The engine MUST monitor aggregate disk usage of all active worktrees and emit a warning event when usage exceeds a configurable threshold (default: 2 GB). |
| FR-008 | P1 | The engine MUST support force-cleanup of a worktree (including partial work) when a track is cancelled or the system is recovering from a crash. |
| FR-009 | P2 | The engine SHOULD use `git worktree add --detach` with shallow depth when the repository is large, to reduce disk consumption per worktree. |

### 5.2 Fan-Out Decomposition

| ID     | Priority | Requirement |
|--------|----------|-------------|
| FR-010 | P0 | When the decomposition engine produces N specs, the engine MUST analyze inter-spec dependencies and construct a directed acyclic graph (DAG). |
| FR-011 | P0 | Specs with no inbound dependency edges in the DAG MUST be eligible for immediate parallel execution. |
| FR-012 | P0 | Specs with inbound dependency edges MUST NOT begin execution until all upstream specs have completed and merged successfully. |
| FR-013 | P0 | The engine MUST support mixed-mode scheduling: parallel clusters of independent specs combined with sequential ordering within dependent chains. |
| FR-014 | P1 | The maximum number of simultaneously executing parallel tracks MUST be configurable (default: 3) and MUST be independent of the worktree limit in FR-006. |
| FR-015 | P1 | The engine MUST implement resource-aware scheduling: if system resources (CPU, memory, disk) are constrained, the engine MUST reduce the effective parallelism below the configured maximum. |
| FR-016 | P1 | The DAG MUST be validated for cycles before execution begins. If a cycle is detected, the engine MUST reject the decomposition and report the cycle to the orchestrator. |
| FR-017 | P2 | The engine SHOULD support priority-based scheduling within a parallelism tier, allowing critical-path specs to be scheduled before lower-priority specs when slots are limited. |

### 5.3 Agent-to-Worktree Assignment

| ID     | Priority | Requirement |
|--------|----------|-------------|
| FR-018 | P0 | Each worktree MUST be assigned exactly one dedicated agent (code executor). No agent may operate on more than one worktree simultaneously. |
| FR-019 | P0 | Each agent MUST receive as context: (a) its assigned spec, (b) the parent plan, (c) the parent TDD, and (d) the parent PRD. |
| FR-020 | P0 | Each agent MUST follow the lifecycle: spawn, execute, self-test, self-review, signal complete. |
| FR-021 | P0 | The engine MUST enforce a configurable turn budget per agent. When the budget is exhausted, the agent MUST be terminated and the track marked as failed. |
| FR-022 | P0 | On agent failure, the engine MUST retry exactly once with a fresh agent instance in the same worktree. If the retry also fails, the track MUST be escalated. |
| FR-023 | P1 | The turn budget MUST be configurable per-spec based on estimated complexity (e.g., small: 30 turns, medium: 60 turns, large: 120 turns). |
| FR-024 | P1 | Agent scope enforcement MUST prevent an agent from reading or writing files outside its assigned worktree directory. |
| FR-025 | P2 | The engine SHOULD capture agent execution logs (turns, tool calls, decisions) for post-mortem analysis of failed tracks. |

### 5.4 Merge-Back and Integration

| ID     | Priority | Requirement |
|--------|----------|-------------|
| FR-026 | P0 | After all parallel tracks in a parallelism tier complete, the engine MUST merge each track's branch into the integration branch. |
| FR-027 | P0 | Merge order MUST follow the dependency DAG: independent tracks merge first, then dependent tracks in topological order. |
| FR-028 | P0 | The engine MUST use `git merge --no-commit` to detect conflicts before finalizing each merge. |
| FR-029 | P0 | Trivial conflicts (changes to entirely different files, or non-overlapping changes within the same file) MUST be auto-resolved without human intervention. |
| FR-030 | P0 | After all tracks are merged, the engine MUST run the full project test suite on the integration branch. |
| FR-031 | P0 | If integration tests fail, the engine MUST identify the track(s) responsible by analyzing test failure stack traces and git blame on changed lines, then send only those tracks back for revision. |
| FR-032 | P1 | Conflicts involving overlapping changes in the same file region where intent is determinable from the spec MUST be resolved by an AI conflict resolution agent. |
| FR-033 | P1 | Conflicts that cannot be auto-resolved or AI-resolved MUST be escalated to a human with a structured conflict report containing: the conflicting hunks, both specs' intents, and a suggested resolution. |
| FR-034 | P1 | The engine MUST maintain a conflict resolution log recording each conflict's type, resolution strategy, and outcome for learning and auditing. |
| FR-035 | P2 | The engine SHOULD support incremental merge (merge each track as it completes, rather than waiting for all tracks in a tier) when tracks within a tier are truly independent. |

### 5.5 Cross-Track Communication and Coordination

| ID     | Priority | Requirement |
|--------|----------|-------------|
| FR-036 | P0 | Tracks MUST NOT share mutable state during execution. All cross-track data exchange MUST occur through the merge-back process. |
| FR-037 | P0 | Database migrations MUST be identified during decomposition and assigned to a single track or sequenced across tracks. Two tracks MUST NOT produce independent migration files for the same schema. |
| FR-038 | P1 | Interface contracts (API endpoints, shared types, event schemas, function signatures) between tracks MUST be declared in the specs and validated after merge. |
| FR-039 | P1 | If contract validation fails after merge (e.g., Track A exports a function with signature `foo(a, b)` but Track B calls `foo(a, b, c)`), the engine MUST identify both tracks and send them back for reconciliation with the contract discrepancy report. |
| FR-040 | P2 | The engine SHOULD support a shared constants/types file that is pre-committed to the integration branch before tracks begin, so that all tracks can read (but not write) shared definitions. |

### 5.6 Progress Tracking and Observability

| ID     | Priority | Requirement |
|--------|----------|-------------|
| FR-041 | P0 | The engine MUST maintain per-track status with states: `pending`, `queued`, `executing`, `testing`, `reviewing`, `merging`, `complete`, `failed`, `escalated`. |
| FR-042 | P0 | The engine MUST expose overall request progress as: completed tracks / total tracks, with the current phase of each in-progress track. |
| FR-043 | P1 | The engine MUST calculate estimated time remaining based on a rolling average of completed track durations within the current request. |
| FR-044 | P1 | The engine MUST detect stalled tracks: if a track has not advanced to a new lifecycle phase within a configurable timeout (default: 15 minutes), it MUST be flagged and an alert emitted. |
| FR-045 | P1 | The engine MUST emit structured events for all state transitions (track started, track completed, merge conflict detected, etc.) to support external monitoring. |
| FR-046 | P2 | The engine SHOULD provide a summary dashboard view showing: active request ID, DAG visualization, per-track status, disk usage, and elapsed/estimated time. |

---

## 6. Non-Functional Requirements

| ID      | Category       | Requirement |
|---------|----------------|-------------|
| NFR-001 | Performance    | Worktree creation MUST complete within 10 seconds for repositories up to 1 GB. |
| NFR-002 | Performance    | Merge-back of a single track MUST complete within 30 seconds, excluding test suite execution. |
| NFR-003 | Performance    | The scheduling overhead (DAG analysis, resource checks, queue management) MUST add no more than 2 seconds per scheduling decision. |
| NFR-004 | Reliability    | If the engine process crashes mid-execution, it MUST be possible to resume or cleanly abort all in-flight tracks on restart. Worktrees MUST NOT be left in a corrupted state. |
| NFR-005 | Reliability    | Partial merge failures MUST NOT corrupt the integration branch. All merges MUST use `--no-commit` with explicit commit only after validation. |
| NFR-006 | Resource Limits | Total disk usage across all active worktrees MUST NOT exceed a configurable maximum (default: 5 GB). |
| NFR-007 | Resource Limits | The engine MUST NOT spawn more OS-level processes than the configured maximum (default: 3 agents + 1 orchestrator). |
| NFR-008 | Security       | Agent filesystem access MUST be scoped to the assigned worktree. Agents MUST NOT be able to access the main working copy, other worktrees, or files outside the repository. |
| NFR-009 | Observability  | All state transitions, errors, and resource usage events MUST be logged with structured fields (request ID, track ID, timestamp, event type). |
| NFR-010 | Recoverability | The engine MUST persist execution state (DAG, track statuses, worktree paths) to disk so that progress survives a process restart. |
| NFR-011 | Idempotency    | Resuming a partially-completed request MUST NOT re-execute tracks that have already completed and merged successfully. |

---

## 7. Success Metrics

| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| Wall-clock reduction for 3-spec requests | >= 50% reduction vs. sequential execution | Compare elapsed time: parallel engine vs. sequential baseline on the same spec set. |
| Wall-clock reduction for 5-spec requests | >= 65% reduction vs. sequential execution | Same comparison methodology with 5 independent specs. |
| Auto-resolved merge conflicts | >= 80% of all conflicts resolved without human intervention | Count auto-resolved + AI-resolved conflicts / total conflicts over 30 days. |
| AI-resolved conflict accuracy | >= 90% of AI-resolved conflicts produce correct results (no regressions) | Track whether AI-resolved conflicts pass integration tests on first attempt. |
| Integration test pass rate on first merge | >= 85% of requests pass integration tests without track revision | Count first-attempt passes / total merge-back attempts. |
| Track isolation violations | 0 incidents per month | Monitor for cross-worktree filesystem access attempts. |
| Stalled track detection latency | Detected within 2 minutes of stall onset | Measure time between last track activity and stall alert. |
| Worktree cleanup reliability | 100% of worktrees cleaned up within 5 minutes of track completion | Audit worktree directory presence vs. track completion timestamps. |
| Disk usage adherence | 0 incidents of exceeding configured disk limit | Monitor disk usage against threshold continuously. |
| Crash recovery success rate | >= 95% of interrupted requests resume correctly | Track resumption outcomes after simulated and real crashes. |

---

## 8. Risks and Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|------------|--------|------------|
| R1 | **Disk exhaustion from concurrent worktrees.** Each worktree is a near-full checkout. With 5 concurrent worktrees on a 1 GB repo, that is 5 GB consumed. | High | High | Enforce hard disk limits (FR-006, FR-007, NFR-006). Use shallow/sparse checkouts where possible (FR-009). Monitor and alert proactively. |
| R2 | **Track A completes but its changes break Track B's assumptions.** Track B was coded against the original branch state, not Track A's modifications. | High | Medium | Dependency DAG ensures truly dependent tracks are sequenced (FR-012). Interface contracts catch mismatches (FR-038, FR-039). Integration testing catches remaining issues (FR-030, FR-031). |
| R3 | **Database migration conflicts.** Two tracks independently generate migrations that alter the same table or produce conflicting migration sequence numbers. | Medium | High | Identify migrations during decomposition and assign to a single track or strictly sequence them (FR-037). Validate migration order and schema consistency during merge-back. |
| R4 | **Agent consumes excessive resources (turns, memory, time).** A runaway agent delays the entire request. | Medium | Medium | Turn budgets (FR-021, FR-023). Stall detection (FR-044). Single retry then escalate policy (FR-022). |
| R5 | **AI conflict resolution produces incorrect merges.** The AI resolver misunderstands spec intent and introduces subtle bugs. | Medium | High | Integration tests catch regressions (FR-030). Conflict resolution log enables audit (FR-034). Conservative confidence threshold: only AI-resolve when confidence exceeds 0.85, otherwise escalate. |
| R6 | **Cross-request conflicts.** Two different requests modify the same files in separate worktrees, leading to persistent merge conflicts. | Low | Medium | Serialize requests that touch overlapping file sets at the orchestrator level (out of scope for this engine, but flag as a dependency on the Pipeline Core). |
| R7 | **Engine crash mid-execution leaves orphaned worktrees.** Worktrees are created but the engine dies before cleanup. | Medium | Medium | Persist execution state to disk (NFR-010). On startup, scan for orphaned worktrees and either resume or clean up (NFR-004). |
| R8 | **Partial merge leaves integration branch in broken state.** A track merges successfully but the next track's merge fails, leaving the integration branch with only some changes. | Medium | High | Use `--no-commit` for all merges (FR-028). Only finalize the integration branch commit after all tracks in a tier merge cleanly and tests pass. Support rollback of the integration branch to pre-merge state. |
| R9 | **Track needs restart from scratch.** Agent produces fundamentally wrong output and retry is not sufficient. | Low | Medium | Support force-cleanup of a single track's worktree (FR-008). Re-create the worktree from the integration branch head and re-assign a fresh agent. Preserve the failed agent's logs for diagnosis (FR-025). |

---

## 9. Phasing

### Phase 1: MVP (Milestone 1)

**Goal**: Prove that parallel worktree execution works end-to-end for independent specs with basic merge-back.

| Capability | Requirements |
|------------|--------------|
| Worktree creation and cleanup | FR-001 through FR-006 |
| Basic fan-out (all specs independent, no DAG) | FR-010, FR-011 |
| Agent assignment with turn budgets | FR-018 through FR-022 |
| Sequential merge-back with auto-resolve for trivial conflicts | FR-026 through FR-030 |
| Track isolation enforcement | FR-036, NFR-008 |
| Basic progress tracking | FR-041, FR-042 |
| State persistence for crash recovery | NFR-004, NFR-010 |

**Exit Criteria**: A 3-spec request with independent specs executes in parallel and merges cleanly, with >= 40% wall-clock reduction vs. sequential.

### Phase 2: Dependency-Aware Scheduling (Milestone 2)

**Goal**: Support partially-dependent workloads with mixed-mode scheduling and smarter conflict resolution.

| Capability | Requirements |
|------------|--------------|
| DAG-based dependency analysis | FR-010 (enhanced), FR-012, FR-013, FR-016 |
| Mixed-mode scheduling | FR-013, FR-014, FR-015 |
| AI-assisted conflict resolution | FR-032, FR-033, FR-034 |
| Integration test failure attribution | FR-031 |
| Database migration sequencing | FR-037 |
| Stall detection and alerting | FR-044, FR-045 |
| Estimated time remaining | FR-043 |
| Complexity-based turn budgets | FR-023 |

**Exit Criteria**: A 5-spec request with 2 dependent chains and 3 independent specs executes with correct ordering, AI-resolves at least one conflict, and achieves >= 55% wall-clock reduction.

### Phase 3: Full Engine (Milestone 3)

**Goal**: Production-grade robustness, observability, and optimization.

| Capability | Requirements |
|------------|--------------|
| Interface contract validation | FR-038, FR-039, FR-040 |
| Agent execution logging and post-mortem | FR-025 |
| Incremental merge (merge as tracks complete) | FR-035 |
| Priority-based scheduling | FR-017 |
| Shallow/sparse worktree optimization | FR-009 |
| Dashboard view | FR-046 |
| Full crash recovery and idempotent resume | NFR-010, NFR-011 |

**Exit Criteria**: Engine handles 10+ spec requests with complex dependency graphs, achieves all success metric targets, and recovers cleanly from injected failures.

---

## 10. Open Questions

| # | Question | Impact | Owner | Status |
|---|----------|--------|-------|--------|
| OQ-1 | How should cross-request file conflicts be handled? If Request A and Request B both modify `src/auth.ts` in separate worktrees, who wins? Should the orchestrator serialize such requests, or should the engine handle cross-request merge? | Determines whether this engine needs cross-request awareness or if serialization is handled upstream. | Pipeline Core team | Open |
| OQ-2 | What is the maximum practical repository size for worktree-based parallelism? At what repo size do we need to switch to sparse checkouts or a different isolation strategy? | Determines FR-009 priority and whether sparse checkout is MVP or post-MVP. | Platform team | Open |
| OQ-3 | Should the AI conflict resolver have access to git history (blame, log) for context, or only the spec and the conflicting hunks? More context improves accuracy but increases token cost. | Affects AI resolver architecture and cost projections. | Agent Framework team | Open |
| OQ-4 | How should the engine handle specs that are discovered to be dependent only after execution begins (e.g., Track A unexpectedly modifies a file that Track B also needs)? The DAG was wrong. | Determines whether we need runtime dependency detection or if we accept this as a decomposition quality issue. | Decomposition Engine team | Open |
| OQ-5 | What is the retry policy for integration test failures? If Track X is sent back for revision and fails again, how many cycles before the entire request is abandoned or escalated? | Affects the feedback loop design and prevents infinite revision cycles. | Pipeline Core team | Open |
| OQ-6 | Should worktrees share a common git object store (the default `git worktree` behavior) or should they use separate clones for stronger isolation? Shared object stores save disk but create a single point of corruption. | Determines worktree creation strategy and disk usage projections. | Platform team | Open |
| OQ-7 | How should the engine interact with external services during parallel execution? If Track A and Track B both need to call an external API or database during testing, do they share the same test environment or need isolated ones? | Determines test environment provisioning requirements. | Infrastructure team | Open |
| OQ-8 | What is the expected frequency of non-trivial merge conflicts in practice? If most decompositions produce truly independent specs, the AI conflict resolver may rarely be needed. Conversely, if conflicts are frequent, it becomes critical path. | Affects Phase 2 prioritization. Needs data from early Phase 1 usage. | Data from Phase 1 | Open |

---

## Appendix A: Worktree Directory Layout

```
repo-root/
  .worktrees/
    req-abc123/
      track-auth-service/          # worktree for auth service spec
        .git                       # linked to main repo's git dir
        src/
        tests/
        ...
      track-payment-api/           # worktree for payment API spec
        .git
        src/
        tests/
        ...
      track-notification-worker/   # worktree for notification spec
        .git
        src/
        tests/
        ...
    req-def456/
      track-dashboard-ui/
        ...
```

## Appendix B: Branch Naming and Merge Flow

```
main
  |
  +-- auto/req-abc123/integration     (integration branch for request)
        |
        +-- auto/req-abc123/track-auth-service
        +-- auto/req-abc123/track-payment-api
        +-- auto/req-abc123/track-notification-worker
```

**Merge flow (3 independent tracks):**

```
1. Create integration branch from main
2. Create track branches from integration branch
3. Agents execute in parallel on track branches
4. All agents complete
5. Merge track-auth-service into integration (--no-commit, validate, commit)
6. Merge track-payment-api into integration (--no-commit, validate, commit)
7. Merge track-notification-worker into integration (--no-commit, validate, commit)
8. Run full test suite on integration branch
9. If tests pass: PR integration branch -> main
10. If tests fail: identify failing track(s), send back for revision
```

**Merge flow (mixed mode: A independent, B depends on A, C independent):**

```
1. Create integration branch from main
2. Create track branches from integration branch
3. Execute Track A and Track C in parallel
4. Both complete
5. Merge Track A into integration
6. Merge Track C into integration
7. Create Track B branch from integration (now includes A's changes)
8. Execute Track B
9. Track B completes
10. Merge Track B into integration
11. Run full test suite
12. PR integration branch -> main
```

## Appendix C: Track State Machine

```
                    +----------+
                    | pending  |
                    +----+-----+
                         |
                    +----v-----+
              +---->|  queued  |  (waiting for parallelism slot)
              |     +----+-----+
              |          |
              |     +----v------+
              |     | executing |
              |     +----+------+
              |          |
              |     +----v-----+
              |     | testing  |
              |     +----+-----+
              |          |
              |     +----v-------+
              |     | reviewing  |
              |     +----+-------+
              |          |
              |     +----v-----+
              |     | merging  |
              |     +----+-----+
              |          |
              |     +----v-------+
              |     | complete   |
              |     +------------+
              |
              |     +--------+      +------------+
              +-----|  failed |----->| escalated  |
                    +--------+      +------------+
                    (retry once,
                     then escalate)
```

## Appendix D: Configuration Defaults

| Parameter | Default | Description |
|-----------|---------|-------------|
| `parallel.max_worktrees` | 5 | Maximum concurrent worktrees across all requests. |
| `parallel.max_tracks` | 3 | Maximum simultaneously executing parallel tracks per request. |
| `parallel.disk_warning_threshold` | 2 GB | Emit warning when aggregate worktree disk usage exceeds this. |
| `parallel.disk_hard_limit` | 5 GB | Refuse to create new worktrees when aggregate usage exceeds this. |
| `parallel.stall_timeout_minutes` | 15 | Minutes without phase advancement before a track is flagged as stalled. |
| `parallel.agent_turn_budget.small` | 30 | Turn budget for small-complexity specs. |
| `parallel.agent_turn_budget.medium` | 60 | Turn budget for medium-complexity specs. |
| `parallel.agent_turn_budget.large` | 120 | Turn budget for large-complexity specs. |
| `parallel.conflict_ai_confidence_threshold` | 0.85 | Minimum confidence for AI conflict resolution; below this, escalate. |
| `parallel.worktree_cleanup_delay_seconds` | 300 | Seconds to wait after track completion before worktree removal (allows inspection). |

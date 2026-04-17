# PLAN-006-3: Agent Assignment and Isolation

## Metadata
- **Parent TDD**: TDD-006-parallel-execution
- **Estimated effort**: 4 days
- **Dependencies**: [PLAN-006-1-worktree-management, PLAN-006-2-dag-scheduling]
- **Blocked by**: [PLAN-006-1-worktree-management] (needs WorktreeManager for worktree paths), [PLAN-006-2-dag-scheduling] (needs Scheduler dispatch callbacks)
- **Priority**: P0

## Objective

Implement the agent spawning, worktree assignment, filesystem isolation enforcement, turn budget management, and retry policy for parallel track execution. This plan covers the strict 1:1 mapping between agents and worktrees, the context bundle preparation that gives each agent its spec and relevant documents, the PostToolUse hook that prevents agents from escaping their worktree sandbox, and the retry/escalation logic for failed agents.

## Scope

### In Scope
- `TrackAssignment` data model: track-to-worktree-to-agent mapping (TDD 3.4.1)
- Agent spawning: Claude Code subagent session creation with correct working directory and context (TDD 3.4.2)
- Context bundle preparation: spec file, parent plan/TDD/PRD, turn budget, interface contracts, shared type definitions (TDD 3.4.2)
- Filesystem isolation hook (PostToolUse): path validation ensuring all file access resolves within the assigned worktree (TDD 3.4.3)
- Git isolation: verification that each worktree has independent HEAD/index/working tree (TDD 3.4.3)
- Turn budget enforcement: complexity-based defaults (small=30, medium=60, large=120), 90% warning, termination at budget exhaustion (TDD 3.4.4)
- Retry policy: one retry with fresh agent in same worktree after `git reset --hard HEAD && git clean -fd`, escalation on second failure (TDD 3.4.5)
- Agent lifecycle: spawn, execute, self-test, self-review, commit, signal complete (TDD 3.4.2)
- Agent liveness monitoring: process/session status check every 30 seconds (TDD 3.1.4)
- Cross-track communication constraints: no mutable shared state, pre-execution shared types only (TDD 3.7.1)
- Interface contract extraction and pre-commit of shared types to integration branch (TDD 3.7.2, 5.1)
- Events: `agent.spawned`, `agent.completed`, `agent.failed`, `agent.budget_warning`, `security.isolation_violation`

### Out of Scope
- DAG construction and scheduling decisions (PLAN-006-2)
- Merge-back after agent completion (PLAN-006-4)
- Integration testing and failure attribution (PLAN-006-5)
- Container-based isolation (Phase 3+ consideration per TDD 9.4)
- Agent tool allowlist beyond filesystem isolation (broader scope than this engine)

## Tasks

1. **Define TrackAssignment and agent-related types** -- Create the data model for tracking the agent-to-worktree-to-spec mapping.
   - Files to create/modify:
     - `src/parallel/types.ts` (modify -- add agent types)
   - Acceptance criteria:
     - `TrackAssignment` interface matches TDD 3.4.1: `trackName`, `worktreePath`, `branchName`, `agentSessionId`, `spec`, `parentPlan`, `parentTDD`, `parentPRD`, `turnBudget`, `turnsUsed`, `retryCount`
     - `AgentLifecyclePhase` enum: `spawning`, `executing`, `testing`, `reviewing`, `committing`, `complete`, `failed`
     - `InterfaceContract` interface matches TDD 3.7.2: `producer`, `consumer`, `contractType`, `definition`
   - Estimated effort: 2 hours

2. **Implement context bundle preparation** -- Build the function that assembles the initial prompt and context for an agent session given a spec and its parent documents.
   - Files to create/modify:
     - `src/parallel/agent-spawner.ts` (new)
   - Acceptance criteria:
     - `prepareContextBundle(assignment)` assembles: the spec file content, parent plan/TDD/PRD excerpts, turn budget with complexity, interface contracts this track must satisfy, and any shared type definitions from the integration branch
     - Context is structured as a prompt template that instructs the agent about its working directory, scope, commit conventions, and turn budget
     - Commit message format follows TDD 3.4.2: includes spec name, request ID, and turns used
     - Context size is bounded (truncate large parent docs to relevant sections)
   - Estimated effort: 4 hours

3. **Implement AgentSpawner: session creation and lifecycle management** -- Build the component that spawns Claude Code subagent sessions in worktree directories and tracks their lifecycle.
   - Files to create/modify:
     - `src/parallel/agent-spawner.ts` (modify)
   - Acceptance criteria:
     - `spawnAgent(assignment)` creates a Claude Code subagent session with CWD set to `assignment.worktreePath`
     - Injects the context bundle as the initial prompt
     - Sets `assignment.agentSessionId` on successful spawn
     - `getAgentStatus(sessionId)` returns current lifecycle phase
     - `terminateAgent(sessionId)` cleanly terminates an agent session
     - Agent completion is detected and reported via callback to the Scheduler
     - Emits `agent.spawned` event on successful spawn
   - Estimated effort: 5 hours

4. **Implement filesystem isolation hook** -- Build the PostToolUse hook that validates all file paths accessed by an agent resolve within its assigned worktree.
   - Files to create/modify:
     - `src/parallel/isolation-hook.ts` (new)
   - Acceptance criteria:
     - Hook intercepts all file-related tool calls (Read, Write, Edit, Bash with file args)
     - Resolves the target path relative to the worktree CWD using `path.resolve()`
     - Validates the resolved path starts with `track.worktreePath` (prefix check)
     - Blocks and logs any access outside the worktree boundary
     - Handles path traversal attacks: `../`, symlink following, absolute paths outside worktree
     - Emits `security.isolation_violation` event on blocked access
     - Returns `false` to block the tool call, `true` to allow it
     - Follows the exact validation logic in TDD 3.4.3
   - Estimated effort: 4 hours

5. **Implement turn budget enforcement** -- Build the monitoring that tracks agent turns, issues warnings, and terminates agents that exceed their budget.
   - Files to create/modify:
     - `src/parallel/agent-spawner.ts` (modify -- add budget tracking)
   - Acceptance criteria:
     - Turn count increments on each agent tool call or conversation turn
     - Default budgets from config: small=30, medium=60, large=120 (TDD 3.4.4)
     - At 90% of budget: inject warning message into agent context, emit `agent.budget_warning`
     - At 100% of budget: terminate agent, set track status to `failed` with reason `budget_exhausted`
     - Budget can be overridden per-spec via configuration
   - Estimated effort: 3 hours

6. **Implement agent liveness monitoring** -- Build the periodic check that verifies agents are still running and responsive.
   - Files to create/modify:
     - `src/parallel/agent-spawner.ts` (modify -- add liveness checks)
   - Acceptance criteria:
     - Checks agent process/session status every 30 seconds (TDD 3.1.4)
     - Detects agent crash (process exit, OOM, network failure)
     - On crash detection: inspects worktree for uncommitted work and commits beyond branch point (TDD 3.9.3)
     - Reports agent death to the retry/escalation handler
   - Estimated effort: 3 hours

7. **Implement retry policy and escalation** -- Build the retry logic for failed agents: one retry with worktree reset, then escalation.
   - Files to create/modify:
     - `src/parallel/retry-handler.ts` (new)
   - Acceptance criteria:
     - On first failure: resets worktree (`git reset --hard HEAD && git clean -fd`), spawns fresh agent (TDD 3.4.5)
     - On second failure: marks track as `escalated`, emits escalation event with failure logs
     - Handles three failure modes: agent crash, budget exhaustion, persistent test failures
     - If worktree has commits beyond branch point from crashed agent: preserves partial work, spawns continuation agent
     - If worktree is clean (no changes): re-queues track from scratch
     - `retryCount` tracked in `TrackAssignment` and persisted to state
     - Emits `agent.failed` event with `retryCount` and `reason`
   - Estimated effort: 4 hours

8. **Implement shared types pre-commit** -- Build the function that commits shared type definitions and constants to the integration branch before tracks begin execution.
   - Files to create/modify:
     - `src/parallel/agent-spawner.ts` (modify -- add pre-commit logic)
   - Acceptance criteria:
     - `preCommitSharedTypes(requestId, interfaceContracts)` extracts shared type definitions from specs
     - Creates a temporary worktree for the integration branch (TDD 5.1)
     - Commits shared types with conventional message format
     - Removes the temporary worktree after commit
     - All track worktrees created after this commit will inherit the shared types
   - Estimated effort: 3 hours

9. **Unit and integration tests for agent assignment** -- Test spawning, isolation, budget enforcement, retry, and liveness.
   - Files to create/modify:
     - `tests/parallel/agent-spawner.test.ts` (new)
     - `tests/parallel/isolation-hook.test.ts` (new)
     - `tests/parallel/retry-handler.test.ts` (new)
   - Acceptance criteria:
     - Tests context bundle contains all required components (spec, parents, budget, contracts)
     - Tests filesystem isolation blocks `../` traversal, symlinks, absolute paths outside worktree
     - Tests filesystem isolation allows all paths within worktree
     - Tests turn budget warning at 90%, termination at 100%
     - Tests retry: first failure resets and retries, second failure escalates
     - Tests crash recovery: partial commits preserved, clean state re-queued
     - Tests liveness detection of dead agent
     - Property test: no agent operation produces a file outside its worktree (fuzz paths)
   - Estimated effort: 6 hours

## Dependencies & Integration Points

- **Upstream**: PLAN-006-1 provides `WorktreeManager.createTrackWorktree()` for creating the agent's workspace and `StatePersister` for persisting track assignment state.
- **Upstream**: PLAN-006-2 provides `Scheduler` dispatch callbacks that trigger agent spawning.
- **Downstream**: PLAN-006-4 (Merge/Conflicts) is triggered when an agent signals completion (agent commits to track branch, engine merges to integration).
- **Downstream**: PLAN-006-5 (Progress/Testing) consumes agent lifecycle events for progress reporting and stall detection.
- **External**: Depends on the Claude Code subagent spawning API for session creation. The exact API surface needs to be confirmed during implementation.
- **Cross-track**: Interface contracts extracted here feed into post-merge validation in PLAN-006-4.

## Testing Strategy

- **Unit tests**: Context bundle assembly, path validation logic (extensive edge cases), turn counter, retry state machine.
- **Integration tests**: Spawn a mock agent in a real worktree, verify CWD is correct, verify isolation hook blocks out-of-bounds access, verify cleanup after agent completion.
- **Security tests**: Fuzz the isolation hook with adversarial paths: `../../../../etc/passwd`, symlinks pointing outside worktree, Unicode path tricks, null bytes.
- **Property-based tests**: For any randomly generated file path, the isolation hook correctly classifies it as inside or outside the worktree.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Claude Code subagent API may not support CWD scoping natively | Medium | High -- core requirement | Prototype early; if CWD is not natively scoped, wrap all tool calls with path prefix |
| Symlink traversal bypasses path-prefix isolation check | Medium | High -- security violation | Resolve all symlinks before prefix check; block symlink creation in worktree |
| Agent context bundle too large for single prompt | Low | Medium | Truncate parent docs to relevant sections; use progressive disclosure |
| Turn budget too aggressive for complex specs | Medium | Medium -- premature termination | Monitor turn usage in early runs; adjust defaults based on empirical data |
| Race condition between liveness check and agent natural completion | Low | Low | Agent signals completion before liveness check marks it dead; check for completion signal before declaring crash |

## Definition of Done

- [ ] TrackAssignment maps agents 1:1 to worktrees with full lifecycle tracking
- [ ] Context bundle includes spec, parent docs, turn budget, interface contracts, and shared types
- [ ] Agent spawns in correct worktree directory with injected context
- [ ] PostToolUse isolation hook blocks all file access outside the assigned worktree
- [ ] Isolation hook handles path traversal attacks (../, symlinks, absolute paths)
- [ ] Turn budget enforced: warning at 90%, termination at 100%
- [ ] Agent liveness monitored every 30 seconds
- [ ] Retry policy: one retry with worktree reset, escalation on second failure
- [ ] Shared types pre-committed to integration branch before track execution
- [ ] All events emitted per TDD Appendix B (agent.spawned, agent.completed, agent.failed, agent.budget_warning, security.isolation_violation)
- [ ] All unit, integration, and security tests pass

# PLAN-006-4: Merge-Back Engine and Conflict Resolution

## Metadata
- **Parent TDD**: TDD-006-parallel-execution
- **Estimated effort**: 5 days
- **Dependencies**: [PLAN-006-1-worktree-management, PLAN-006-2-dag-scheduling, PLAN-006-3-agent-assignment]
- **Blocked by**: [PLAN-006-1-worktree-management] (needs branch operations), [PLAN-006-2-dag-scheduling] (needs DAG-ordered merge sequence)
- **Priority**: P0

## Objective

Implement the merge-back engine that integrates completed track branches into the integration branch in DAG-topological order, with conflict classification, automatic resolution for trivial conflicts, AI-assisted resolution for moderate conflicts, human escalation for complex conflicts, and rollback procedures for failed merges. This is the critical convergence point where parallel work recombines into a coherent codebase.

## Scope

### In Scope
- DAG-ordered merge sequencing within clusters (TDD 3.5.1)
- Merge sequence using `git merge --no-commit --no-ff` with inspection before finalization (TDD 3.5.2)
- Merge abort (`git merge --abort`) on any failure during conflict resolution (TDD 3.5.2)
- Conflict classification: disjoint files, non-overlapping hunks, overlapping compatible, overlapping conflicting, structural (TDD 3.5.3)
- Auto-resolve for non-overlapping hunks using stage extraction (TDD 3.5.3)
- AI conflict resolution agent: spawn specialized subagent with base/ours/theirs content and both specs (TDD 3.5.3)
- Confidence threshold enforcement: accept AI resolution only if >= `conflict_ai_confidence_threshold` (default 0.85) (TDD 3.5.3)
- Human escalation with structured conflict report (TDD 3.5.3)
- Conflict resolution logging: `ConflictRecord` for every resolution (TDD 3.5.4)
- `MergeResult` data model for tracking merge outcomes (TDD 4.3)
- Rollback procedures: single track merge revert, full integration branch reset (TDD 6.2)
- Circuit breakers: merge conflict breaker (> 5 unresolved conflicts escalates entire request) (TDD 6.3)
- Interface contract validation after merge-back (TDD 3.7.2)
- Database migration sequence validation after merge-back (TDD 3.7.3)
- Events: `merge.started`, `merge.conflict_detected`, `merge.conflict_resolved`, `merge.completed`, `merge.failed`

### Out of Scope
- Worktree creation/cleanup mechanics (PLAN-006-1)
- DAG construction and scheduling (PLAN-006-2)
- Agent execution within worktrees (PLAN-006-3)
- Integration test execution and failure attribution (PLAN-006-5)
- Incremental merge (merge as each track completes rather than batch per cluster -- Phase 3, TDD Section 10)

## Tasks

1. **Define merge-related types** -- Create TypeScript interfaces for merge results, conflict records, and conflict resolution requests/results.
   - Files to create/modify:
     - `src/parallel/types.ts` (modify -- add merge types)
   - Acceptance criteria:
     - `MergeResult` matches TDD 4.3: `trackName`, `integrationBranch`, `trackBranch`, `mergeCommitSha`, `conflictCount`, `conflicts`, `resolutionStrategy`, `resolutionDurationMs`, `timestamp`
     - `ConflictDetail` includes `file`, `conflictType`, `resolution`, `confidence`
     - `ConflictRecord` matches TDD 3.5.4: `id`, `requestId`, `file`, `trackA`, `trackB`, `conflictType`, `resolutionStrategy`, `aiConfidence`, `resolution`, `integrationTestsPassed`, `timestamp`
     - `ConflictResolutionRequest` and `ConflictResolutionResult` match TDD 3.5.3
     - Conflict type enum: `disjoint`, `non-overlapping`, `overlapping-compatible`, `overlapping-conflicting`, `structural`
   - Estimated effort: 2 hours

2. **Implement merge ordering logic** -- Build the function that determines the correct merge order for tracks within a cluster based on DAG topology.
   - Files to create/modify:
     - `src/parallel/merge-engine.ts` (new)
   - Acceptance criteria:
     - `computeMergeOrder(cluster, dag)` returns an ordered list of track names
     - Nodes with outgoing edges (dependents waiting) merge first (TDD 3.5.1)
     - Among equally-connected nodes, alphabetical order for determinism
     - For the worked example: Cluster 0 merges Track-A before Track-C (since Track-B depends on A)
   - Estimated effort: 2 hours

3. **Implement core merge sequence** -- Build the merge function that executes the `git merge --no-commit --no-ff` flow with inspection.
   - Files to create/modify:
     - `src/parallel/merge-engine.ts` (modify)
   - Acceptance criteria:
     - `mergeTrack(requestId, trackName, integrationBranch)` executes the exact git sequence from TDD 3.5.2
     - Uses `--no-commit --no-ff` so the engine inspects before finalizing
     - Detects conflicts via `git diff --name-only --diff-filter=U`
     - On clean merge: commits with conventional message including track name, request ID, conflict count
     - On conflict: delegates to conflict resolution pipeline
     - On any failure: calls `git merge --abort` to restore integration branch
     - Emits `merge.started` at beginning, `merge.completed` or `merge.failed` at end
     - Returns `MergeResult` with full details
   - Estimated effort: 5 hours

4. **Implement conflict classification** -- Build the classifier that categorizes each conflicting file by type.
   - Files to create/modify:
     - `src/parallel/conflict-classifier.ts` (new)
   - Acceptance criteria:
     - `classifyConflict(file, requestId)` returns the conflict type and confidence
     - Extracts base (stage 1), ours (stage 2), and theirs (stage 3) via `git show :N:<file>`
     - **Disjoint files**: detected when git auto-merged successfully (no conflict markers)
     - **Non-overlapping hunks**: same file, different regions; conflict due to context overlap
     - **Overlapping compatible**: same region but specs describe complementary changes (needs heuristic or AI assessment)
     - **Overlapping conflicting**: same region, contradictory intent
     - **Structural**: file reorganization (function moves, module renames)
     - Classification is deterministic for the same input
   - Estimated effort: 5 hours

5. **Implement auto-resolve for non-overlapping conflicts** -- Build the automatic resolution for trivial conflicts where changes are in different regions of the same file.
   - Files to create/modify:
     - `src/parallel/conflict-resolver.ts` (new)
   - Acceptance criteria:
     - `autoResolve(file, requestId)` attempts to merge non-overlapping hunks
     - Extracts base, ours, and theirs versions using git stage commands (TDD 3.5.3)
     - Applies both sets of changes to the base when hunks do not overlap
     - On success: stages the resolved file with `git add`, returns confidence 0.95
     - On failure (hunks actually overlap): delegates to AI resolution
     - Records the resolution in the conflict log
     - Emits `merge.conflict_resolved` with strategy `auto`
   - Estimated effort: 4 hours

6. **Implement AI conflict resolution agent** -- Build the specialized subagent that resolves overlapping conflicts using both specs as context.
   - Files to create/modify:
     - `src/parallel/conflict-resolver.ts` (modify -- add AI resolution)
   - Acceptance criteria:
     - `aiResolve(request: ConflictResolutionRequest)` spawns a conflict resolution subagent
     - Provides the agent with: base content, ours content, theirs content, both specs, relevant interface contracts (TDD 3.5.3)
     - Agent returns `ConflictResolutionResult`: resolved content, confidence score, reasoning, strategy
     - If confidence >= `conflict_ai_confidence_threshold` (0.85): accept resolution, stage file
     - If confidence < threshold: escalate to human
     - Emits `merge.conflict_detected` when conflict found, `merge.conflict_resolved` when resolved
     - Turn budget for conflict resolution agent is separate and bounded (e.g., 10 turns)
   - Estimated effort: 5 hours

7. **Implement human escalation** -- Build the escalation report generator for conflicts that cannot be auto- or AI-resolved.
   - Files to create/modify:
     - `src/parallel/conflict-resolver.ts` (modify -- add escalation)
   - Acceptance criteria:
     - `escalateConflict(file, requestId, trackA, trackB, aiResult?)` generates a structured escalation report
     - Report format matches TDD 3.5.3 JSON schema: includes both track contents, spec intents, AI suggestion (if available), AI confidence, reasoning
     - Report written to `.autonomous-dev/conflicts/req-{id}/conflict-{N}.json`
     - Emits escalation event with report reference
     - Aborts the merge (`git merge --abort`) when escalation is triggered
   - Estimated effort: 3 hours

8. **Implement merge circuit breaker** -- Build the circuit breaker that escalates the entire request when too many conflicts accumulate.
   - Files to create/modify:
     - `src/parallel/merge-engine.ts` (modify -- add circuit breaker)
   - Acceptance criteria:
     - Tracks cumulative unresolved conflict count per request
     - When count exceeds `merge_conflict_escalation_threshold` (default 5): pauses all merging, escalates entire request (TDD 6.3)
     - Emits `request.escalated` with reason and list of unresolved conflicts
   - Estimated effort: 2 hours

9. **Implement rollback procedures** -- Build the functions to revert a single track merge or reset the entire integration branch.
   - Files to create/modify:
     - `src/parallel/merge-engine.ts` (modify -- add rollback)
   - Acceptance criteria:
     - `rollbackTrackMerge(requestId, trackName)` finds the merge commit via `git log --merges --grep` and reverts it with `git revert -m 1` (TDD 6.2)
     - `rollbackIntegration(requestId)` resets the integration branch to its pre-merge state using `git reset --hard` (TDD 6.2)
     - Rollback is only performed on engine-managed branches (auto/ prefix safety check)
     - Both operations are logged and state persisted
   - Estimated effort: 3 hours

10. **Implement interface contract validation** -- Build the post-merge validation that checks interface contracts between tracks are satisfied.
    - Files to create/modify:
      - `src/parallel/contract-validator.ts` (new)
    - Acceptance criteria:
      - `validateContracts(requestId, contracts)` runs after all tracks in a cluster are merged
      - Checks type definitions: producer's exported type matches consumer's import (TDD 3.7.2)
      - Checks function signatures: arity and type compatibility
      - Checks API endpoints: route existence in merged codebase
      - Produces a reconciliation report listing any failures
      - Contract failures do not abort the merge but are reported for revision
    - Estimated effort: 4 hours

11. **Implement database migration sequence validation** -- Build the post-merge check that verifies migration files are correctly sequenced.
    - Files to create/modify:
      - `src/parallel/contract-validator.ts` (modify -- add migration validation)
    - Acceptance criteria:
      - `validateMigrationSequence(requestId, migrationDir)` checks for gaps, duplicates, and ordering (TDD 3.7.3)
      - Renumbers migration files if necessary to maintain contiguous sequence
      - Logs any renumbering for auditability
    - Estimated effort: 2 hours

12. **Unit and integration tests for merge engine** -- Test merge ordering, conflict classification, resolution strategies, and rollback.
    - Files to create/modify:
      - `tests/parallel/merge-engine.test.ts` (new)
      - `tests/parallel/conflict-classifier.test.ts` (new)
      - `tests/parallel/conflict-resolver.test.ts` (new)
      - `tests/parallel/contract-validator.test.ts` (new)
    - Acceptance criteria:
      - Tests merge ordering with the TDD worked example (A before C in Cluster 0)
      - Tests clean merge (no conflicts) end-to-end in a real git repo
      - Tests non-overlapping hunk auto-resolve with known file samples
      - Tests AI resolution mock: confidence above threshold accepted, below threshold escalated
      - Tests escalation report format matches TDD schema
      - Tests circuit breaker triggers at configured threshold
      - Tests rollback: single track revert, full integration reset
      - Tests `git merge --abort` on resolution failure
      - Tests merge idempotency: merging same track twice does not change integration branch
      - Tests interface contract validation: passing and failing contracts
      - Tests migration sequence validation: contiguous, gaps, duplicates
    - Estimated effort: 7 hours

## Dependencies & Integration Points

- **Upstream**: PLAN-006-1 provides branch operations (`git checkout`, `git merge`, `git revert`) and worktree cleanup after merge.
- **Upstream**: PLAN-006-2 provides DAG topology for determining merge order and cluster completion signals that trigger merge-back.
- **Upstream**: PLAN-006-3 provides completed track branches with agent commits ready for merging.
- **Downstream**: PLAN-006-5 consumes merge events for progress reporting and triggers integration testing after all merges in a request complete.
- **Integration**: The merge engine is called by the Scheduler (PLAN-006-2) at cluster boundaries. After merging a cluster, the Scheduler creates worktrees for the next cluster from the updated integration branch.

## Testing Strategy

- **Unit tests**: Merge ordering logic, conflict classification against known file samples, auto-resolve hunk extraction, circuit breaker trigger conditions, rollback correctness.
- **Integration tests**: Real git repo with two branches modifying the same file -- test clean merge, non-overlapping conflict auto-resolve, and merge abort on failure.
- **Mock tests**: AI resolver with canned responses at various confidence levels. Verify threshold enforcement.
- **Property-based tests**: Merge idempotency (merging the same track twice is a no-op on integration branch).
- **Scenario tests**: TDD worked example end-to-end: 3 tracks, merge A then C (Cluster 0), then merge B (Cluster 1).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Non-overlapping hunk detection is imprecise for complex diffs | Medium | Medium -- false positives escalate unnecessarily | Use git's own merge machinery as first pass; only custom-merge when git reports conflict |
| AI conflict resolver produces subtly incorrect merges | Medium | High -- silent bugs in integrated code | Integration tests catch most issues; confidence threshold is conservative (0.85); human review on low confidence |
| Merge order within a cluster affects conflict outcomes (order-dependent resolution) | Low | Medium | Deterministic ordering (TDD 3.5.1) ensures reproducibility; rollback + reorder is possible |
| `git merge --abort` may fail if the repository is in an unexpected state | Low | High -- stuck integration branch | Fallback: `git reset --hard` to pre-merge commit (known good state from state log) |
| Circuit breaker false positives: many small, easily-resolved conflicts trigger premature escalation | Low | Medium | Count only unresolved conflicts (after auto/AI resolution) toward the threshold |

## Definition of Done

- [ ] Merge ordering follows DAG topology with deterministic tiebreaking
- [ ] Merge uses `--no-commit --no-ff` with inspection before every commit
- [ ] `git merge --abort` called on any failure during resolution
- [ ] Conflict classifier correctly categorizes all five conflict types from TDD 3.5.3
- [ ] Auto-resolve handles non-overlapping hunks with confidence 0.95
- [ ] AI resolver spawns subagent with correct context, enforces confidence threshold
- [ ] Human escalation produces structured report matching TDD format
- [ ] Circuit breaker pauses merging at configured conflict threshold
- [ ] Rollback works for single track and full integration reset
- [ ] Interface contract validation runs after cluster merge
- [ ] Database migration sequence validated and renumbered if needed
- [ ] Every conflict resolution recorded in `ConflictRecord` for auditing
- [ ] All merge events emitted per TDD Appendix B
- [ ] All unit, integration, and property-based tests pass

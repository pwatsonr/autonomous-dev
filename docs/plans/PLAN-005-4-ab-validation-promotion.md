# PLAN-005-4: A/B Validation & Human-Approved Promotion

## Metadata
- **Parent TDD**: TDD-005-agent-factory
- **Estimated effort**: 10 days
- **Dependencies**: PLAN-005-1 (Agent Registry Foundation), PLAN-005-2 (Metrics & Observation), PLAN-005-3 (Improvement Lifecycle)
- **Blocked by**: PLAN-005-3
- **Priority**: P1
- **Risk Level**: Medium

## Objective

Build the A/B testing framework that validates proposed agent modifications by running both current and proposed versions on historical inputs with blind scoring, and implement the human-approved promotion workflow that commits validated improvements to git. After this plan, the full Phase 2 improvement lifecycle is operational: observation -> analysis -> proposal -> meta-review -> A/B validation -> human-approved promotion (or rejection).

This plan also delivers the domain gap detection logging, the manual comparison CLI, and the Phase 2 CLI commands for promoting, rejecting, and inspecting proposals.

## Scope

### In Scope

- A/B Evaluation Protocol: all 7 steps from TDD 3.5.1 (input selection, current agent run, proposed agent run, label randomization, blind scoring with median-of-3, de-randomization, aggregate decision)
- A/B Evaluation Result schema (`ABEvaluationResult`, `ABInput`, `DimensionScores`, `ABAggregate`) (TDD 3.5.2)
- Blind scoring integrity: reviewer cannot determine which output is current vs. proposed (TDD 3.5.1 Step 4-5)
- Decision logic: positive (60%+ wins, delta > 0), negative (40%+ losses or delta < -0.2), inconclusive (TDD 3.5.1 Step 7)
- Token budget enforcement for validation runs (TDD 3.7.3, configurable default 100,000)
- Manual A/B comparison: `agent compare <name> --version-a X --version-b Y [--inputs N]` (TDD 3.5.3)
- Human-approved promotion workflow (Phase 1-2 behavior from TDD 3.4.8)
- Promotion commit: write new agent definition, update version_history, commit with convention, reload registry (TDD 3.4.8)
- Rejection workflow: reject proposal, log reason, agent returns to ACTIVE (TDD 3.4.8)
- Agent state transitions: UNDER_REVIEW -> VALIDATING -> PROMOTED/REJECTED (TDD 2.2)
- Domain gap detection and logging to `data/domain-gaps.jsonl` (TDD 3.7.1)
- Evaluation result storage at `data/evaluations/` (TDD 3.5.3)
- CLI commands: `agent promote`, `agent reject`, `agent compare`, `agent accept`, `agent gaps` (TDD 5.1)
- ImprovementLifecycle API: `runABValidation()`, `promote()`, `reject()` (TDD 5.2)
- Semver commit message conventions (TDD 3.6.2)

### Out of Scope

- Canary phase (PLAN-005-5)
- Autonomous promotion (PLAN-005-5)
- Dynamic agent creation pipeline (PLAN-005-5) -- domain gaps are logged but creation is not triggered
- Agent compatibility tracking (PLAN-005-5)
- Pipeline-level re-validation on agent change (PLAN-005-5)

## Tasks

1. **Historical input selector** -- Select appropriate historical inputs for A/B testing based on the weakness report and agent history.
   - Files to create: `src/agent-factory/validation/input-selector.ts`
   - Acceptance criteria: Queries metrics database for the agent's past production invocations. Selects 3-5 inputs per TDD 3.5.1 Step 1: at least 1 below-median input, at least 1 above-median input, at least 1 from the domain identified in the weakness report (if applicable). Records selected input hashes for audit trail. Returns error if fewer than 3 historical inputs exist (minimum input enforcement).
   - Estimated effort: 6 hours

2. **Blind runner** -- Execute both current and proposed agent versions on selected inputs.
   - Files to create: `src/agent-factory/validation/blind-runner.ts`
   - Acceptance criteria: For each selected input, invokes the current agent version (records output as "version_A") and the proposed agent version (records output as "version_B"). Does NOT reuse historical outputs; re-runs both versions. Records wall clock time and token consumption per run. Tags invocations with environment "validation" in metrics. Tracks cumulative token consumption against budget.
   - Estimated effort: 8 hours

3. **Label randomizer** -- Randomize which output is presented as "Output 1" vs "Output 2" to the scorer.
   - Files to create: `src/agent-factory/validation/randomizer.ts`
   - Acceptance criteria: For each input, randomly assigns version_A/version_B to Output 1/Output 2. Stores the mapping for later de-randomization. Uses cryptographically secure random source. Mapping is not accessible to the scoring component.
   - Estimated effort: 2 hours

4. **Blind scorer** -- Invoke the appropriate reviewer agent to score both outputs without knowing which is current vs. proposed.
   - Files to create: `src/agent-factory/validation/blind-scorer.ts`
   - Acceptance criteria: Selects the appropriate reviewer agent based on the target agent's role (doc-reviewer for authors, quality-reviewer for executors, architecture-reviewer for design agents). Provides the reviewer with: the original input, "Output 1" and "Output 2" (in randomized order), and the agent's evaluation_rubric. Reviewer scores each output on every rubric dimension (1.0 - 5.0) and provides free-text comparison. Scoring repeated 3 times per input (median taken). Tags scoring invocations with environment "validation".
   - Estimated effort: 10 hours

5. **De-randomizer and comparator** -- Map scores back to version labels and compute comparison results.
   - Files to create: `src/agent-factory/validation/comparator.ts`
   - Acceptance criteria: Uses stored randomization mapping to assign scores back to version_A (current) and version_B (proposed). For each input, computes: per-dimension score delta (proposed - current), overall score delta (mean of dimension deltas), win/loss/tie (proposed wins if delta > 0.2, current wins if delta < -0.2, tie otherwise). Computes scoring variance across the 3 rounds. Produces `ABInput` records per TDD 3.5.2.
   - Estimated effort: 4 hours

6. **Aggregate decision engine** -- Determine the validation verdict from per-input comparison results.
   - Files to create: `src/agent-factory/validation/decision-engine.ts`
   - Acceptance criteria: Computes: proposed win count, current win count, tie count, mean delta across all inputs, per-dimension improvement/regression. Decision: POSITIVE if proposed wins on 60%+ of inputs AND mean delta > 0; NEGATIVE if proposed loses on 40%+ of inputs OR mean delta < -0.2; INCONCLUSIVE otherwise. Produces `ABAggregate` with human-readable recommendation summary. Stores complete `ABEvaluationResult` at `data/evaluations/<evaluation_id>.json`.
   - Estimated effort: 4 hours

7. **A/B validation orchestrator** -- Coordinate the full 7-step A/B protocol end to end.
   - Files to create: `src/agent-factory/validation/orchestrator.ts`
   - Acceptance criteria: Implements `runABValidation()` from the ImprovementLifecycle API. Orchestrates: input selection -> current run -> proposed run -> randomization -> blind scoring (3x per input) -> de-randomization -> aggregate decision. Tracks total token consumption; aborts if validation-token-budget exceeded. Updates proposal status: `validating` -> `validated_positive` or `validated_negative`. Handles partial failure gracefully (e.g., one scoring round fails -> use remaining 2 rounds).
   - Estimated effort: 8 hours

8. **Token budget enforcement** -- Track and enforce the per-validation-run token budget.
   - Files to modify: `src/agent-factory/validation/orchestrator.ts`
   - Acceptance criteria: Configurable budget (default 100,000 tokens). Tracks cumulative input + output tokens across all agent runs and scoring rounds. If budget exceeded mid-validation: abort gracefully, mark result as inconclusive with reason "token_budget_exceeded", do not proceed to promotion. Budget remaining is visible during the run.
   - Estimated effort: 3 hours

9. **Human-approved promotion workflow** -- Enable operator to review and promote validated proposals.
   - Files to create: `src/agent-factory/promotion/promoter.ts`
   - Acceptance criteria: Presents operator with: the proposal diff, the weakness report, the A/B comparison results (per-input scores for both versions), and the meta-reviewer findings. On `agent promote <name> <version>`: writes new agent definition to `.md` file, updates `version` and `version_history` in frontmatter, commits with convention message (`feat(agents): update <name> v<old> -> v<new> -- <rationale>` for minor/major, `fix(agents): update...` for patch), reloads registry. State transition: VALIDATING -> PROMOTED -> ACTIVE (new version).
   - Estimated effort: 8 hours

10. **Rejection workflow** -- Enable operator to reject validated proposals.
    - Files to create: `src/agent-factory/promotion/rejector.ts`
    - Acceptance criteria: On `agent reject <name> <version> --reason "<reason>"`: updates proposal status to "rejected", logs rejection reason to audit log, transitions agent state from UNDER_REVIEW/VALIDATING to ACTIVE (current version continues), emits rejection metric event.
    - Estimated effort: 3 hours

11. **Domain gap detection and logging** -- Detect and log domain gaps when no agent matches a task.
    - Files to create: `src/agent-factory/gaps/detector.ts`
    - Acceptance criteria: When `getForTask()` returns no agent above the 0.6 similarity threshold: logs gap to `data/domain-gaps.jsonl` with gap_id, task_domain, task_description, closest_agent, closest_similarity, detected_at, status "detected". Checks rate limit (1 creation per calendar week). Falls back to closest-matching agent with warning injected into pipeline state.
    - Estimated effort: 4 hours

12. **Manual A/B comparison CLI** -- Allow operators to manually compare any two agent versions.
    - Files to modify: `src/agent-factory/cli.ts`
    - Acceptance criteria: `agent compare <name> --version-a X --version-b Y [--inputs N]` follows the same A/B protocol as automated validation. Operator specifies versions and optional input count (default 3, max 5). Results written to `data/evaluations/` and displayed in CLI with per-input breakdown and aggregate verdict.
    - Estimated effort: 6 hours

13. **CLI commands: promote, reject, accept, gaps** -- Implement remaining Phase 2 CLI commands.
    - Files to modify: `src/agent-factory/cli.ts`
    - Acceptance criteria: `agent promote <name> <version>` triggers promotion workflow with confirmation. `agent reject <name> <version> --reason "<reason>"` triggers rejection. `agent accept <name>` accepts a proposed new agent from `data/proposed-agents/` (placeholder for PLAN-005-5 dynamic creation). `agent gaps` lists all detected domain gaps with status.
    - Estimated effort: 6 hours

14. **Agent state transitions: validation and promotion states** -- Extend the registry to support VALIDATING, PROMOTED, REJECTED state transitions.
    - Files to modify: `src/agent-factory/registry.ts`
    - Acceptance criteria: UNDER_REVIEW -> VALIDATING (A/B test initiated, meta-review approved). VALIDATING -> PROMOTED (A/B positive, human approves). VALIDATING -> REJECTED (A/B negative or human rejects). PROMOTED -> ACTIVE (commit succeeds, registry reloads). REJECTED -> ACTIVE (automatic, current version continues). All transitions logged to audit log. Guards enforced per TDD 2.2 table.
    - Estimated effort: 4 hours

## Dependencies & Integration Points

- **PLAN-005-3 (Improvement Lifecycle)**: Produces `meta_approved` proposals that feed into this plan's A/B validation pipeline. Proposal store is shared.
- **PLAN-005-2 (Metrics & Observation)**: MetricsEngine provides historical invocations for input selection. Validation runs produce invocation metrics tagged with environment "validation".
- **PLAN-005-1 (Agent Registry Foundation)**: Registry provides agent invocation via Agent Runtime. Registry reload is triggered after promotion.
- **PLAN-005-5 (Autonomous Capabilities)**: Canary phase and autonomous promotion extend the state machine built in this plan. Domain gap logging feeds into dynamic creation.

## Testing Strategy

**Unit tests:**
- Input selector: verify minimum 3 inputs enforced; verify below-median, above-median, domain-specific selection; verify error when < 3 historical inputs.
- Comparator: verify delta computation; verify win/loss/tie classification with threshold 0.2.
- Decision engine: verify POSITIVE when proposed wins 60%+ with positive mean delta; verify NEGATIVE when proposed loses 40%+ or mean delta < -0.2; verify INCONCLUSIVE for intermediate cases.
- Token budget: verify abort when budget exceeded; verify correct cumulative tracking across runs.
- Version bump: verify commit message uses `feat(agents):` for minor/major and `fix(agents):` for patch.

**Integration tests:**
- Full A/B validation: seed historical invocations -> create proposal -> run A/B validation -> verify 7-step protocol executed in order -> verify evaluation result stored -> verify proposal status updated.
- Blind scoring integrity: verify the scorer receives randomized labels; inspect scoring input to confirm version information is not leaked.
- Minimum input enforcement: attempt A/B validation with 2 historical inputs -> verify system requires at least 3.
- Token budget enforcement: set low token budget (10,000) -> verify A/B validation aborts with inconclusive verdict.
- Full promotion cycle: generate proposal -> meta-approve -> A/B validate (positive) -> promote -> verify git commit -> verify registry reloaded -> verify new version active.
- Rejection cycle: generate proposal -> A/B validate (negative) -> verify proposal rejected -> verify agent returns to ACTIVE.

**A/B Testing Validation (from TDD 8.4):**
- Scoring consistency: run the same A/B comparison 5 times -> verify verdict is consistent across runs (within expected variance).
- Blind scoring: verify scorer cannot determine which output is current vs. proposed from any data in the scoring input.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| A/B validation is expensive in tokens | High | Medium | Token budget enforcement; configurable max inputs (3-5); track per-validation token costs for budget planning |
| Blind scoring is not truly blind if reviewer infers from content style | Medium | Medium | Randomize output order; strip metadata from outputs; monitor scoring variance for bias signals |
| Reviewer agent scoring is inconsistent (high variance) | Medium | Medium | Median-of-3 reduces noise; flag high-variance inputs in results; human reviewer can override |
| Promotion git commit fails due to conflicts | Low | Medium | Abort promotion on commit failure; agent remains at current version; operator can retry |
| Inconclusive verdicts create proposal backlog | Medium | Low | Track inconclusive rate; allow manual override via `agent promote` with acknowledgment; increase input count for retry |

## Definition of Done

- [ ] A/B validation follows all 7 steps of the protocol from TDD 3.5.1
- [ ] Blind scoring integrity verified: scorer cannot determine which output is current vs. proposed
- [ ] Scoring uses median-of-3 rounds to reduce non-determinism
- [ ] Decision logic correctly classifies positive, negative, and inconclusive verdicts
- [ ] Token budget enforcement aborts validation when budget exceeded
- [ ] Minimum 3 historical inputs enforced; error when insufficient data
- [ ] Human-approved promotion writes new agent file, commits to git with convention message, reloads registry
- [ ] Rejection workflow logs reason and returns agent to ACTIVE state
- [ ] Manual A/B comparison CLI works for arbitrary version pairs
- [ ] Domain gaps detected and logged with closest agent and similarity score
- [ ] All CLI commands functional: `promote`, `reject`, `compare`, `accept`, `gaps`
- [ ] All state transitions (VALIDATING, PROMOTED, REJECTED) enforced with guards and audit logging
- [ ] Evaluation results stored at `data/evaluations/`
- [ ] All unit, integration, and security tests pass
- [ ] Phase 2 exit criteria achievable: 5+ proposals generated, 3+ promoted, zero privilege escalation, 70%+ proposals show improvement

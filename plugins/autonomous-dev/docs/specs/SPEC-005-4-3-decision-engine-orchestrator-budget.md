# SPEC-005-4-3: Aggregate Decision Engine, A/B Orchestrator, and Token Budget Enforcement

## Metadata
- **Parent Plan**: PLAN-005-4
- **Tasks Covered**: Task 6 (Aggregate decision engine), Task 7 (A/B validation orchestrator), Task 8 (Token budget enforcement)
- **Estimated effort**: 15 hours

## Description

Implement the aggregate decision engine that determines the validation verdict from per-input comparisons, the orchestrator that coordinates the full 7-step A/B protocol end-to-end, and the token budget enforcement that tracks and limits total token consumption during validation. Together these deliver the `runABValidation()` API from the ImprovementLifecycle interface.

## Files to Create/Modify

### New Files

**`src/agent-factory/validation/decision-engine.ts`**
- Exports: `DecisionEngine` class with `decide(comparisons: ComparisonResult[]): ABAggregate`

**`src/agent-factory/validation/orchestrator.ts`**
- Exports: `ABValidationOrchestrator` class with `runValidation(proposal: AgentProposal): ABEvaluationResult`

### Modified Files

**`src/agent-factory/improvement/types.ts`** (extend)
- Add: `ABEvaluationResult`, `ABAggregate`, `ABVerdict`, `ABInput`

## Implementation Details

### Aggregate Decision Engine (`validation/decision-engine.ts`)

```typescript
type ABVerdict = 'positive' | 'negative' | 'inconclusive';

interface ABAggregate {
  verdict: ABVerdict;
  proposed_wins: number;
  current_wins: number;
  ties: number;
  total_inputs: number;
  mean_delta: number;
  per_dimension_summary: Record<string, DimensionSummary>;
  recommendation: string;        // human-readable summary
}

interface DimensionSummary {
  mean_delta: number;
  improved: boolean;             // mean_delta > 0
  dimension_name: string;
}
```

**Decision rules (TDD 3.5.1 Step 7):**

```typescript
function decide(comparisons: ComparisonResult[]): ABAggregate {
  const total = comparisons.length;
  const proposed_wins = comparisons.filter(c => c.outcome === 'proposed_wins').length;
  const current_wins = comparisons.filter(c => c.outcome === 'current_wins').length;
  const ties = comparisons.filter(c => c.outcome === 'tie').length;
  const mean_delta = mean(comparisons.map(c => c.overall_delta));

  let verdict: ABVerdict;

  // POSITIVE: proposed wins on 60%+ of inputs AND mean delta > 0
  if (proposed_wins / total >= 0.60 && mean_delta > 0) {
    verdict = 'positive';
  }
  // NEGATIVE: proposed loses on 40%+ of inputs OR mean delta < -0.2
  else if (current_wins / total >= 0.40 || mean_delta < -0.2) {
    verdict = 'negative';
  }
  // INCONCLUSIVE: everything else
  else {
    verdict = 'inconclusive';
  }

  // Per-dimension summary
  const dimensions = new Set(comparisons.flatMap(c => Object.keys(c.per_dimension_delta)));
  const per_dimension_summary: Record<string, DimensionSummary> = {};
  for (const dim of dimensions) {
    const deltas = comparisons.map(c => c.per_dimension_delta[dim]).filter(d => d !== undefined);
    const dimMeanDelta = mean(deltas);
    per_dimension_summary[dim] = {
      mean_delta: dimMeanDelta,
      improved: dimMeanDelta > 0,
      dimension_name: dim
    };
  }

  // Recommendation
  const recommendation = generateRecommendation(verdict, proposed_wins, current_wins, ties, total, mean_delta, per_dimension_summary);

  return { verdict, proposed_wins, current_wins, ties, total_inputs: total, mean_delta, per_dimension_summary, recommendation };
}
```

**Recommendation generation:**
- POSITIVE: "Proposed version wins on {N}/{total} inputs with mean quality improvement of {delta}. Recommend proceeding to promotion."
- NEGATIVE: "Proposed version loses on {N}/{total} inputs with mean quality delta of {delta}. Recommend rejecting this proposal."
- INCONCLUSIVE: "Results are inconclusive ({wins}/{losses}/{ties}). Consider increasing input count or manual review."

### A/B Validation Orchestrator (`validation/orchestrator.ts`)

```typescript
interface ABEvaluationResult {
  evaluation_id: string;          // UUID v4
  proposal_id: string;
  agent_name: string;
  started_at: string;
  completed_at: string;
  inputs: ABInput[];
  aggregate: ABAggregate;
  token_consumption: TokenConsumption;
  aborted: boolean;
  abort_reason?: string;
}

interface ABInput {
  input_id: string;
  selection_reason: string;
  version_a_scores: DimensionScores;
  version_b_scores: DimensionScores;
  per_dimension_delta: Record<string, number>;
  overall_delta: number;
  outcome: 'proposed_wins' | 'current_wins' | 'tie';
}

interface TokenConsumption {
  input_selection_tokens: number;
  version_a_run_tokens: number;
  version_b_run_tokens: number;
  scoring_tokens: number;
  total_tokens: number;
  budget: number;
  utilization_percent: number;
}
```

**Orchestration of the 7-step A/B protocol:**

```typescript
async runValidation(proposal: AgentProposal): Promise<ABEvaluationResult> {
  const tokenTracker = new TokenTracker(config.validationTokenBudget); // default 100,000

  // Step 1: Input selection
  const inputs = await inputSelector.selectInputs(proposal.agent_name, weaknessReport);
  tokenTracker.add(/* any tokens used in selection */);

  const abInputs: ABInput[] = [];

  for (const input of inputs) {
    // Step 2: Run current agent
    const currentRun = await blindRunner.runCurrentVersion(input, currentAgent);
    tokenTracker.add(currentRun.input_tokens + currentRun.output_tokens);

    if (tokenTracker.exceeded) {
      return abortResult('token_budget_exceeded', abInputs, tokenTracker);
    }

    // Step 3: Run proposed agent
    const proposedRun = await blindRunner.runProposedVersion(input, proposal.proposed_definition);
    tokenTracker.add(proposedRun.input_tokens + proposedRun.output_tokens);

    if (tokenTracker.exceeded) {
      return abortResult('token_budget_exceeded', abInputs, tokenTracker);
    }

    // Step 4: Randomize labels
    const randomized = randomizer.randomize({ input, version_a: currentRun, version_b: proposedRun });

    // Step 5: Blind scoring (3 rounds)
    const scoringResult = await blindScorer.score(randomized, rubric, targetRole);
    tokenTracker.add(scoringResult.totalScoringTokens);

    if (tokenTracker.exceeded) {
      return abortResult('token_budget_exceeded', abInputs, tokenTracker);
    }

    // Step 6: De-randomize
    const comparison = comparator.compare(scoringResult, randomizer.getMapping(randomized.mapping_id));

    abInputs.push(toABInput(comparison));
  }

  // Step 7: Aggregate decision
  const aggregate = decisionEngine.decide(abInputs.map(toComparisonResult));

  // Update proposal status
  if (aggregate.verdict === 'positive') {
    proposalStore.updateStatus(proposal.proposal_id, 'validated_positive');
  } else {
    proposalStore.updateStatus(proposal.proposal_id, 'validated_negative');
  }

  // Store evaluation result
  const result = buildEvaluationResult(proposal, abInputs, aggregate, tokenTracker);
  await storeEvaluation(result);

  return result;
}
```

**Evaluation storage:**
- Write complete `ABEvaluationResult` as JSON to `data/evaluations/<evaluation_id>.json`.
- One file per evaluation for easy retrieval and inspection.

### Token Budget Enforcement

Integrated into the orchestrator via `TokenTracker`:

```typescript
class TokenTracker {
  private cumulative: number = 0;

  constructor(private budget: number) {}  // default 100,000

  add(tokens: number): void {
    this.cumulative += tokens;
  }

  get exceeded(): boolean {
    return this.cumulative > this.budget;
  }

  get remaining(): number {
    return Math.max(0, this.budget - this.cumulative);
  }

  get consumption(): TokenConsumption {
    return {
      total_tokens: this.cumulative,
      budget: this.budget,
      utilization_percent: (this.cumulative / this.budget) * 100,
      // category breakdowns set by caller
    };
  }
}
```

**Abort behavior:**
- When budget exceeded mid-validation: stop immediately.
- Mark result as `inconclusive` with reason `token_budget_exceeded`.
- Do NOT proceed to promotion (proposal stays at current status).
- Include partial results (inputs scored so far) in the evaluation.

## Acceptance Criteria

1. POSITIVE verdict when proposed wins 60%+ of inputs AND mean delta > 0.
2. NEGATIVE verdict when proposed loses 40%+ of inputs OR mean delta < -0.2.
3. INCONCLUSIVE for intermediate cases.
4. Per-dimension improvement/regression summary computed.
5. Human-readable recommendation generated for each verdict.
6. Orchestrator executes all 7 steps in correct order.
7. Token consumption tracked across all agent runs and scoring rounds.
8. Validation aborted when token budget exceeded.
9. Aborted validation marked inconclusive with reason `token_budget_exceeded`.
10. Partial results included in aborted evaluations.
11. Proposal status updated: `validated_positive` or `validated_negative`.
12. Evaluation results stored at `data/evaluations/<evaluation_id>.json`.
13. Configurable token budget (default 100,000).

## Test Cases

### Decision Engine Tests

```
test_positive_verdict_clear_winner
  Input: 5 comparisons, 4 proposed_wins, 1 tie, mean_delta=0.6
  Expected: verdict="positive"

test_positive_requires_60_percent
  Input: 5 comparisons, 2 proposed_wins, 3 ties, mean_delta=0.3
  Expected: verdict not "positive" (only 40% wins)

test_positive_requires_positive_delta
  Input: 5 comparisons, 4 proposed_wins, 1 current_win, mean_delta=-0.1
  Expected: verdict not "positive" (negative mean delta)

test_negative_40_percent_losses
  Input: 5 comparisons, 2 current_wins, 3 ties
  Expected: verdict="negative" (40% losses)

test_negative_large_negative_delta
  Input: 5 comparisons, 1 current_win, 4 ties, mean_delta=-0.3
  Expected: verdict="negative" (mean delta < -0.2)

test_inconclusive_mixed
  Input: 5 comparisons, 2 proposed_wins, 1 current_win, 2 ties, mean_delta=0.1
  Expected: verdict="inconclusive"

test_per_dimension_summary
  Input: comparisons with deltas {correctness: +0.5, quality: -0.2}
  Expected: correctness improved=true, quality improved=false

test_recommendation_positive
  Expected: recommendation contains "Recommend proceeding to promotion"

test_recommendation_negative
  Expected: recommendation contains "Recommend rejecting"

test_recommendation_inconclusive
  Expected: recommendation contains "inconclusive"
```

### Orchestrator Tests

```
test_full_7_step_protocol
  Setup: proposal with weakness report, 3 historical inputs
  Expected: all 7 steps execute, evaluation result stored

test_evaluation_stored_as_json
  Action: run validation
  Expected: file exists at data/evaluations/<id>.json with correct content

test_proposal_status_updated_positive
  Setup: validation produces positive verdict
  Expected: proposal status = "validated_positive"

test_proposal_status_updated_negative
  Setup: validation produces negative verdict
  Expected: proposal status = "validated_negative"

test_partial_failure_scoring
  Setup: 1 of 3 scoring rounds fails for one input
  Expected: validation continues with 2 rounds, still produces result

test_orchestrator_respects_input_order
  Expected: steps execute in order: select -> run A -> run B -> randomize -> score -> derandomize -> decide
```

### Token Budget Tests

```
test_budget_tracking_cumulative
  Action: add 30000 + 40000 + 20000
  Expected: cumulative = 90000, exceeded=false (budget=100000)

test_budget_exceeded_detection
  Action: add 60000 + 50000
  Expected: exceeded=true after second add

test_abort_on_budget_exceeded
  Setup: budget=50000, first pair costs 60000
  Expected: validation aborted after first pair

test_abort_verdict_inconclusive
  Setup: budget exceeded
  Expected: verdict="inconclusive", reason="token_budget_exceeded"

test_partial_results_on_abort
  Setup: 2 inputs completed before budget exceeded on 3rd
  Expected: evaluation includes 2 ABInput results

test_configurable_budget
  Setup: config.validationTokenBudget = 200000
  Expected: TokenTracker uses 200000 as budget

test_budget_remaining_computation
  Action: add 30000 to 100000 budget
  Expected: remaining = 70000

test_utilization_percent
  Action: consume 75000 of 100000 budget
  Expected: utilization_percent = 75.0
```

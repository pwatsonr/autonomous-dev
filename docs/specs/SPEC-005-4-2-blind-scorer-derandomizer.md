# SPEC-005-4-2: Blind Scorer and De-randomizer Comparator

## Metadata
- **Parent Plan**: PLAN-005-4
- **Tasks Covered**: Task 4 (Blind scorer), Task 5 (De-randomizer and comparator)
- **Estimated effort**: 14 hours

## Description

Implement the blind scoring system that invokes the appropriate reviewer agent to score both outputs without knowledge of which is current vs. proposed, including median-of-3 scoring for consistency, and the de-randomizer that maps scores back to version labels and computes per-input comparison results with win/loss/tie classification.

## Files to Create/Modify

### New Files

**`src/agent-factory/validation/blind-scorer.ts`**
- Exports: `BlindScorer` class with `score(pair: RandomizedPair, rubric: QualityDimension[], targetRole: AgentRole): ScoringResult`

**`src/agent-factory/validation/comparator.ts`**
- Exports: `Comparator` class with `compare(scoringResult: ScoringResult, mapping: RandomizationMapping): ComparisonResult`

### Modified Files

**`src/agent-factory/improvement/types.ts`** (extend)
- Add: `ScoringResult`, `ScoringRound`, `DimensionScores`, `ComparisonResult`, `InputComparison`

## Implementation Details

### Blind Scorer (`validation/blind-scorer.ts`)

```typescript
interface ScoringResult {
  input_id: string;
  rounds: ScoringRound[];         // 3 rounds
  median_scores: MedianScores;
  scoring_variance: number;       // variance across rounds
}

interface ScoringRound {
  round_number: number;           // 1, 2, 3
  reviewer_invocation_id: string;
  output_1_scores: DimensionScores;
  output_2_scores: DimensionScores;
  output_1_overall: number;
  output_2_overall: number;
  free_text_comparison: string;
}

interface DimensionScores {
  scores: Record<string, number>;   // dimension_name -> score (1.0-5.0)
  overall: number;                  // weighted mean of dimension scores
}

interface MedianScores {
  output_1: DimensionScores;
  output_2: DimensionScores;
}
```

**Reviewer selection based on target agent role:**

| Target Agent Role | Reviewer Agent |
|-------------------|---------------|
| `author` | `doc-reviewer` |
| `executor` | `quality-reviewer` |
| `reviewer` | `architecture-reviewer` |
| `meta` | `architecture-reviewer` |

**Scoring prompt (per round):**

```
You are scoring two outputs produced by an agent for the same input.
Do NOT attempt to determine which output is "better" overall -- score each independently.

## Original Input
{input_content}

## Output 1
{randomized_output_1}

## Output 2
{randomized_output_2}

## Evaluation Rubric
Score each output on every dimension (1.0 to 5.0):
{for each dimension:}
- **{name}** (weight: {weight}): {description}
  Score Output 1: ___
  Score Output 2: ___

## Instructions
1. Score each output independently on each dimension.
2. Provide a brief free-text comparison (2-3 sentences).
3. Output a JSON object with:
   {
     "output_1_scores": { "dimension_name": score, ... },
     "output_2_scores": { "dimension_name": score, ... },
     "comparison": "free text"
   }
```

**Median-of-3 computation:**

1. Run the scoring prompt 3 times (3 separate reviewer invocations).
2. For each dimension, for each output:
   - Collect the 3 scores across rounds.
   - Take the median value.
3. Compute `scoring_variance` as the average variance across all dimension scores.
4. Tag all scoring invocations with `environment: 'validation'`.

**Partial failure handling:**
- If one scoring round fails (timeout, unparseable output): use the remaining 2 rounds.
- Take median of 2 (which is the mean).
- If 2 rounds fail: use the single remaining round.
- If all 3 fail: return error in ScoringResult.

### De-randomizer and Comparator (`validation/comparator.ts`)

```typescript
interface ComparisonResult {
  input_id: string;
  version_a_scores: DimensionScores;    // current agent
  version_b_scores: DimensionScores;    // proposed agent
  per_dimension_delta: Record<string, number>;  // proposed - current per dimension
  overall_delta: number;                 // mean of dimension deltas
  outcome: 'proposed_wins' | 'current_wins' | 'tie';
  scoring_variance: number;
}
```

**De-randomization steps:**

1. Retrieve the `RandomizationMapping` for this input.
2. If `output_1_is === 'version_a'`:
   - `version_a_scores = median_scores.output_1`
   - `version_b_scores = median_scores.output_2`
3. Else:
   - `version_a_scores = median_scores.output_2`
   - `version_b_scores = median_scores.output_1`

**Delta computation:**

For each dimension:
```
delta[dimension] = version_b_scores.scores[dimension] - version_a_scores.scores[dimension]
```

Overall delta:
```
overall_delta = mean(all dimension deltas)
```

**Win/loss/tie classification (threshold: 0.2):**
- `proposed_wins`: `overall_delta > 0.2`
- `current_wins`: `overall_delta < -0.2`
- `tie`: `-0.2 <= overall_delta <= 0.2`

## Acceptance Criteria

1. Appropriate reviewer agent selected based on target agent's role.
2. Reviewer receives only "Output 1" and "Output 2" labels (no version info).
3. Scoring uses the target agent's `evaluation_rubric` dimensions.
4. Each dimension scored on 1.0-5.0 scale.
5. Scoring repeated 3 times per input; median taken per dimension.
6. Partial failure handled: 2 of 3 rounds still produce a result.
7. All scoring invocations tagged with `environment: 'validation'`.
8. De-randomization correctly maps scores back to version_a (current) and version_b (proposed).
9. Per-dimension delta computed as proposed minus current.
10. Overall delta is the mean of dimension deltas.
11. Win/loss/tie classification uses 0.2 threshold.
12. Scoring variance computed and reported.

## Test Cases

### Blind Scorer Tests

```
test_reviewer_selection_author
  Input: target agent role="author"
  Expected: doc-reviewer selected as scorer

test_reviewer_selection_executor
  Input: target agent role="executor"
  Expected: quality-reviewer selected

test_reviewer_selection_reviewer
  Input: target agent role="reviewer"
  Expected: architecture-reviewer selected

test_scoring_3_rounds
  Action: score a pair
  Expected: 3 ScoringRound entries

test_scores_within_range
  Expected: all dimension scores between 1.0 and 5.0

test_median_of_3_scores
  Input: rounds produce scores [3.0, 4.0, 5.0] for a dimension
  Expected: median = 4.0

test_median_of_2_on_partial_failure
  Input: 1 round fails, remaining produce [3.0, 5.0]
  Expected: median = 4.0 (mean of 2)

test_all_rounds_fail
  Input: all 3 rounds fail
  Expected: ScoringResult indicates error

test_validation_environment_tag
  Expected: all scorer invocations have environment="validation"

test_no_version_info_in_prompt
  Expected: scoring prompt does not contain "version_a", "version_b", "current", "proposed"

test_free_text_comparison_captured
  Expected: each round includes non-empty free_text_comparison

test_scoring_variance_computed
  Input: round scores [3.0, 4.0, 5.0]
  Expected: variance computed across rounds

test_scoring_uses_agent_rubric
  Input: agent has 4 rubric dimensions
  Expected: scores produced for all 4 dimensions
```

### Comparator Tests

```
test_derandomize_output_1_is_version_a
  Setup: mapping says output_1=version_a
  Expected: version_a_scores = output_1 median scores

test_derandomize_output_1_is_version_b
  Setup: mapping says output_1=version_b
  Expected: version_a_scores = output_2 median scores

test_per_dimension_delta
  Input: version_a scores {correctness: 3.0, quality: 4.0}
         version_b scores {correctness: 4.0, quality: 3.5}
  Expected: delta = {correctness: 1.0, quality: -0.5}

test_overall_delta_computation
  Input: deltas [1.0, -0.5]
  Expected: overall_delta = 0.25

test_proposed_wins_positive_delta
  Input: overall_delta = 0.5
  Expected: outcome = "proposed_wins"

test_current_wins_negative_delta
  Input: overall_delta = -0.3
  Expected: outcome = "current_wins"

test_tie_within_threshold
  Input: overall_delta = 0.1
  Expected: outcome = "tie"

test_tie_at_boundary_positive
  Input: overall_delta = 0.2
  Expected: outcome = "tie" (not strictly greater than 0.2)

test_tie_at_boundary_negative
  Input: overall_delta = -0.2
  Expected: outcome = "tie" (not strictly less than -0.2)

test_wins_just_above_threshold
  Input: overall_delta = 0.21
  Expected: outcome = "proposed_wins"

test_comparison_includes_scoring_variance
  Expected: ComparisonResult.scoring_variance is set
```

### Blind Scoring Integrity Tests

```
test_scorer_cannot_determine_version
  Action: inspect the full scoring prompt
  Expected: no text that would allow the scorer to identify current vs. proposed

test_output_order_varies_across_inputs
  Action: randomize 10 pairs
  Expected: not all have the same order (approximately 50/50)

test_metadata_stripped_from_outputs
  Setup: output contains "Version 1.0.0" in header
  Expected: version text stripped before inclusion in scoring prompt
```

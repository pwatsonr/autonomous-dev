# SPEC-004-3-1: Iteration Controller, Convergence Tracker & Quality Regression Detector

## Metadata
- **Parent Plan**: PLAN-004-3
- **Tasks Covered**: Task 1, Task 2, Task 3
- **Estimated effort**: 12 hours

## Description

Implement the IterationController that tracks iteration state and enforces termination conditions, the ConvergenceTracker that analyzes score trends and finding patterns across iterations to detect stagnation, and the QualityRegressionDetector that identifies score drops between iterations and recommends rollback. These three components collectively govern when the review loop continues, warns, or terminates.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/review-gate/iteration-controller.ts` | Create | Iteration state tracking and termination enforcement |
| `src/review-gate/convergence-tracker.ts` | Create | Score trend and finding pattern analysis |
| `src/review-gate/quality-regression-detector.ts` | Create | Score drop detection and rollback recommendation |

## Implementation Details

### 1. IterationController (`iteration-controller.ts`)

**Type definitions:**
```typescript
interface IterationState {
  gate_id: string;
  document_id: string;
  current_iteration: number;
  max_iterations: number;
  score_history: { iteration: number; aggregate_score: number }[];
  finding_history: { iteration: number; findings: MergedFinding[] }[];
  content_hashes: { iteration: number; hash: string }[];
  outcome_history: { iteration: number; outcome: "approved" | "changes_requested" | "rejected" }[];
  stagnation_count: number;  // consecutive iterations where stagnation was detected
  checkpoints: IterationCheckpoint[];
}

interface IterationCheckpoint {
  iteration: number;
  stage: "validation" | "review_started" | "review_completed" | "aggregation" | "decision";
  timestamp: string;
  state_snapshot: Partial<IterationState>;
}

interface IterationDecision {
  should_continue: boolean;
  outcome: "approved" | "changes_requested" | "rejected" | null;
  reason: string;
  stagnation_warning: boolean;
  quality_regression: QualityRegression | null;
  identical_revision: boolean;
}
```

**Class: `IterationController`**

**Constructor:**
```typescript
constructor(private config: { max_iterations: number; auto_rollback_on_regression: boolean } = { max_iterations: 3, auto_rollback_on_regression: false })
```

**Methods:**

- `initializeGate(gateId: string, documentId: string): IterationState` -- Creates a new iteration state with `current_iteration: 0`, empty histories.

- `startIteration(state: IterationState): IterationState` -- Increments `current_iteration`. Returns updated state. Throws if `current_iteration > max_iterations`.

- `recordReviewOutcome(state: IterationState, aggregateScore: number, findings: MergedFinding[], contentHash: string, approvalOutcome: "approved" | "changes_requested" | "rejected"): IterationDecision` -- Records the result of the current iteration and decides next action.

  **Decision logic:**
  ```
  1. Record score, findings, content hash, outcome in history.
  2. Check identical revision: if contentHash matches any previous iteration's hash:
     return { should_continue: false, outcome: "changes_requested",
              reason: "Revision is identical to a previous version. No changes were made.",
              identical_revision: true }
  3. If approvalOutcome === "approved":
     return { should_continue: false, outcome: "approved", reason: "Document approved." }
  4. If approvalOutcome === "rejected":
     return { should_continue: false, outcome: "rejected", reason: "Document rejected." }
  5. Run convergence tracker. If stagnation detected:
     state.stagnation_count++
     If state.stagnation_count >= 2:
       return { should_continue: false, outcome: "rejected",
                reason: "Stagnation persisted for 2 consecutive iterations.",
                stagnation_warning: true }
     Else:
       stagnation_warning = true
  6. Run quality regression detector:
     If regression detected and auto_rollback_on_regression:
       return { should_continue: true, outcome: "changes_requested",
                reason: "Quality regression detected. Rolling back to previous version.",
                quality_regression: <regression details> }
     If regression detected and not auto_rollback:
       quality_regression = <regression details>
  7. If current_iteration >= max_iterations:
     return { should_continue: false, outcome: "rejected",
              reason: "Maximum iterations ({max_iterations}) reached without approval." }
  8. Else:
     return { should_continue: true, outcome: "changes_requested",
              reason: "Document requires revisions." }
  ```

- `checkpoint(state: IterationState, stage: string): void` -- Saves a checkpoint with the current state snapshot for crash recovery.

- `restoreFromCheckpoint(gateId: string): IterationState | null` -- Restores state from the last checkpoint. Returns null if no checkpoint exists.

**Content hash computation:**
```typescript
function computeContentHash(content: string): string {
  // Normalize whitespace before hashing (collapse multiple spaces, trim lines)
  const normalized = content.replace(/\s+/g, ' ').trim();
  // Use SHA-256 hash
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
```

### 2. ConvergenceTracker (`convergence-tracker.ts`)

**Class: `ConvergenceTracker`**

**Primary method:**
```typescript
analyze(state: IterationState): ConvergenceAnalysis
```

**`ConvergenceAnalysis` interface:**
```typescript
interface ConvergenceAnalysis {
  stagnation_detected: boolean;
  stagnation_reasons: string[];
  score_trend: "improving" | "flat" | "declining";
  score_delta: number | null;          // current - previous (null for iteration 1)
  resolved_findings: string[];          // finding IDs resolved this iteration
  recurred_findings: string[];          // finding IDs that recurred
  finding_count_trend: "decreasing" | "flat" | "increasing";
}
```

**Algorithm:**

Only meaningful when `state.current_iteration >= 2` (need at least 2 data points). For iteration 1, return `{ stagnation_detected: false, score_trend: "flat", ... }`.

1. **Score trend:**
   ```
   current_score = state.score_history[current].aggregate_score
   previous_score = state.score_history[current - 1].aggregate_score
   score_delta = current_score - previous_score

   if score_delta > 0: score_trend = "improving"
   if score_delta === 0: score_trend = "flat"
   if score_delta < 0: score_trend = "declining"
   ```

2. **Finding resolution:**
   ```
   previous_findings = state.finding_history[current - 1].findings
   current_findings = state.finding_history[current].findings

   For each previous finding:
     Match key = (section_id, category_id)
     If no current finding matches this key:
       Mark as "resolved", add to resolved_findings
   ```

3. **Finding recurrence:**
   ```
   For each current finding:
     Match key = (section_id, category_id)
     Check all findings across ALL previous iterations that were marked "resolved"
     If a match exists among resolved findings:
       Mark as "recurred", add to recurred_findings
   ```

4. **Finding count trend:**
   ```
   current_count = current_findings.length
   previous_count = previous_findings.length

   if current_count < previous_count: "decreasing"
   if current_count === previous_count: "flat"
   if current_count > previous_count: "increasing"
   ```

5. **Stagnation detection** (ANY of these triggers stagnation):
   ```
   stagnation_detected = false
   stagnation_reasons = []

   if score_trend === "declining":
     stagnation_detected = true
     stagnation_reasons.push("Aggregate score declined from {previous} to {current}.")

   if recurred_findings.length > 0:
     stagnation_detected = true
     stagnation_reasons.push("{count} previously resolved finding(s) have recurred.")

   if finding_count_trend !== "decreasing":
     stagnation_detected = true
     stagnation_reasons.push("Total finding count did not decrease ({previous_count} -> {current_count}).")
   ```

### 3. QualityRegressionDetector (`quality-regression-detector.ts`)

**Class: `QualityRegressionDetector`**

**Configuration:**
```typescript
interface RegressionConfig {
  margin: number;  // default: 5 (points)
}
```

**Primary method:**
```typescript
detect(state: IterationState, config?: Partial<RegressionConfig>): QualityRegression | null
```

**Algorithm:**
```
if state.current_iteration < 2:
    return null  // first iteration cannot have regression

current_score = state.score_history[current].aggregate_score
previous_score = state.score_history[current - 1].aggregate_score
delta = current_score - previous_score

if current_score < previous_score - margin:
    return {
      previous_score,
      current_score,
      delta,
      rollback_recommended: true
    }
else:
    return null
```

**Key behavior:**
- Regression is only flagged when the drop exceeds the margin. A drop of exactly `margin` points is NOT a regression (must be strictly greater).
- The detector produces the `QualityRegression` object but does NOT perform the rollback. The IterationController decides whether to auto-rollback based on configuration.
- The regression does not auto-reject. Full review feedback is still generated and available.

## Acceptance Criteria

1. IterationController tracks iteration count starting at 1 for the first review.
2. Max iterations configurable, default 3.
3. After max iterations without approval, outcome is `rejected` with descriptive reason.
4. Score history persisted across iterations for trend analysis.
5. Finding history persisted across iterations for resolution/recurrence tracking.
6. Identical revision detected via content hash comparison (whitespace-normalized SHA-256).
7. Identical revision produces `changes_requested` with `identical_revision: true`.
8. Checkpoints saved with stage and state snapshot for crash recovery.
9. `restoreFromCheckpoint()` returns the last saved state or null.
10. ConvergenceTracker computes score trend as improving/flat/declining.
11. Finding resolution: findings from iteration N not present in N+1 marked resolved.
12. Finding recurrence: resolved findings that reappear in a later iteration marked recurred.
13. Stagnation detected when ANY of: score declines, resolved finding recurs, finding count does not decrease.
14. Stagnation count tracked; forced rejection after 2 consecutive stagnation iterations.
15. Quality regression flagged when `current_score < previous_score - margin` (margin default 5).
16. First iteration returns null for regression (no previous score).
17. Regression produces `QualityRegression` object with delta and rollback recommendation.
18. Auto-rollback is configurable and only triggers when `auto_rollback_on_regression` is true.

## Test Cases

### `tests/review-gate/iteration-controller.test.ts`

1. **Happy path -- approved on iteration 1**: Initialize, start iteration 1, record approved outcome. Decision: `should_continue: false, outcome: "approved"`.
2. **Revision loop -- approved on iteration 2**: Iteration 1 `changes_requested`. Iteration 2 `approved`. Decision at iteration 2: approved.
3. **Max iterations reached**: Iterations 1-3 all `changes_requested`. Iteration 3 decision: `should_continue: false, outcome: "rejected"`, reason mentions max iterations.
4. **Identical revision detection**: Iteration 1 content hash "abc123". Iteration 2 same hash. Decision: `should_continue: false, outcome: "changes_requested"`, `identical_revision: true`.
5. **Identical revision with whitespace change**: Content differs only in whitespace. After normalization, hash is the same. Detected as identical.
6. **Stagnation -- 1 iteration warning only**: Iteration 2 score declines. `stagnation_warning: true`. `should_continue: true` (first stagnation is a warning).
7. **Stagnation -- 2 consecutive forced rejection**: Iterations 2 and 3 both have declining scores. `stagnation_count` reaches 2. Decision: `should_continue: false, outcome: "rejected"`.
8. **Stagnation resets if iteration improves**: Iteration 2 declines (stagnation). Iteration 3 improves. `stagnation_count` resets to 0.
9. **Checkpoint save and restore**: Save checkpoint at stage "review_completed". Restore. Verify state matches.
10. **Restore from no checkpoint**: `restoreFromCheckpoint("nonexistent")` returns null.
11. **Max iterations configurable**: Config with `max_iterations: 5`. Iterations 1-4 are `changes_requested`, `should_continue: true`. Iteration 5 `changes_requested`, `should_continue: false, outcome: "rejected"`.

### `tests/review-gate/convergence-tracker.test.ts`

12. **Iteration 1 -- no analysis**: Returns `stagnation_detected: false`, `score_trend: "flat"`, `score_delta: null`.
13. **Score improving**: Iteration 1 score 75, iteration 2 score 82. `score_trend: "improving"`, `score_delta: 7`.
14. **Score declining**: Iteration 1 score 80, iteration 2 score 72. `score_trend: "declining"`, `score_delta: -8`. `stagnation_detected: true`.
15. **Score flat**: Iteration 1 score 80, iteration 2 score 80. `score_trend: "flat"`, `score_delta: 0`.
16. **Finding resolved**: Iteration 1 has finding at (section: "goals", category: "goals_measurability"). Iteration 2 has no finding at that key. `resolved_findings` includes that finding ID.
17. **Finding recurred**: Finding resolved in iteration 2, but reappears in iteration 3. `recurred_findings` includes the finding. `stagnation_detected: true`.
18. **Finding count decreasing**: Iteration 1 has 5 findings, iteration 2 has 3. `finding_count_trend: "decreasing"`. Not a stagnation trigger by itself.
19. **Finding count flat -- stagnation**: Iteration 1 has 5 findings, iteration 2 has 5. `finding_count_trend: "flat"`. `stagnation_detected: true`.
20. **Finding count increasing -- stagnation**: Iteration 1 has 3, iteration 2 has 5. `stagnation_detected: true`.
21. **Multiple stagnation reasons**: Score declines AND findings recur. `stagnation_reasons` has 2 entries.
22. **No stagnation when score improves and findings decrease**: Score up, finding count down, no recurrences. `stagnation_detected: false`.

### `tests/review-gate/quality-regression-detector.test.ts`

23. **First iteration -- no regression**: Single iteration in history. Returns null.
24. **Score drop within margin**: Previous 80, current 76. Margin 5. Drop is 4 (within margin). Returns null.
25. **Score drop exactly at margin**: Previous 80, current 75. Drop is 5. Returns null (must be strictly greater).
26. **Score drop exceeding margin**: Previous 80, current 74. Drop is 6 > 5. Returns `QualityRegression` with `previous_score: 80, current_score: 74, delta: -6, rollback_recommended: true`.
27. **Score improves -- no regression**: Previous 75, current 82. Returns null.
28. **Custom margin**: Margin 10. Drop of 11 flagged. Drop of 9 not flagged.
29. **Regression with auto-rollback off**: Regression detected. IterationController returns `should_continue: true` with `quality_regression` populated but no rollback.
30. **Regression with auto-rollback on**: Regression detected. IterationController returns `should_continue: true` with reason mentioning rollback.

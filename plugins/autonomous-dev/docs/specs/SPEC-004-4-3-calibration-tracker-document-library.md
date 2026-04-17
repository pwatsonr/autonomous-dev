# SPEC-004-4-3: Calibration Tracker & Calibration Document Library

## Metadata
- **Parent Plan**: PLAN-004-4
- **Tasks Covered**: Task 8, Task 9
- **Estimated effort**: 11 hours

## Description

Implement the reviewer calibration tracking system that measures reviewer quality over time using a rolling window of confirmed findings and misses, and build the calibration document library with reference documents at known quality tiers for automated regression testing of reviewer scoring consistency.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/review-gate/metrics/calibration-tracker.ts` | Create | Per-reviewer calibration score computation and action triggers |
| `tests/review-gate/calibration/calibration-runner.ts` | Create | Automated runner for calibration regression tests |
| `tests/review-gate/calibration/gold/prd-gold.md` | Create | Expert-quality PRD reference document |
| `tests/review-gate/calibration/gold/tdd-gold.md` | Create | Expert-quality TDD reference document |
| `tests/review-gate/calibration/silver/prd-silver.md` | Create | Good PRD with known issues |
| `tests/review-gate/calibration/silver/tdd-silver.md` | Create | Good TDD with known issues |
| `tests/review-gate/calibration/bronze/prd-bronze.md` | Create | Below-threshold PRD with documented defects |
| `tests/review-gate/calibration/bronze/tdd-bronze.md` | Create | Below-threshold TDD with documented defects |
| `tests/review-gate/calibration/failing/prd-failing.md` | Create | Fundamentally flawed PRD |
| `tests/review-gate/calibration/failing/tdd-failing.md` | Create | Fundamentally flawed TDD |
| `tests/review-gate/calibration/expectations.ts` | Create | Expected scores and findings for each reference document |

## Implementation Details

### 1. CalibrationTracker (`metrics/calibration-tracker.ts`)

**Type definitions:**
```typescript
interface CalibrationEvent {
  reviewer_id: string;
  event_type: "confirmed_finding" | "miss";
  gate_id: string;
  timestamp: string;
  details: string;
}

interface CalibrationRecord {
  reviewer_id: string;
  reviewer_role: string;
  total_reviews: number;
  confirmed_findings: number;
  misses: number;
  calibration_score: number;          // -1.0 to +1.0
  action: CalibrationAction;
  window_size: number;                // number of reviews in the window
  last_updated: string;
  events: CalibrationEvent[];         // rolling window of events
}

type CalibrationAction =
  | "no_action"            // 0.7 to 1.0
  | "monitor"              // 0.4 to 0.69
  | "review_prompt"        // 0.1 to 0.39
  | "remove_from_pool";   // -1.0 to 0.09

interface CalibrationTrackerConfig {
  window_size: number;                // default: 50
  action_thresholds: {
    no_action_min: number;            // default: 0.7
    monitor_min: number;              // default: 0.4
    review_prompt_min: number;        // default: 0.1
    // below review_prompt_min: remove_from_pool
  };
}
```

**Class: `CalibrationTracker`**

**Constructor:**
```typescript
constructor(
  private store: MetricsStore,
  private config: CalibrationTrackerConfig = {
    window_size: 50,
    action_thresholds: {
      no_action_min: 0.7,
      monitor_min: 0.4,
      review_prompt_min: 0.1,
    },
  }
)
```

**Methods:**

- `recordConfirmedFinding(reviewerId: string, gateId: string, details: string): void`
  Records a +1 event when a reviewer's finding is confirmed by downstream evidence.

- `recordMiss(reviewerId: string, gateId: string, details: string): void`
  Records a -1 event when a document the reviewer approved later triggers a backward cascade.

- `getCalibrationRecord(reviewerId: string): CalibrationRecord`
  Computes the current calibration state for a reviewer.

- `getCalibrationAction(reviewerId: string): CalibrationAction`
  Returns the recommended action based on the calibration score.

**Calibration score computation (TDD section 3.11.2):**
```typescript
function computeCalibrationScore(events: CalibrationEvent[], windowSize: number): number {
  // Take the most recent `windowSize` events
  const windowEvents = events.slice(-windowSize);

  if (windowEvents.length === 0) return 0;

  const confirmed = windowEvents.filter(e => e.event_type === "confirmed_finding").length;
  const misses = windowEvents.filter(e => e.event_type === "miss").length;
  const totalReviews = windowEvents.length;

  // calibration_score = (confirmed - misses) / totalReviews
  // Range: -1.0 to +1.0
  const score = (confirmed - misses) / totalReviews;

  // Clamp to range
  return Math.max(-1.0, Math.min(1.0, Math.round(score * 1000) / 1000));
}
```

**Action determination:**
```typescript
function determineAction(
  score: number,
  thresholds: CalibrationTrackerConfig["action_thresholds"]
): CalibrationAction {
  if (score >= thresholds.no_action_min) return "no_action";
  if (score >= thresholds.monitor_min) return "monitor";
  if (score >= thresholds.review_prompt_min) return "review_prompt";
  return "remove_from_pool";
}
```

**Calibration data update triggers:**
1. After each gate completion: update `total_reviews` for all participating reviewers.
2. After a backward cascade event: call `recordMiss()` for reviewers who approved the now-cascading document.
3. When a downstream issue confirms a finding: call `recordConfirmedFinding()` for the reviewer(s) who flagged it.

**Rolling window behavior:**
- Events older than `window_size` reviews are dropped from the computation (not deleted from storage, just excluded from the score calculation).
- When a new event is recorded, it becomes the newest event in the window, and if the window is full, the oldest event slides out.

### 2. Calibration Document Library

**Expected score ranges by tier:**

| Tier | Expected Score Range | Expected Outcome |
|------|---------------------|-----------------|
| Gold | 90-100 | `approved` |
| Silver | 70-85 | Likely `changes_requested` (below 85 threshold for PRD/TDD) |
| Bronze | 50-70 | `changes_requested` |
| Failing | 0-49 | `changes_requested` or `rejected` |

**PRD Gold Reference (`gold/prd-gold.md`):**
- Complete, well-structured PRD with all required sections
- Quantified problem statement with data points
- SMART goals with measurable success criteria
- 5+ user stories in "As a / I want / So that" format
- All requirements numbered, prioritized (P0/P1/P2), with testable acceptance criteria
- Non-functional requirements with specific thresholds
- Comprehensive risk section with likelihood/impact/mitigation
- Internally consistent (goals align with requirements, stories align with requirements)

**PRD Silver Reference (`silver/prd-silver.md`):**
- Known issues (documented in expectations):
  - Problem statement lacks quantification (expected `problem_clarity` score ~65-70)
  - 2 requirements use vague language ("fast", "user-friendly") without thresholds (expected `requirements_testability` ~60-65)
  - Risk section missing 1 high-impact risk (expected `risk_identification` ~60)
  - Otherwise solid structure and content

**PRD Bronze Reference (`bronze/prd-bronze.md`):**
- Known issues (documented in expectations):
  - Problem statement is generic (expected `problem_clarity` ~50)
  - Only 3 user stories (expected `user_story_coverage` ~50-55)
  - Multiple requirements missing acceptance criteria (expected `requirements_completeness` ~55)
  - No non-functional requirements section (expected floor violation)
  - Goals are not measurable (expected `goals_measurability` ~45-50)

**PRD Failing Reference (`failing/prd-failing.md`):**
- Fundamentally flawed:
  - No problem statement section (expected `problem_clarity` ~0-10)
  - Goals are aspirational with no metrics (expected `goals_measurability` ~20)
  - Requirements are a bullet list with no structure, no priorities, no acceptance criteria
  - Contradictions between goals and requirements (expected `internal_consistency` ~20)
  - No risk section

**TDD documents follow the same tier pattern for TDD-specific categories.**

### 3. Calibration Runner (`calibration/calibration-runner.ts`)

**Type definitions:**
```typescript
interface CalibrationExpectation {
  document_path: string;
  document_type: DocumentType;
  tier: "gold" | "silver" | "bronze" | "failing";
  expected_score_range: { min: number; max: number };
  expected_outcome: ("approved" | "changes_requested" | "rejected")[];
  expected_findings: {
    category_id: string;
    min_count: number;
    severity?: FindingSeverity;
  }[];
  score_tolerance: number;  // +/- tolerance for consistency checks (default: 5)
}

interface CalibrationRunResult {
  document_path: string;
  tier: string;
  actual_score: number;
  expected_range: { min: number; max: number };
  score_in_range: boolean;
  actual_outcome: string;
  outcome_expected: boolean;
  expected_findings_found: { category_id: string; expected: number; actual: number; pass: boolean }[];
  consistency_check: { run_scores: number[]; variance: number; within_tolerance: boolean };
  overall_pass: boolean;
}
```

**Class: `CalibrationRunner`**

**Primary method:**
```typescript
async runCalibration(
  reviewerExecutor: ReviewerExecutor,
  expectations: CalibrationExpectation[],
  runs_per_document: number = 3  // run multiple times for consistency check
): Promise<CalibrationRunResult[]>
```

**Algorithm:**
```
For each expectation:
  1. Load the reference document from expectations.document_path
  2. Run the document through the full review pipeline `runs_per_document` times
  3. For each run:
     a. Record the aggregate score
     b. Record the outcome
     c. Record findings by category
  4. Check score_in_range: all run scores fall within expected_range
  5. Check outcome_expected: all run outcomes are in expected_outcome list
  6. Check expected_findings: for each expected finding category,
     at least min_count findings were generated in all runs
  7. Consistency check: compute variance across runs.
     within_tolerance = (max_score - min_score) <= score_tolerance
  8. overall_pass = score_in_range AND outcome_expected AND
     all expected_findings_found AND consistency_within_tolerance
```

**Designed to run:**
- After reviewer prompt changes (mandatory)
- After rubric updates (mandatory)
- Periodically (weekly recommended)
- On-demand via test command

## Acceptance Criteria

1. CalibrationTracker tracks per-reviewer confirmed findings (+1) and misses (-1).
2. Calibration score = (confirmed - misses) / total_reviews, range -1.0 to +1.0.
3. Rolling window: default 50 reviews. Events beyond window excluded from computation.
4. Action thresholds: 0.7-1.0 no_action, 0.4-0.69 monitor, 0.1-0.39 review_prompt, below 0.1 remove_from_pool.
5. Calibration data updated after gate completion and after backward cascade events.
6. Calibration document library contains at least 8 reference documents: 1 PRD + 1 TDD per tier.
7. Gold docs are expected to score 90-100 and be approved.
8. Silver docs are expected to score 70-85 with known category weaknesses.
9. Bronze docs are expected to score 50-70 with multiple defects.
10. Failing docs are expected to score below 50.
11. Known defects in silver/bronze docs have documented expected finding categories.
12. CalibrationRunner executes reviewer against the library and validates scores, outcomes, and findings.
13. Consistency check: scores within +/- 5 point tolerance across multiple runs (NFR-001).
14. Runner designed to execute periodically or on-demand.

## Test Cases

### `tests/review-gate/metrics/calibration-tracker.test.ts`

1. **No events -- score 0**: New reviewer with no events. `calibration_score: 0`, `action: "review_prompt"` (0 is between 0.1 boundary; actually 0 < 0.1, so `remove_from_pool`). Correction: score 0 is < 0.1. Action: `remove_from_pool`. But a brand new reviewer should not immediately be removed. Note: this is the formula's output. In practice, calibration data is flagged as low-confidence when window is small.
2. **All confirmed -- score 1.0**: 10 events, all `confirmed_finding`. Score: 10/10 = 1.0. Action: `no_action`.
3. **All misses -- score -1.0**: 10 events, all `miss`. Score: -10/10 = -1.0. Action: `remove_from_pool`.
4. **Mixed events -- score 0.6**: 10 events: 8 confirmed, 2 misses. Score: (8-2)/10 = 0.6. Action: `monitor`.
5. **Score at 0.7 boundary**: 10 events: 8.5 confirmed... Since events are discrete, use 17 confirmed + 3 misses in 20 events: (17-3)/20 = 0.7. Action: `no_action`.
6. **Score at 0.4 boundary**: (14-6)/20 = 0.4. Action: `monitor`.
7. **Score at 0.1 boundary**: (11-9)/20 = 0.1. Action: `review_prompt`.
8. **Score below 0.1**: (10-10)/20 = 0.0. Action: `remove_from_pool`.
9. **Rolling window**: 60 events recorded. Window size 50. Only last 50 used. If recent 50 are all confirmed: score 1.0.
10. **Rolling window slides**: Add event 51. Event 1 is dropped. Score recomputed on last 50.
11. **Multiple reviewers tracked independently**: Reviewer A score 0.8, Reviewer B score 0.3. Separate records.
12. **Record confirmed finding**: Call `recordConfirmedFinding`. Verify event added. Score increases.
13. **Record miss**: Call `recordMiss`. Verify event added. Score decreases.
14. **Custom thresholds**: Set `no_action_min: 0.8`. Score 0.75 now gets `monitor` instead of `no_action`.

### `tests/review-gate/calibration/calibration-runner.test.ts`

15. **Gold doc in range**: Mock reviewer returns score 95. Expected range 90-100. `score_in_range: true`.
16. **Gold doc below range**: Mock reviewer returns score 80. Expected range 90-100. `score_in_range: false`. `overall_pass: false`.
17. **Failing doc above range**: Mock reviewer returns score 60. Expected range 0-49. `score_in_range: false`.
18. **Expected findings found**: Bronze PRD expected to flag `requirements_completeness`. Mock returns 2 findings for that category. `pass: true`.
19. **Expected findings missing**: Silver TDD expected to flag `tradeoff_rigor`. Mock returns 0 findings. `pass: false`.
20. **Consistency within tolerance**: 3 runs produce scores [82, 85, 84]. Variance (max-min) = 3 <= 5. `within_tolerance: true`.
21. **Consistency outside tolerance**: 3 runs produce scores [75, 85, 90]. Variance = 15 > 5. `within_tolerance: false`.
22. **Outcome matches expectation**: Gold PRD expected outcome "approved". Mock returns "approved". `outcome_expected: true`.
23. **Overall pass -- all checks pass**: Score in range, outcome expected, findings found, consistency ok. `overall_pass: true`.
24. **Overall fail -- one check fails**: Score in range, but expected findings missing. `overall_pass: false`.

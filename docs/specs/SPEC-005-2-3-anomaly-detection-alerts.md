# SPEC-005-2-3: Anomaly Detection Rules and Alert Management

## Metadata
- **Parent Plan**: PLAN-005-2
- **Tasks Covered**: Task 6 (Anomaly detection rules), Task 7 (Alert management)
- **Estimated effort**: 12 hours

## Description

Implement the 6 anomaly detection rules that evaluate agent health after each invocation, and the alert management system that handles creation, deduplication, escalation, acknowledgment, and auto-resolution of alerts. Together these components provide the early-warning system that identifies agent degradation before it impacts pipeline quality.

## Files to Create/Modify

### New Files

**`src/agent-factory/metrics/anomaly-detector.ts`**
- Exports: `AnomalyDetector` class with `evaluate(agentName: string): AlertRecord[]`
- Exports: `ANOMALY_RULES: AnomalyRule[]` (for introspection/testing)

### Modified Files

**`src/agent-factory/metrics/sqlite-store.ts`** (extend alert operations)
- Add: `findActiveAlert(agentName: string, ruleId: string): AlertRecord | null`
- Add: `countConsecutiveGoodInvocations(agentName: string, sinceAlertCreated: string): number`

**`src/agent-factory/metrics/engine.ts`** (integrate anomaly evaluation)
- Modify: `record()` to call `evaluateAnomalies()` in post-record hook

## Implementation Details

### Anomaly Detection Rules (`metrics/anomaly-detector.ts`)

Each rule implements this interface:

```typescript
interface AnomalyRule {
  id: string;
  name: string;
  severity: AlertSeverity;
  evaluate(agentName: string, metrics: InvocationMetric[], aggregate: AggregateMetrics, config: AnomalyThresholds): AnomalyFinding | null;
}

interface AnomalyFinding {
  ruleId: string;
  severity: AlertSeverity;
  message: string;
  evidence: Record<string, unknown>;
}

interface AnomalyThresholds {
  approvalRateDrop: number;          // default 0.70
  qualityDeclinePoints: number;      // default 0.5
  qualityDeclineWindow: number;      // default 10
  escalationRate: number;            // default 0.30
  tokenBudgetMultiplier: number;     // default 2.0
}
```

**Rule 1: Approval Rate Drop (CRITICAL)**
- ID: `ANOMALY_001_APPROVAL_RATE_DROP`
- Condition: Rolling 30-day approval rate drops below threshold (default 0.70).
- Evidence: `{ current_rate, threshold, invocation_count }`
- Message: `"Approval rate for '{agent}' is {rate} (below threshold {threshold})"`

**Rule 2: Quality Score Decline (WARNING)**
- ID: `ANOMALY_002_QUALITY_DECLINE`
- Condition: Average quality score over the last N invocations (default 10) is more than X points (default 0.5) below the 30-day average.
- Evidence: `{ recent_avg, overall_avg, decline_points, window_size }`
- Message: `"Quality score for '{agent}' declined by {decline} points over last {window} invocations"`

**Rule 3: Review Iteration Spike (WARNING)**
- ID: `ANOMALY_003_REVIEW_ITERATION_SPIKE`
- Condition: The last 3 consecutive invocations have review_iteration_count at or above the p95 of all historical review iterations for this agent.
- Computation:
  1. Compute p95 of all review_iteration_count for the agent.
  2. Check if the last 3 invocations each have count >= p95.
- Evidence: `{ last_3_iterations, p95_threshold }`
- Message: `"Review iterations for '{agent}' spiked: last 3 invocations at {values} (p95 = {p95})"`

**Rule 4: Escalation Rate Exceeded (CRITICAL)**
- ID: `ANOMALY_004_ESCALATION_RATE`
- Condition: Rate of review_outcome='rejected' in the last 30 days exceeds threshold (default 0.30).
- Evidence: `{ rejection_rate, threshold, rejected_count, total_count }`
- Message: `"Escalation rate for '{agent}' is {rate} (threshold {threshold})"`

**Rule 5: Trend Reversal (WARNING)**
- ID: `ANOMALY_005_TREND_REVERSAL`
- Condition: Trend direction changed from 'improving' to 'declining' between the previous and current aggregate snapshot.
- Requires: at least 2 aggregate snapshots for comparison.
- Evidence: `{ previous_direction, current_direction, previous_slope, current_slope }`
- Message: `"Trend reversal detected for '{agent}': was {previous}, now {current}"`

**Rule 6: Token Budget Exceeded (INFO)**
- ID: `ANOMALY_006_TOKEN_BUDGET`
- Condition: Last invocation's total tokens (input + output) exceed 2x (configurable multiplier) the 30-day average.
- Evidence: `{ invocation_tokens, avg_tokens, multiplier }`
- Message: `"Token usage for '{agent}' last invocation ({tokens}) exceeded {multiplier}x average ({avg})"`

### Alert Management

**Deduplication:**
- Before creating a new alert, check if an active (unresolved) alert already exists for the same agent + rule combination.
- If active alert exists: do NOT create a duplicate. Return the existing alert.
- Deduplication key: `(agent_name, rule_id, resolved_at IS NULL)`.

**Auto-resolution:**
- After each invocation is recorded, for each active alert on that agent:
  1. Count consecutive invocations since the alert's `created_at` where the anomaly condition no longer holds.
  2. If 5 consecutive "good" invocations: auto-resolve the alert by setting `resolved_at` to current timestamp.
- "Good" definition varies per rule:
  - ANOMALY_001: `review_outcome === 'approved'`
  - ANOMALY_002: `output_quality_score >= overall_avg - 0.5`
  - ANOMALY_003: `review_iteration_count < p95`
  - ANOMALY_004: `review_outcome !== 'rejected'`
  - ANOMALY_005: Trend direction is not 'declining' (re-evaluated on next aggregate)
  - ANOMALY_006: `total_tokens <= avg * multiplier`

**Alert recurrence:**
- After an alert is resolved, if the condition recurs, a new alert is created (new `alert_id`).

**Acknowledgment:**
- `acknowledgeAlert(alertId)` sets `acknowledged = true`. Does not resolve the alert.

## Acceptance Criteria

1. All 6 anomaly rules implemented with correct conditions and thresholds.
2. Thresholds configurable via `agent-factory.yaml`.
3. Each rule produces a specific message and structured evidence.
4. Deduplication prevents duplicate active alerts for the same agent + rule.
5. Auto-resolution triggers after 5 consecutive good invocations.
6. Resolved alerts have `resolved_at` set to timestamp.
7. New alerts created if condition recurs after resolution.
8. Acknowledgment sets flag without resolving.
9. Critical alerts surface via system notification mechanism.
10. All rules evaluated after each invocation metric is recorded.

## Test Cases

### Rule 1: Approval Rate Drop

```
test_approval_rate_below_threshold_fires
  Input: 10 invocations, 6 approved (rate 0.60), threshold 0.70
  Expected: alert fired with severity CRITICAL

test_approval_rate_above_threshold_no_alert
  Input: 10 invocations, 8 approved (rate 0.80), threshold 0.70
  Expected: no alert

test_approval_rate_at_threshold_no_alert
  Input: 10 invocations, 7 approved (rate 0.70), threshold 0.70
  Expected: no alert (at threshold, not below)
```

### Rule 2: Quality Score Decline

```
test_quality_decline_fires
  Input: 30-day avg = 4.0; last 10 avg = 3.3 (decline 0.7 > 0.5)
  Expected: alert fired with severity WARNING

test_quality_no_decline_no_alert
  Input: 30-day avg = 4.0; last 10 avg = 3.8 (decline 0.2 < 0.5)
  Expected: no alert

test_quality_decline_fewer_than_window
  Input: only 5 invocations available (window = 10)
  Expected: uses all 5 for comparison (best effort)
```

### Rule 3: Review Iteration Spike

```
test_iteration_spike_3_consecutive
  Input: p95 = 3; last 3 invocations have iterations [3, 4, 5]
  Expected: alert fired

test_iteration_spike_only_2_consecutive
  Input: p95 = 3; last 3 invocations have iterations [1, 4, 5]
  Expected: no alert (only 2 of 3 at p95)

test_iteration_spike_insufficient_history
  Input: fewer than 10 total invocations
  Expected: no alert (p95 unreliable with small sample)
```

### Rule 4: Escalation Rate Exceeded

```
test_escalation_rate_exceeded
  Input: 10 invocations, 4 rejected (rate 0.40), threshold 0.30
  Expected: alert fired with severity CRITICAL

test_escalation_rate_below_threshold
  Input: 10 invocations, 2 rejected (rate 0.20), threshold 0.30
  Expected: no alert
```

### Rule 5: Trend Reversal

```
test_trend_reversal_improving_to_declining
  Input: previous snapshot direction="improving", current="declining"
  Expected: alert fired

test_trend_stable_to_declining_no_alert
  Input: previous="stable", current="declining"
  Expected: no alert (not a reversal from improving)

test_no_previous_snapshot
  Input: only 1 snapshot exists
  Expected: no alert (cannot detect reversal)
```

### Rule 6: Token Budget Exceeded

```
test_token_budget_exceeded
  Input: last invocation tokens = 50000; 30-day avg = 20000; multiplier = 2.0
  Expected: alert fired with severity INFO

test_token_budget_within_bounds
  Input: last invocation tokens = 35000; avg = 20000; multiplier = 2.0
  Expected: no alert (35000 < 40000)
```

### Deduplication Tests

```
test_no_duplicate_active_alert
  Setup: fire ANOMALY_001 -> alert created
  Action: evaluate again with same condition
  Expected: existing alert returned, no new alert

test_new_alert_after_resolution
  Setup: fire ANOMALY_001 -> resolve after 5 good -> condition recurs
  Expected: new alert created with different alert_id
```

### Auto-Resolution Tests

```
test_auto_resolve_after_5_good
  Setup: active ANOMALY_001 alert
  Action: record 5 consecutive approved invocations
  Expected: alert resolved_at set

test_no_resolve_after_4_good
  Setup: active alert
  Action: record 4 consecutive good, then 1 bad
  Expected: alert still active (counter resets)

test_auto_resolve_mixed_rules
  Setup: active alerts for ANOMALY_001 and ANOMALY_002
  Action: record 5 invocations that satisfy ANOMALY_001 but not ANOMALY_002
  Expected: ANOMALY_001 resolved, ANOMALY_002 still active
```

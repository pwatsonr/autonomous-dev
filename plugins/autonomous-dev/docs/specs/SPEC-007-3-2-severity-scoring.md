# SPEC-007-3-2: Severity Scoring Algorithm & LLM Override

## Metadata
- **Parent Plan**: PLAN-007-3
- **Tasks Covered**: Task 4 (severity scoring algorithm), Task 5 (LLM severity override)
- **Estimated effort**: 10 hours

## Description

Implement the weighted severity scoring matrix that deterministically assigns P0-P3 severity based on five factors (error rate, affected users, service criticality, duration, data integrity risk), and the constrained LLM override mechanism that allows at most one-level adjustment with written justification.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/severity-scorer.ts` | Create | Weighted scoring matrix, `estimate_affected_users()`, LLM override |
| `src/engine/prompts/severity-override.ts` | Create | LLM prompt template for severity adjustment |
| `tests/engine/severity-scorer.test.ts` | Create | Boundary condition and override constraint tests |

## Implementation Details

### Task 4: Severity Scoring Algorithm

The scoring function implements the exact weighted matrix from TDD section 3.5.3.

**Factor weights**:
| Factor | Weight |
|--------|--------|
| Error rate | 0.30 |
| Affected users (estimated) | 0.25 |
| Service criticality | 0.20 |
| Duration | 0.15 |
| Data integrity risk | 0.10 |

**Score-to-severity mapping**:
| Score Range | Severity |
|-------------|----------|
| >= 0.75 | P0 (Critical) |
| >= 0.55 | P1 (High) |
| >= 0.35 | P2 (Medium) |
| < 0.35 | P3 (Low) |

```typescript
interface SeverityResult {
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  score: number;
  breakdown: SeverityBreakdown;
  override?: SeverityOverride;
}

interface SeverityBreakdown {
  error_rate: { value: number; sub_score: number; weighted: number };
  affected_users: { value: number; sub_score: number; weighted: number };
  service_criticality: { value: string; sub_score: number; weighted: number };
  duration: { value: number; sub_score: number; weighted: number };
  data_integrity: { value: string; sub_score: number; weighted: number };
}

function computeSeverity(
  candidate: CandidateObservation,
  serviceConfig: ServiceConfig,
  throughputRps: number
): SeverityResult {
  let score = 0.0;
  const breakdown: Partial<SeverityBreakdown> = {};

  // Factor 1: Error rate (weight 0.30)
  const errorRate = candidate.metric_value;
  let errorRateSubScore: number;
  if (errorRate > 50)      errorRateSubScore = 1.0;   // P0 range
  else if (errorRate > 20) errorRateSubScore = 0.75;  // P1 range
  else if (errorRate > 5)  errorRateSubScore = 0.50;  // P2 range
  else if (errorRate > 1)  errorRateSubScore = 0.25;  // P3 range
  else                     errorRateSubScore = 0.0;
  score += 0.30 * errorRateSubScore;
  breakdown.error_rate = {
    value: errorRate,
    sub_score: errorRateSubScore,
    weighted: 0.30 * errorRateSubScore,
  };

  // Factor 2: Affected users (weight 0.25)
  const affected = estimateAffectedUsers(throughputRps, errorRate, candidate.sustained_minutes);
  let userSubScore: number;
  if (affected > 10000)     userSubScore = 1.0;
  else if (affected > 1000) userSubScore = 0.75;
  else if (affected > 100)  userSubScore = 0.50;
  else                      userSubScore = 0.25;
  score += 0.25 * userSubScore;
  breakdown.affected_users = {
    value: affected,
    sub_score: userSubScore,
    weighted: 0.25 * userSubScore,
  };

  // Factor 3: Service criticality (weight 0.20)
  const criticalityScores: Record<string, number> = {
    critical: 1.0,
    high: 0.75,
    medium: 0.50,
    low: 0.25,
  };
  const critSubScore = criticalityScores[serviceConfig.criticality] ?? 0.25;
  score += 0.20 * critSubScore;
  breakdown.service_criticality = {
    value: serviceConfig.criticality,
    sub_score: critSubScore,
    weighted: 0.20 * critSubScore,
  };

  // Factor 4: Duration (weight 0.15)
  const duration = candidate.sustained_minutes;
  let durationSubScore: number;
  if (duration > 60)      durationSubScore = 1.0;
  else if (duration > 30) durationSubScore = 0.75;
  else if (duration > 10) durationSubScore = 0.50;
  else                    durationSubScore = 0.25;
  score += 0.15 * durationSubScore;
  breakdown.duration = {
    value: duration,
    sub_score: durationSubScore,
    weighted: 0.15 * durationSubScore,
  };

  // Factor 5: Data integrity (weight 0.10)
  let dataSubScore: number;
  let dataLabel: string;
  if (candidate.has_data_loss_indicator) {
    dataSubScore = 1.0;
    dataLabel = 'data_loss_confirmed';
  } else if (candidate.has_data_corruption_indicator) {
    dataSubScore = 0.75;
    dataLabel = 'data_corruption_possible';
  } else {
    dataSubScore = 0.0;
    dataLabel = 'no_data_risk';
  }
  score += 0.10 * dataSubScore;
  breakdown.data_integrity = {
    value: dataLabel,
    sub_score: dataSubScore,
    weighted: 0.10 * dataSubScore,
  };

  // Map to severity
  let severity: 'P0' | 'P1' | 'P2' | 'P3';
  if (score >= 0.75)      severity = 'P0';
  else if (score >= 0.55) severity = 'P1';
  else if (score >= 0.35) severity = 'P2';
  else                    severity = 'P3';

  return {
    severity,
    score,
    breakdown: breakdown as SeverityBreakdown,
  };
}

function estimateAffectedUsers(
  throughputRps: number,
  errorRatePercent: number,
  durationMinutes: number
): number {
  // affected = throughput * error_rate * duration
  // throughput is in requests/second, convert to total over duration
  const totalRequests = throughputRps * durationMinutes * 60;
  const erroredRequests = totalRequests * (errorRatePercent / 100);
  // Assume each user makes ~3 requests during the window (rough heuristic)
  return Math.round(erroredRequests / 3);
}
```

### Task 5: LLM Severity Override

The LLM receives the deterministic severity, scoring breakdown, and candidate data. It may propose an override of exactly one level.

**LLM prompt template**:

```typescript
const SEVERITY_OVERRIDE_PROMPT = `
You are reviewing a severity assessment for a production issue.

## Deterministic Assessment
- Severity: {severity}
- Score: {score}
- Breakdown:
  - Error rate: {error_rate_value}% -> {error_rate_subscore} (weighted: {error_rate_weighted})
  - Affected users: ~{affected_users} -> {users_subscore} (weighted: {users_weighted})
  - Service criticality: {criticality} -> {criticality_subscore} (weighted: {criticality_weighted})
  - Duration: {duration_minutes} min -> {duration_subscore} (weighted: {duration_weighted})
  - Data integrity: {data_integrity} -> {data_subscore} (weighted: {data_weighted})

## Evidence Summary
{evidence_summary}

## Instructions
Based on the evidence, determine if the severity should be adjusted.
You may adjust by AT MOST one level (e.g., P2 -> P1 or P2 -> P3).
You CANNOT adjust by more than one level.

Respond in this exact format:
OVERRIDE: <yes|no>
NEW_SEVERITY: <P0|P1|P2|P3>
JUSTIFICATION: <one sentence explaining why>
`;

interface SeverityOverride {
  original_severity: string;
  new_severity: string;
  justification: string;
  accepted: boolean;    // false if override was more than 1 level
}

async function requestLlmOverride(
  result: SeverityResult,
  candidate: CandidateObservation,
  evidenceSummary: string
): Promise<SeverityOverride | null> {
  const prompt = SEVERITY_OVERRIDE_PROMPT
    .replace('{severity}', result.severity)
    .replace('{score}', result.score.toFixed(4))
    // ... fill all placeholders

  const response = await llmQuery(prompt);
  const parsed = parseSeverityOverrideResponse(response);

  if (!parsed || parsed.override === 'no') {
    return null;
  }

  // Validate: at most one level difference
  const severityOrder = ['P0', 'P1', 'P2', 'P3'];
  const originalIdx = severityOrder.indexOf(result.severity);
  const newIdx = severityOrder.indexOf(parsed.new_severity);
  const diff = Math.abs(originalIdx - newIdx);

  if (diff > 1) {
    // Reject: more than one level change
    return {
      original_severity: result.severity,
      new_severity: parsed.new_severity,
      justification: parsed.justification,
      accepted: false,  // REJECTED
    };
  }

  return {
    original_severity: result.severity,
    new_severity: parsed.new_severity,
    justification: parsed.justification,
    accepted: true,
  };
}
```

**Override rejection**: If the LLM proposes more than one level change (e.g., P3 to P1), the override is rejected and logged with `accepted: false`. The deterministic severity stands.

## Acceptance Criteria

1. Scoring function accepts a candidate observation and service config. Computes weighted score across all five factors with the exact threshold ranges from the TDD.
2. Error rate sub-scoring: >50% = 1.0, >20% = 0.75, >5% = 0.50, >1% = 0.25, else 0.0.
3. Affected users sub-scoring: >10,000 = 1.0, >1,000 = 0.75, >100 = 0.50, else 0.25.
4. Service criticality sub-scoring: critical = 1.0, high = 0.75, medium = 0.50, low = 0.25.
5. Duration sub-scoring: >60 min = 1.0, >30 min = 0.75, >10 min = 0.50, else 0.25.
6. Data integrity: data loss = 1.0, corruption = 0.75, else 0.0.
7. Severity mapping: >=0.75 = P0, >=0.55 = P1, >=0.35 = P2, else P3.
8. `estimate_affected_users()` computes from throughput, error rate, and duration.
9. LLM override constrained to exactly one level (up or down).
10. Overrides of more than one level are rejected and logged.
11. Override includes a written justification string.
12. Override is recorded in the candidate observation metadata.
13. Full breakdown is available for the observation report severity rationale table.

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-3-2-01 | TDD example: P1 | error=12.3%, users=2400, critical, 45min, no data risk | Score ~0.63, severity P1 |
| TC-3-2-02 | P0 boundary | error=55%, users=15000, critical, 90min, data loss | Score >= 0.75, severity P0 |
| TC-3-2-03 | P0 exact boundary | Score = 0.75 exactly | Severity P0 (>= 0.75) |
| TC-3-2-04 | P1 exact boundary | Score = 0.55 exactly | Severity P1 (>= 0.55) |
| TC-3-2-05 | P2 exact boundary | Score = 0.35 exactly | Severity P2 (>= 0.35) |
| TC-3-2-06 | P3 low score | error=1.5%, users=50, low, 5min, no risk | Score < 0.35, severity P3 |
| TC-3-2-07 | Affected users estimate | 58 rps, 12.3% error, 45 min | ~(58 * 45 * 60 * 0.123) / 3 = ~6,432 users |
| TC-3-2-08 | Override one level up | Deterministic=P2, LLM says P1 with justification | Override accepted, severity becomes P1 |
| TC-3-2-09 | Override one level down | Deterministic=P1, LLM says P2 with justification | Override accepted, severity becomes P2 |
| TC-3-2-10 | Override two levels rejected | Deterministic=P3, LLM says P1 | Override rejected (`accepted: false`), severity stays P3 |
| TC-3-2-11 | Override no change | LLM responds `OVERRIDE: no` | No override applied |
| TC-3-2-12 | Zero throughput | Throughput=0 rps | `estimateAffectedUsers` returns 0 |
| TC-3-2-13 | All-max factors | error=100%, users=100K, critical, 120min, data loss | Score = 0.30+0.25+0.20+0.15+0.10 = 1.0, P0 |
| TC-3-2-14 | Breakdown in result | Any input | `breakdown` object contains all 5 factor values, sub-scores, and weighted contributions |

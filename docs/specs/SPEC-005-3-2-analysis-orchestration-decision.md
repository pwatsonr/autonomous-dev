# SPEC-005-3-2: Performance Analysis Orchestration and Decision Logic

## Metadata
- **Parent Plan**: PLAN-005-3
- **Tasks Covered**: Task 3 (Performance analysis orchestration), Task 4 (Analysis decision logic)
- **Estimated effort**: 10 hours

## Description

Implement the analysis orchestration that collects metrics data, invokes the `performance-analyst` agent, and parses the output into a structured `WeaknessReport`, plus the decision logic that routes the analysis result to the appropriate next step (no action, propose modification, or log domain gap for specialist creation).

## Files to Create/Modify

### New Files

**`src/agent-factory/improvement/analyzer.ts`**
- Exports: `PerformanceAnalyzer` class with `analyze(agentName: string): AnalysisResult`

## Implementation Details

### Performance Analysis Orchestration (`improvement/analyzer.ts`)

```typescript
interface AnalysisResult {
  success: boolean;
  report?: WeaknessReport;
  nextAction: 'no_action' | 'propose_modification' | 'log_domain_gap' | 'error';
  error?: string;
}

class PerformanceAnalyzer {
  constructor(
    private registry: IAgentRegistry,
    private metricsEngine: IMetricsEngine,
    private observationTracker: ObservationTracker,
    private auditLogger: AuditLogger,
    private reportStore: WeaknessReportStore
  ) {}

  async analyze(agentName: string): Promise<AnalysisResult> { ... }
}
```

**Analysis steps:**

**Step 1: Collect input data for the performance-analyst agent**

Gather the following for the target agent:

```typescript
interface AnalysisInput {
  agent: {
    name: string;
    version: string;
    role: string;
    expertise: string[];
    evaluation_rubric: QualityDimension[];
  };
  metrics: {
    aggregate: AggregateMetrics;
    recent_invocations: InvocationMetric[];  // last 20
    per_dimension_scores: DimensionBreakdown[];
    domain_breakdown: Record<string, DomainStats>;
    active_alerts: AlertRecord[];
    trend: TrendResult;
  };
}

interface DimensionBreakdown {
  dimension: string;
  avg_score: number;
  median_score: number;
  stddev: number;
  trend_slope: number;
  worst_domains: string[];     // domains where this dimension scores lowest
}
```

- `aggregate`: from `metricsEngine.getAggregate(agentName)`.
- `recent_invocations`: from `metricsEngine.getInvocations(agentName, { limit: 20 })`.
- `per_dimension_scores`: computed by grouping quality_dimensions across recent invocations by dimension name, then computing stats per dimension.
- `domain_breakdown`: from the aggregate metrics.
- `active_alerts`: from `metricsEngine.getAlerts({ agentName, activeOnly: true })`.

**Step 2: Format as structured prompt input**

Construct a prompt for the `performance-analyst` agent that includes:

```
You are analyzing the performance of agent '{name}' (v{version}, role: {role}).

## Current Metrics
- Invocations (30d): {count}
- Approval rate: {rate}
- Average quality score: {avg} / 5.0
- Trend: {direction} (slope: {slope}, confidence: {confidence})

## Per-Dimension Performance
| Dimension | Avg Score | Median | Stddev | Trend | Worst Domains |
|-----------|-----------|--------|--------|-------|---------------|
{for each dimension}

## Domain Breakdown
| Domain | Invocations | Approval Rate | Avg Quality |
|--------|-------------|---------------|-------------|
{for each domain}

## Active Alerts
{list each alert with rule, severity, message}

## Recent Invocations (last 20)
{summary table: timestamp, domain, quality_score, review_outcome, iterations}

---

Produce a structured weakness report with:
1. overall_assessment: "healthy" | "needs_improvement" | "critical"
2. weaknesses: array of { dimension, severity, evidence, affected_domains, suggested_focus }
3. strengths: array of strings
4. recommendation: "no_action" | "propose_modification" | "propose_specialist"

Format your response as a JSON code block.
```

**Step 3: Invoke the performance-analyst agent**

- Look up the `performance-analyst` agent via `registry.get('performance-analyst')`.
- If not found or FROZEN: return error result.
- Invoke via the Agent Runtime with the formatted input.
- The invocation is itself recorded in metrics with `environment: 'production'` (the analyst is a real agent doing real work).

**Step 4: Parse the agent's output into a WeaknessReport**

- Extract JSON from the agent's response (look for ```json ... ``` code blocks or raw JSON).
- Parse into the `WeaknessReport` schema.
- If parsing fails: log error, return `{ success: false, nextAction: 'error' }`.
- Assign a `report_id` (UUID v4) and set `analysis_date` to current timestamp.
- Persist the report via `reportStore.append(report)`.

**Step 5: Handle analysis failure**

- If the agent invocation fails (timeout, error, unparseable output): log error to audit log, do NOT crash, do NOT throw.
- The observation tracker does NOT reset (analysis will be retried on the next threshold crossing or manual trigger).

### Analysis Decision Logic

After a successful analysis, route based on the report:

```typescript
function decideNextAction(report: WeaknessReport): 'no_action' | 'propose_modification' | 'log_domain_gap' {
  if (report.overall_assessment === 'healthy') {
    // No action needed. Reset observation counter for next cycle.
    return 'no_action';
  }

  if (report.recommendation === 'propose_specialist') {
    // Log domain gap, do not generate a modification proposal.
    return 'log_domain_gap';
  }

  if (report.recommendation === 'propose_modification' &&
      (report.overall_assessment === 'needs_improvement' || report.overall_assessment === 'critical')) {
    return 'propose_modification';
  }

  // Default: no action (unexpected state)
  return 'no_action';
}
```

**`no_action` path:**
- Reset the observation counter for the agent: `observationTracker.resetForPromotion(agentName, currentVersion)`.
- Agent remains ACTIVE. Next analysis triggers after another threshold crossing.

**`propose_modification` path:**
- Proceed to proposal generation (SPEC-005-3-3).
- Transition agent state to UNDER_REVIEW.

**`log_domain_gap` path:**
- Append to `data/domain-gaps.jsonl`:
```json
{
  "gap_id": "uuid-v4",
  "task_domain": "{from report weakness affected_domains}",
  "description": "{from weakness suggested_focus}",
  "detected_at": "2026-04-08T10:00:00.000Z",
  "source_agent": "{agent_name}",
  "status": "specialist_recommended",
  "closest_agent": "{agent_name}",
  "analysis_report_id": "{report.report_id}"
}
```
- Do NOT proceed to proposal generation.
- Log `domain_gap_specialist_recommended` to audit log.

## Acceptance Criteria

1. Analyzer collects all per-invocation metrics, aggregate, trend, per-dimension scores, and domain breakdown for the target agent.
2. Data formatted as structured input for the performance-analyst agent.
3. Performance-analyst agent invoked via registry with the formatted input.
4. Agent output parsed into a `WeaknessReport` with all required fields.
5. Analysis failure handled gracefully: logged, no crash, no observation counter reset.
6. Decision logic: healthy -> no_action + reset observation counter.
7. Decision logic: needs_improvement/critical + propose_modification -> proceed to proposal.
8. Decision logic: propose_specialist -> log domain gap, do not generate proposal.
9. Domain gaps logged to `data/domain-gaps.jsonl` with status "specialist_recommended".
10. Audit log records analysis events.

## Test Cases

### Analysis Orchestration Tests

```
test_collect_analysis_input_complete
  Setup: agent with 25 invocations across 2 domains, 3 rubric dimensions
  Action: collect input data
  Expected: aggregate populated, 20 recent invocations, per_dimension for all 3 dimensions, 2 domains

test_invoke_performance_analyst
  Setup: performance-analyst agent loaded
  Action: analyze("code-executor")
  Expected: agent invoked with formatted metrics input

test_parse_valid_analysis_output
  Input: agent returns valid JSON with all WeaknessReport fields
  Expected: WeaknessReport parsed successfully, report_id assigned

test_parse_json_in_code_block
  Input: agent returns ```json { ... } ```
  Expected: JSON extracted and parsed

test_parse_failure_returns_error
  Input: agent returns prose text, not JSON
  Expected: AnalysisResult with success=false, nextAction='error'

test_agent_invocation_failure_no_crash
  Setup: performance-analyst agent times out
  Expected: error logged, success=false returned, no throw

test_observation_counter_not_reset_on_failure
  Setup: analysis fails
  Expected: observationTracker state unchanged (will retry at next crossing)

test_report_persisted_to_jsonl
  Action: successful analysis
  Expected: report in data/weakness-reports.jsonl

test_performance_analyst_not_found
  Setup: performance-analyst not in registry
  Expected: error result returned gracefully
```

### Decision Logic Tests

```
test_healthy_no_action
  Input: report with overall_assessment="healthy"
  Expected: nextAction="no_action"

test_healthy_resets_observation_counter
  Input: report with overall_assessment="healthy"
  Expected: observationTracker.resetForPromotion called

test_needs_improvement_propose
  Input: overall_assessment="needs_improvement", recommendation="propose_modification"
  Expected: nextAction="propose_modification"

test_critical_propose
  Input: overall_assessment="critical", recommendation="propose_modification"
  Expected: nextAction="propose_modification"

test_propose_specialist_logs_gap
  Input: recommendation="propose_specialist"
  Expected: nextAction="log_domain_gap"

test_domain_gap_logged_to_jsonl
  Input: recommendation="propose_specialist"
  Expected: entry in data/domain-gaps.jsonl with status="specialist_recommended"

test_domain_gap_does_not_trigger_proposal
  Input: recommendation="propose_specialist"
  Expected: proposal generation NOT invoked

test_audit_log_for_analysis_complete
  Action: successful analysis
  Expected: audit log contains analysis event with report summary
```

### Integration Tests

```
test_full_observation_to_analysis
  Setup: seed 15 invocations with declining quality pattern
  Expected: observation trigger fires -> analyzer invoked -> weakness report generated

test_analysis_to_decision_routing
  Setup: seed invocations producing "needs_improvement" report
  Expected: decision routes to "propose_modification"

test_healthy_agent_cycle_resets
  Setup: seed invocations producing "healthy" report
  Expected: observation counter reset, next analysis after 10 more invocations
```

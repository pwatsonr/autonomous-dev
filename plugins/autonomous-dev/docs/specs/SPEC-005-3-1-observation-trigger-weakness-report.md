# SPEC-005-3-1: Observation Trigger and Weakness Report Schema

## Metadata
- **Parent Plan**: PLAN-005-3
- **Tasks Covered**: Task 1 (Observation trigger), Task 2 (Weakness report schema and storage)
- **Estimated effort**: 7 hours

## Description

Implement the observation trigger that detects when an agent crosses the invocation threshold and initiates the analysis phase, and define the weakness report schema with JSONL persistence. The observation trigger hooks into the MetricsEngine's post-record flow and serves as the entry point to the entire improvement lifecycle.

## Files to Create/Modify

### New Files

**`src/agent-factory/improvement/observation-trigger.ts`**
- Exports: `ObservationTrigger` class with `check(agentName: string, agentVersion: string): TriggerDecision`

**`src/agent-factory/improvement/types.ts`**
- Exports: `WeaknessReport`, `Weakness`, `OverallAssessment`, `Recommendation`, `TriggerDecision`, `AgentProposal`, `MetaReviewResult`, `MetaReviewFinding`

### Modified Files

**`src/agent-factory/metrics/engine.ts`**
- Add: post-record hook that calls `observationTrigger.check()` after each `record()` call

## Implementation Details

### Observation Trigger (`improvement/observation-trigger.ts`)

```typescript
interface TriggerDecision {
  triggered: boolean;
  reason: string;
  agentName: string;
  invocationCount: number;
  threshold: number;
}

class ObservationTrigger {
  constructor(
    private observationTracker: ObservationTracker,
    private registry: IAgentRegistry,
    private config: AgentFactoryConfig,
    private auditLogger: AuditLogger
  ) {}

  check(agentName: string, agentVersion: string): TriggerDecision {
    // 1. Record the invocation in the observation tracker
    const state = this.observationTracker.recordInvocation(agentName, agentVersion);

    // 2. Guard: agent must not be FROZEN
    const agentState = this.registry.getState(agentName);
    if (agentState === 'FROZEN') {
      return { triggered: false, reason: 'agent is FROZEN', ... };
    }

    // 3. Guard: no analysis already in progress (agent not UNDER_REVIEW or VALIDATING)
    if (['UNDER_REVIEW', 'VALIDATING', 'CANARY'].includes(agentState)) {
      return { triggered: false, reason: 'analysis already in progress', ... };
    }

    // 4. Check threshold
    if (state.status !== 'threshold_reached') {
      return { triggered: false, reason: 'threshold not reached', ... };
    }

    // 5. Trigger analysis
    return { triggered: true, reason: 'threshold reached', ... };
  }

  // Manual trigger (--force)
  forceCheck(agentName: string): TriggerDecision {
    const agentState = this.registry.getState(agentName);
    if (agentState === 'FROZEN') {
      return { triggered: false, reason: 'agent is FROZEN (cannot force frozen agents)', ... };
    }

    this.observationTracker.forceThresholdReached(agentName);
    return { triggered: true, reason: 'forced by operator', ... };
  }
}
```

**MetricsEngine integration:**

After each `record()` call, the engine invokes:
```typescript
const decision = this.observationTrigger.check(metric.agent_name, metric.agent_version);
if (decision.triggered) {
  // Emit event to the improvement lifecycle (async, non-blocking)
  this.emit('analysis_triggered', { agentName: metric.agent_name, decision });
}
```

The actual analysis execution is handled by SPEC-005-3-2 (analysis orchestration). The trigger only signals that analysis should begin.

### Weakness Report Schema (`improvement/types.ts`)

```typescript
type OverallAssessment = 'healthy' | 'needs_improvement' | 'critical';
type Recommendation = 'no_action' | 'propose_modification' | 'propose_specialist';
type WeaknessSeverity = 'low' | 'medium' | 'high';

interface WeaknessReport {
  report_id: string;              // UUID v4
  agent_name: string;
  agent_version: string;
  analysis_date: string;          // ISO 8601
  overall_assessment: OverallAssessment;
  weaknesses: Weakness[];
  strengths: string[];
  recommendation: Recommendation;
  metrics_summary: MetricsSummary;   // snapshot of key metrics at time of analysis
}

interface Weakness {
  dimension: string;              // rubric dimension name
  severity: WeaknessSeverity;
  evidence: string;               // specific metric data supporting the finding
  affected_domains: string[];     // domains where weakness is most pronounced
  suggested_focus: string;        // actionable guidance for improvement
}

interface MetricsSummary {
  invocation_count: number;
  approval_rate: number;
  avg_quality_score: number;
  trend_direction: string;
  active_alerts: number;
}
```

**Weakness report storage:**

- Persisted as JSONL at `data/weakness-reports.jsonl`.
- One JSON object per line.
- Append-only (same pattern as audit log and metrics JSONL).
- Reader provides `getReports(agentName?: string): WeaknessReport[]`.

**Example weakness report JSONL line:**
```json
{"report_id":"a1b2c3d4-...","agent_name":"code-executor","agent_version":"1.0.0","analysis_date":"2026-04-08T10:00:00.000Z","overall_assessment":"needs_improvement","weaknesses":[{"dimension":"test-coverage","severity":"medium","evidence":"Average test-coverage score is 2.8/5.0, 1.2 below median. Decline of 0.4 over last 15 invocations.","affected_domains":["python"],"suggested_focus":"Emphasize test generation for non-TypeScript domains"}],"strengths":["correctness score stable at 4.2","spec-adherence consistently above 4.0"],"recommendation":"propose_modification","metrics_summary":{"invocation_count":25,"approval_rate":0.80,"avg_quality_score":3.6,"trend_direction":"declining","active_alerts":1}}
```

## Acceptance Criteria

1. After each metric record, observation trigger checks if threshold is met.
2. Trigger respects FROZEN state: frozen agents never trigger analysis.
3. Trigger respects in-progress state: no duplicate analysis triggered for agents already under review.
4. Per-agent threshold overrides from config are respected.
5. `--force` bypasses threshold but not FROZEN guard.
6. Trigger emits an event when analysis should begin (does not run analysis itself).
7. `WeaknessReport` schema includes all fields from TDD 3.4.3.
8. Reports persisted as append-only JSONL at `data/weakness-reports.jsonl`.
9. Reports queryable by agent name.

## Test Cases

### Observation Trigger Tests

```
test_trigger_fires_at_threshold
  Setup: threshold=10, record 10 invocations
  Expected: triggered=true, reason="threshold reached"

test_trigger_does_not_fire_below_threshold
  Setup: threshold=10, record 8 invocations
  Expected: triggered=false, reason="threshold not reached"

test_trigger_skips_frozen_agent
  Setup: agent in FROZEN state, threshold met
  Expected: triggered=false, reason="agent is FROZEN"

test_trigger_skips_under_review_agent
  Setup: agent in UNDER_REVIEW state, threshold met
  Expected: triggered=false, reason="analysis already in progress"

test_trigger_skips_validating_agent
  Setup: agent in VALIDATING state, threshold met
  Expected: triggered=false, reason="analysis already in progress"

test_trigger_respects_per_agent_override
  Setup: default threshold=10, override for code-executor=20
  Action: 15 invocations for code-executor
  Expected: triggered=false (15 < 20)

test_force_trigger_bypasses_threshold
  Setup: 3 invocations (below threshold)
  Action: forceCheck("agent")
  Expected: triggered=true, reason="forced by operator"

test_force_trigger_respects_frozen
  Setup: agent is FROZEN
  Action: forceCheck("agent")
  Expected: triggered=false, reason="agent is FROZEN"

test_trigger_emits_event
  Setup: threshold met
  Expected: 'analysis_triggered' event emitted on MetricsEngine
```

### Weakness Report Schema Tests

```
test_weakness_report_serialization
  Action: create WeaknessReport, serialize to JSON
  Expected: all fields present, valid JSON

test_weakness_report_append_to_jsonl
  Action: write 2 reports
  Expected: 2 lines in JSONL file, both parseable

test_weakness_report_query_by_agent
  Setup: 3 reports for "code-executor", 2 for "prd-author"
  Action: getReports("code-executor")
  Expected: returns 3 reports

test_weakness_report_all_fields_present
  Action: parse a valid report
  Expected: report_id, agent_name, agent_version, analysis_date, overall_assessment, weaknesses, strengths, recommendation, metrics_summary all present

test_weakness_severity_enum
  Expected: only 'low', 'medium', 'high' accepted

test_overall_assessment_enum
  Expected: only 'healthy', 'needs_improvement', 'critical' accepted

test_recommendation_enum
  Expected: only 'no_action', 'propose_modification', 'propose_specialist' accepted
```

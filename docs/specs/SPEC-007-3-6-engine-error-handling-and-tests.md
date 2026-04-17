# SPEC-007-3-6: Intelligence Engine Error Handling & Test Suite

## Metadata
- **Parent Plan**: PLAN-007-3
- **Tasks Covered**: Task 15 (intelligence engine failure handling), Task 16 (unit and integration tests)
- **Estimated effort**: 18 hours

## Description

Implement the intelligence engine failure handling for Claude session failures, token budget exhaustion, and invalid observation structures per TDD section 6.3. Build the comprehensive unit and integration test suite covering all engine components: error detection, severity scoring, fingerprinting, deduplication, anomaly detection, baseline updates, trend analysis, and the full engine pipeline.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/error-handler.ts` | Create | Session failure retry, token budget tracking, schema validation |
| `src/engine/schema-validator.ts` | Create | YAML frontmatter validation against observation schema |
| `tests/engine/error-detector.test.ts` | Modify | Additional edge case and boundary tests |
| `tests/engine/severity-scorer.test.ts` | Modify | TDD example verification |
| `tests/engine/fingerprint.test.ts` | Modify | Stack normalizer comprehensive tests |
| `tests/engine/deduplicator.test.ts` | Modify | All three window tests |
| `tests/engine/anomaly-detector.test.ts` | Modify | Both methods, boundary conditions |
| `tests/engine/baseline.test.ts` | Modify | EWMA convergence, learning mode |
| `tests/engine/trend-analyzer.test.ts` | Modify | Slope computation, extrapolation |
| `tests/integration/engine-pipeline.test.ts` | Create | Full engine pipeline with mock data |
| `tests/integration/graceful-degradation.test.ts` | Create | Partial data, missing sources |

## Implementation Details

### Task 15: Intelligence Engine Failure Handling

Three failure modes from TDD section 6.3.

**Failure 1: Claude session fails or times out**

```typescript
async function withLlmRetry<T>(
  operation: () => Promise<T>,
  context: { service: string; phase: string },
  auditLog: AuditLogger
): Promise<T | null> {
  try {
    return await operation();
  } catch (firstError) {
    auditLog.warn(`LLM session failed for ${context.service}/${context.phase}: ${firstError}. Retrying...`);

    try {
      return await operation();
    } catch (secondError) {
      auditLog.error(`LLM retry failed for ${context.service}/${context.phase}: ${secondError}. Generating minimal observation.`);
      return null; // Caller generates minimal observation
    }
  }
}

// When LLM is unavailable, generate a minimal observation:
function generateMinimalObservation(
  candidate: CandidateObservation,
  severity: SeverityResult,
  service: ServiceConfig
): MinimalObservation {
  return {
    ...candidate,
    summary: `[Auto-generated] ${candidate.error_type ?? 'error'} detected on ${service.name}. LLM analysis unavailable.`,
    root_cause_hypothesis: 'LLM analysis unavailable. Manual investigation required.',
    recommended_action: 'Review metrics and logs manually.',
    llm_analysis_available: false,
    severity: severity.severity,
    confidence: severity.score * 0.7, // Reduce confidence without LLM corroboration
  };
}
```

**Failure 2: Token budget exceeded mid-run**

```typescript
class TokenBudgetTracker {
  private consumed: number = 0;

  constructor(private maxTokens: number) {} // Default: 200,000 (NFR-005)

  record(tokens: number): void {
    this.consumed += tokens;
  }

  isExhausted(): boolean {
    return this.consumed >= this.maxTokens;
  }

  canContinue(estimatedNextServiceTokens: number = 30000): boolean {
    return this.consumed + estimatedNextServiceTokens <= this.maxTokens;
  }

  get remaining(): number {
    return Math.max(0, this.maxTokens - this.consumed);
  }
}

// In the runner loop:
for (const service of services) {
  if (!tokenBudget.canContinue()) {
    auditLog.warn(
      `Token budget exhausted (${tokenBudget.consumed}/${tokenBudget.maxTokens}). ` +
      `Completing current service ${currentService}, skipping remaining: ${remainingServices.join(', ')}`
    );
    metadata.errors.push(`Token budget exceeded. Skipped: ${remainingServices.join(', ')}`);
    break;
  }
  // Process service...
  tokenBudget.record(serviceTokensUsed);
}
```

**Failure 3: Invalid observation structure**

```typescript
import { z } from 'zod';

const ObservationFrontmatterSchema = z.object({
  id: z.string().regex(/^OBS-\d{8}-\d{6}-[a-f0-9]{4}$/),
  timestamp: z.string().datetime(),
  service: z.string().min(1),
  repo: z.string().min(1),
  type: z.enum(['error', 'anomaly', 'trend', 'adoption']),
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  confidence: z.number().min(0).max(1),
  triage_status: z.enum(['pending', 'promoted', 'dismissed', 'deferred', 'investigating', 'cooldown']),
  triage_decision: z.enum(['promote', 'dismiss', 'defer', 'investigate']).nullable(),
  triage_by: z.string().nullable(),
  triage_at: z.string().datetime().nullable(),
  triage_reason: z.string().nullable(),
  defer_until: z.string().nullable(),
  cooldown_active: z.boolean(),
  linked_prd: z.string().nullable(),
  linked_deployment: z.string().nullable(),
  effectiveness: z.enum(['improved', 'unchanged', 'degraded', 'pending']).nullable(),
  effectiveness_detail: z.object({
    pre_fix_avg: z.number().nullable(),
    post_fix_avg: z.number().nullable(),
    improvement_pct: z.number().nullable(),
    measured_window: z.string().nullable(),
  }).nullable().optional(),
  observation_run_id: z.string(),
  tokens_consumed: z.number().int(),
  fingerprint: z.string(),
  occurrence_count: z.number().int().min(1),
  data_sources: z.object({
    prometheus: z.enum(['available', 'degraded', 'unreachable', 'not_configured']),
    grafana: z.enum(['available', 'degraded', 'unreachable', 'not_configured']),
    opensearch: z.enum(['available', 'degraded', 'unreachable', 'not_configured']),
    sentry: z.enum(['available', 'degraded', 'unreachable', 'not_configured']),
  }),
  related_observations: z.array(z.string()),
  oscillation_warning: z.boolean(),
});

function validateObservation(frontmatter: unknown): { valid: boolean; errors: string[] } {
  const result = ObservationFrontmatterSchema.safeParse(frontmatter);
  if (result.success) {
    return { valid: true, errors: [] };
  }
  return {
    valid: false,
    errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
  };
}
```

Invalid observations are rejected and logged. They are NOT written to disk. The validation error is recorded in the run audit log.

### Task 16: Test Suite

**Unit test requirements per component**:

| Component | Key Tests |
|-----------|-----------|
| Severity scorer | Given TDD example inputs (error=12.3%, users=2400, critical, 45min) -> P1. Boundary tests at 0.75, 0.55, 0.35 |
| Fingerprint | Same error + different timestamps -> same hash. `Foo.java:42` normalizes to `Foo.java:*` |
| Stack normalizer | Line numbers, memory addresses, thread IDs, timestamps all removed |
| Deduplication | Intra-run merge increments count. Inter-run updates pending. Post-triage auto-dismisses |
| Anomaly (z-score) | z=3.2, sensitivity=2.5 -> flagged. z=2.0 -> not flagged. Bad direction check |
| Anomaly (IQR) | Outside upper bound -> flagged. Within bounds -> not flagged |
| Baseline | EWMA converges with alpha=0.1. Learning mode transitions correctly |
| Trend | Positive slope + degrading direction -> observation. Below threshold -> no observation |
| Confidence | All lookup table combinations verified |
| False positive | Maintenance window, excluded pattern, load test marker each tested |

**Integration test: full engine pipeline with mock data**:

```typescript
describe('Full Engine Pipeline', () => {
  test('produces correct candidate observations from mock scrubbed data', async () => {
    // Setup: mock scrubbed data with known error conditions
    const mockMetrics = createMockPrometheusResults({
      error_rate: 12.3,
      latency_p99: 8200,
      throughput: 53,
      availability: 87.7,
    });
    const mockLogs = createMockOpenSearchResults([
      { message: 'ConnectionPoolExhausted: pool "orders-db"', count: 1847 },
    ]);
    const mockAlerts = createMockGrafanaAlerts([
      { name: 'API Gateway 5xx Rate', state: 'alerting' },
    ]);

    // Run engine
    const result = await routeObservations(
      apiGatewayConfig,
      mockMetrics,
      mockLogs,
      mockAlerts,
      existingBaseline,
      config,
      previousRunState
    );

    // Verify: at least one error observation generated
    expect(result.observations.length).toBeGreaterThan(0);
    const errorObs = result.observations.find(o => o.type === 'error');
    expect(errorObs).toBeDefined();
    expect(errorObs!.metric_value).toBe(12.3);
    expect(errorObs!.service).toBe('api-gateway');
  });

  test('handles missing data sources gracefully', async () => {
    // Prometheus unavailable, only OpenSearch data
    const result = await routeObservations(
      apiGatewayConfig,
      [], // No prometheus data
      mockLogs,
      mockAlerts,
      existingBaseline,
      config,
      previousRunState
    );

    // Should still produce observations from log data
    // Confidence should be lower due to missing metric data
  });

  test('multiple observation types for one service', async () => {
    // Setup: error condition + anomaly condition + trend condition
    // All three should produce observations
    const result = await routeObservations(/* ... */);
    expect(result.observations.filter(o => o.type === 'error')).toHaveLength(1);
    expect(result.observations.filter(o => o.type === 'anomaly')).toHaveLength(1);
    expect(result.observations.filter(o => o.type === 'trend')).toHaveLength(1);
  });
});
```

## Acceptance Criteria

1. Claude session timeout triggers one retry. Second failure produces a minimal observation (metrics only, no LLM analysis, reduced confidence).
2. Token budget exceeded mid-run: complete current service, skip remaining, note skipped services in run metadata.
3. Invalid YAML frontmatter is validated against the full schema from TDD section 4.1. Invalid observations are rejected and logged, never written to disk.
4. All engine components have unit tests with deterministic inputs and expected outputs.
5. Severity scorer verified against TDD example (error=12.3%, 2400 users, critical, 45min -> P1).
6. Fingerprint determinism verified: same error with different timestamps -> same hash.
7. Stack normalizer verified: `Foo.java:42` -> `Foo.java:*`.
8. Deduplication all three windows verified with concrete scenarios.
9. Anomaly detection both methods verified with boundary conditions.
10. Baseline EWMA convergence verified.
11. Integration test: full engine pipeline with mock scrubbed data produces correct candidates.
12. Graceful degradation test: engine produces partial results when a data source is missing.

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-3-6-01 | LLM retry success | First call fails, second succeeds | Result from second call |
| TC-3-6-02 | LLM retry exhaustion | Both calls fail | Minimal observation with `llm_analysis_available: false` |
| TC-3-6-03 | Minimal observation confidence | LLM unavailable | Confidence reduced by 0.7x factor |
| TC-3-6-04 | Token budget: continue | 150K consumed, 200K limit, est 30K next | `canContinue()` returns true |
| TC-3-6-05 | Token budget: halt | 185K consumed, 200K limit, est 30K next | `canContinue()` returns false |
| TC-3-6-06 | Token budget: complete current | Budget exhausted mid-run | Current service completes, remaining skipped |
| TC-3-6-07 | Schema valid | All fields correct types and enums | `valid: true` |
| TC-3-6-08 | Schema invalid id format | `id: "BAD-FORMAT"` | `valid: false`, error on `id` |
| TC-3-6-09 | Schema invalid severity | `severity: "P5"` | `valid: false`, error on `severity` |
| TC-3-6-10 | Schema missing required | No `service` field | `valid: false` |
| TC-3-6-11 | Integration: TDD example | Mock data matching TDD section 3.9.2 example | Error observation for api-gateway with P1 severity |
| TC-3-6-12 | Integration: partial data | Only OpenSearch available | Observation generated with lower confidence |
| TC-3-6-13 | Integration: no issues | All metrics normal | No observations generated |
| TC-3-6-14 | Integration: multi-type | Error + anomaly + trend conditions | 3 observations for one service |
| TC-3-6-15 | Cooldown prerequisite | Time window check logic | Correct boolean for within/outside window |

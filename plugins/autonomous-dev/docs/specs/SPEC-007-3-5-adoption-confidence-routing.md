# SPEC-007-3-5: Feature Adoption, Confidence Scoring & Observation Routing

## Metadata
- **Parent Plan**: PLAN-007-3
- **Tasks Covered**: Task 12 (feature adoption tracking), Task 13 (confidence scoring), Task 14 (observation type decision tree)
- **Estimated effort**: 11 hours

## Description

Implement feature adoption tracking that monitors new endpoint traffic after deployments, the three-factor confidence scoring algorithm (evidence, dedup, history), and the observation type decision tree that routes each service evaluation through the correct priority: error -> anomaly -> trend -> adoption.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/adoption-tracker.ts` | Create | Deploy annotation detection and new endpoint traffic analysis |
| `src/engine/confidence.ts` | Create | Three-factor weighted confidence score |
| `src/engine/observation-router.ts` | Create | Decision tree routing for observation types |
| `tests/engine/adoption-tracker.test.ts` | Create | Deploy detection and traffic comparison tests |
| `tests/engine/confidence.test.ts` | Create | Score computation tests with all factor combinations |
| `tests/engine/observation-router.test.ts` | Create | Routing priority and multi-observation tests |

## Implementation Details

### Task 12: Feature Adoption Tracking

Tracks traffic to newly deployed endpoints based on Grafana deploy annotations.

```typescript
interface AdoptionResult {
  detected: boolean;
  deploy_info: {
    commit: string;
    deployed_at: string;
    days_since_deploy: number;
  };
  endpoints: EndpointAdoption[];
}

interface EndpointAdoption {
  endpoint: string;
  first_traffic_at: string | null;
  current_rps: number;
  error_rate: number;
  comparison?: {
    similar_endpoint: string;
    similar_endpoint_rps: number;
    similar_endpoint_error_rate: number;
    traffic_ratio: number;    // current/similar
  };
}

async function trackFeatureAdoption(
  service: ServiceConfig,
  grafanaAdapter: GrafanaAdapter,
  prometheusAdapter: PrometheusAdapter,
  config: IntelligenceConfig
): Promise<AdoptionResult | null> {
  // Step 1: Get recent deploy annotations from Grafana (last 7 days)
  const annotations = await grafanaAdapter.getAnnotations(
    service.grafana_dashboard_uid,
    7 * 24, // 7 days in hours
    ['deploy', 'release']
  );

  if (annotations.annotations.length === 0) {
    return null; // No recent deploys
  }

  const results: EndpointAdoption[] = [];

  // Step 2: For each deploy within the last 7 days
  for (const annotation of annotations.annotations) {
    const deployDate = new Date(annotation.time);
    const daysSince = (Date.now() - deployDate.getTime()) / (24 * 60 * 60 * 1000);

    // Step 3: Identify new/changed endpoints from deploy metadata
    // Parse annotation text for endpoint information
    const newEndpoints = extractNewEndpoints(annotation.text);

    // Step 4: Query Prometheus for traffic to new endpoints
    for (const endpoint of newEndpoints) {
      const trafficQuery = `sum(rate(http_requests_total{job="${service.prometheus_job}",handler="${endpoint}"}[1h]))`;
      const errorQuery = `sum(rate(http_requests_total{job="${service.prometheus_job}",handler="${endpoint}",status=~"5.."}[1h])) / sum(rate(http_requests_total{job="${service.prometheus_job}",handler="${endpoint}"}[1h])) * 100`;

      const traffic = await prometheusAdapter.executeInstantQuery('adoption_traffic', trafficQuery);
      const errors = await prometheusAdapter.executeInstantQuery('adoption_errors', errorQuery);

      const adoption: EndpointAdoption = {
        endpoint,
        first_traffic_at: traffic.value > 0 ? deployDate.toISOString() : null,
        current_rps: traffic.value ?? 0,
        error_rate: errors.value ?? 0,
      };

      // Step 5: Compare to similar endpoints (same service, similar path pattern)
      // e.g., /api/v2/orders compared to /api/v1/orders
      const similarEndpoint = findSimilarEndpoint(endpoint, service);
      if (similarEndpoint) {
        const similarTraffic = await prometheusAdapter.executeInstantQuery(
          'similar_traffic',
          `sum(rate(http_requests_total{job="${service.prometheus_job}",handler="${similarEndpoint}"}[1h]))`
        );
        adoption.comparison = {
          similar_endpoint: similarEndpoint,
          similar_endpoint_rps: similarTraffic.value ?? 0,
          similar_endpoint_error_rate: 0, // Query separately if needed
          traffic_ratio: similarTraffic.value > 0
            ? (traffic.value ?? 0) / similarTraffic.value
            : 0,
        };
      }

      results.push(adoption);
    }
  }

  return results.length > 0 ? {
    detected: true,
    deploy_info: {
      commit: annotations.annotations[0].text.match(/commit[:\s]+([a-f0-9]+)/i)?.[1] ?? 'unknown',
      deployed_at: annotations.annotations[0].time,
      days_since_deploy: (Date.now() - new Date(annotations.annotations[0].time).getTime()) / (24 * 60 * 60 * 1000),
    },
    endpoints: results,
  } : null;
}
```

### Task 13: Confidence Scoring

Three-factor weighted composite score per TDD section 3.8.

```typescript
interface ConfidenceScore {
  composite: number;       // 0.0 - 1.0
  evidence_score: number;  // 0.0 - 1.0
  dedup_score: number;     // 0.0 - 1.0
  history_score: number;   // 0.0 - 1.0
}

const CONFIDENCE_WEIGHTS = {
  evidence: 0.50,
  dedup: 0.25,
  history: 0.25,
};

function computeConfidence(
  candidate: CandidateObservation,
  dedupResult: DeduplicationResult,
  triageHistory: TriageHistorySummary
): ConfidenceScore {
  // Factor 1: Evidence strength (0.0 - 1.0)
  const evidenceScore = computeEvidenceScore(candidate);

  // Factor 2: Deduplication match quality (0.0 - 1.0)
  const dedupScore = computeDedupScore(dedupResult);

  // Factor 3: Historical false positive rate (0.0 - 1.0)
  const historyScore = computeHistoryScore(triageHistory);

  // Weighted composite
  const composite =
    CONFIDENCE_WEIGHTS.evidence * evidenceScore +
    CONFIDENCE_WEIGHTS.dedup * dedupScore +
    CONFIDENCE_WEIGHTS.history * historyScore;

  return { composite, evidence_score: evidenceScore, dedup_score: dedupScore, history_score: historyScore };
}

function computeEvidenceScore(candidate: CandidateObservation): number {
  const sources = candidate.data_sources_used;
  const hasMetric = sources.includes('prometheus');
  const hasLog = sources.includes('opensearch');
  const hasAlert = sources.includes('grafana');

  // Lookup table from TDD section 3.8:
  if (hasMetric && hasLog && hasAlert) return 1.0;
  if (hasMetric && hasLog)             return 0.8;
  if (hasMetric && candidate.sustained_minutes > 0) return 0.7;
  if (hasLog && candidate.log_samples.length > 10)  return 0.6;
  if (sources.length === 1)            return 0.4;
  // Data source gaps
  return 0.3;
}

function computeDedupScore(dedupResult: DeduplicationResult): number {
  // Lookup table from TDD section 3.8:
  switch (dedupResult.action) {
    case 'related_to_promoted':  return 1.0; // Exact match to promoted
    // Note: fuzzy match to promoted would be 0.8 (handled via similarity)
    case 'new':                  return 0.5; // New fingerprint, no matches
    case 'auto_dismiss':         return 0.3; // Similar to dismissed
    case 'merge_intra_run':      return 0.5; // Treat as new (within same run)
    case 'update_inter_run':     return 0.7; // Recurring issue still pending
    default:                     return 0.5;
  }
}

function computeHistoryScore(history: TriageHistorySummary): number {
  // Lookup table from TDD section 3.8:
  if (history.total_similar === 0) return 0.5;  // New pattern, no history

  const promoteRate = history.promoted_count / history.total_similar;

  if (promoteRate > 0.80) return 1.0;  // Historically promoted at >80%
  if (promoteRate >= 0.50) return 0.7; // Mixed history
  if (history.dismissed_count / history.total_similar > 0.50) return 0.2; // Mostly dismissed
  return 0.5;
}

interface TriageHistorySummary {
  total_similar: number;
  promoted_count: number;
  dismissed_count: number;
  deferred_count: number;
  investigating_count: number;
}
```

### Task 14: Observation Type Decision Tree

Routes each service evaluation through the priority: error -> anomaly -> trend -> adoption. Multiple observation types can coexist for the same service in one run.

```typescript
interface RoutingResult {
  observations: CandidateObservation[];
  skipped_phases: string[];    // Phases skipped due to learning mode
}

async function routeObservations(
  service: ServiceConfig,
  metrics: PrometheusResult[],
  logs: ScrubbedOpenSearchResult[],
  alerts: GrafanaAlertResult,
  baseline: BaselineMetrics,
  config: IntelligenceConfig,
  previousRunState: PreviousRunState
): Promise<RoutingResult> {
  const observations: CandidateObservation[] = [];
  const skipped: string[] = [];

  // Priority 1: Error detection (always active, even in learning mode)
  const errorCandidates = await detectErrors(metrics, logs, getServiceThresholds(config, service.name), service);
  const filteredErrors = errorCandidates.filter(c => !isFalsePositive(c, config, new Date()).filtered);
  observations.push(...filteredErrors);

  // Priority 2: Anomaly detection (Phase 2+, requires baseline, not in learning mode)
  if (!baseline.learning_mode) {
    for (const metric of BASELINE_METRICS) {
      const currentValue = getCurrentMetricValue(metrics, metric);
      if (currentValue === null) continue;

      const anomaly = config.anomaly_detection.method === 'zscore'
        ? detectAnomalyZScore(metric, currentValue, baseline.metrics[metric], config.anomaly_detection.sensitivity, previousRunState.anomalyFlags[metric])
        : detectAnomalyIQR(metric, currentValue, baseline.metrics[metric], previousRunState.anomalyFlags[metric]);

      if (anomaly.detected && anomaly.consecutive_runs >= 2) {
        observations.push(anomalyToCandidate(anomaly, service));
      }
    }
  } else {
    skipped.push('anomaly_detection (learning_mode)');
  }

  // Priority 3: Trend analysis (Phase 2+, requires baseline, not in learning mode)
  if (!baseline.learning_mode) {
    for (const metric of BASELINE_METRICS) {
      for (const window of config.trend_analysis.windows) {
        const trend = await analyzeTrend(metric, window, prometheusAdapter, service, baseline.metrics[metric], config);
        if (trend.detected) {
          observations.push(trendToCandidate(trend, service));
        }
      }
    }
  } else {
    skipped.push('trend_analysis (learning_mode)');
  }

  // Priority 4: Feature adoption (Phase 2+, not in learning mode)
  if (!baseline.learning_mode) {
    const adoption = await trackFeatureAdoption(service, grafanaAdapter, prometheusAdapter, config);
    if (adoption?.detected) {
      observations.push(adoptionToCandidate(adoption, service));
    }
  } else {
    skipped.push('feature_adoption (learning_mode)');
  }

  return { observations, skipped_phases: skipped };
}
```

**Key**: Multiple observation types CAN coexist for the same service in one run. For example, an error observation and a trend observation can both be generated if both conditions are met.

## Acceptance Criteria

1. Feature adoption retrieves recent deploy annotations from Grafana (last 7 days).
2. For each deploy, new/changed endpoints are identified and traffic is queried from Prometheus.
3. Adoption report includes first observed traffic timestamp, current RPS, error rate, and comparison to similar endpoints.
4. Evidence score uses the lookup table from TDD section 3.8 (1.0 for metric+log+alert, down to 0.3 for gaps).
5. Dedup score: 1.0 for exact match to promoted, 0.5 for new, 0.3 for similar to dismissed.
6. History score: 1.0 for >80% promote rate, 0.5 for new pattern, 0.2 for >50% dismiss rate.
7. Composite confidence = 0.50 * evidence + 0.25 * dedup + 0.25 * history. Range 0.0-1.0.
8. Decision tree routes: error (always) -> anomaly (not learning) -> trend (not learning) -> adoption (not learning).
9. Multiple observation types can coexist for the same service in one run.
10. Learning mode skips anomaly, trend, and adoption phases but not error detection.

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-3-5-01 | Adoption: new endpoint found | Deploy 2 days ago, endpoint `/api/v2/new` has traffic | Adoption result with current_rps > 0 |
| TC-3-5-02 | Adoption: no deploys | No annotations in last 7 days | `null` returned |
| TC-3-5-03 | Adoption: endpoint comparison | `/api/v2/orders` vs `/api/v1/orders` | `traffic_ratio` computed |
| TC-3-5-04 | Confidence: metric+log+alert | All 3 data sources | `evidence_score: 1.0` |
| TC-3-5-05 | Confidence: metric+log only | Prometheus + OpenSearch | `evidence_score: 0.8` |
| TC-3-5-06 | Confidence: single source | Only Prometheus | `evidence_score: 0.4` |
| TC-3-5-07 | Confidence: data gaps | Source unavailable | `evidence_score: 0.3` |
| TC-3-5-08 | Confidence: promoted dedup | `action: 'related_to_promoted'` | `dedup_score: 1.0` |
| TC-3-5-09 | Confidence: new fingerprint | `action: 'new'` | `dedup_score: 0.5` |
| TC-3-5-10 | Confidence: mostly promoted history | 8 promoted out of 10 | `history_score: 1.0` |
| TC-3-5-11 | Confidence: mostly dismissed | 6 dismissed out of 10 | `history_score: 0.2` |
| TC-3-5-12 | Confidence: composite | evidence=1.0, dedup=0.5, history=0.5 | `0.5*1.0 + 0.25*0.5 + 0.25*0.5 = 0.75` |
| TC-3-5-13 | Routing: error only | Error rate above threshold, in learning mode | Only error observation; anomaly/trend/adoption skipped |
| TC-3-5-14 | Routing: all types | Error + anomaly + trend conditions met, not learning | 3 observations generated |
| TC-3-5-15 | Routing: learning mode | New service in learning mode | Error active; anomaly, trend, adoption skipped with reasons |

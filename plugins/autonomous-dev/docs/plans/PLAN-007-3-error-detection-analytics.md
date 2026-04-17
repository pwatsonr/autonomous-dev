# PLAN-007-3: Error Detection & Analytics Engine

## Metadata
- **Parent TDD**: TDD-007-production-intelligence
- **Estimated effort**: 10 days
- **Dependencies**: [PLAN-007-1, PLAN-007-2]
- **Blocked by**: [PLAN-007-1] (requires data collection pipeline), [PLAN-007-2] (requires scrubbed data)
- **Priority**: P0

## Objective

Build the intelligence engine that transforms scrubbed production data into candidate observations. This plan covers deterministic threshold-based error detection, false positive filtering, severity scoring, fingerprint-based deduplication (exact and fuzzy), baseline management with learning mode, anomaly detection (z-score and IQR), trend analysis via linear regression, feature adoption tracking, and confidence scoring. The engine produces structured candidate observations ready for report generation.

## Scope

### In Scope
- Threshold-based error detection with sustained duration checks (section 3.5.1)
- Detection of all error types: crash, exception, timeout, degraded performance, data inconsistency (section 3.5.1)
- False positive filtering: maintenance windows, excluded error patterns, load test markers (section 3.5.2)
- Severity scoring algorithm with weighted factor matrix (section 3.5.3)
- LLM severity override constrained to one level with justification (section 3.5.3)
- Fingerprint generation with SHA-256 hashing of structural components (section 3.6.1)
- Stack trace normalization (remove line numbers, memory addresses, thread IDs, timestamps) (section 3.6.1)
- Deduplication windows: intra-run, inter-run (7 days), post-triage (30 days) (section 3.6.2)
- Fingerprint storage schema and management (section 3.6.3)
- Fuzzy similarity matching: Jaccard on stack frames, Levenshtein on error messages, temporal correlation (section 3.6.4)
- Baseline calculation with exponentially weighted moving average (section 3.7.1)
- Learning mode: 7-day data collection without anomaly/trend observations, minimum 6 runs (section 3.7.1)
- Anomaly detection: z-score (default) and IQR methods (section 3.7.2)
- Trend analysis: linear regression slope over 7d/14d/30d windows (section 3.7.3)
- Feature adoption tracking via deploy annotations and new endpoint traffic (section 3.7.4)
- Confidence scoring: evidence, dedup, and history factors (section 3.8)
- Observation type decision tree (Appendix C)
- Intelligence engine failure handling (section 6.3)

### Out of Scope
- Raw data collection from MCP servers (PLAN-007-1)
- PII/secret scrubbing (PLAN-007-2)
- Observation report file generation and storage (PLAN-007-4)
- Human triage interface and PRD promotion (PLAN-007-4)
- Governance: cooldown enforcement, oscillation detection, effectiveness tracking (PLAN-007-5)
- Phase 3 Sentry-enriched error reports (addressed in PLAN-007-5 context)
- Cross-service cascade detection (deferred per OQ-1 to Phase 2+)

## Tasks

1. **Implement threshold-based error detection** -- Build the deterministic threshold checker that compares current error rates against configured thresholds with sustained duration validation.
   - Files to create/modify: `src/engine/error-detector.ts`
   - Acceptance criteria: Accepts scrubbed Prometheus data and `intelligence.yaml` thresholds. Computes error rate and checks against `error_rate_percent` threshold. Performs range query to verify the sustained duration (`sustained_duration_minutes`). Supports per-service overrides deep-merged with defaults. Returns candidate observation with type, metric value, threshold value, and sustained minutes.
   - Estimated effort: 6 hours

2. **Implement additional error type detectors** -- Build detectors for crash (process termination), unhandled exception, timeout, degraded performance, and data inconsistency per TDD section 3.5.1.
   - Files to create/modify: `src/engine/error-detector.ts`
   - Acceptance criteria: Crash detection via `up == 0` or `changes(up) > 0`. Exception detection via OpenSearch aggregation of `level:ERROR` by exception class. Timeout detection via p99 latency exceeding SLA threshold. Degraded performance when p95 exceeds 2x baseline. Data inconsistency when HTTP 422/400 rate spikes. Each detector produces a typed candidate observation.
   - Estimated effort: 6 hours

3. **Implement false positive filtering** -- Build the filter chain that checks maintenance windows, excluded error patterns, and load test markers before a candidate proceeds to classification.
   - Files to create/modify: `src/engine/false-positive-filter.ts`
   - Acceptance criteria: Maintenance window check uses time-range matching against config. Excluded patterns use regex matching against candidate log samples. Load test markers check request metadata for configured marker tags. Filtered candidates are logged with reason and excluded from further processing. Filter runs before any LLM classification to save tokens.
   - Estimated effort: 4 hours

4. **Implement severity scoring algorithm** -- Build the weighted scoring matrix (error rate: 0.30, affected users: 0.25, service criticality: 0.20, duration: 0.15, data integrity: 0.10) with the scoring function from TDD section 3.5.3.
   - Files to create/modify: `src/engine/severity-scorer.ts`
   - Acceptance criteria: Scoring function accepts a candidate observation and service config. Computes weighted score across all five factors with the exact threshold ranges from the TDD. Maps aggregate score to P0/P1/P2/P3 using the thresholds (>=0.75, >=0.55, >=0.35, else). Includes `estimate_affected_users()` function based on throughput, error rate, and duration. Service criticality read from per-service config.
   - Estimated effort: 6 hours

5. **Implement LLM severity override** -- Build the LLM prompt and response handling that allows the LLM to adjust deterministic severity by at most one level with written justification.
   - Files to create/modify: `src/engine/severity-scorer.ts`, LLM prompt templates
   - Acceptance criteria: LLM receives the deterministic severity, scoring breakdown, and candidate data. May propose an override of exactly one level (up or down). Override must include a written justification string. Overrides of more than one level are rejected and logged. Override is recorded in the candidate observation metadata.
   - Estimated effort: 4 hours

6. **Implement fingerprint generation and stack trace normalization** -- Build the SHA-256 fingerprint hasher over service name, error class, affected endpoint, error code, and normalized top-3 stack trace frames.
   - Files to create/modify: `src/engine/fingerprint.ts`, `src/engine/stack-normalizer.ts`
   - Acceptance criteria: Fingerprint is deterministic: same logical error across deployments produces the same hash. Stack trace normalization removes line numbers, memory addresses, thread IDs, and timestamps. Top 3 frames are extracted and normalized before hashing. Fingerprint is hex-encoded.
   - Estimated effort: 4 hours

7. **Implement deduplication engine** -- Build the three deduplication windows (intra-run, inter-run 7 days, post-triage 30 days) with the merge and auto-dismiss logic from TDD section 3.6.2.
   - Files to create/modify: `src/engine/deduplicator.ts`, fingerprint store read/write
   - Acceptance criteria: Intra-run: multiple instances merge into one observation with `occurrence_count`. Inter-run: matching fingerprint for a `pending` observation appends an update rather than creating a new file. Post-triage: matching a `dismissed` observation auto-dismisses with reason `"previously_dismissed_duplicate"`. Matching a `promoted` observation flags as `"related_to_promoted"`. Fingerprint store (`.autonomous-dev/fingerprints/<service>.json`) is read at run start and written at run end.
   - Estimated effort: 8 hours

8. **Implement fuzzy similarity matching** -- Build the near-duplicate detection layer using Jaccard similarity on normalized stack frames (>80%), Levenshtein on error messages (<20% distance), and temporal correlation (same service, spike within 5 minutes).
   - Files to create/modify: `src/engine/similarity.ts`
   - Acceptance criteria: Jaccard similarity computed on normalized frame sets; >80% overlap triggers match. Levenshtein distance computed on error messages; <20% of message length triggers match. Temporal correlation: same service, error spike start within 5 minutes. When fuzzy match triggers, the new candidate and existing observation are presented to the LLM for a merge/separate decision.
   - Estimated effort: 6 hours

9. **Implement baseline management** -- Build the baseline storage, EWMA update algorithm, and learning mode lifecycle from TDD section 3.7.1.
   - Files to create/modify: `src/engine/baseline.ts`, baseline file read/write
   - Acceptance criteria: Baseline files (`.autonomous-dev/baselines/<service>.json`) match the schema from TDD section 4.2. EWMA update uses alpha=0.1: `mean = 0.9 * mean + 0.1 * new_value`. Standard deviation updated similarly. 14d and 30d windows query Prometheus `avg_over_time`/`stddev_over_time` directly. Learning mode active for first 7 days or minimum 6 observation runs. During learning mode, metrics are collected but no anomaly/trend observations are generated. Threshold-based error detection (task 1) remains active during learning mode.
   - Estimated effort: 6 hours

10. **Implement anomaly detection** -- Build z-score (default) and IQR anomaly detection methods from TDD section 3.7.2.
    - Files to create/modify: `src/engine/anomaly-detector.ts`
    - Acceptance criteria: Z-score method: `z = (current - mean) / stddev`, flags when `|z| > sensitivity` (default 2.5). IQR method: flags outside `Q1 - 1.5*IQR` to `Q3 + 1.5*IQR` bounds. Anomalies only generated when: service not in learning mode, anomaly persists across 2 consecutive runs, deviation is in a "bad" direction (increased errors/latency, decreased throughput/availability).
    - Estimated effort: 4 hours

11. **Implement trend analysis** -- Build linear regression slope computation over 7d/14d/30d windows from TDD section 3.7.3.
    - Files to create/modify: `src/engine/trend-analyzer.ts`
    - Acceptance criteria: Queries Prometheus for hourly data points over each window. Computes linear regression slope. Normalizes as percentage change per window relative to baseline mean. Generates trend observation when `|pct_change| > min_slope_threshold` (default 5%) and direction is degrading. Includes extrapolated "days until threshold breach" estimate.
    - Estimated effort: 4 hours

12. **Implement feature adoption tracking** -- Build the deploy annotation detection and new endpoint traffic analysis from TDD section 3.7.4.
    - Files to create/modify: `src/engine/adoption-tracker.ts`
    - Acceptance criteria: Retrieves recent deploy annotations from Grafana (last 7 days). Identifies new/changed endpoints from deploy metadata. Queries Prometheus for traffic to new endpoints. Reports first observed traffic timestamp, current RPS, error rate, and comparison to similar endpoints.
    - Estimated effort: 4 hours

13. **Implement confidence scoring** -- Build the three-factor confidence score from TDD section 3.8 (evidence: 0.50, dedup: 0.25, history: 0.25).
    - Files to create/modify: `src/engine/confidence.ts`
    - Acceptance criteria: Evidence score uses the lookup table from TDD (1.0 for metric+log+alert, down to 0.3 for data source gaps). Dedup score: 1.0 for exact match to promoted, 0.5 for new, 0.3 for similar to dismissed. History score: 1.0 for >80% promote rate, 0.5 for new pattern, 0.2 for >50% dismiss rate. Composite confidence is the weighted sum. Score is a float 0.0-1.0 included in the candidate observation.
    - Estimated effort: 4 hours

14. **Implement observation type decision tree** -- Wire the decision tree from Appendix C so that each service evaluation follows the correct priority: error -> anomaly -> trend -> adoption.
    - Files to create/modify: `src/engine/observation-router.ts`
    - Acceptance criteria: For each service, the engine checks error detection first. If no error, checks anomaly detection (Phase 2+). If no anomaly, checks trend analysis (Phase 2+). If no trend, checks feature adoption (Phase 2+). Multiple observation types can coexist for the same service in one run (e.g., both an error and a trend).
    - Estimated effort: 3 hours

15. **Implement intelligence engine failure handling** -- Handle Claude session failures, token budget exhaustion, and invalid observation structures per TDD section 6.3.
    - Files to create/modify: `src/engine/error-handler.ts`, schema validator
    - Acceptance criteria: Claude session timeout triggers one retry. Second failure produces a minimal observation (metrics only, no LLM analysis). Token budget exceeded mid-run: complete current service, skip remaining, note in metadata. Invalid YAML frontmatter: reject observation and log validation error. All failures are recoverable (no run crash).
    - Estimated effort: 4 hours

16. **Write unit and integration tests for the analytics engine** -- Test each component with deterministic inputs and expected outputs per TDD section 8.1 and 8.2.
    - Files to create/modify: Test files for all engine modules
    - Acceptance criteria: Severity scorer: given specific inputs, produces expected P0/P1/P2/P3 per TDD examples. Fingerprint generator: same error with different timestamps produces same fingerprint. Stack normalizer: `Foo.java:42` becomes `Foo.java:*`. Cooldown checker (prerequisite logic): time window logic correct. Anomaly detector: z=3.2 with sensitivity=2.5 flags anomaly. Baseline updater: EWMA converges correctly. Deduplication: intra-run merge increments count; inter-run updates existing observation; post-triage auto-dismisses. Integration test: full engine run with mock scrubbed data produces correct candidate observations. Graceful degradation test: engine produces partial results when a data source is missing.
    - Estimated effort: 14 hours

## Dependencies & Integration Points
- **Upstream**: PLAN-007-1 provides raw data via MCP adapters. PLAN-007-2 provides the `scrub()` function that cleans data before it enters this engine.
- **Downstream**: PLAN-007-4 consumes candidate observations to generate report files. PLAN-007-5 hooks into the fingerprint store and observation metadata for governance decisions.
- **Data stores**: Reads/writes `.autonomous-dev/baselines/<service>.json` and `.autonomous-dev/fingerprints/<service>.json`. These are file-based JSON stores.
- **LLM interaction**: Severity override (task 5), fuzzy match merge/separate decision (task 8), and root-cause hypothesis generation are LLM-powered. All other components are deterministic.
- **Configuration**: Thresholds, sensitivity, window sizes, and per-service overrides are read from `intelligence.yaml`.

## Testing Strategy
- **Unit tests**: Each engine component tested in isolation with deterministic inputs. Severity scorer tested with boundary conditions (score at 0.75, 0.55, 0.35 boundaries). Fingerprint tested for determinism and normalization correctness. Deduplication tested with intra-run, inter-run, and post-triage scenarios. Anomaly detection tested with z-score and IQR methods. Trend analysis tested with known slope data.
- **Integration tests**: Full engine pipeline with mock scrubbed data. Observation type routing confirmed. Multiple observation types for one service in one run. Engine correctly handles missing data sources (partial data). Token budget enforcement halts gracefully.
- **Regression tests**: Any false positive or missed detection discovered in production is added as a test case.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Severity scoring weights do not match real-world importance | Medium | Medium | Weights are configurable. Collect feedback from triage decisions and adjust weights in Phase 2. |
| False positive filtering is too aggressive, missing real issues | Low | High | Filter reasons are logged. Track filtered-but-real-issue rate via weekly audit of dismissed candidates. |
| Baseline EWMA alpha=0.1 converges too slowly for rapidly changing services | Medium | Low | Alpha is configurable. Document guidance for tuning based on service volatility. |
| Fuzzy similarity matching is expensive for large fingerprint stores | Low | Medium | Fuzzy matching only runs against observations from the last 7 days. Fingerprint store is partitioned by service. |
| LLM severity override consistently overrides deterministic scoring | Medium | Medium | Track override rate. If >30%, re-calibrate the deterministic weights. One-level constraint prevents runaway inflation. |
| Linear regression trend analysis produces false positives for seasonal patterns | Medium | Medium | Trend observations require degrading direction. Weekly/monthly seasonality not accounted for in Phase 1. Phase 2 can add day-of-week normalization. |

## Definition of Done
- [ ] Threshold-based error detection identifies all five error types from TDD section 3.5.1
- [ ] False positive filtering excludes maintenance windows, excluded patterns, and load test traffic
- [ ] Severity scoring produces correct P0-P3 for boundary conditions matching TDD examples
- [ ] LLM severity override is constrained to one level with justification
- [ ] Fingerprint generation is deterministic across deployments after stack trace normalization
- [ ] Deduplication correctly handles intra-run merge, inter-run update, and post-triage auto-dismiss
- [ ] Fuzzy similarity matching detects near-duplicates via Jaccard, Levenshtein, and temporal correlation
- [ ] Baseline management supports learning mode (7 days / 6 runs) and EWMA updates
- [ ] Anomaly detection (z-score and IQR) flags persistent, bad-direction deviations only when not in learning mode
- [ ] Trend analysis computes linear regression slope and extrapolates days-to-breach
- [ ] Feature adoption tracking reports traffic metrics for newly deployed endpoints
- [ ] Confidence scoring combines evidence, dedup, and history factors into a 0.0-1.0 score
- [ ] Observation type decision tree routes candidates through the correct priority order
- [ ] Intelligence engine failures are handled per TDD section 6.3 without crashing the run
- [ ] All unit tests pass with deterministic, boundary-condition, and edge-case coverage
- [ ] Integration test confirms full engine pipeline produces correct candidate observations from mock data

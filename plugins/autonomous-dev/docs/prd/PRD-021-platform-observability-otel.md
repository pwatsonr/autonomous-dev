# PRD-021: Platform Observability (OpenTelemetry)

**Metadata:** PRD-021 | v0.1.0 | 2026-04-18 | Patrick Watson | Draft | autonomous-dev

---

## 1. Problem

autonomous-dev has zero observability on itself. Daemon crashes, phase stalls, cost spikes, agent hallucinations — all opaque. Logs are flat files. No traces across phase/session boundaries. PRD-005 tells USERS to instrument their apps but the platform is not instrumented. OpenTelemetry (CNCF Graduated) is the universal 2026 standard — we need it applied internally, with vendor-neutral backend support so orgs can ship telemetry to any OTLP sink.

When the daemon stalls mid-phase, the on-call engineer has no trace to follow. When an LLM call inflates a session cost by 10x, there is no span correlating the model invocation to the phase and the tenant. When a review gate rejects and retries six times, there is no metric to surface that retry loop. The platform is blind to itself. That has to end.

This PRD defines how autonomous-dev instruments every internal subsystem using OpenTelemetry SDK, propagates W3C Trace Context across session spawn boundaries, emits RED/USE metrics, ships structured logs correlated to traces, enables profiling for daemon hotspots, defines SLOs via OpenSLO with Sloth-generated Prometheus rules, and provides pluggable OTLP export to any vendor backend. It also defines dashboards-as-code, alert rules, and optional eBPF auto-instrumentation.

---

## 2. Goals

| ID | Goal |
|----|------|
| G-1 | OpenTelemetry instrumentation across every subsystem: daemon loop, phase execution, LLM calls, state store, review gates, intake, notifications. |
| G-2 | W3C Trace Context propagation through session spawns via environment variables. |
| G-3 | Traces + metrics + logs + profiles unified under a single OTel pipeline (OTel 2025+ GA signals). |
| G-4 | OpenLLMetry GenAI semantic conventions applied to every LLM span. |
| G-5 | RED (rate, errors, duration) and USE (utilization, saturation, errors) metrics emitted per subsystem. |
| G-6 | SLOs defined via OpenSLO YAML; Prometheus alerting rules generated via Sloth. |
| G-7 | Pluggable backend via OTLP; adapter documentation for Grafana LGTM stack (default), Datadog, Honeycomb, New Relic, Chronosphere, Azure Monitor, Google Cloud Ops, AWS Application Signals, Sentry. |
| G-8 | eBPF auto-instrumentation option using Grafana Beyla and Pixie (advanced/opt-in). |
| G-9 | AI-assisted incident response hooks for PagerDuty and incident.io. |
| G-10 | Dashboards-as-code checked into the repository under `plugins/autonomous-dev/dashboards/`, with Grafana JSON and Datadog YAML variants. |

---

## 3. Non-Goals

| ID | Non-Goal |
|----|----------|
| NG-1 | Hosting or operating an observability backend. The platform emits; users run or subscribe to a backend. |
| NG-2 | Replacing user-application observability instrumentation (addressed in PRD-005 and PRD-016). |
| NG-3 | Building or positioning as an APM product. |
| NG-4 | Authoring or maintaining dashboards for every possible user backend. Supported: Grafana JSON, Datadog YAML. |
| NG-5 | Building an AIOps or ML-based anomaly detection product. Alert rules are threshold/SLO-burn-rate based. |

---

## 4. Personas

**Platform SRE** — operates the autonomous-dev daemon in production; owns uptime SLOs; needs traces and dashboards to diagnose incidents within MTTR budget.

**On-Call Engineer** — receives alerts from Alertmanager or PagerDuty; needs a single trace ID to jump from alert to root cause without grepping flat log files.

**Platform Maintainer** — develops autonomous-dev itself; needs metrics to validate performance of new phase logic and regression-detect instrumentation overhead.

**Cost Owner** — owns LLM and infrastructure spend; needs per-call cost counters correlated with tenant, model, phase, and session to generate chargebacks and identify runaway calls.

**Compliance Auditor** — needs assurance that no PII appears in spans or metric labels; needs audit trail of trace data retention and redaction policies.

---

## 5. User Stories

| ID | Story |
|----|-------|
| US-01 | As a Platform SRE, I can follow a single trace from request submission through all phase executions to final deployment, so I understand the full causal chain. |
| US-02 | As an On-Call Engineer, I am paged when an SLO error budget burns faster than the defined threshold, so I can act before the budget is exhausted. |
| US-03 | As a Platform Maintainer, I can view a daemon health dashboard that shows RED metrics per subsystem without writing any queries. |
| US-04 | As a Cost Owner, I can see per-LLM-call token spend correlated with the span that triggered the call, the model, the phase, and the tenant. |
| US-05 | As a Compliance Auditor, I can query traces and confirm that PII fields are hashed or absent before telemetry reaches the backend. |
| US-06 | As a Platform SRE, I am alerted when a phase stall exceeds the defined stall threshold, with a trace ID attached to the alert. |
| US-07 | As a Platform Maintainer, I can view a phase latency heatmap to identify which phase type has the longest p99 duration over the past 7 days. |
| US-08 | As a Platform SRE, I can scope all telemetry queries to a specific tenant using the `tenant_id` attribute without cross-tenant leakage. |
| US-09 | As a Platform Maintainer, I can swap from Grafana LGTM to Datadog as the OTLP backend by changing a config value with zero code changes. |
| US-10 | As a Platform SRE, I can enable eBPF auto-instrumentation via Beyla to capture network-level spans for daemon-to-external calls without recompiling the daemon. |
| US-11 | As a Platform Maintainer running locally, I can point telemetry at a local Jaeger instance for development without affecting production config. |
| US-12 | As a Platform SRE, I can use Grafana Tempo as the trace backend in production, navigating from a metric panel to a correlated trace with one click. |
| US-13 | As a Cost Owner, I can use Honeycomb for high-cardinality span analysis on model + tenant + phase combinations that Prometheus cannot efficiently handle. |
| US-14 | As a Platform Maintainer, I can trigger an on-demand pprof/OTel profile of the daemon to identify CPU or memory hotspots without always-on profile overhead. |
| US-15 | As an On-Call Engineer, I have an incident.io channel auto-created when a critical SLO alert fires, populated with the relevant trace ID and error budget remaining. |
| US-16 | As a Platform Maintainer, I can version-control all dashboards in the repository and promote them through environments via CI. |
| US-17 | As a Platform SRE, I can run `autonomous-dev observe status` to see a per-subsystem health summary in the terminal without opening a browser. |
| US-18 | As an On-Call Engineer, I can run `autonomous-dev observe trace <request_id>` to pretty-print the full trace for a request directly in the terminal. |

---

## 6. Functional Requirements

### 6.1 Instrumentation (FR-100s)

**FR-100** The OTel SDK MUST be initialized in the daemon bootstrap before any subsystem starts, reading endpoint and sampling config from the platform config file and environment variables.

**FR-101** Trace spans MUST be emitted at the following boundaries:
- Phase start and end (including phase type, phase ID, session ID, tenant ID as attributes)
- Every LLM call (model, prompt token count, completion token count, cost estimate)
- Every state-store read and write operation (operation type, key namespace, duration)
- Every review gate evaluation (gate type, result, retry count)
- Every intake message received (source, message type, session created)
- Every notification dispatch (channel, delivery status)

**FR-102** W3C Trace Context (`traceparent`, `tracestate`) MUST be injected into session spawn environment variables so child processes continue the same trace.

**FR-103** Auto-instrumentation libraries for HTTP, database, and gRPC MUST be enabled where those transports are used internally.

### 6.2 Semantic Conventions (FR-200s)

**FR-200** All spans MUST follow OpenTelemetry semantic conventions for their signal type (HTTP, DB, messaging, etc.) using the attribute names defined in the OTel spec.

**FR-201** Every LLM span MUST carry OpenLLMetry GenAI semantic convention attributes: `gen_ai.system`, `gen_ai.request.model`, `gen_ai.request.max_tokens`, `gen_ai.usage.prompt_tokens`, `gen_ai.usage.completion_tokens`, `gen_ai.response.finish_reason`.

**FR-202** Every span MUST carry a `tenant_id` attribute derived from the active session context, enabling per-tenant telemetry scoping at the backend.

### 6.3 Metrics (FR-300s)

**FR-300** RED metrics (rate, error rate, duration histograms) MUST be emitted for: daemon loop iterations, phase executions, LLM calls, state-store operations, review gate evaluations, intake processing, notification dispatch.

**FR-301** USE metrics (utilization, saturation, errors) MUST be emitted for: daemon process CPU, daemon heap/RSS, disk I/O for worktree checkouts, file descriptor consumption.

**FR-302** A cost counter (`autonomous_dev_llm_cost_usd_total`) labeled by `model`, `phase_type`, `tenant_id` MUST be emitted for every LLM call, integrating with PRD-023 cost tracking.

### 6.4 Logs (FR-400s)

**FR-400** All daemon log output MUST be emitted as structured JSON via the OTel log pipeline (OTLP log export), replacing the current flat-file output.

**FR-401** Every log record MUST include `trace_id` and `span_id` fields populated from the active span context, enabling direct correlation between logs and traces in the backend.

**FR-402** Log records MUST pass through a PII redaction processor (per PRD-026 policy) before export. Prompt text MUST be hashed or omitted; user identifiers MUST be pseudonymized.

### 6.5 Profiles (FR-500s)

**FR-500** OTel profiles (2025 GA signal) MUST be supported for capturing daemon CPU and memory hotspots using pprof-format profiles wrapped in OTLP profile export.

**FR-501** Backend adapters MUST be documented for Parca and Pyroscope as profile storage backends. Profile collection MUST be on-demand, not always-on, to bound overhead.

### 6.6 SLOs (FR-600s)

**FR-600** OpenSLO YAML definitions MUST be authored for the following SLOs:
- Daemon uptime (availability)
- Phase execution success rate
- Request queue age (freshness SLO)
- LLM call latency p99
- Deployment success rate

**FR-601** Sloth MUST be used to generate Prometheus recording and alerting rules from the OpenSLO definitions. Generated rules MUST be committed to the repository alongside the OpenSLO source.

**FR-602** Error-budget policy MUST be codified: burn-rate fast-burn (1-hour window) and slow-burn (6-hour window) alert thresholds defined per SLO.

### 6.7 Backend Adapters (FR-700s)

**FR-700** OTLP-HTTP MUST be the default export protocol. OTLP-gRPC MUST be supported as an opt-in alternative.

**FR-701** Adapter documentation and example configuration MUST be provided for: Grafana LGTM stack (Loki + Grafana + Tempo + Mimir), Datadog, Honeycomb, New Relic, Chronosphere, Azure Monitor, Google Cloud Ops, AWS Application Signals, Sentry.

**FR-702** No vendor-specific SDK, client library, or import MUST appear in the core daemon code. All vendor integration is achieved via OTLP configuration and documented collector pipelines.

### 6.8 Sampling (FR-800s)

**FR-800** Tail-based sampling via OpenTelemetry Collector `tailsampling` processor is the RECOMMENDED production configuration.

**FR-801** The default head-based sampler MUST be configurable; default is 10% of traces sampled, with 100% sampling enforced for any trace containing an error span.

**FR-802** Per-tenant sampling rate override MUST be supported via config, enabling high-value tenants to run at 100% and reducing cost for high-volume low-value tenants.

### 6.9 eBPF Option (FR-900s)

**FR-900** Grafana Beyla MAY be used as an eBPF-based auto-instrumentation agent that instruments the daemon process at the OS level without SDK changes.

**FR-901** Pixie MAY be deployed for Kubernetes-side network-level visibility into daemon pod communication.

**FR-902** eBPF instrumentation MUST be documented as an advanced option with privilege requirements, kernel version constraints, and security considerations clearly stated.

### 6.10 Dashboards and Alerts (FR-1000s)

**FR-1000** All dashboards MUST be stored as code under `plugins/autonomous-dev/dashboards/` and versioned in the repository alongside the platform source.

**FR-1001** Two dashboard format variants MUST be maintained: Grafana JSON (for LGTM and Grafana Cloud) and Datadog dashboard YAML (for Datadog backend).

**FR-1002** Prometheus alerting rules generated by Sloth from OpenSLO definitions MUST be stored under `plugins/autonomous-dev/alerts/` and applied via Alertmanager configuration.

**FR-1003** Incident tool integrations MUST be provided as documented adapter configurations: PagerDuty escalation policy wiring and incident.io webhook automation for auto-channel creation.

### 6.11 CLI (FR-1100s)

**FR-1100** `autonomous-dev observe status` MUST display a per-subsystem health summary (last 5 minutes RED metrics, current SLO compliance) in the terminal.

**FR-1101** `autonomous-dev observe trace <request_id>` MUST retrieve and pretty-print the full trace for a given request ID, showing span tree with durations and key attributes.

**FR-1102** `autonomous-dev observe export --format otlp` MUST dump recent in-memory telemetry to stdout or file in OTLP JSON format, enabling support bundles without backend access.

---

## 7. Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-01 | Instrumentation overhead MUST be less than 3% additional CPU utilization under steady-state production load (benchmarked in CI). |
| NFR-02 | Trace coverage MUST be greater than or equal to 95% of all pipeline operations (phase starts, LLM calls, review gates) as verified by span coverage tests. |
| NFR-03 | OTLP export MUST include retry logic with exponential backoff and dead-letter buffer to handle transient backend unavailability without data loss. |
| NFR-04 | Backpressure from a slow or unavailable OTLP backend MUST NOT degrade daemon throughput. The exporter MUST drop telemetry rather than block the critical path. |
| NFR-05 | Zero PII (personally identifiable information) MUST appear in exported spans, metrics labels, or log records as validated by automated PII redaction tests. |
| NFR-06 | Backend swap (e.g., Grafana LGTM to Datadog) MUST require only configuration changes and MUST NOT require daemon downtime beyond a restart. |
| NFR-07 | Sampling rate MUST be configurable per tenant at runtime without daemon restart, reloading from config on a defined interval. |
| NFR-08 | Profile collection MUST be on-demand only. Always-on profiling MUST NOT be the default. |
| NFR-09 | Reference dashboards MUST render in under 5 seconds on a standard Grafana or Datadog instance with 30 days of data. |
| NFR-10 | SLO burn-rate alerts MUST trigger within 1 minute of the burn rate exceeding threshold under test conditions. |

---

## 8. Architecture

### Signal Flow

```
autonomous-dev Daemon
┌─────────────────────────────────────────────────────────────┐
│  Daemon Loop │ Phase Executor │ LLM Client │ State Store    │
│  Review Gate │ Intake Handler │ Notifier   │ Session Spawn  │
│                    │                                         │
│              OTel SDK (Go / Python)                         │
│         Traces │ Metrics │ Logs │ Profiles                  │
│                    │                                         │
│         OTLP Exporter (HTTP default / gRPC opt-in)          │
└────────────────────┬────────────────────────────────────────┘
                     │
           OTel Collector (agent mode)
           ┌─────────┴───────────────┐
           │  tail-sampling processor │
           │  PII redaction processor │
           │  batch processor         │
           └─────────┬───────────────┘
                     │ OTLP
        ┌────────────┼──────────────┐
        ▼            ▼              ▼
  Grafana LGTM   Datadog      Honeycomb
  (default)    (adapter)     (adapter)
  Loki/Tempo/    │             │
  Mimir/Grafana  New Relic    Chronosphere
                 Azure Monitor  AWS App Signals

Side Channel:
OpenSLO YAML → Sloth → Prometheus Rules
Prometheus → Alertmanager → PagerDuty / incident.io
```

### W3C Trace Context Propagation

Session spawn injects `TRACEPARENT` and `TRACESTATE` into the child process environment. The child OTel SDK reads these on initialization and continues the parent trace, ensuring a single distributed trace spans daemon → session subprocess → tool invocations.

### Collector Topology

Development: daemon → local Jaeger (all-in-one) via OTLP-HTTP on localhost:4318.
Production: daemon → OTel Collector DaemonSet (or sidecar) → backend of choice. Collector handles retry, batching, tail sampling, and PII scrubbing, so the daemon exporter remains simple.

---

## 9. Testing Strategy

| Test Type | Coverage Target |
|-----------|----------------|
| Span coverage test | Assert every instrumented boundary emits a span with required attributes using OTel SDK test exporter |
| Attribute correctness | Assert OpenLLMetry GenAI attributes present and correctly typed on every LLM span |
| PII redaction test | Assert known PII patterns absent from exported span/log payloads |
| Backend-swap smoke test | Run against Jaeger (dev) and assert OTLP export succeeds; config-swap to second endpoint and assert spans arrive |
| Sampling correctness | Assert error spans always sampled at 100%; non-error spans sampled within configured tolerance |
| SLO rule generation test | Assert Sloth-generated Prometheus rules syntactically valid and match expected burn-rate alert names |
| Dashboard rendering snapshot | Grafana snapshot test for reference dashboards against fixture data |
| Overhead benchmark | Before/after CPU and throughput benchmark in CI; fail if instrumentation overhead exceeds 3% |

---

## 10. Migration Plan

### Phase 1 — Foundation (Weeks 1–3)

- Initialize OTel SDK in daemon bootstrap with OTLP-HTTP exporter.
- Instrument phase start/end, LLM call, state-store op with basic spans.
- Emit RED metrics for phase execution and LLM calls.
- Set up Grafana LGTM stack as default local and reference backend.
- Commit initial Grafana dashboards for phase execution and daemon health.
- Add span coverage tests to CI gate.

### Phase 2 — Conventions, SLOs, Alerts (Weeks 4–6)

- Apply OpenLLMetry GenAI semantic conventions to all LLM spans.
- Add `tenant_id` attribute propagation across all spans.
- Author OpenSLO YAML for five initial SLOs.
- Run Sloth to generate Prometheus alerting rules; add to repository.
- Wire Alertmanager to PagerDuty and incident.io webhook adapters.
- Implement structured JSON log pipeline with trace_id/span_id correlation.
- Add PII redaction processor and redaction test to CI.
- Add Datadog dashboard YAML variants.

### Phase 3 — Advanced (Weeks 7–10)

- Enable OTel profiles (on-demand) with Pyroscope/Parca adapter documentation.
- Document and test eBPF option via Grafana Beyla.
- Implement per-tenant sampling config with runtime reload.
- Configure OTel Collector tail-sampling for production topology.
- Implement CLI: `observe status`, `observe trace`, `observe export`.
- Add adapter documentation for all FR-701 backends.
- Load and performance test instrumentation overhead; enforce 3% CI gate.

---

## 11. Risks

| ID | Risk | Mitigation |
|----|------|------------|
| R-1 | Instrumentation causes measurable performance regression | Benchmark CI gate; async/non-blocking exporter; drop-on-backpressure policy |
| R-2 | PII leaks into spans (prompt text, user identifiers) | PII redaction processor in Collector; automated redaction test in CI; hash-only for prompt content |
| R-3 | Backend cost explosion due to high trace/metric volume | Tail-based sampling; per-tenant rate control; metric cardinality governance |
| R-4 | Vendor lock-in via semantic convention drift | Pin OTel minor version; audit on upgrade; no vendor SDK in core |
| R-5 | OTLP gRPC vs HTTP protocol mismatches with chosen backend | Default to OTLP-HTTP; document gRPC opt-in with backend-specific notes |
| R-6 | OTel schema drift across major SDK versions | Pin SDK minor version; schema compatibility tests on upgrade PRs |
| R-7 | User prompt content visible in traces | Hash prompt text at instrumentation layer; never include raw prompt in span attributes |
| R-8 | Sampling causes loss of critical error traces | Error spans always sampled at 100% regardless of head/tail rate; verified by sampling correctness test |
| R-9 | Always-on profiling introduces overhead | On-demand only by default; documented toggle; overhead benchmark in CI |
| R-10 | Dashboard maintenance burden as platform evolves | Generate dashboards from metric/SLO definitions where possible; snapshot regression tests flag drift |
| R-11 | eBPF privilege requirements block adoption in restricted environments | Documented as opt-in advanced feature; kernel version and CAP_BPF requirements stated explicitly |
| R-12 | SLO thresholds miscalibrated, causing alert fatigue | Start Phase 2 SLOs in warn-only mode for 90 days; promote to page only after baseline established |

---

## 12. Success Metrics

| Metric | Target |
|--------|--------|
| Incident MTTR (p95) | Less than 30 minutes |
| SLO compliance report | Generated and reviewed monthly |
| Trace coverage of pipeline operations | Greater than or equal to 95% |
| PII incidents in spans | Zero |
| Backend swap effort | Zero code changes, config-only |
| SLO burn-rate alert latency | Less than 1 minute from threshold crossing to page |
| Dashboard adoption among operators | Greater than or equal to 80% within 60 days of Phase 2 |
| Instrumentation CPU overhead | Less than 3% under production load |

---

## 13. Open Questions

| ID | Question | Owner | Target |
|----|----------|-------|--------|
| OQ-1 | Default reference backend: Grafana LGTM or Datadog? Current PRD assumes LGTM; confirm with platform team. | Platform SRE | Week 1 |
| OQ-2 | Default head-sampling rate: 10% proposed; validate against expected trace volume and backend storage cost. | Cost Owner | Week 2 |
| OQ-3 | Profiles always-on vs on-demand: on-demand is the default proposal; confirm no use case requires always-on. | Platform Maintainer | Week 3 |
| OQ-4 | OpenSLO canonical format or native Sloth YAML: standardize on OpenSLO as source-of-truth with Sloth as generator. Confirm. | Platform SRE | Week 4 |
| OQ-5 | Dashboard format: Grafana JSON + Datadog YAML in Phase 1/2, with Perses as a future option. Confirm scope. | Platform Maintainer | Week 4 |
| OQ-6 | eBPF instrumentation: Phase 3 as proposed, or defer to post-1.0? Confirm privilege model acceptable. | Platform SRE | Week 5 |

---

## 14. References

### Related PRDs

- PRD-001: Daemon architecture
- PRD-005: Production intelligence (user-app observability)
- PRD-007: Escalation and review gates
- PRD-014: Deployment SLOs
- PRD-016: Application instrumentation guidance
- PRD-018: LLM observability conventions
- PRD-023: Cost tracking and attribution
- PRD-026: PII handling and data governance

### External References

- OpenTelemetry: https://opentelemetry.io
- OpenLLMetry GenAI conventions: https://www.traceloop.com/openllmetry
- Grafana Beyla eBPF: https://grafana.com/oss/beyla-ebpf/
- Pixie: https://px.dev
- OpenSLO: https://openslo.com
- Sloth: https://sloth.dev
- Grafana OTel docs: https://grafana.com/docs/opentelemetry/
- incident.io: https://incident.io
- PagerDuty: https://www.pagerduty.com

---

**END PRD-021**

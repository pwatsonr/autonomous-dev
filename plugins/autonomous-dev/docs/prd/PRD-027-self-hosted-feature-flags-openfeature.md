# PRD-027: Self-Hosted Feature Flags (OpenFeature)

**Metadata**

| Field | Value |
|---|---|
| PRD | PRD-027 |
| Version | v0.1.0 |
| Date | 2026-04-18 |
| Author | Patrick Watson |
| Status | Draft |
| Product | autonomous-dev |

---

## 1. Problem Statement

autonomous-dev recommends feature flags throughout its guidance (PRD-014 for progressive delivery, PRD-013 for new-project bootstrap) but does not dogfood them for its own internal rollouts. Plugin updates currently ship as all-or-nothing to every user simultaneously, with no ability to stage rollout, target specific tenants, or instantly revert misbehaving changes.

OpenFeature (CNCF Incubating as of 2026) is the vendor-neutral specification for feature flagging. By embedding the OpenFeature SDK internally and adopting flagd (CNCF Sandbox) as the default self-hosted provider, autonomous-dev gains:

- Progressive rollout of new agents, models, prompts, and pipeline changes
- Instant kill-switch capability for in-flight tasks
- Per-tenant flag scoping without external service dependencies
- A vendor-neutral contract allowing provider swaps without code changes
- Full audit trail satisfying PRD-019 compliance requirements

This PRD defines requirements for embedding OpenFeature natively into the autonomous-dev daemon and plugin ecosystem, with flagd as the default provider and a defined adapter matrix for external providers.

---

## 2. Goals

| ID | Goal |
|---|---|
| G-1 | Embed OpenFeature SDK into the autonomous-dev daemon and plugin host at startup |
| G-2 | Default provider is flagd (CNCF Sandbox): self-hosted, no network egress required, file-based with HTTP polling |
| G-3 | Adapter matrix covering LaunchDarkly, Unleash (OSS), GrowthBook, Statsig, Flagsmith, and Flipt |
| G-4 | Every new agent, model configuration, prompt version, or pipeline behavior change ships behind a flag |
| G-5 | Flag metadata schema enforces: owner, expiration date, kill-switch capability, rollout strategy, and description |
| G-6 | Flag lifecycle tracked as technical debt; expiration enforced via scorecard integration (PRD-025) |
| G-7 | CLI surface for flag operations: list, create, toggle, expire, audit history, emergency kill |
| G-8 | Per-tenant flag scoping aligned with PRD-020 multi-tenancy model |
| G-9 | Full audit trail of every flag mutation with actor, timestamp, old value, and new value |
| G-10 | Dogfooding: trust-ladder advances (PRD-007), agent-factory promotions (PRD-003), LLM provider failover (PRD-018), and deploy-tier enables (PRD-017) all gated by flags |

---

## 3. Non-Goals

| ID | Non-Goal |
|---|---|
| NG-1 | Building a feature-flag product — OpenFeature is the contract; we are a consumer, not a provider |
| NG-2 | Becoming an A/B testing or experimentation statistics platform (LaunchDarkly, Statsig handle that at the provider level) |
| NG-3 | Providing experimentation statistics or significance testing engine |
| NG-4 | Replacing user-facing flags in tenant projects — organizations choose their own provider |
| NG-5 | Supporting OpenFeature Web SDK variants at this time (Server SDK only in scope for v0.1) |

---

## 4. Personas

| Persona | Description |
|---|---|
| Platform Maintainer | Engineers shipping changes to autonomous-dev itself; primary author of new flags |
| Release Engineer | Manages rollout percentage progression and monitors rollout health metrics |
| SRE | Uses kill-switch and emergency CLI to respond to incidents; monitors flag-vs-error-rate dashboards |
| Tenant Admin | Views beta flags available for their tenant; enables opt-in flags for their organization |
| Agent Factory Operator | Promotes new agent variants behind flags as part of PRD-003 autonomous-with-guardrails Phase 3 pipeline |

---

## 5. User Stories

| ID | Story |
|---|---|
| US-01 | As a Platform Maintainer, I can roll out a new model configuration at 5% → 25% → 100% via flag percentage rules, so gradual exposure limits blast radius |
| US-02 | As an SRE, I can kill a misbehaving agent variant via a single CLI command and have all in-flight tasks receive the signal within 30 seconds |
| US-03 | As a Tenant Admin, I can enable a beta feature scoped to my tenant without affecting other organizations |
| US-04 | As a Platform Maintainer, I receive a scorecard warning when a flag approaches its 90-day sunset window, so technical debt does not accumulate |
| US-05 | As an Agent Factory Operator, I gate agent promotion from staging to production behind a flag, so rollback is a single toggle |
| US-06 | As a Release Engineer, I can inspect the full history of every change to a flag — who changed it, when, from what value to what value |
| US-07 | As a Platform Maintainer, I can swap the flag provider from flagd to LaunchDarkly by changing a single config key with zero downtime |
| US-08 | As an SRE, when error rates spike above threshold, the rollout halts automatically and I receive an alert with the correlated flag state |
| US-09 | As a Release Engineer, I can configure per-environment flag states so a flag is always-on in dev but gated in production |
| US-10 | As a Platform Maintainer, I can target flag enablement by trust level, so higher-trust users get earlier access to experimental features |
| US-11 | As a Platform Maintainer, I see a stale-flag warning in the scorecard when a flag has been at 100% rollout for more than the sunset window |
| US-12 | As an SRE, a kill-switch propagates instantly to every in-flight autonomous task, not just new tasks |
| US-13 | As a Tenant Admin, I can configure a kill-switch flag that disables all agent activity for my tenant in an emergency |
| US-14 | As a Platform Maintainer, I can perform an emergency admin override via CLI bypassing the normal approval workflow for critical incidents |
| US-15 | As a Release Engineer, every flag evaluation emits an OpenTelemetry span attribute so I can correlate flag state with distributed traces (PRD-021) |
| US-16 | As a Platform Maintainer, post-sunset flag removal is automated via an agent-factory PR, removing dead code branches |

---

## 6. Functional Requirements

### 6.1 OpenFeature Core (FR-100s)

| ID | Requirement |
|---|---|
| FR-100 | The OpenFeature SDK must be initialized at autonomous-dev daemon startup before any plugin or agent loads |
| FR-101 | Flag evaluation must use the standard OpenFeature typed methods: `getBooleanValue`, `getStringValue`, `getNumberValue`, `getObjectValue`, with typed defaults |
| FR-102 | Evaluation context must include: `tenant_id`, `trust_level`, `environment`, and `user_id` when applicable; context is immutable per-request |
| FR-103 | The OpenFeature provider must be swappable at runtime via configuration reload without daemon restart |
| FR-104 | All flag evaluation errors must be handled gracefully — evaluation failures return the typed default value and emit a warning span |

### 6.2 Provider Adapters (FR-200s)

| ID | Requirement |
|---|---|
| FR-200 | flagd is the default provider: runs locally as a sidecar or embedded process, file-based flag definitions, supports HTTP polling for live updates |
| FR-201 | Adapter implementations must be provided for: LaunchDarkly, Unleash (OSS), GrowthBook, Statsig, Flagsmith, Flipt |
| FR-202 | Provider selection and configuration managed via the autonomous-dev config file; adapter authors publish via the plugin registry (PRD-003) |
| FR-203 | All adapters implement the OpenFeature Provider interface; no provider-specific API calls in business logic |
| FR-204 | Provider health checked on startup; unhealthy provider falls back to flagd local file with logged warning |

### 6.3 Flag Metadata Schema (FR-300s)

| ID | Requirement |
|---|---|
| FR-300 | Every flag must carry metadata: `owner` (team or individual), `expiration_date` (ISO-8601), `kill_switch_capable` (boolean), `rollout_strategy` (enum: always, percent, rule_based, targeted), `description` (free text), `created_at`, `last_modified_by` |
| FR-301 | Flags missing required metadata fields are rejected at creation time with a descriptive validation error |
| FR-302 | Expiration enforcement is surfaced via the PRD-025 scorecard integration; flags past expiration trigger a blocking scorecard failure |
| FR-303 | Rollout strategies: `always` (100% on), `percent` (0–100 numeric), `rule_based` (CEL expression evaluated against context), `targeted` (explicit list of tenant_id or user_id values) |

### 6.4 Flag Lifecycle (FR-400s)

| ID | Requirement |
|---|---|
| FR-400 | Flags are proposed at change-plan time (alongside the code change); created in `draft` state with default value `false` / off |
| FR-401 | Lifecycle states: `draft` → `active` → `rollout` → `stable` → `sunset` → `removed`; state transitions are audited |
| FR-402 | Default sunset window is 90 days from transition to `stable`; configurable per flag in metadata |
| FR-403 | Post-sunset, an agent-factory job (PRD-003) opens a PR removing the flag call sites and dead code branches; maintainer reviews and merges |
| FR-404 | Flags in `rollout` state expose rollout percentage and current evaluation distribution metrics |

### 6.5 Internal Dogfooding (FR-500s)

| ID | Requirement |
|---|---|
| FR-500 | Agent-factory promotions from staging to production (PRD-003 Phase 3) must be gated by a boolean flag; promotion blocked when flag is off |
| FR-501 | LLM provider failover activation (PRD-018) must be gated by a flag allowing per-tenant or per-environment override of the failover target |
| FR-502 | Production-tier enablement (PRD-017) for a tenant must be gated by a flag; SRE toggles flag after checklist completion |
| FR-503 | Trust-ladder advances (PRD-007) for an agent variant must be gated by a flag; reversion of trust is the kill-switch |
| FR-504 | Prompt version changes (PRD-018 prompt versioning) must be gated by a string flag returning the active prompt version identifier |

### 6.6 Kill Switches (FR-600s)

| ID | Requirement |
|---|---|
| FR-600 | Any flag with `kill_switch_capable: true` in metadata can be used as an instant disable; setting to off must take effect within the propagation SLA |
| FR-601 | Kill signals must propagate to in-flight tasks via the PRD-007 task-interrupt mechanism; tasks must check kill-switch state at defined yield points |
| FR-602 | Emergency CLI command: `autonomous-dev flag kill <flag-name>` sets the flag to off with actor recorded as the authenticated CLI user |
| FR-603 | A global kill switch `autonomous-dev.agents.all_enabled` disables all autonomous task execution when set to false |

### 6.7 Per-Tenant Scoping (FR-700s)

| ID | Requirement |
|---|---|
| FR-700 | Flag evaluation context includes `tenant_id`; flagd rule syntax and other provider rules can target specific tenant identifiers |
| FR-701 | Tenant admins can list flags visible to their tenant and see current evaluated state but cannot modify flag definitions |
| FR-702 | Per-tenant flags are permitted per PRD-020 isolation model; tenant-scoped flags must not be evaluable by other tenants |
| FR-703 | Tenant flag inheritance: org-level defaults can be overridden by tenant-level targeting rules |

### 6.8 Audit Trail (FR-800s)

| ID | Requirement |
|---|---|
| FR-800 | Every flag mutation is logged with a structured record: `{actor, flag_key, old_value, new_value, timestamp, change_reason}` |
| FR-801 | Audit trail is exportable to SIEM integrations defined in PRD-022; export format is OCSF-compatible JSON |
| FR-802 | When compliance mode is active (PRD-019), audit records are hash-chained to produce a tamper-evident log |
| FR-803 | Audit records are retained for the minimum retention period defined per PRD-026 data governance policy |

### 6.9 Observability (FR-900s)

| ID | Requirement |
|---|---|
| FR-900 | Every flag evaluation emits an OpenTelemetry span attribute `feature_flag.key` and `feature_flag.provider_name` per the OTel semantic conventions draft (PRD-021) |
| FR-901 | Rollout percentage progression is tracked as a metric `autonomous_dev.flag.rollout_percent{flag_key}` |
| FR-902 | Error-rate-vs-flag-state dashboards are pre-built in the PRD-021 observability stack; Release Engineers receive an alert when error rate correlation exceeds threshold during rollout |
| FR-903 | Flag evaluation latency is tracked; p95 must remain under 5ms for the flagd local provider |

### 6.10 CLI (FR-1000s)

| ID | Requirement |
|---|---|
| FR-1000 | `autonomous-dev flag list` — lists all flags with state, rollout percentage, and expiration |
| FR-1001 | `autonomous-dev flag create <key> --strategy <strategy> --owner <owner> --expires <date>` — creates a new flag in draft state |
| FR-1002 | `autonomous-dev flag toggle <key> [on|off]` — enables or disables a flag; requires actor authentication |
| FR-1003 | `autonomous-dev flag expire <key>` — marks a flag for sunset and triggers the agent-factory removal PR |
| FR-1004 | `autonomous-dev flag history <key>` — displays full audit trail for a specific flag |
| FR-1005 | `autonomous-dev flag kill <key>` — emergency disable with immediate propagation; logs actor and timestamp |

---

## 7. Non-Functional Requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-01 | Flag evaluation latency | p95 < 5ms using flagd local provider |
| NFR-02 | Provider swap | Zero-downtime provider swap via config reload |
| NFR-03 | Audit completeness | 100% of flag mutations captured in audit trail |
| NFR-04 | Telemetry span coverage | ≥ 95% of flag evaluations emit OTel span attribute |
| NFR-05 | Kill-switch propagation | < 30 seconds from CLI toggle to all in-flight task yield points |
| NFR-06 | Stale-flag detection | Stale flags surfaced in scorecard within 24 hours of expiration |
| NFR-07 | Expiration enforcement | 100% of expired flags generate blocking scorecard failures |
| NFR-08 | Vendor neutrality | Zero provider-specific API calls in business logic; all evaluation through OpenFeature SDK |

---

## 8. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  autonomous-dev Daemon                                           │
│                                                                  │
│  ┌──────────────────┐    ┌─────────────────────────────────┐    │
│  │  Agent / Plugin  │───▶│  OpenFeature SDK                │    │
│  │  Business Logic  │    │  getBooleanValue(key, ctx)       │    │
│  └──────────────────┘    └──────────────┬──────────────────┘    │
│                                         │                        │
│                          ┌──────────────▼──────────────────┐    │
│                          │  Provider Adapter Layer          │    │
│                          │  (pluggable, zero-downtime swap) │    │
│                          └──┬───────────┬──────────────┬───┘    │
│                             │           │              │         │
│                   ┌─────────▼──┐  ┌─────▼──────┐ ┌───▼──────┐  │
│                   │  flagd     │  │ LaunchDark  │ │ Unleash  │  │
│                   │  (default) │  │ Statsig     │ │ Flipt    │  │
│                   │  local/HTTP│  │ Flagsmith   │ │ GrowthBk │  │
│                   └────────────┘  └─────────────┘ └──────────┘  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Cross-Cutting Concerns                                   │   │
│  │  Audit Trail ─ OTel Spans ─ Scorecard Expiry ─ Kill-Sw   │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘

Internal Dogfooding Gates:
  PRD-003 agent-factory promotions ──► boolean flag
  PRD-007 trust-ladder advances    ──► boolean flag (kill-switch)
  PRD-017 prod-tier enables        ──► boolean flag
  PRD-018 LLM failover             ──► boolean flag
  PRD-018 prompt versions          ──► string flag
```

Evaluation context flows from the daemon's request scope into each `getBooleanValue` / `getStringValue` call. The provider adapter translates the OpenFeature context into provider-native targeting rules. All evaluation results flow back through the SDK hook chain, where the audit hook and OTel hook fire on every evaluation.

---

## 9. Testing Strategy

| Test Category | Description |
|---|---|
| Provider contract tests | Each adapter (flagd, LaunchDarkly, Unleash, GrowthBook, Statsig, Flagsmith, Flipt) runs the OpenFeature conformance test suite |
| Kill-switch propagation | Integration test verifies in-flight tasks receive interrupt within 30s SLA after CLI kill command |
| Scorecard expiration | Unit test verifies expired-flag metadata triggers a blocking scorecard failure within 24h detection window |
| Audit-trail integrity | Hash-chain verification test in compliance mode; replay test confirms no mutations are missing |
| Per-tenant targeting | Test matrix: flag enabled for tenant A, disabled for tenant B; confirm no cross-tenant evaluation leakage |
| Provider-swap test | Swap from flagd to mock provider at runtime; verify zero evaluation failures and no daemon restart |
| Rollout strategy correctness | Statistical test verifies percent-rollout evaluates to expected distribution within ±2% at N=10000 evaluations |
| Emergency-kill CLI test | E2E test: CLI kill command → propagation → task interrupt → audit log entry verified |
| Dead-flag scan | Agent-factory test: sunset flag triggers PR with correct code removal; CI validates no remaining call sites |

---

## 10. Migration Plan

### Phase 1 — Weeks 1–2: Foundation

- Embed OpenFeature Server SDK into daemon startup sequence
- Integrate flagd as default provider with file-based flag definitions
- Implement flag CRUD API and audit logging (FR-800s)
- CLI commands: `list`, `create`, `toggle`, `history`, `kill` (FR-1000s)
- Flag metadata schema validation (FR-300s)

### Phase 2 — Weeks 3–4: Dogfooding and Observability

- Gate PRD-003 agent-factory promotions behind boolean flags (FR-500)
- Gate PRD-017 prod-tier enables behind boolean flags (FR-502)
- Gate PRD-018 LLM failover and prompt versions behind flags (FR-501, FR-504)
- Gate PRD-007 trust-ladder advances behind flags (FR-503)
- OTel span emission on every evaluation (FR-900s)
- Scorecard integration for expiration enforcement (FR-301, FR-302)

### Phase 3 — Weeks 5–6: Provider Matrix and Tenant Scoping

- Implement LaunchDarkly, Unleash, GrowthBook adapters (FR-201)
- Implement Statsig, Flagsmith, Flipt adapters (FR-201)
- Per-tenant scoping and targeting rules (FR-700s)
- Kill-switch dashboard in PRD-021 observability stack (FR-902)
- Compliance-mode hash-chained audit trail (FR-802)
- Provider-swap zero-downtime test coverage

---

## 11. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | Flag complexity explosion | High | Medium | Enforce lifecycle + scorecard; auto-removal agent |
| R-2 | Stale flags accumulate in code | Medium | Medium | Agent-factory dead-flag scan on every CI run |
| R-3 | Emergency-kill race condition | Low | High | Idempotent kill operation; audit log deduplication |
| R-4 | Provider outage | Low | High | Local flagd fallback always available; health-check failover |
| R-5 | Flag drift vs. code reality | Medium | Medium | Dead-flag static analysis in CI |
| R-6 | Vendor-specific feature creep | Medium | Low | OpenFeature interface-only policy; adapter review gate |
| R-7 | Per-tenant flag scope leak | Low | Critical | OPA policy enforcement on evaluation context |
| R-8 | Audit log volume | High | Low | Log rotation per PRD-026 retention policy |
| R-9 | Evaluator performance under load | Low | Medium | Local flagd cache; p95 budget enforced in CI |
| R-10 | OpenFeature spec churn | Medium | Medium | Pin OpenFeature SDK version; scheduled upgrade reviews |

---

## 12. Success Metrics

| Metric | Target |
|---|---|
| New agent/model/pipeline changes shipped behind flag | ≥ 90% |
| Flag expiration compliance | ≥ 95% of flags sunset within window |
| Flag-related rollback MTTR | < 5 minutes |
| Stale flags older than 6 months post-sunset | Zero |
| Kill-switch failures in incident rehearsal | Zero |
| p95 flag evaluation latency (flagd local) | < 5ms |

---

## 13. Open Questions

| ID | Question | Owner | Due |
|---|---|---|---|
| OQ-1 | Default provider: flagd or Flipt? Flipt has a richer UI but flagd is the CNCF-blessed reference implementation | Platform Maintainer | Phase 1 kickoff |
| OQ-2 | Scorecard host: Backstage plugin vs. built-in PRD-025 scorecard renderer? | Platform Maintainer + SRE | Phase 1 kickoff |
| OQ-3 | Flag provider swap policy: allowed across minor versions or only major? | Release Engineering | Phase 2 |
| OQ-4 | Per-tenant flag inheritance: do org-level defaults cascade to tenants, or is each tenant independent? | PRD-020 owner | Phase 2 |
| OQ-5 | OpenFeature Web SDK: do any browser-based control plane surfaces (PRD-009) require Web SDK integration? | PRD-009 owner | Phase 3 |

---

## 14. References

### Related PRDs

| PRD | Title | Relationship |
|---|---|---|
| PRD-003 | Agent Factory | Agent promotions gated by flags (FR-500) |
| PRD-007 | Escalation and Trust (Kill Switch) | Trust-ladder advances and kill-switch propagation (FR-503, FR-601) |
| PRD-013 | New-Project Bootstrap | Recommends feature flags; dogfoods this PRD |
| PRD-014 | Progressive Delivery | Progressive rollout strategy alignment |
| PRD-017 | Production Tier | Prod-tier enables gated by flags (FR-502) |
| PRD-018 | LLM Provider Abstraction | Failover and prompt versioning gated by flags (FR-501, FR-504) |
| PRD-019 | Compliance | Hash-chained audit trail requirement (FR-802) |
| PRD-020 | Multi-Tenancy and RBAC | Per-tenant flag scoping (FR-700s) |
| PRD-021 | OpenTelemetry Observability | Flag evaluation OTel spans (FR-900s) |
| PRD-022 | Security and Audit | Audit trail export to SIEM (FR-801) |
| PRD-025 | Scorecards | Flag expiration enforcement (FR-301, FR-302) |
| PRD-026 | Data Governance and PII Residency | Audit log retention policy (FR-803) |

### External References

| Resource | URL |
|---|---|
| OpenFeature Specification | https://openfeature.dev |
| flagd (CNCF Sandbox) | https://flagd.dev |
| Unleash (OSS) | https://github.com/Unleash/unleash |
| GrowthBook | https://www.growthbook.io |
| Flagsmith | https://www.flagsmith.com |
| Flipt | https://www.flipt.io |
| Statsig | https://statsig.com |
| LaunchDarkly | https://launchdarkly.com |

---

**END PRD-027**

# PRD-018: LLM Provider Abstraction & Agent-SDK Migration

Metadata: PRD-018 | v0.1.0 | 2026-04-18 | Patrick Watson | Draft | autonomous-dev

## 1. Problem
PRD-001 NG-4 hard-codes Claude as the only LLM provider. Anthropic outage = full system stop; single-vendor lock-in; no model failover. Separately, the system spawns CLI sessions — Claude Agent SDK offers a more robust integration path with session hooks, subagents, and streaming. Both are strategic corners we should back out of now while the surface area is small.

## 2. Goals (G-1..G-10)
G-1 `LLMProvider` interface isolating any non-Claude-specific model call. G-2 Primary: Claude (via Agent SDK); fallback adapter list for OpenAI (gpt-5-codex), Gemini (2.5+), Bedrock, Vertex, OSS via vLLM. G-3 Failover chain config: primary → secondary → tertiary with exponential backoff. G-4 Agent SDK migration as successor to CLI spawn (gradual, per-phase). G-5 Prompt abstraction layer so per-provider differences (system vs user, tool schema) are transparent. G-6 OpenLLMetry OTel GenAI semantic conventions emitted on every call. G-7 Cost-per-call per-provider tracking (feeds PRD-023). G-8 Per-phase model routing (e.g., use Haiku for cheap contextualization, Opus for complex reasoning). G-9 Prompt versioning + eval (PRD-025 ADRs reference evals). G-10 Claude remains default; non-Claude providers only active if explicitly enabled.

## 3. Non-Goals (NG-1..NG-6)
Not replacing Claude Code plugin architecture; not a model-training platform; not hosting models; not a prompt-management SaaS; not an A/B test orchestrator (Phase 3 only); not on-the-fly model switching mid-session.

## 4. Personas
Platform Operator, Cost Owner, Reliability Reviewer, Plugin Maintainer, Agent Factory (PRD-003).

## 5. User Stories (US-01..US-18)
Operator configures Claude primary + Gemini secondary for failover; Anthropic outage triggers automatic switch with audit event; per-phase routing sends discovery to Haiku and reasoning to Opus; cost dashboard compares providers for identical phases; prompt A/B-tested with eval harness (PRD-025); Agent SDK replaces CLI spawn for PRD-author phase first; streaming tool-use works; provider adapter version pinned; prompt version pinned in session metadata; OTel GenAI conventions visible in traces; OSS model (Llama 3.1 via vLLM) runs for cost-sensitive queries; Bedrock Claude works for AWS-native customers; Vertex Claude for GCP-native; regulated data never leaves region (adapter honors region); fallback chain configurable per request class; evals run across providers before promoting.

## 6. FR
### 6.1 Provider Interface (FR-100s)
FR-100 `LLMProvider` contract: complete, stream, tool_use, count_tokens, estimate_cost, health_check. FR-101 Adapters: anthropic, anthropic-bedrock, anthropic-vertex, openai, google-gemini, vllm-openai-compatible, ollama. FR-102 Version pinned per adapter (track model_id + API version).

### 6.2 Failover Chain (FR-200s)
FR-200 Config: `llm.chain = ["anthropic:opus-4-7", "anthropic-bedrock:opus-4-5", "gemini:2.5-pro"]`. FR-201 Exponential backoff (2s, 4s, 8s, 16s) per step. FR-202 Fall through on non-transient errors (auth, input-too-large) — do NOT retry. FR-203 Audit event per failover.

### 6.3 Agent SDK Migration (FR-300s)
FR-300 `SessionRunner` interface; CLI-spawn adapter (legacy) + Agent-SDK adapter (preferred). FR-301 Phased rollout per PRD phase: PRD-author first, then TDD-author, then executors. FR-302 Agent SDK path supports subagents, hooks, streaming. FR-303 Migration ADR tracks per-phase completion.

### 6.4 Prompt Abstraction (FR-400s)
FR-400 `PromptAssembler` translates common message structure to per-provider format. FR-401 Tool schemas normalized (JSON Schema) and converted per-adapter. FR-402 System-prompt placement handled per provider.

### 6.5 Per-Phase Routing (FR-500s)
FR-500 Config: `llm.phase_routing = { "contextualize": "haiku", "review": "sonnet", "reason": "opus" }`. FR-501 Agents request model by role name; router resolves. FR-502 Defaults ship as sane starting point.

### 6.6 Observability (FR-600s)
FR-600 OTel GenAI semantic conventions emitted (model, temperature, token-counts, latency, cost-estimate). FR-601 Per-call trace span with provider adapter attribute. FR-602 Log prompt hash (not content) for privacy.

### 6.7 Cost & Budget (FR-700s)
FR-700 Per-provider per-model cost-per-token table. FR-701 Estimate_cost hooked to PRD-023 cost attribution. FR-702 Budget breach triggers fallback chain or halt.

### 6.8 Prompt Versioning & Evals (FR-800s)
FR-800 Prompts stored under `plugins/autonomous-dev/prompts/` with semver. FR-801 `autonomous-dev prompt eval <id>` runs against harness. FR-802 Promote-on-eval-pass policy (Phase 3).

### 6.9 Regional & Compliance (FR-900s)
FR-900 Adapter config honors region (us-east-1, eu-west-1, asia-northeast-1, etc.). FR-901 Data-residency enforced per PRD-026. FR-902 Bedrock / Vertex default for regulated workloads.

### 6.10 CLI (FR-1000s)
FR-1000 `autonomous-dev llm list-providers`, `... llm test <adapter>`, `... llm set-primary <adapter>`, `... llm config chain`.

## 7. NFR (NFR-01..NFR-10)
Failover latency <30s end-to-end; provider health-check p95 <2s; cost estimation ±10% accuracy; adapter parity tests across providers; zero PII-in-prompts leaks (hash-only logging); OTel GenAI spans ≥95% of calls; prompt version pinned in every trace; backward-compatible across provider adapter minor versions; failover chain documented in docs site; provider adapter timeouts configurable.

## 8. Architecture
ASCII: Agent → PromptAssembler → LLMProvider (chain) → [Anthropic | OpenAI | Gemini | Bedrock | Vertex | vLLM | Ollama] → OTel GenAI trace → Cost ledger → Response. Session Runner: CLI-spawn (legacy) / Agent SDK (preferred).

## 9. Testing
Parity tests per adapter; failover chain test with fault-injection; prompt-version regression harness; OTel span-shape assertion; cost-estimation accuracy test; regional-isolation test (request to eu adapter must not hit us endpoint).

## 10. Migration
Phase 1 (wks 1–3): LLMProvider interface + Anthropic Direct + OpenAI adapter + failover + OTel GenAI + cost tracking. Phase 2 (wks 4–6): Gemini + Bedrock + Vertex + per-phase routing + prompt abstraction. Phase 3 (wks 7–10): vLLM/Ollama + Agent SDK runner for PRD-author phase + prompt eval harness + regional compliance.

## 11. Risks (R-1..R-12)
Non-Claude provider parity gaps (eval-gate); tool-schema differences (normalization layer); latency spikes on failover (circuit breaker); prompt leakage via provider telemetry (regional/compliance adapter); cost spike from accidental Opus-on-every-call (phase-routing defaults); Agent SDK breaking-change cadence (pin version); provider outage false positives (health-check cooldown); regional mis-route (config validation); eval drift (snapshot baselines); OSS model hallucination risk (disable by default for reviewer roles); vendor-specific caching lost on provider switch; user-facing cost differences (per-provider dashboard).

## 12. Success Metrics
MTTR on provider outage <5min (auto-failover); cost per request ↓15% via phase-routing; prompt eval pass rate ≥95% on release; zero PII-leak via adapter logs; Agent SDK adoption on ≥3 phases by Phase 3.

## 13. Open Questions (OQ-1..OQ-6)
Anthropic via direct API vs Bedrock vs Vertex as primary default? Prompt storage format (Markdown with frontmatter vs JSON)? Eval harness vendor (LangSmith / Braintrust / Langfuse / homegrown)? Per-phase routing as strict rule or suggestion? Agent SDK migration order — authors first or executors? OSS model default enabled or always opt-in?

## 14. References
PRDs: PRD-001 (NG-4 reversed here), PRD-003 (agent factory), PRD-007 (escalation), PRD-021 (OTel), PRD-023 (cost), PRD-026 (residency).
URLs: https://platform.claude.com, https://docs.anthropic.com/agents/sdk, https://aws.amazon.com/bedrock/, https://cloud.google.com/vertex-ai, https://platform.openai.com, https://ai.google.dev/gemini-api, https://docs.vllm.ai, https://ollama.com, https://opentelemetry.io/docs/specs/semconv/gen-ai/, https://www.traceloop.com/openllmetry.

**END PRD-018**

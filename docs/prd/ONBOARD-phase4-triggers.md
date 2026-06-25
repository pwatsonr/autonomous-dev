# PRD: ONBOARD Phase 4 — Discord/Slack Scoped Task Triggers

## 1. Title and Metadata

| Field | Value |
|-------|-------|
| Document Title | A **scoped** chat command `/{autodev} {project\|repo} {scope-id} {task}` on the EXISTING `intake/` framework: resolve scope → authorize for that scope → enqueue a pipeline request → report back → watch for stability, then stop |
| Initiative | ONBOARD (epic #583) |
| Tracking Issue | #596 (to be filed) |
| Phase | 4 of 5 — depends on P0 (ownership/scope, 0.3.32), P1 (ingestion, 0.3.33) and the **pre-existing `intake/` command framework**. Order: 0 → 1 → (2 ∥ 3) → **4** → 5 |
| Author | Operator-directed Claude Code session (pwatsonr@gmail.com) |
| Date | 2026-06-24 |
| Version | **0.2 (Draft — revised after doc-review; B1–B3 + M1–M7 folded in)** |
| Build mechanism | **Operator-directed** on clone `~/codebase/autonomous-dev-build` (R1); built against the existing **injected/mockable** transport seams so NO live bot credentials are needed to build + test; 3-round adversarial self-review before deploy |
| Predecessors / **reuse** | The pre-existing **`plugins/autonomous-dev/intake/`** framework — `intake_router.ts` (resolve-user → authorize → rate-limit → execute, string-keyed handler map), `handlers/submit_handler.ts` (sanitize → NLP-parse → ambiguity → dedupe → **enqueue**, returns `{requestId,…}`), `core/sanitizer.ts` (`InjectionRule`s), `core/request_parser.ts` (injected `ClaudeApiClient`), `authz/authz_engine.ts` (`Role` admin/operator/contributor/viewer + `authorize()`), `rate_limit/rate_limiter.ts`, `adapters/{discord,slack}/*` (HTTP servers, ed25519 / HMAC-SHA256+replay verification, 3 s deferred-ACK + `response_url`), `types/{request_source,request-type}.ts`. Plus the OUTBOUND `src/notifications/adapters/{discord,slack}-adapter.ts` (`DeliveryAdapter`) and P0 `src/ownership`. |

## 2. Problem Statement

Onboarded orgs submit autonomous work via the CLI or the portal. Teams live in Discord/Slack. The daemon **already** accepts commands from Discord/Slack through the `intake/` framework (signature-verified, authz'd, rate-limited, sanitized, NLP-parsed, enqueued) — but those commands carry **no scope**: there is no first-class way to say "run this against *this project / this repo*," nor anything that watches the change afterward. Phase 4 adds a **scoped** command — `/{autodev} {project|repo} {scope-id} {task…}` — that binds the requested work to a known P0 scope, authorizes the chat user **for that scope**, enqueues the request through the existing pipeline, reports progress back to the originating channel, and then **watches the change for a stabilization window** before the system disengages.

## 3. Goals and Non-Goals

### Goals
1. A **scoped trigger command** on BOTH Discord + Slack, implemented as a new handler on the existing `intake_router` (one core; the platform adapters already exist) — operator's ratified "both platforms, one core" choice.
2. Grammar `/{autodev} project|repo <scope-id> <task…>` → reuse intake sanitize + parse → **resolve `scope-id` against P0 ownership** → **authorize the chat user FOR THAT SCOPE** (extends `AuthzEngine`, default-deny) → enqueue a pipeline request tagged with `{scope, origin}` via the existing submit path.
3. **Status reporting** back to the originating channel (accepted + throttled phase transitions + terminal done/failed + PR link) via the existing outbound `DeliveryAdapter`; terminal status is ALSO recorded to the request audit trail so it survives a chat outage.
4. **Stabilization watch** (the net-new subsystem): after `done`, watch the change for a window; disengage when "stable"; alert on regression inside the window; **hard-cap** the window; persist across daemon restarts.
5. **Reuse, not rebuild**: signature verification, the 3 s deferred-ACK, rate limiting, injection sanitization, and the Discord/Slack HTTP ingress are the **existing** intake components — Phase 4 adds scope + authz-by-scope + the watch + the scoped reporter.
6. **Buildable without live credentials** (existing injected seams: `ClaudeApiClient`, the adapter transports) — tokens are a deploy-time prereq stored `0600`/env per the existing pattern.

### Non-Goals
- **Not** re-implementing intake's adapters, signature verification, 3 s ACK, authz engine, rate limiter, or sanitizer — all exist and are reused.
- **Not** replacing CLI/portal intake — the scoped command is an additional command on the same router.
- **Not** `mayAutoImproveScope` gating — that gate governs **proactive/enrollment** behavior; a chat command is **operator-requested** work, which the gate's own contract (`src/ownership/commands.ts`) and P2 FR-D3 explicitly **exclude**. Requested work is governed by `AuthzEngine` + scope resolution (FR-C), not the enrollment gate. *(Was a v0.1 error; corrected per review B2.)*
- **No** multi-turn chat conversations / modal flows in v1 for the scoped command (clarifying questions still surface via the existing ambiguity → blocking-question path, not a chat thread).
- **Not** bot hosting/infra — the operator provisions the Discord + Slack apps and supplies secrets; the daemon consumes them via the existing loaders.
- **Not** portal UI (daemon-side phase).

## 4. Functional Requirements

### FR-A — Scoped command on the existing router
Register a new handler (`TriggerHandler`, command name e.g. `trigger`) on `intake_router` for the grammar `/{autodev} <scope-type> <scope-id> <task…>`, `scope-type ∈ {project, repo}`. The adapters already produce an `IncomingCommand {commandName, args[], flags, rawText, source}`; the handler consumes `args` as `[scopeType, scopeId, …task]`. Dispatch flows through the existing resolve-user → authorize → rate-limit → execute pipeline.

### FR-B — Parse + sanitize (reused)
The task text is sanitized through the existing `core/sanitizer.ts` `InjectionRule`s and bounded to the existing `MIN/MAX_DESCRIPTION_LENGTH` (10–10 000); an `INJECTION_BLOCKED` or out-of-bounds task is rejected (audited) and never enqueued. Structured parse reuses `request_parser.ts` (injected `ClaudeApiClient`; mock in tests). Typed parse errors: bad scope-type, missing/empty scope-id, empty task. *(Review M3, MINOR-1.)*

### FR-C — Scope resolution + scope-aware authorization
Resolve `scope-id` against P0 ownership (`src/ownership`): unknown project/repo → reject (clear message, no enqueue). **Authorize the user FOR THE RESOLVED SCOPE** by extending `AuthzEngine` with a scope-aware predicate `(userId, platform, scope) → allow|deny`, layered on the existing `Role` model; **default-deny**. An unauthorized user → reject + audit. *(Review B2, M5; OQ-3.)*

### FR-D — Enqueue (reused submit path) + idempotency
On pass, enqueue via the existing `submit_handler` pipeline, tagging the request with `scope` (project/repo id) and origin (`RequestSource` + `AdapterMetadata`: platform, channel, user, message id). The pipeline then runs unchanged (R1: a normal request → honors the allowlist; never the live checkout/crawled repo). **Idempotency (FR-D2):** dedupe by the platform interaction/message id in a **file-backed store** (`~/.autonomous-dev/state/triggers/seen.json`), loaded **before** the accept loop so a retried webhook is idempotent across restarts; TTL = `max(7 d, MAX_WATCH_DAYS)`. *(Review M1, AC8, OQ-5.)*

### FR-E — Status reporting (outbound, reused adapter) + audit fallback
Post to the originating channel via the existing `DeliveryAdapter`: (E1) **accepted** with the REQ id + budgeted cost + ETA; (E2) **phase transitions** (throttled — at least prd/code/review/done); (E3) **terminal** done(+PR link)/failed(+reason). Reporting is best-effort and never blocks the pipeline; **(E-fallback) the terminal status is ALWAYS written to the request audit trail** and surfaced by the portal/CLI independent of chat delivery, so a chat outage never loses the outcome. Cost is surfaced on accept; a rate/cost rejection cites the cap. *(Review M6, MINOR-5.)*

### FR-F — Stabilization watch (NEW)
After a triggered request reaches `done`, register a watch keyed to the change (**unit-of-watch = the PR's HEAD branch**, so CI = the PR's checks; fall back to `main` once merged). A **persisted, restart-safe** state machine `watching → stable | regressed | expired`:
- **stable** (definition = OQ-1) → post a "stabilized" message + disengage.
- **regressed** inside the window → post an alert; an optional follow-up is itself a **single** guarded enqueue (same idempotency store; never re-arms the watch). *(MINOR-4.)*
- **(FR-F3) hard cap**: a watch terminates `expired` after `MAX_WATCH_DAYS = 14` (configurable) with "window expired — manual review"; no auto-follow-up. *(Review M2.)*
Multiple concurrent watches supported; all transitions audited.

### FR-G — Credentials + configuration (reused pattern)
Reuse the **existing** intake secret-loading pattern (env-based signing secrets per `slack_verifier.ts`; Discord public key likewise), co-located under a `triggers`/`intake` config block that selects enabled platforms. Any file-backed secret is `0600` under `~/.autonomous-dev/secrets/`, referenced not inlined, never logged/echoed/committed (mirrors the Neo4j cred). A deploy-prereq doc enumerates the exact app setup + least-privilege scopes per platform. *(Review M7.)*

### FR-H — Rate limiting + concurrency (reused + extended)
Reuse the existing `rate_limit/rate_limiter.ts` for per-user/per-channel limits; **add a per-scope concurrency cap** (a single scope can't have N triggered pipelines running at once). Over-limit → rejected with a clear message (a trigger ≈ $3 / 20 min and integrates a PR), not unbounded-queued.

### FR-I — Audit events
Extend `AuditEventType` **additively** (per P2 TC-2a) with: `trigger_received`, `trigger_accepted`, `trigger_enqueued`, `trigger_rejected_{unsigned,unauthz,unknown_scope,injection,ratelimit,parse}`, `watch_started`, `watch_stable`, `watch_regressed`, `watch_expired`. *(Review M4.)*

## 5. Acceptance Criteria (→ #596)
- **AC1** — A signature-verified Discord scoped command from a user authorized FOR THAT SCOPE enqueues a request tagged with the scope; a forged signature or a user not authorized for the scope is rejected (no enqueue) + audited. *(Reuses existing verification.)*
- **AC2** — AC1 holds identically for Slack (same handler, existing adapter).
- **AC3** — The originating channel receives `accepted`(REQ id + cost/ETA) and terminal `done`(+PR)/`failed`(+reason); the terminal status is ALSO in the request audit trail even if chat delivery fails.
- **AC4** — An unknown `scope-id` → rejected, nothing enqueued. (No `mayAutoImproveScope` involvement — requested work.)
- **AC5** — An injection-flagged or out-of-bounds task is rejected (audited), never enqueued.
- **AC6** — The stabilization watch runs after `done`, **persists across a daemon restart**, disengages when stable per OQ-1, alerts on regression, and terminates `expired` at the hard cap.
- **AC7** — The full feature **builds + tests green with NO live bot credentials** (mock `ClaudeApiClient` + a `FakeTriggerTransport` seam).
- **AC8** — A retried/duplicate inbound (same interaction/message id) does not double-enqueue, **including across a restart** (dedupe store loaded first).
- **AC9** — **R1**: the trigger only enqueues a normal pipeline request; no path builds the live checkout or a crawled repo directly.

## 6. Non-Functional Requirements
- **Security**: reuse existing per-platform signature verification (reject unsigned/expired/replayed); scope-aware default-deny authz; injection sanitize (FR-B); least-privilege bot scopes; zero secret leakage.
- **Latency**: reuse the existing 3 s deferred-ACK / `response_url` pattern — ack fast, process + report async.
- **Reliability**: at-least-once with restart-safe idempotency (AC8); watches + pending triggers file-backed and resumed on restart (daemon idiom).
- **Observability**: audit every trigger decision + every watch transition (FR-I).
- **Cost safety**: rate limit + per-scope concurrency cap (FR-H); cost surfaced on accept.

## 7. Technical Constraints
- **TC-1 Reuse the `intake/` framework** — extend `intake_router` with a scoped handler; reuse sanitizer, parser (injected `ClaudeApiClient`), authz engine, rate limiter, the Discord/Slack adapters (HTTP ingress + signature verify + 3 s ACK), and `submit_handler`'s enqueue. Phase 4's net-new code = the scoped grammar + scope resolution + scope-authz predicate + the stabilization watch + the scoped reporter. *(Review B1, B3.)*
- **TC-2 Audit** — extend `AuditEventType` additively (FR-I).
- **TC-3** Daemon test idiom: ts-jest transpile-only + `test_*()`/`assert()`/`describe()/it()`; `tsc --noEmit` separate type gate; `bin/*.ts` bun-run outside tsconfig.
- **TC-4 R1** — the trigger only enqueues; never builds directly.

## 8. Open Questions (resolve in TDD / operator picks)

- **OQ-1 — the stabilization "stable" definition (OPERATOR DECISION).** Disengage when the change is stable for a window (default **N = 3 days**, per-scope override). Unit-of-watch = the PR's HEAD branch (→ `main` once merged). Options:
  - **(a) CI green for N days** — objective; needs the repo's GitHub Checks status. Strong where CI exists.
  - **(b) No reverts / new failures for N days** — catches real regressions; fuzzier detection.
  - **(c) No follow-up PRs/issues for N days** — cheap; weak signal.
  - **RESOLVED (operator, 2026-06-25): (a) CI-green-for-N-days, N=3** — primary signal = the PR HEAD branch's CI/Checks staying green for 3 consecutive days; reinforced by (b) no-reverts/new-failures; fall back to (c) where the repo has no CI. Per-scope override on N allowed.
- **OQ-2 — inbound ingress.** Reuse the **existing** intake Discord/Slack HTTP adapters as ingress (recommended — already verify signatures + 3 s ACK), vs. routing through the portal, vs. a new listener. **Lean: reuse the existing intake adapters.** Resolve in TDD.
- **OQ-3 — scope-authz predicate.** Build on `authz_engine.ts` with a new `(userId, platform, scope) → allow|deny` predicate; backing data = a per-scope allowlist, or map onto ownership/enrollment? Default-deny regardless. Resolve in TDD.
- **OQ-4 — dedupe key + retention** (platform interaction/message id; TTL per FR-D2).
- **OQ-5 — regression follow-up** (FR-F): auto-open a follow-up request, or alert-only? (Default alert-only in v1.)

## 9. Risks
- **Forged / cross-scope triggers** → unwanted autonomous PRs. *Mitigation:* existing signature verification + scope-aware default-deny authz (FR-C) + audit.
- **Runaway cost** (~$3 / 20 min, integrates a PR). *Mitigation:* existing rate limiter + per-scope concurrency cap (FR-H); cost surfaced on accept.
- **Chat-borne prompt injection** in the task text. *Mitigation:* existing `sanitizer.ts` injection rules (FR-B).
- **Secret leakage.** *Mitigation:* reuse the existing env/secret pattern; `0600`; never logged.
- **Watch never disengages / leaks.** *Mitigation:* persisted state machine + hard cap `MAX_WATCH_DAYS` (FR-F3); restart-safe; audited.
- **R1 violation.** *Mitigation:* triggers enqueue normal requests only; pipeline enforces the allowlist.

## 10. Traceability
| AC | FRs |
|----|-----|
| AC1/AC2 | FR-A, FR-C, FR-D (+ existing signature verify) |
| AC3 | FR-E |
| AC4 | FR-C |
| AC5 | FR-B |
| AC6 | FR-F |
| AC7 | FR-A/B (injected seams) |
| AC8 | FR-D2 |
| AC9 | TC-4 |
- Handoff §Phase 4 (webhooks/triggers); depends on P0 (#584) + P1 (#588/#589) + the existing `intake/` framework (SPEC-008).

## 11. Implementation order (reuse-first; injected transport throughout)
1. **Scoped grammar + handler** — `TriggerHandler` on `intake_router`; parse `[scopeType, scopeId, …task]`; reuse sanitizer + bounds (mock `ClaudeApiClient`).
2. **Scope resolution + scope-authz** — resolve against P0 ownership; extend `AuthzEngine` with the scope predicate (default-deny).
3. **Enqueue + idempotency** — tag the request (scope + origin) through `submit_handler`; file-backed restart-safe dedupe store.
4. **Scoped reporting** — wire the outbound `DeliveryAdapter` for accepted/phase/terminal; terminal → audit fallback.
5. **Stabilization watch** — persisted state machine, CI/regression signals per OQ-1, hard cap, restart-safe.
6. **Audit events + config + deploy-prereq docs** — `AuditEventType` additions; per-platform app-setup guide; secret loading.

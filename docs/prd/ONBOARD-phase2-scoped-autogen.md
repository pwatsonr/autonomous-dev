# PRD: ONBOARD Phase 2 — Scoped Auto-generation of Skills/Commands

## 1. Title and Metadata

| Field | Value |
|-------|-------|
| Document Title | Extend the agent-factory to propose **scoped skills/commands** from ingested memory — human-gated, with a repo→project→global scope heuristic |
| Initiative | ONBOARD (epic #583) |
| Tracking Issue | #590 |
| Phase | 2 of 5 — depends on Phase 0 (daemon 0.3.32) + Phase 1 file layer (daemon 0.3.33). Order: 0 → 1 → (2 ∥ 3) → 4 → 5 |
| Author | Operator-directed Claude Code session (pwatsonr@gmail.com) |
| Date | 2026-06-23 |
| Version | 0.2 (Draft — revised after PRD review, must-fix H1–H5/M1–M4 folded in) |
| Build mechanism | **Operator-directed** on clone `~/codebase/autonomous-dev-build` (R1); 3-round adversarial self-review before deploy |
| Predecessors | P0 ownership/scope (ArtifactScope, registry (scope,name) resolution, `managed:false`); P1 scoped memory + ingestion (`src/memory`, `src/ingest`, `mayAutoImproveScope` gate) |
| **MVP cut** | **Skills only.** The pipeline is artifact-`kind`-ready, but only the `skill` kind is implemented + gated in Phase 2; the `command` kind is the immediate fast-follow (same pipeline, second kind) once the skill path is proven. Reduces the safety surface to one frontmatter schema + one tool allowlist + one meta-review variant. |

---

## 2. Problem Statement

Phase 1 fills each repo/project with **scoped memory** (what the repo is: stack, standards, ownership, build, conventions). Today that memory is inert — nothing turns it into capability. The agent-factory can already analyze→propose→meta-review→park→**promote** *agents* (human-gated, safety-gated), but it cannot generate **skills** or **commands**, and it has no notion of generating an artifact *at a scope* (this repo vs this project vs global). Phase 2 closes that gap: read a repo/project's ingested memory, detect an **opportunity** ("this repo uses HashiCorp Vault" / "every repo in this project shares a lint convention"), **generate a candidate skill or command**, decide its **scope** by a repo→project→global heuristic, run it through the **existing safety gates** (`enforceConstraints` + meta-reviewer), and **park** it for a human to promote. This is the "Hermes-like" auto-capability step: the platform proposes its own scoped tooling from what it learned, and a human stays in the loop on every promotion.

---

## 3. Goals and Non-Goals

### Goals
- **G1** — Generate a candidate **skill** (valid frontmatter + body) from a repo/project's ingested memory. (The artifact model carries a `kind` discriminant; `command` generation is the fast-follow — see the MVP cut.)
- **G2** — Decide the artifact's **scope** by heuristic: a signal seen in one repo → `repo:<id>`; recurring across repos in a project → `project:<id>`; across projects/org-wide → `global` — **propose, never auto-apply**.
- **G3** — Run every generated artifact through the **existing safety gates** before parking: deterministic `enforceConstraints` (artifact-appropriate) **then** the meta-reviewer security checklist.
- **G4** — **Park** generated artifacts as proposals (reusing the agent-factory proposal/park pattern); a human reviews and **promotes** — nothing is auto-applied.
- **G5** — On promote, write the artifact into a **scoped artifact store** the platform owns (`~/.autonomous-dev/artifacts/<scope>/{skills,commands}/<name>.md`) + git-audit it — **never into a crawled repo** (R1).
- **G6** — Operator CLI: `artifact propose --repo <id> | --project <id>`, `artifact list [--status]`, `artifact show <id>`, `artifact accept <id>`, `artifact reject <id>`.

### Non-Goals
- **NG1** — **Improving existing skills/commands** (a full observation→analyze→improve loop for them). Phase 2 GENERATES new artifacts; the self-improvement loop for skills/commands is a later phase. (Agents keep their existing improvement loop, untouched.)
- **NG2** — **Live consumption/injection** of scoped artifacts into a running pipeline (a scoped pipeline actually *using* a generated repo-skill) → **Phase 4** (scoped triggers) / Phase 5. Phase 2 lands the artifact in the scoped store; wiring it into a live run is later.
- **NG3** — **Auto-promote.** Promotion is always human-gated (mirrors agents). No artifact is ever written to the store without an explicit `artifact accept`.
- **NG4** — A **runtime registry** for skills/commands. Claude Code's own loader discovers skills/commands from the filesystem; Phase 2 only needs to *write them to the right place* with valid schema — not model their execution.
- **NG5** — **Auto-trigger on ingest.** Generation is operator-invoked (`artifact propose`) in Phase 2; an auto-on-ingest trigger is deferred (riskier; the parked-for-human model is the safe MVP).
- **NG6** — Writing anything to a crawled/target repo (no PRs adding `.claude/skills/…`). Strictly the platform's own scoped store.
- **NG7** — Portal UI for reviewing/promoting artifacts → **Phase 3** (Phase 2 exposes CLI + data only).
- **NG8** — The `command` artifact **kind** (generating slash-commands) → **fast-follow after Phase 2** (the pipeline is kind-ready; only `skill` is built + gated here, to keep one frontmatter schema / one tool allowlist / one meta-review variant in the safety surface).

---

## 4. Functional Requirements

### FR-A — Opportunity detection (memory → generation signal)
- **FR-A1** — `OpportunityDetector` interface (mirrors the Phase 1 `Extractor`): reads a repo's resolved memory **doc content directly** — `resolveMemory({repoId}).layers[*].docs[*].content` (grep/parse the markdown) — and emits zero+ `Opportunity { id, kind: 'skill', repoId, title, evidence, suggestedName }`. It does **not** go through `signalsFromMemory` (which is owner-only — `deps` is hardcoded empty). Best-effort + independent.
- **FR-A2** — A starter detector set over Phase 1's actual memory topics (`overview`, `dependencies`, `ownership`, `build-deploy`, `test-conventions`): **secrets/vault** (a vault/secrets-manager mention in the `dependencies`/`build-deploy` doc → propose a repo-scoped "vault access" skill), **test-convention** (a strong recurring test setup in `test-conventions` → a "run/scaffold tests" skill), **domain-glossary** (a rich `overview`/domain doc → a "domain context" skill). Detectors are data-driven and additive.
- **FR-A3** — Detection is **read-only** over memory + ownership; it never writes memory, never touches a crawled repo.
- **FR-A4 (degradation contract)** — Detector failures are caught **per-detector**, logged to audit (`details.event = 'detector_failed'`), and excluded from the proposal set; `artifact propose` still exits success and surfaces skipped detectors in a `--verbose` summary.

### FR-B — Scope decision (the heuristic)
- **FR-B1** — `decideScope(opportunity, occurrences)` is a **pure** function: an opportunity seen in exactly one repo → `repo:<id>`; seen in ≥ K repos **all within one project** → `project:<id>`; seen across multiple projects / org-wide → `global`. K is configurable (**default 3** — biases toward repo-scoped proposals; relax later when confidence-weighting exists). **Opportunity identity** for aggregation: two opportunities count as "the same signal" iff `(kind, normalizedSuggestedName)` matches — so vault-in-A + vault-in-B aggregate, but vault-in-A + tests-in-B do not.
- **FR-B2** — Scope is **proposed**, never applied. The artifact proposal records `proposedScope` + the rationale (which repos/occurrences drove it).
- **FR-B3** — repo→project grouping uses the **existing `Ownership.repos[].projectId` membership** (Phase 0), **not** `inferProjects` (which *proposes new* projects — wrong tool here). Reuse `ArtifactScope` (P0); no new scope vocabulary.

### FR-C — Artifact model + generation
- **FR-C1** — A minimal `GeneratedArtifact { kind: 'skill'|'command', name, scope, frontmatter, body }` model + a parser/serializer good enough to **emit** a valid `.md` and **re-read** it (mirrors `src/agent-factory/parser.ts`; no runtime model). The model carries `kind`, but **only `kind: 'skill'` is implemented + gated in Phase 2** (FR-C2/FR-D enumerate skill schema + allowlist + meta-review for skills; `command` is NG8). Skills have no model today — this is the one genuinely-new type.
- **FR-C2** — A `generateArtifact(opportunity, scope, memory)` step constructs a generation prompt from the opportunity + the repo's memory and invokes the LLM to produce the artifact body + frontmatter (name, description, scope, `managed: true`, the skill `description`/trigger or the command surface). Injected runtime (reuse the factory's `ClaudeRuntime`) so it is unit-testable with a fake.
- **FR-C3** — Generated artifacts are always `managed: true` (platform-owned, improvable later) and carry their `scope:` — they slot into the Phase 0 scope vocabulary.

### FR-D — Safety gates
- **FR-D1** — `enforceArtifactConstraints(artifact)` — a **NEW deterministic, no-LLM, single-artifact validator** (it occupies the same *lifecycle position* as the proposer's pre-meta-review hard gate, but it is NOT the agent diff-style `enforceConstraints`, which diffs current↔proposed and has no `current` for a fresh generation). Checks: **(a) no secrets/credentials** in the body (entropy + known token patterns); **(b) tool/permission allowlist** — see FR-D1a; **(c) valid schema** (required skill frontmatter present + well-formed); **(d) scope sanity** (a `repo:`/`project:` id that exists in ownership); **(e) name safety** (`isSafeRepoId`-style charset; no path traversal); **(f) injection-pattern check** on the body (e.g. "ignore previous instructions", tool-call directives, fenced executable templates — see R7/M3). Any violation rejects the proposal **before** meta-review.
- **FR-D1a (tool allowlist — load-bearing security decision)** — a generated skill's tool surface defaults to **read-only: `Read`, `Glob`, `Grep`**. `Bash`/`Edit`/`Write`/`WebFetch` and any other mutating/exfil-capable tool are **rejected** in a generated skill unless an explicit operator override is recorded on the proposal at accept-time. (There is no existing skill allowlist to reuse — the agent allowlist is keyed by agent *role*, which skills lack.)
- **FR-D2** — Meta-review uses a **NEW artifact-specific reviewer agent** (`artifact-meta-reviewer.md`, sibling to `agent-meta-reviewer.md`) with its own checklist for generated skills (tool/permission escalation vs FR-D1a, prompt-injection in the body, scope creep beyond the cited evidence, schema compliance, proportionality to the opportunity). A `blocker` finding forces reject (reuse the existing hard-override *mechanism*). **Rationale:** the existing `agent-meta-reviewer` body is entirely agent-shaped (tools/role/expertise/rubric); a sibling agent keeps the agent path **truly untouched** (R6) rather than editing shared agent logic.
- **FR-D3** — The **`mayAutoImproveScope` gate (FR-G2 / P1)** governs only *proactive/autonomous* action and, per its own contract, **NOT operator-requested work**. Phase 2 generation + `artifact accept` are operator-requested, so the gate is **not** consulted on the propose/accept path. It is the documented seam for a *future* auto-trigger / auto-promote (NG5's eventual undeferral) — that is the only place it binds.

### FR-E — Park + human promote
- **FR-E1** — Generated artifacts are **parked** as `ArtifactProposal` records in a **new JSON-backed store** (status machine `pending_meta_review → meta_approved | meta_rejected → promoted`), modeled on the agent `ProposalStore`'s *status-machine + append pattern* but re-implemented (the agent store is JSONL+SQLite + agent-specific; we avoid the native dep and the shared types — see OQ-1). Never auto-promoted.
- **FR-E2** — `artifact accept <id>` **promotes**: writes the artifact to `~/.autonomous-dev/artifacts/<scope-dir>/skills/<name>.md`, records it (audit; **git-commit only if the scoped store is itself a git repo** — see OQ-3), updates status → `promoted`. This implements the **same lifecycle shape** (write → audit/commit → status) as `promoter.ts` but **does NOT reuse it**: the agent promoter is coupled to `projectRoot` git, `registry.reload()`, agent state transitions (`VALIDATING/UNDER_REVIEW → ACTIVE`), the observation tracker, and `validatePrerequisites` — **none of which apply** to a file in the platform's own scoped store. The human-facing accept summary surfaces: (a) the opportunity + memory evidence that drove generation, (b) the scope rationale, (c) the meta-review verdict + findings, (d) the proposed artifact body (new-file diff), and (e) any tool-allowlist override being granted (FR-D1a).
- **FR-E3** — `artifact reject <id>` marks it terminally rejected (audited). `artifact list`/`show` surface the queue + diffs.

### FR-F — Operator CLI
- **FR-F1** — `autonomous-dev artifact propose --repo <id>` (or `--project <id>`): runs detectors over that scope's memory, decides scope per opportunity, generates + gates + parks proposals; prints a summary.
- **FR-F2** — `artifact list [--status pending|approved|rejected|promoted]`, `artifact show <id>` (renders the artifact + rationale + gate results), `artifact accept <id>`, `artifact reject <id>`.
- **FR-F3** — Wired into `bin/autonomous-dev.sh` dispatch (a bun bin like `ownership-cli`/`ingest-cli`).

---

## 5. Acceptance Criteria (→ #590)
- **AC1** — `artifact propose --repo <id>` over a repo whose memory shows a vault signal **proposes a repo-scoped skill** (parked, `pending`), with rationale citing the evidence.
- **AC2** — An opportunity present across ≥K repos of one project is proposed at **`project:` scope** (not repo); an org-wide one at **`global`** — scope decided by the heuristic, recorded with rationale.
- **AC3** — Every generated artifact passes **`enforceArtifactConstraints` then meta-review** before parking; a constraint/blocker violation rejects it (a secret-bearing or tool-escalating generation never parks).
- **AC4** — Nothing is auto-applied: artifacts are **parked**; `artifact accept` writes the file into the scoped store + commits; `artifact reject` discards. No write ever lands in a crawled repo.
- **AC5** — Promote writes to `~/.autonomous-dev/artifacts/<scope>/…` with valid schema (re-parseable), at the proposed scope, `managed: true`.
- **AC6** — The pipeline carries an artifact `kind` discriminant and **`kind: 'skill'` is fully implemented + gated** (schema, allowlist, meta-review variant, store layout); `command` is structurally accommodated but **out of scope for Phase 2** (NG8, fast-follow).

---

## 6. Non-Functional Requirements
- **NFR-1 (Human-gated):** no artifact is written to the store without an explicit `artifact accept`; tested.
- **NFR-2 (Read-only on repos):** zero writes to any crawled repo; the scoped store is the platform's own dir; tested (NFR mirrors P1 NFR-1).
- **NFR-3 (Safety-gated):** no generated artifact reaches the store without passing both gates; a secret/tool-escalation generation is rejected; tested with adversarial fixtures.
- **NFR-4 (Test isolation):** injected LLM runtime + injected IO; never invoke a real model or touch live operator state in tests (reuse the factory's fake runtime).
- **NFR-5 (Reuse, no reinvention):** proposal/park/promote, meta-review, audit, scope resolver, ingestion memory, `inferProjects`, `mayAutoImproveScope` are reused, not rebuilt.
- **NFR-6 (CI/type gate):** touched-file tests green; `tsc --noEmit` 0; eslint 0; the `test_*()` + local-assert + describe/it idiom.

---

## 7. Technical Constraints
- **TC-1** — Build operator-directed on the clone; never the live checkout (R1). Land via the release+deploy runbook.
- **TC-2** — **Reuse vs new (precise)** — *reused by pattern* (not as-is): the proposal store's status-machine shape (FR-E1), the meta-review **hard-override mechanism** + `MetaReviewOrchestrator` invocation path (FR-D2, with a NEW sibling reviewer agent), the promoter's write→audit→status **shape** (FR-E2, NOT its agent-coupled body). *Reused as-is*: `audit` logger, `ownership/scope` + `Ownership.repos[].projectId`, `memory/resolveMemory`. *New code*: the `GeneratedArtifact` model + parser (FR-C), `enforceArtifactConstraints` (FR-D1 — a new single-artifact validator, not the agent diff `enforceConstraints`), the opportunity/scope layer (FR-A/B), `artifact-meta-reviewer.md`, the JSON `ArtifactProposalStore`.
- **TC-2a (audit events)** — the existing `AuditEventType` is a **closed agent-centric union**. Phase 2 **extends it additively** with `artifact_proposed` / `artifact_promoted` / `artifact_rejected` / `detector_failed` (a small, safe touched-shared-types change — preferred over shoehorning artifact events under `agent_*` with a `details.event` discriminator). This is the one shared-types edit; it does not change agent behavior.
- **TC-3** — Generated artifacts live in the platform's **scoped store**, not the crawled repo (NG6). Consumption into a live scoped run is Phase 4.
- **TC-4** — JSON-backed proposal store (avoid the `better-sqlite3` native dep for the new store; the existing SQLite index is agents-only and untouched).
- **TC-5** — The LLM generation uses the factory's existing runtime/auth; no new secret.

---

## 8. Open Questions (resolve in TDD)
- **OQ-1** — *(decided H2/M1)* Separate **JSON `ArtifactProposalStore`** (decided), mirroring the P1 questions store. Cost acknowledged: the status-machine + append durability is re-implemented; benefit: no native dep, no shared-store changes, agent loop untouched.
- **OQ-2** — *(decided H2)* **New `artifact-meta-reviewer.md`** sibling agent (decided), not a reuse of `agent-meta-reviewer`'s agent-shaped body. Open: the exact checklist wording — finalize in TDD.
- **OQ-3** — Scoped-store dir layout + the Phase-4 consumption seam: `~/.autonomous-dev/artifacts/{global,project/<id>,repo/<id>}/skills/` mirroring the memory tree. **Is the scoped store a git repo (so accept can commit), or audit-only?** Decide in TDD — affects FR-E2's "commit only if a repo."
- **OQ-4** — Opportunity-detector starter set + evidence thresholds (and K) — start vault/test/domain + K=3, refine from real ingested memory.
- **OQ-5** — Generation prompt + the **skill** frontmatter schema (required fields) — finalize in the TDD against Claude Code's actual skill frontmatter spec.
- **OQ-6 (load-bearing)** — The concrete generated-skill **tool allowlist** (FR-D1a). Lean: read-only `Read`/`Glob`/`Grep`; everything else rejected without an explicit accept-time operator override. Confirm the exact set in TDD.

---

## 9. Risks
| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| R1 | A generated artifact embeds a secret or escalates tools | High | `enforceArtifactConstraints` (no-secrets + tool allowlist) **then** meta-review; adversarial NFR-3 tests; human promote |
| R2 | Auto-applying a low-quality artifact | High | Propose-don't-apply; parked; human `accept` only; never auto-promote (NG3) |
| R3 | Writing into a crawled repo (R1/NG6) | High | Scoped store is the platform's own dir; no repo write path exists; tested |
| R4 | Over-scoping into two full skill+command factories (#498) | Medium | One unified artifact pipeline; NG1/NG4 cut the registry + improvement loop; skills-first |
| R5 | Wrong scope (repo artifact that should be project/global, or vice-versa) | Medium | Heuristic is propose-only with rationale; human adjusts at accept-time; K configurable |
| R6 | Meta-reviewer/agent-loop regression from touching shared code | Medium | New store + new bin + a NEW sibling `artifact-meta-reviewer` agent (the existing agent path is untouched). The only shared edit is the additive `AuditEventType` extension (TC-2a). Full agent-factory tests stay green as a gate |
| R7 | **Memory-borne prompt injection** — a hostile string in a crawled README/CODEOWNERS lands in memory, a detector picks it up, and the generator embeds it in the proposed skill body (the LLM meta-reviewer may miss a well-crafted one) | High | Deterministic `enforceArtifactConstraints` injection-pattern check (FR-D1f) **before** meta-review; proposal rationale records the memory source; adversarial NFR-3 fixtures; human promote is the final gate |

---

## 10. Traceability
| Acceptance | Functional Requirements |
|------------|-------------------------|
| AC1 | FR-A1, FR-A2, FR-C2, FR-E1, FR-F1 |
| AC2 | FR-B1, FR-B2, FR-B3 |
| AC3 | FR-D1, FR-D2 |
| AC4 | FR-E1, FR-E2, FR-E3, NFR-1, NFR-2 |
| AC5 | FR-C1, FR-E2 |
| AC6 | FR-C1, FR-C3 |

---

## 11. Implementation order (skills-only MVP; one kind-ready pipeline)
1. **P2.1** — `GeneratedArtifact` model (`kind: 'skill'`) + parser/serializer (`src/artifact-factory/types.ts` + `parser.ts`), emit/re-read a valid scoped `.md`. [FR-C1]
2. **P2.2** — `OpportunityDetector` + starter detectors reading `resolveMemory(...).layers[*].docs[*].content` directly (`src/artifact-factory/detectors.ts`). [FR-A]
3. **P2.3** — `decideScope` heuristic (pure; repo→project via `Ownership.repos[].projectId`, K=3, opportunity identity = `(kind, normalizedSuggestedName)`) (`src/artifact-factory/scope-decider.ts`). [FR-B]
4. **P2.4** — `enforceArtifactConstraints` (no-secrets / tool-allowlist FR-D1a / schema / scope / name / **injection-pattern** FR-D1f) (`src/artifact-factory/constraints.ts`). [FR-D1]
5. **P2.5** — `generateArtifact` (injected runtime) + a NEW `artifact-meta-reviewer.md` sibling agent + the meta-review invocation (reuse the hard-override mechanism). [FR-C2, FR-D2]
6. **P2.6** — `ArtifactProposalStore` (new JSON store) + park/list/show/accept/reject + `promoteArtifact` (write to scoped store; audit, commit-if-repo) + additive `AuditEventType` extension (TC-2a). [FR-E]
7. **P2.7** — operator CLI `bin/artifact-cli.ts` (`artifact propose|list|show|accept|reject`) + dispatch. [FR-F]
8. **P2.8** — 3-round adversarial self-review (security/correctness/edge — incl. the R7 injection fixtures) → release+deploy 0.3.34 → verify.

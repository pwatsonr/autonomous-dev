# PRD: ONBOARD Phase 2 — Scoped Auto-generation of Skills/Commands

## 1. Title and Metadata

| Field | Value |
|-------|-------|
| Document Title | Extend the agent-factory to propose **scoped skills/commands** from ingested memory — human-gated, with a repo→project→global scope heuristic |
| Initiative | ONBOARD (epic #583) |
| Tracking Issue | #590 |
| Phase | 2 of 5 — depends on Phase 0 (daemon 0.3.32) + Phase 1 file layer (daemon 0.3.33). Order: 0 → 1 → (2 ∥ 3) → 4 → 5 |
| Author | Operator-directed Claude Code session (pwatsonr@gmail.com) |
| Date | 2026-06-24 |
| Build mechanism | **Operator-directed** on clone `~/codebase/autonomous-dev-build` (R1); 3-round adversarial self-review before deploy |
| Predecessors | P0 ownership/scope (ArtifactScope, registry (scope,name) resolution, `managed:false`); P1 scoped memory + ingestion (`src/memory`, `src/ingest`, `mayAutoImproveScope` gate) |

---

## 2. Problem Statement

Phase 1 fills each repo/project with **scoped memory** (what the repo is: stack, standards, ownership, build, conventions). Today that memory is inert — nothing turns it into capability. The agent-factory can already analyze→propose→meta-review→park→**promote** *agents* (human-gated, safety-gated), but it cannot generate **skills** or **commands**, and it has no notion of generating an artifact *at a scope* (this repo vs this project vs global). Phase 2 closes that gap: read a repo/project's ingested memory, detect an **opportunity** ("this repo uses HashiCorp Vault" / "every repo in this project shares a lint convention"), **generate a candidate skill or command**, decide its **scope** by a repo→project→global heuristic, run it through the **existing safety gates** (`enforceConstraints` + meta-reviewer), and **park** it for a human to promote. This is the "Hermes-like" auto-capability step: the platform proposes its own scoped tooling from what it learned, and a human stays in the loop on every promotion.

---

## 3. Goals and Non-Goals

### Goals
- **G1** — Generate a candidate **skill** or **command** (valid frontmatter + body) from a repo/project's ingested memory.
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

---

## 4. Functional Requirements

### FR-A — Opportunity detection (memory → generation signal)
- **FR-A1** — `OpportunityDetector` interface (mirrors the Phase 1 `Extractor`): reads a repo's resolved memory (`resolveMemory({repoId})`) and emits zero+ `Opportunity { id, kind: 'skill'|'command', repoId, title, evidence, suggestedName }`. Best-effort + independent (a throwing detector degrades its own signal only).
- **FR-A2** — A starter detector set over Phase 1's memory topics: **secrets/vault** (a vault/secrets-manager signal in `dependencies`/`build-deploy` → propose a repo-scoped "vault access" skill), **test-convention** (a strong recurring test setup → a "run/scaffold tests" command), **domain-glossary** (a rich README/domain doc → a "domain context" skill). Detectors are data-driven and additive.
- **FR-A3** — Detection is **read-only** over memory + ownership; it never writes memory, never touches a crawled repo.

### FR-B — Scope decision (the heuristic)
- **FR-B1** — `decideScope(opportunity, occurrences)` is a **pure** function: an opportunity seen in exactly one repo → `repo:<id>`; seen in ≥ K repos all within one project (via Phase 0 ownership + Phase 1 `inferProjects`) → `project:<id>`; seen across multiple projects / org-wide → `global`. K is configurable (default 2).
- **FR-B2** — Scope is **proposed**, never applied. The artifact proposal records `proposedScope` + the rationale (which repos/occurrences drove it).
- **FR-B3** — Reuse `ArtifactScope` (P0) + `inferProjects`/`signalsFromMemory` (P1) for repo→project grouping; no new scope vocabulary.

### FR-C — Artifact model + generation
- **FR-C1** — A minimal `GeneratedArtifact { kind: 'skill'|'command', name, scope, frontmatter, body }` model + a parser/serializer good enough to **emit** a valid `.md` and **re-read** it (mirrors `src/agent-factory/parser.ts`; no runtime model). Skills/commands have no model today — this is the one genuinely-new type.
- **FR-C2** — A `generateArtifact(opportunity, scope, memory)` step constructs a generation prompt from the opportunity + the repo's memory and invokes the LLM to produce the artifact body + frontmatter (name, description, scope, `managed: true`, the skill `description`/trigger or the command surface). Injected runtime (reuse the factory's `ClaudeRuntime`) so it is unit-testable with a fake.
- **FR-C3** — Generated artifacts are always `managed: true` (platform-owned, improvable later) and carry their `scope:` — they slot into the Phase 0 scope vocabulary.

### FR-D — Safety gates (reused, artifact-adapted)
- **FR-D1** — `enforceArtifactConstraints(artifact)` — deterministic, no-LLM (mirrors `enforceConstraints`): **no secrets/credentials** in the body, **tool/permission surface** within an allowlist (a generated skill may not grant tools beyond a safe set), **valid schema** (required frontmatter present + well-formed), **scope sanity** (a `repo:`/`project:` scope id that exists in ownership), **name safety** (the `isSafeRepoId`-style charset; no path traversal). Violations reject the proposal pre-meta-review.
- **FR-D2** — The **meta-reviewer** (`agent-meta-reviewer`) reviews each generated artifact against a security checklist adapted for skills/commands (tool/permission escalation, prompt-injection in the generated body, scope creep beyond the evidence, schema compliance, proportionality). A `blocker` finding forces reject (reuse the existing hard-override).
- **FR-D3** — The **`mayAutoImproveScope` gate (FR-G2 / P1)** governs any *autonomous* action; Phase 2 generation is propose-only/parked, so it is permitted broadly, but the gate is consulted at the point a future auto-trigger or auto-promote would act (documented seam) and at promote-time for an enrolled-scope sanity check.

### FR-E — Park + human promote
- **FR-E1** — Generated artifacts are **parked** as `ArtifactProposal` records in a store reusing the agent proposal pattern (JSON-backed; status machine `pending_meta_review → meta_approved | meta_rejected → promoted`). Never auto-promoted.
- **FR-E2** — `artifact accept <id>` **promotes**: writes the artifact to `~/.autonomous-dev/artifacts/<scope-dir>/{skills,commands}/<name>.md`, git-commits it (conventional message), updates status → `promoted`, audits. Mirrors `promoter.ts` (write→commit→status→audit), targeting the scoped store instead of `agents/`.
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
- **AC6** — Both **skills and commands** are supported by the one pipeline (artifact `kind` discriminant); the build sequences skills first.

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
- **TC-2** — **Reuse** (TC, hard): `agent-factory/improvement/proposal-store.ts` pattern, `meta-reviewer.ts` (`agent-meta-reviewer`), `enforceConstraints` shape, `promotion/promoter.ts` shape, `audit`, `ownership/scope` + `mayAutoImproveScope`, `memory/resolveMemory`, `ingest/inference`. New code only where skills/commands have no model (FR-C) + the opportunity/scope layer (FR-A/B).
- **TC-3** — Generated artifacts live in the platform's **scoped store**, not the crawled repo (NG6). Consumption into a live scoped run is Phase 4.
- **TC-4** — JSON-backed proposal store (avoid the `better-sqlite3` native dep for the new store; the existing SQLite index is agents-only and untouched).
- **TC-5** — The LLM generation uses the factory's existing runtime/auth; no new secret.

---

## 8. Open Questions (resolve in TDD)
- **OQ-1** — Reuse the agent `ProposalStore` (JSONL+SQLite) directly with an artifact-kind discriminant, or a separate JSON `ArtifactProposalStore`? Lean: **separate JSON store** (avoids the native dep + keeps the agent loop untouched), mirroring the P1 questions store.
- **OQ-2** — Does the meta-reviewer reuse `agent-meta-reviewer` with an artifact-context prompt, or get an artifact-specific checklist variant? Lean: **reuse the agent, adapt the prompt**; revisit if the checklist mismatches.
- **OQ-3** — Exact scoped-store dir layout + how a future scoped run resolves it (the consumption seam for Phase 4). Lean: `~/.autonomous-dev/artifacts/{global,project/<id>,repo/<id>}/{skills,commands}/` mirroring the memory tree.
- **OQ-4** — Opportunity-detector starter set + their evidence thresholds — start with vault/test/domain, refine from real ingested memory.
- **OQ-5** — Generation prompt + the artifact frontmatter schema (skill vs command required fields) — finalize in the TDD against Claude Code's actual skill/command frontmatter spec.

---

## 9. Risks
| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| R1 | A generated artifact embeds a secret or escalates tools | High | `enforceArtifactConstraints` (no-secrets + tool allowlist) **then** meta-review; adversarial NFR-3 tests; human promote |
| R2 | Auto-applying a low-quality artifact | High | Propose-don't-apply; parked; human `accept` only; never auto-promote (NG3) |
| R3 | Writing into a crawled repo (R1/NG6) | High | Scoped store is the platform's own dir; no repo write path exists; tested |
| R4 | Over-scoping into two full skill+command factories (#498) | Medium | One unified artifact pipeline; NG1/NG4 cut the registry + improvement loop; skills-first |
| R5 | Wrong scope (repo artifact that should be project/global, or vice-versa) | Medium | Heuristic is propose-only with rationale; human adjusts at accept-time; K configurable |
| R6 | Meta-reviewer/agent-loop regression from touching shared code | Medium | New store + new bin; the agent path is reused read-only/by-pattern, not modified; full agent-factory tests stay green |

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

## 11. Implementation order (skills-first; one unified pipeline)
1. **P2.1** — `GeneratedArtifact` model + parser/serializer (`src/artifact-factory/types.ts` + `parser.ts`), emit/re-read a valid scoped `.md`. [skill kind first]
2. **P2.2** — `OpportunityDetector` + starter detectors over `resolveMemory` (`src/artifact-factory/detectors.ts`). [FR-A]
3. **P2.3** — `decideScope` heuristic (pure; reuse `inferProjects`/ownership) (`src/artifact-factory/scope-decider.ts`). [FR-B]
4. **P2.4** — `enforceArtifactConstraints` (no-secrets / tool-allowlist / schema / scope / name) (`src/artifact-factory/constraints.ts`). [FR-D1]
5. **P2.5** — `generateArtifact` (injected runtime) + meta-review adapter (reuse `agent-meta-reviewer`). [FR-C2, FR-D2]
6. **P2.6** — `ArtifactProposalStore` (JSON) + park/list/show/accept/reject + `promoteArtifact` (write to scoped store + commit, mirror `promoter.ts`). [FR-E]
7. **P2.7** — operator CLI `bin/artifact-cli.ts` + dispatch; add `command` kind. [FR-F, AC6]
8. **P2.8** — 3-round adversarial self-review (security/correctness/edge) → release+deploy 0.3.34 → verify.

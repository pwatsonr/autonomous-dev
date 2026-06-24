# PRD: ONBOARD Phase 1 — Read-only Org Ingestion + Per-repo/Project Memory

## 1. Title and Metadata

| Field | Value |
|-------|-------|
| Document Title | Read-only org ingestion → per-repo/project memory (hybrid: file scoped-memory tree + Neo4j relationship graph), project inference, blocking-question queue, ingest≠enroll toggle |
| Initiative | ONBOARD (epic #583) |
| Tracking Issue | #587 |
| Phase | 1 of 5 — depends on Phase 0 (shipped in daemon 0.3.32) |
| Author | Operator-directed Claude Code session (pwatsonr@gmail.com) |
| Date | 2026-06-23 |
| Version | 0.1 (Draft) |
| Build mechanism | **Operator-directed** on clone `~/codebase/autonomous-dev-build` (R1); adversarially self-reviewed before deploy |
| Substrate | **HYBRID** — file-based scoped memory tree + Neo4j relationship graph (operator-decided, research-informed) |
| Predecessor | Phase 0 (ownership/scope model: Org/Project/Repo + flexible tags; scope+managed; registry resolution; standards project tier) |

---

## 2. Problem Statement

Phase 0 shipped the **ownership + scope skeleton** (Org→Project→Repo, scoped artifacts, a resolver). It is empty: there is no way to populate it from a real org, and no per-repo/project **knowledge**. Phase 1 fills the skeleton: link a GitHub org, crawl every repo read-only, extract what each repo is (standards, stack, architecture, deps, ownership, conventions), write that as **scoped memory**, **infer the project structure** from cross-repo relationships, and do it all without enrolling anything into auto-improvement. This is the data layer every later phase consumes — Phase 2 generates scoped skills from this memory, Phase 3's portal visualizes the ingestion, Phase 4's webhooks trigger scoped pipelines, Phase 5 ties it together.

---

## 3. Goals and Non-Goals

### Goals
- **G1** — Link a GitHub org and **crawl every repo read-only** (no writes to any target repo).
- **G2** — Per repo, extract: code standards, stack/language, system architecture, UX/UI patterns (frontend), build/deploy targets, domain glossary, dependencies, CODEOWNERS/ownership, test conventions → write **per-repo memory**.
- **G3** — A **hierarchical, scoped file memory tree** (`global → org → project → repo`, most-specific-wins, **reusing the Phase 0 scope resolver**), more detail closer to the source.
- **G4** — A **Neo4j relationship graph** (repos, projects, deps, schemas, owners + relationships) powering cross-repo queries.
- **G5** — **Project inference:** cluster repos into projects from shared deps/schemas/teams/naming/cross-refs → **proposed** project groupings (human-gated, not auto-applied).
- **G6** — **Blocking-question queue:** ingestion ambiguities enqueue an answerable Question; that repo's ingestion pauses until answered.
- **G7** — **Ingest ≠ enroll:** everything is ingested (read-only); a per-repo `participate_in_auto_improvement` toggle (default off) gates the existing auto-improvement lifecycle.

### Non-Goals
- **NG1** — Portal UI for ingestion / question-answering / toggles → **Phase 3** (Phase 1 exposes CLI + data only).
- **NG2** — Auto-generation of scoped skills/agents/commands from memory → **Phase 2**.
- **NG3** — Discord/Slack webhook triggers → **Phase 4**.
- **NG4** — Running the auto-improvement lifecycle on enrolled repos — that's the existing machinery; Phase 1 only adds the enrollment **gate**.
- **NG5** — Writing anything to target repos (strictly read-only crawl). No PRs, no commits, no issues on crawled repos.
- **NG6** — A semantic/vector recall layer — deferred (add when fuzzy cross-memory search is needed).

---

## 4. Functional Requirements

### FR-A — Org crawl (read-only)
- **FR-A1** — `autonomous-dev org link <org>` records a linked GitHub org in the ownership manifest (`ownership.org`) and lists its repos via the authenticated GitHub API (reuse the `gh` auth already present).
- **FR-A2** — `autonomous-dev org ingest [<org>] [--repo <name>...]` crawls each repo **read-only**: a shallow clone (or API tree+blob reads) into a scratch cache; never writes to the repo or pushes anything.
- **FR-A3** — Crawl is **resumable + incremental**: per-repo ingestion status is tracked; re-running skips up-to-date repos (by HEAD sha) and resumes blocked/failed ones.
- **FR-A4** — Rate-limit + scale aware: bounded concurrency, respects GitHub API limits, OK at 100s of repos.

### FR-B — Per-repo memory extraction
- **FR-B1** — Extractors produce, per repo: stack/language + frameworks (**reuse `intake/standards/auto-detection.ts AutoDetectionScanner`**), inferred code standards, system-architecture summary, UX/UI patterns (frontend), build/deploy targets (CI/Dockerfiles), domain glossary (README/docs), dependency list, CODEOWNERS/ownership, test conventions.
- **FR-B2** — Each extractor is independent + best-effort: a failing extractor degrades that field, never aborts the repo's ingestion.
- **FR-B3** — Output is written as **per-repo memory** (structured markdown + a machine-readable `index.json`) under the repo scope.

### FR-C — File-based scoped memory tree
- **FR-C1** — Memory root (e.g. `~/.autonomous-dev/memory/`) with `global/`, `org/<id>/`, `project/<id>/`, `repo/<id>/`, each holding memory docs + `index.json`.
- **FR-C2** — `resolveMemory(scopeContext)` walks `global → org → project → repo`, **most-specific-wins, reusing the Phase 0 `ownership/scope` resolver** (`scopeEligible`/`mostSpecificEligible`). A new `src/memory/` module mirrors `src/ownership/` (types + loader/store + resolver, injected IO, pure where possible).
- **FR-C3** — Memory writes are atomic + git-auditable-friendly (the memory root may be a git repo; out of scope to enforce here).

### FR-D — Neo4j relationship graph *(gated on the connection credential; file layer does not depend on it)*
- **FR-D1** — A `src/graph/` Neo4j client wrapper (bolt `neo4j.pwatson.space:7687`, credential via env/config) writing nodes (`Org`, `Project`, `Repo`, `Dependency`, `Schema`, `Owner`) + relationships (`IN_ORG`, `IN_PROJECT`, `DEPENDS_ON`, `OWNS|USES` schema, `OWNED_BY`).
- **FR-D2** — Ingestion upserts each repo's nodes + relationships (idempotent by id).
- **FR-D3** — **Graceful degradation:** if Neo4j is unreachable/unauthenticated, ingestion still completes the file layer + logs that the graph layer was skipped; project inference falls back to file/in-memory clustering (FR-E).

### FR-E — Project inference
- **FR-E1** — Cluster repos into candidate projects by shared dependencies/schemas, shared owners/teams (CODEOWNERS), naming conventions, and cross-references. File/in-memory clustering is the baseline; the Neo4j graph enriches it (shared-relationship / community detection) when available.
- **FR-E2** — Output is a set of **proposed** projects + repo→project memberships, **human-gated** (mirrors the agent-factory propose→park→approve pattern). Never auto-applied to the ownership manifest.
- **FR-E3** — `autonomous-dev project infer` / `project proposals` lists proposals; an operator approves to write them into `ownership` (via the Phase 0 CLI).

### FR-F — Blocking-question queue
- **FR-F1** — On ambiguity (e.g. "is repo X in project Y?", "which standard is authoritative?"), ingestion enqueues a **Question** (`id`, `repoId`, `question`, `options[]`, `status: pending|answered`, `answer`).
- **FR-F2** — A repo with a pending question is marked **blocked**; its ingestion pauses until answered.
- **FR-F3** — `autonomous-dev questions list` / `questions answer <id> <choice>` (the portal UI is Phase 3). Answering unblocks + resumes that repo.

### FR-G — Ingest ≠ enroll toggle
- **FR-G1** — `Repo` gains `participate_in_auto_improvement: boolean` (default **false**). Ingestion sets it false for all.
- **FR-G2** — The existing auto-improvement lifecycle (observation-trigger / analyze / promote) only acts on repos where this flag is true — a single gate added at the daemon's request-eligibility check, reusing Phase 0's ownership lookup.
- **FR-G3** — `autonomous-dev repo enroll <id>` / `repo unenroll <id>` flips it (reuses the Phase 0 ownership store).

---

## 5. Acceptance Criteria (→ #587)
- **AC1** — `org link` + `org ingest` crawls every repo read-only; each repo ends with a per-repo memory file.
- **AC2** — Projects are **inferred** (proposals) from cross-repo relationships.
- **AC3** — A repo with an ambiguity raises an **answerable** question; answering resumes it.
- **AC4** — Nothing is auto-enrolled — every repo defaults `participate_in_auto_improvement: false`; `repo enroll` flips it.
- **AC5** — `resolveMemory` for a repo returns the merged global+org+project+repo memory (most-specific-wins).
- **AC6** — With Neo4j reachable, the graph is populated + enriches inference; **with Neo4j down, ingestion still completes the file layer** (graceful degradation).

---

## 6. Non-Functional Requirements
- **NFR-1 (Read-only safety):** zero writes to any crawled repo; enforced + tested (no `git push`, no API mutations).
- **NFR-2 (Degradation):** the file layer is fully functional without Neo4j (FR-D3) — Neo4j is additive.
- **NFR-3 (Scale):** OK at 100s of repos — bounded concurrency, incremental by HEAD sha, no full re-crawl.
- **NFR-4 (Test isolation):** mock the GitHub crawl + a test/in-memory graph; never touch live operator state or the real org in tests.
- **NFR-5 (Idempotency):** re-ingesting a repo is idempotent (file + graph upserts).
- **NFR-6 (CI):** judged by touched-file tests + no new failing gate (main is pre-existing-red); `tsc --noEmit` is the type gate.

---

## 7. Technical Constraints
- **TC-1** — Build operator-directed on the clone; never the live checkout (R1). Land via release+deploy runbook.
- **TC-2** — **Reuse**: `ownership/scope` resolver (FR-C2), `AutoDetectionScanner` (FR-B1), the ownership store/CLI (FR-E3/FR-G3), the propose→park→approve pattern (FR-E2). No reinvention.
- **TC-3** — **Neo4j credential is an external prerequisite** (homelab secret) — the graph layer is gated on it; the build proceeds file-first so it is not blocked.
- **TC-4** — `better-sqlite3` rebuild-per-cache + node-only if a SQLite store is used for the question queue (or use a JSON store to avoid the native dep).
- **TC-5** — GitHub crawl uses the existing `gh` auth; no new secret beyond Neo4j.

---

## 8. Open Questions (resolve in TDD)
- **OQ-1** — Crawl mechanism: shallow git clone vs GitHub API tree+blob reads. Lean: shallow clone for repos needing broad scanning (standards/arch), API for targeted files — decide per-extractor cost.
- **OQ-2** — Memory root location + format: `~/.autonomous-dev/memory/` markdown+index.json; is the memory root its own git repo (versioned) now or later?
- **OQ-3** — Question-queue store: JSON file vs SQLite. Lean JSON (avoids the native dep; small volume).
- **OQ-4** — Neo4j schema/constraints + the exact graph model (labels/rels) — finalize in the TDD with the neo4j-expert once the credential lands.
- **OQ-5** — Project-inference algorithm specifics (clustering thresholds; graph community detection vs file heuristics) — start heuristic, refine.

---

## 9. Risks
| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| R1 | Accidental write to a crawled repo | High | Strict read-only crawl (shallow clone to scratch, never push); NFR-1 test asserts no mutating ops |
| R2 | Neo4j credential unavailable blocks the phase | Medium | File-first build + graceful degradation (FR-D3); graph is additive |
| R3 | Crawl cost/rate-limits at 100s of repos | Medium | Bounded concurrency, incremental by sha (FR-A3/A4) |
| R4 | Over-scoping (handoff #498) | Medium | Tight NG list; propose-don't-apply; portal/auto-gen/webhooks explicitly deferred |
| R5 | Extraction quality (heuristics miss/misclassify) | Medium | Best-effort per-extractor (FR-B2); ambiguities → questions (FR-F), not silent guesses |

---

## 10. Traceability
| Acceptance | Functional Requirements |
|------------|-------------------------|
| AC1 | FR-A1, FR-A2, FR-B1, FR-B3 |
| AC2 | FR-E1, FR-E2 |
| AC3 | FR-F1, FR-F2, FR-F3 |
| AC4 | FR-G1, FR-G2, FR-G3 |
| AC5 | FR-C1, FR-C2 |
| AC6 | FR-D1, FR-D2, FR-D3 |

---

## 11. Implementation order (file-first; Neo4j when credential lands)
1. **P1.1** — `src/memory/` scoped file memory module (types + store + `resolveMemory`, reusing `ownership/scope`). [no Neo4j]
2. **P1.2** — org crawl (read-only) + per-repo extractors (reuse `AutoDetectionScanner`) → per-repo memory. [no Neo4j]
3. **P1.3** — ingest≠enroll toggle (`Repo.participate_in_auto_improvement` + the daemon gate + `repo enroll`). [no Neo4j]
4. **P1.4** — blocking-question queue + CLI. [no Neo4j]
5. **P1.5** — project inference (file/in-memory clustering) → proposals. [no Neo4j]
6. **P1.6** — `src/graph/` Neo4j layer + graph-enriched inference + FR-D3 degradation. [**needs the Neo4j credential**]
7. **P1.7** — full self-review (security/correctness/edge) → release+deploy → verify.

# PRD: ONBOARD Phase 0 — Ownership & Scope Model

## 1. Title and Metadata

| Field | Value |
|-------|-------|
| Document Title | Ownership & scope model (Org/Project/Repo + flexible grouping tags; `scope` + `managed` on artifacts) |
| Initiative | ONBOARD (epic #583) |
| Tracking Issue | #584 |
| Phase | 0 of 5 — **foundational; blocks all other phases** |
| Author | Operator-directed Claude Code session (pwatsonr@gmail.com) |
| Date | 2026-06-22 |
| Version | 0.1 (Draft — pending operator review) |
| Type | Foundational feature |
| Build mechanism | **Operator-directed** on clone `~/codebase/autonomous-dev-build` (per handoff R1) |
| Target landing | `pwatsonr/autonomous-dev` plugin, via the normal release+deploy runbook |
| Predecessor | daemon 0.3.31 (self-improvement loop wired + self-feeding) |
| Reviewers | Operator (pwatsonr) |

---

## 2. Problem Statement

Today autonomous-dev manages **one** repo's agents/skills/commands as a flat, global, all-AI-managed set. The ONBOARD initiative (epic #583) requires onboarding an entire GitHub org — potentially **hundreds of repos** — where:

- artifacts must be **scoped** (global vs a specific project vs a specific repo);
- some artifacts are **user-owned** — the AI must load and obey them but must **never** modify/improve/promote them (business & quarterly goals, system-arch & language constraints, compliance);
- repos group into **projects**, with a flexible sub-grouping (teams / domains / product-lines).

None of this exists. Every later phase depends on it:

- **Phase 1 (ingestion)** has nowhere to write per-repo / per-project scoped memory.
- **Phase 2 (scoped auto-gen)** cannot decide global vs project vs repo scope, nor tell *managed* from *authoritative* artifacts.
- **Phase 3 (portal views)** cannot filter by project/repo/team.
- **Phase 4 (webhooks)** cannot route a `{project|repo}` trigger.

Phase 0 builds exactly that foundation and nothing more.

---

## 3. Goals and Non-Goals

### Goals
- **G1** — An **Org → Project → Repo** ownership model plus a **flexible grouping-tag** dimension, persisted in the existing config manifest.
- **G2** — Every agent/skill/command carries **`scope`** (`global | project:<id> | repo:<id>`) and **`managed`** (`true | false`).
- **G3** — The registry **loads multi-scope** artifacts and **resolves** which apply to a request, **most-specific-wins** (repo > project > global) with explicit override.
- **G4** — `managed:false` artifacts are **loaded and used** but **never** shadowed / improved / promoted / modified by the agent-factory lifecycle. (Distinct from today's `FROZEN`, which is AI-owned-but-unimprovable.)
- **G5** — User constraints can be expressed as **scoped `standards.yaml`** rules enforced by `rule-set-enforcement-reviewer` at the correct scope.

### Non-Goals
- **NG1** — Org link / crawl / ingestion → **Phase 1**.
- **NG2** — Auto-generation of scoped artifacts → **Phase 2**.
- **NG3** — Portal views / filtering UI → **Phase 3** (Phase 0 only provides the data the portal will later read).
- **NG4** — Discord/Slack triggers → **Phase 4**.
- **NG5** — Migrating today's global artifacts to other scopes; they **default to `global` + `managed:true`** (behavior-preserving).
- **NG6** — A new DB/graph substrate; Phase 0 **extends the existing JSON manifest**. The memory-substrate decision (files vs Neo4j) is deferred to **Phase 1**.

---

## 4. Functional Requirements

Each FR is independently testable.

### FR-A — Ownership data model + storage
- **FR-A1** — Extend `~/.claude/autonomous-dev.json` with an `ownership` tree: `org` (linked GitHub org login/id, nullable), `projects[]` (`id`, `name`, `tags{}`), `repos[]` (`id`, `path` and/or `remote`, `projectId | null`, `tags{}`).
- **FR-A2** — A repo belongs to **≤ 1 project** (or is standalone). Membership is explicit.
- **FR-A3** — Grouping is a **flexible tag map** (string key → string value) on projects and repos — e.g. `{"team": "payments"}` — with **no enum constraint on the key**. The default surfaced grouping key is `"team"`, but `"domain"`, `"product-line"`, `"business-unit"`, etc. are equally valid with no schema change.
- **FR-A4** — **Backward compatibility:** an absent `ownership` tree means "single implicit org, all repos standalone, all artifacts `global`/`managed:true`" — today's behavior preserved exactly.
- **FR-A5** — A CLI verb assigns a repo to a project and sets/lists tags (e.g. `autonomous-dev project ...` / `repo ...`); config validation **rejects dangling `projectId`** references.

### FR-B — `scope` + `managed` on artifacts
- **FR-B1** — Agent/skill/command definitions accept optional **`scope`** (default `global`) and **`managed`** (default `true`). Location TBD in TDD (file frontmatter for file-based artifacts vs registry-tracked metadata).
- **FR-B2** — `managed:false` is a **new state distinct from `FROZEN`**. The TDD defines its precedence against existing lifecycle states (baseline/shadow/frozen/promoted).
- **FR-B3** — The registry **loud-warns or rejects** a `scope` that references an unknown project/repo id.

### FR-C — Multi-scope load + resolution
- **FR-C1** — The registry loads artifacts from **all** scopes.
- **FR-C2** — For a request against repo `R` (in project `P`), the **effective set** resolves **most-specific-wins**: a `repo:R` artifact overrides a same-named `project:P` artifact, which overrides a same-named `global` one. Explicit override is permitted and logged.
- **FR-C3** — Resolution is **deterministic** and unit-tested against a repo > project > global precedence matrix.

### FR-D — `managed:false` honored by the lifecycle
- **FR-D1** — The agent-factory **improvement / shadow / promotion** paths **skip `managed:false` artifacts entirely** — never analyze-for-improvement, never shadow, never promote, never modify.
- **FR-D2** — `managed:false` artifacts **are loaded and are used** in request handling (authoritative).
- **FR-D3** — A `managed:false` artifact can transition to managed **only by an explicit operator action**, never by any automated path.

### FR-E — Scoped `standards.yaml`
- **FR-E1** — `standards.yaml` rules can be **scoped** to project/repo, and `rule-set-enforcement-reviewer` applies the rules effective for the **target repo** (union of repo + project + global; most-specific-wins on conflicts).

---

## 5. Acceptance Criteria (→ #584)
- **AC1** — A repo can be assigned to a project (CLI + persisted in the manifest).
- **AC2** — A `managed:false` repo-scoped agent **loads and is used** in a request but **never** appears in any shadow/improve/promote path (asserted by test).
- **AC3** — Scope resolution picks **repo > project > global** with explicit override (unit-test matrix).
- **AC4** — A grouping tag (e.g. `team=payments`) can be set on a project/repo and listed; the vocabulary is **not hardcoded**.
- **AC5** — A repo-scoped `standards.yaml` rule is enforced by `rule-set-enforcement-reviewer` **only** for repos in scope.

---

## 6. Non-Functional Requirements
- **NFR-1 (Back-compat):** no `ownership` tree → today's behavior, byte-for-byte where observable.
- **NFR-2 (No native deps):** Phase 0 stays in the JSON manifest; **no `better-sqlite3`/graph** introduced (avoids the rebuild-per-cache + node-only constraint).
- **NFR-3 (Determinism):** scope resolution is pure/deterministic and order-independent of load.
- **NFR-4 (Test isolation):** tests must not read or mutate **live operator state** (`~/.claude/autonomous-dev.json`, live registry); use fixtures/temp dirs.
- **NFR-5 (CI reality):** judged by **touched-file tests passing + no new failing gate** (main is pre-existing-red; see memory `autonomous-dev-ci-gate-debt`), not all-green.

---

## 7. Technical Constraints
- **TC-1** — Build **operator-directed on the clone** `~/codebase/autonomous-dev-build`; the daemon must never touch the live checkout (enforced: live checkout removed from the allowlist).
- **TC-2** — **Reuse** existing machinery: `src/agent-factory/registry.ts`, `src/agent-factory/improvement/*`, `promotion/promoter.ts`, `.autonomous-dev/standards.yaml` + `rule-set-enforcement-reviewer`. No reinvention.
- **TC-3** — Land via the **release+deploy runbook** (memory `autonomous-dev-release-deploy`): version bump, staged deploy, daemon restart-without-upgrader-race.
- **TC-4** — Manifest schema growth must be **versioned** and migration-safe (existing config has no `ownership` key today).

---

## 8. Open Questions (resolve in the TDD)
- **OQ-1** — Project/repo **id scheme**: human slug (`payments`) vs uuid vs GitHub node id. (Lean: slug for projects, repo path/remote-derived id for repos.)
- **OQ-2** — Where `scope`/`managed` lives: **frontmatter** for file-based agents/skills/commands vs registry metadata for lifecycle-tracked ones — likely both, with the registry as the resolution authority.
- **OQ-3** — Precedence when a `managed:false` artifact and a `managed:true` artifact **share a name at different scopes** (does authoritative-at-repo beat managed-at-global? Lean: yes — most-specific-wins regardless of managed flag).
- **OQ-4** — `standards.yaml` scoping mechanism: a `scope:` field inside the file vs path-based placement (per-repo `.autonomous-dev/standards.yaml`) vs both.

---

## 9. Risks
| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| R1 | Touching `registry.ts` + factory lifecycle risks the **live self-improvement loop** | Medium | Clone build; full test run; staged release; `managed:false` paths are additive/skip-only |
| R2 | **Over-engineering** the foundation (handoff #498) | Medium | Tight scope + explicit NG list; JSON manifest not a new DB; defer substrate to Phase 1 |
| R3 | Manifest schema growth breaks existing config readers | Low | Versioned, backward-compatible default (FR-A4) |
| R4 | `managed:false` vs `FROZEN` semantics confusion | Medium | FR-B2 defines precedence explicitly in TDD; tests assert no-improve/no-promote |

---

## 10. Traceability
| Acceptance | Functional Requirements |
|------------|-------------------------|
| AC1 | FR-A1, FR-A2, FR-A5 |
| AC2 | FR-B1, FR-D1, FR-D2, FR-D3 |
| AC3 | FR-B1, FR-C1, FR-C2, FR-C3 |
| AC4 | FR-A3, FR-A5 |
| AC5 | FR-E1, FR-B1 |

# HANDOFF — AI-Native Org Onboarding & Multi-Scope Knowledge System

> Codename: **ONBOARD**. Author: operator-directed session, 2026-06-22 (written near context limit as an explicit handoff). Current deployed baseline: **daemon 0.3.31 + portal 0.3.42**; self-improvement loop is wired, safe (both gates), self-feeding, deployed. This initiative builds ON that.

## 0. One-line vision
Link a GitHub org (including a **legacy** company never built with AI — Google/Wayfair/Amazon-style) → auto-ingest every repo → build **per-project and per-repo memory + scoped agents/skills/commands** → each project becomes "ready to self-improve" → the existing auto-dev lifecycle (baseline → shadow → frozen → promoted + self-improvement) runs on the **AI-managed** ones, while **user-defined immutable** context (business goals, arch/language constraints, standards) is honored but never modified. Visible + steerable from the portal and via Discord/Slack.

---

## 1. Requirements captured (faithful — nothing dropped)

**1. Repo-local vs universal agents/skills/commands + user-owned immutable context.**
- Universal agents/skills stay global; as the system matures, create **more targeted** project/repo-scoped ones. Auto-dev still runs the full lifecycle (baseline/shadow/frozen/promoted + self-improvement) on the **managed** ones.
- New class: **user-defined agents/skills the AI MUST use but MUST NOT improve/modify** — e.g. business goals, quarterly goals, system-architecture constraints ("it's on X / can only be built with language Y"), compliance.
- Legacy-company context to ingest: (a) UX/UI from repo, (b) code standards, (c) system architecture, (d) **anything else we missed** — candidate additions: domain glossary/ubiquitous language, security/compliance policies, deploy targets & runbooks, on-call/ownership (CODEOWNERS), data schemas/contracts, test conventions, dependency/licensing constraints, performance/SLA budgets.

**2. Hermes-like memory** ([hermes-agent.nousresearch.com](https://hermes-agent.nousresearch.com/)).
- Auto-builds memory **per project/repo**.
- Auto-creates command/skill/agent from **its own conversation/observations** (example: figures out there's a vault → creates a skill that knows how to interact with the vault).
- Must be **scope-smart**: decide global (all projects/repos) vs project vs repo for each thing it creates.

**3. Project grouping** — group N repos into a project (e.g. a microservice system). Some context/agents/skills at **project** level, some at **repo** level. Example: two services in different languages share **event-driven schemas** → schemas are project-level (possibly **owned** by one repo); business context is project-level.

**4. Link my GitHub org** → pull all repos → crawl → infer project-level structure automatically → create memories/skills/agents/commands **on ingestion** so each project is ready to start self-improving.
- Portal shows **ingestion in real time**; any **AI question that blocked a repo** is shown for the user to **answer in the portal** (same for project level).
- **Toggle repos on/off**: ingest everything (read-only), but the user toggles which repos participate in auto-improvement.
- **Manual triggers via Discord/Slack webhooks**: `/{autodev} {project|repo} {task}` → triggers the full pipeline until the task is **100% done + stable**; it may keep running X days to watch logs / fix issues, then **stops** after X time.

**5. Portal: project/repo views** (today it shows everything — unworkable at 100s of repos). Add **project / repo filtered views**; **subcategories like teams** (or better grouping).

**6. Make all of these work together.**

---

## 2. Two hard realities to resolve BEFORE building (read first)

**R1 — The autonomous daemon must NOT build its own running code.** Every feature here modifies auto-dev itself. The standing rule (memory: `autonomous-dev-pipeline-blocker`) is the daemon must never run on `/Users/pwatson/codebase/autonomous-dev`. **DECISION NEEDED.** Recommended resolution:
  - Design-heavy phases (0, 2, 5) → **operator-directed** build (a Claude Code session, the way 0.3.29–0.3.31 were built this session), NOT the autonomous daemon.
  - Well-scoped phases/sub-tasks (parts of 1, 3, 4) → run the autonomous pipeline against a **dedicated clone** of autonomous-dev (e.g. `~/codebase/autonomous-dev-build`, added to the allowlist), never the live daemon's checkout; land changes via the normal release+deploy runbook (memory: `autonomous-dev-release-deploy`).
  - Net: "build it via the pipeline" = pipeline-on-a-clone + operator oversight, never self-mutation of the live daemon.

**R2 — This is a multi-month *program*, not one pipeline request.** The pipeline does ONE request (PRD→…→done). So this is decomposed into a dependency-ordered set of **epics → PRDs**, fed incrementally, with oversight between them. Don't submit "build all of section 1" as a single request — it will over-scope and stall.

---

## 3. Architecture decisions (proposed; refine in PRD/TDD)

**A. Ownership model: Org → Project → Repo (+ Team tags).**
- `Org` = linked GitHub org. `Project` = logical grouping of repos (microservice system, product line, or business unit). `Repo` ∈ one project (or standalone). `Team` = a tag/sub-grouping on projects/repos for the portal (alternatives to consider: product line, domain, business unit).
- **Context inheritance:** repo inherits project inherits org. Resolution is **most-specific-wins** with explicit override.
- Storage: a registry/manifest (e.g. `~/.claude/autonomous-dev.json` grows an `org/projects/repos` tree, or a dedicated `projects.db`). Project↔repo membership + ownership of shared artifacts (e.g. "repo A owns the schemas project Z shares").

**B. Scope + managed flags on agents/skills/commands.**
- Every agent/skill/command gets `scope: global|project:<id>|repo:<id>` and `managed: true|false`.
- `managed: true` → the agent-factory lifecycle applies (baseline/shadow/frozen/promoted + self-improvement). `managed: false` → **user-owned, authoritative**: the system MUST load + use it, MUST NOT shadow/improve/promote/modify it. (Distinct from today's `FROZEN`, which means "can't be improved but is still AI-owned"; add an `AUTHORITATIVE`/`PINNED` state or a `managed` field.)
- User-defined **constraints** (business goals, arch/language rules) map well onto the existing `.autonomous-dev/standards.yaml` + `rule-set-enforcement-reviewer` (already in the plugin) — scoped per project/repo. Reuse, don't reinvent.
- Registry must load multi-scope agents and resolve which apply to a given request (by repo→project→global).

**C. Ingestion pipeline (read-only first).** New pipeline parallel to the dev pipeline:
- Per repo: crawl → extract code standards, stack/language, system arch, UX/UI patterns (frontend repos), build/deploy targets, domain glossary, deps, CODEOWNERS, test conventions. → write **per-repo memory** (a structured knowledge file/graph) + **candidate** scoped agents/skills/commands (proposals, not auto-applied).
- Project inference: cluster repos by shared deps/schemas, org teams, naming, cross-refs → **per-project memory** (business/arch/shared-schemas).
- **Blocking questions:** on ambiguity ("is repo X in project Y?", "which code standard is authoritative?") → enqueue a **Question** surfaced in the portal; that repo's ingestion pauses until answered.
- **Toggle:** ingest-everything (read-only) + per-repo `participate_in_auto_improvement` toggle. Ingestion ≠ enrollment.

**D. Memory + auto-generation (the Hermes-like part).** Extend the agent-factory (which already proposes/improves *agents* via analyze→propose→meta-review→park, human-gated) to also propose **skills/commands** and to **scope** them. Generation is gated by the existing safety gates (`enforceConstraints` + meta-reviewer) + human approval. Scope-smartness heuristic: repo-specific signal (vault in THIS repo) → repo scope; recurring across repos → propose promotion to project/global. Reuse `agent-factory/improvement/*` + `promotion/promoter.ts`.

**E. Portal.** Project/repo/team **filtered views**; **ingestion live view**; **blocking-question answer UI**; per-repo **on/off toggle**. Follow the portal discipline in memory `autonomous-dev-release-deploy` (headless-Chrome screenshots @1900px before shipping; versioned assets; CSP-safe external JS; no fabricated data; tests can't touch live operator state).

**F. Webhook triggers.** Extend the existing `discord` plugin (skills `discord:configure/access`) — and add Slack — so `/{autodev} {project|repo} {task}` submits a **scoped** pipeline request → run to `done` → enter a **stabilization watch** (X days: tail logs/CI, auto-fix regressions) → stop after X. Reuses `request submit` + the daemon; adds the post-done watch window.

---

## 4. Phased decomposition (epics → feed the pipeline in this order)

> Each epic = one PRD (operator authors or `/universal-dev:prd` / `prd-author`). Deps in brackets. Keep each epic's requests small (the pipeline over-engineers big asks — memory `autonomous-dev-pipeline-blocker` #498).

- **Phase 0 — Ownership & scope model** [foundational, blocks all]. Org/Project/Repo/Team data model + storage; `scope` + `managed` on agents/skills/commands; registry multi-scope load + resolution; user-authoritative (`managed:false`) honored by the factory (never improved) + by standards.yaml. *Accept:* a repo can be assigned to a project; a `managed:false` repo-scoped agent loads + is used but is never shadowed/promoted; resolution picks repo>project>global.
- **Phase 1 — Read-only org ingestion + per-repo/project memory** [0]. Link org; crawl; extract the standards/arch/UX/domain set; write per-repo + per-project memory; project inference; blocking-question queue; ingest≠enroll toggle. *Accept:* link org → repos crawled → each has a memory file → projects inferred → a blocked repo raises an answerable question → nothing auto-enrolled.
- **Phase 2 — Scoped auto-generation of skills/agents/commands** [0,1]. Factory proposes scoped skills/commands (not just agents) from ingestion + conversation; human-gated; scope heuristic. *Accept:* "discovered a vault" → a repo-scoped vault skill is *proposed* (parked), promotable by the human; a cross-repo pattern proposes project/global scope.
- **Phase 3 — Portal: project/repo/team views + ingestion + questions + toggles** [0,1] (parallel with 2). *Accept:* filter by project/repo/team at 100s-of-repos scale; watch ingestion live; answer a blocking question in-portal; toggle a repo's auto-improvement. Screenshot-verified @1900px.
- **Phase 4 — Discord/Slack scoped triggers + stabilization watch** [0,1]. `/{autodev} {project|repo} {task}` → scoped pipeline → done → X-day watch → stop. *Accept:* a Discord command runs the pipeline on the named repo to done and reports back; watch window tails logs and stops after X.
- **Phase 5 — Integration & "make it all work together"** [all]. End-to-end: link org → ingest → per-project ready → portal visibility → webhook trigger → managed self-improve while authoritative context is honored. *Accept:* a fresh legacy-style org goes from link → self-improving in one tracked flow.

Order: **0 → 1 → (2 ∥ 3) → 4 → 5**.

---

## 5. Decisions that need the user (don't guess)
1. **R1 build-target** (above): operator-directed + pipeline-on-clone — confirm or choose otherwise.
2. **Grouping vocabulary**: Team vs Product-line vs Domain vs Business-unit as the sub-category (§5.1 of the ask).
3. **"X days" stabilization** default (e.g. 3 days?) + what "stable" means (CI green N runs? no new errors in logs?).
4. **Authoritative-context model**: standards.yaml-based vs a first-class `managed:false` agent class vs both.
5. **Memory substrate**: extend the file-based memory, or a graph (Neo4j — the homelab plugin already has a neo4j-expert + MCP) for the per-project knowledge graph?

---

## 6. Orchestration & oversight (the `/goal` vs `/loop` call → **/loop, self-paced**)
Decision: a **self-paced `/loop`** is the steering primitive; the **pipeline** does the building. (Not `/goal` — this is ongoing supervision, not a single objective run.) The overseer loop, each tick:
1. Read the active epic/request status (`autonomous-dev request status/list`, daemon heartbeat).
2. If `done` → **verify** (run tests; for portal epics, headless-Chrome screenshots @1900px; confirm acceptance) → mark epic done → submit the next epic's request.
3. If **blocked** (ingestion question / pipeline pause) → surface to the user (portal + a note); don't guess authoritative answers.
4. If **failed/over-engineered** → triage: create a GitHub issue, decide fix-now vs defer, **pause/restart** the daemon as needed (memory `autonomous-dev-release-deploy` for restart-without-upgrader-race; `#551` request-dir hygiene).
5. Keep the **tracking epic** (below) updated; release+deploy per the runbook when an epic lands.
Suggested kickoff (in a FRESH session for full context budget): `/loop` with the prompt "babysit the ONBOARD build per docs/initiatives/org-onboarding-handoff.md: advance epics in order, verify each (tests + portal screenshots), file issues for defects, pause/restart as needed, never self-mutate the live daemon." Let it self-pace (long idle ticks; the harness re-invokes on pipeline events).

**Portal verification standard:** never declare a portal change good without a 1900px headless screenshot; check the recurring portal disease taxonomy (fabricated data, dead CSP controls, markup/CSS drift, phone-column layouts) from memory `autonomous-dev-release-deploy`.

---

## 7. System context the executor needs (so the next session starts fast)
- **Deployed:** daemon 0.3.31 (pid 30335), portal 0.3.42. Self-improvement loop wired+self-feeding (#576/#581). Release+deploy runbook + gotchas: memory `autonomous-dev-release-deploy`. Pipeline reliability + smoke-test (`pwatsonr/smoke-hello`): memory `autonomous-dev-pipeline-blocker`. CI debt: memory `autonomous-dev-ci-gate-debt`. Self-improvement machinery map: memory `autonomous-dev-self-improvement-maturity`.
- **Key code:** registry `src/agent-factory/registry.ts`; lifecycle `src/agent-factory/improvement/*` + `promotion/promoter.ts`; CLI wiring `bin/agent-cli.ts` + `src/agent-factory/improvement/cli-context.ts`; metrics recorder `bin/record-metric.ts` + `bin/lib/record-metric.js`; pipeline `bin/supervisor-loop.sh` + `bin/lib/phase-helpers.sh` (`resolve_agent`, phase→agent map); standards/rules `.autonomous-dev/standards.yaml` + `rule-set-enforcement-reviewer`; portal = separate `autonomous-dev-portal` plugin (own deploy).
- **Ops:** daemon runs from the installed **cache**, not the repo; allowlist in `~/.claude/autonomous-dev.json .repositories.allowlist`; CI is pre-existing-red on main (judge a PR by its own touched-file tests + no new failing gate, not all-green); `better-sqlite3` must be rebuilt per cache + only works under **node** (not bun).
- **CI debt to clear if "green CI" becomes a goal:** `validator.test.ts` rule tests, `migration_002.test.ts`, `worktree-manager.test.ts` (jest), env-bound `visual-regression`/Cypress/kind (#575).

## 8. Immediate next steps (for the executing session)
1. Get user calls on §5 (esp. R1 build-target).
2. Author **Phase 0 PRD** (operator or `prd-author`), keep scoped.
3. Set up the build target per R1 (clone + allowlist, or operator-directed).
4. Create per-epic GitHub issues under the tracking epic; start the `/loop` overseer.
5. Build Phase 0 → verify → release/deploy → advance.

# TDD: ONBOARD Phase 0 — Ownership & Scope Model

## 1. Title and Metadata

| Field | Value |
|-------|-------|
| Document Title | Ownership & scope model — Org/Project/Repo + flexible tags; `scope`+`managed` on agents; multi-scope resolution; managed:false lifecycle skip; standards project-tier |
| Initiative | ONBOARD (epic #583) |
| Tracking Issue | #584 |
| Linked PRD | `docs/prd/ONBOARD-phase0-ownership-scope.md` (v0.1) |
| Phase | 0 of 5 — foundational; blocks all |
| Author | Operator-directed Claude Code session (pwatsonr@gmail.com) |
| Date | 2026-06-22 |
| Version | 0.1 (Draft — pending operator review) |
| Build mechanism | Operator-directed on clone `~/codebase/autonomous-dev-build` (R1) |
| Target landing | `pwatsonr/autonomous-dev` plugin via release+deploy runbook |
| Language | TypeScript (Node), bash CLI glue; JSON/YAML config |

---

## 2. Overview

Phase 0 introduces the ownership + scope foundation every later ONBOARD phase
depends on. It is **additive and behavior-preserving**: with no `ownership`
tree and no new frontmatter, the system behaves exactly as 0.3.31 does today.

Five workstreams:

- **A. Ownership model + storage** — a new `src/ownership/` module (types +
  loader, mirroring `src/trust/trust-config.ts`) persisting an `ownership`
  tree in `~/.claude/autonomous-dev.json`; CLI verbs to assign repos to
  projects and set/list grouping tags.
- **B. `scope` + `managed` on artifacts** — extend `ParsedAgent` + the parser
  so agent `.md` frontmatter can declare `scope: global|project:<id>|repo:<id>`
  (default `global`) and `managed: true|false` (default `true`). Establish the
  same frontmatter **convention** for skills/commands (storage only; active
  resolution/enforcement of skills/commands deferred to Phase 2 — see ADR-7).
- **C. Multi-scope load + resolution** — the registry keys artifacts by
  `(scope, name)`, and `getForTask()` resolves the **effective** set for a
  target repo/project with **most-specific-wins** (repo > project > global).
- **D. `managed:false` honored by the lifecycle** — a central
  `isManaged()` predicate guards every improvement/shadow/promotion chokepoint
  so a `managed:false` artifact is **loaded and used but never analyzed,
  proposed-on, shadowed, promoted, or modified**. Distinct from `FROZEN`.
- **E. Standards project-tier** — extend the existing standards resolver from
  `default→org→repo→request` to `default→org→**project**→repo→request`, loaded
  from `~/.claude/autonomous-dev/standards/<project-id>.yaml`.

**Key design decisions (full ADRs in §11):**
- ADR-1: Store the ownership tree in the existing JSON manifest; no DB/graph
  (substrate decision deferred to Phase 1). New `src/ownership/` mirrors the
  `trust-config.ts` loader pattern.
- ADR-2: `scope`/`managed` live in artifact **frontmatter**, parsed into
  `ParsedAgent`; the registry is the resolution authority (OQ-2).
- ADR-3: The registry keys by `(scope, name)`; uniqueness becomes per-scope;
  resolution is most-specific-wins (OQ-3).
- ADR-4: `managed` defaults to `true`; `managed:false` is a **declarative,
  write-once governance property**, semantically distinct from the mutable
  runtime `FROZEN` state (ADR-6).
- ADR-5: Reuse the existing standards inheritance resolver; insert a **project
  tier** — no new validation machinery (OQ-4).
- ADR-7: Phase 0 implements scope/managed end-to-end **for agents** (the only
  factory-lifecycle-managed artifact); for skills/commands it lands the
  frontmatter convention + storage and **defers** active resolution/enforcement
  to Phase 2. Keeps Phase 0 tight (handoff #498 over-scope warning).

No schema-breaking change. No new runtime dependency. `better-sqlite3` is **not**
touched (NFR-2).

---

## 3. Architecture

### 3.1 Affected & new files

| File | Change |
|------|--------|
| `src/ownership/types.ts` | **NEW** — `Ownership`, `Project`, `Repo`, `Tags` interfaces |
| `src/ownership/loader.ts` | **NEW** — `loadOwnershipConfig()` + resolution helpers (`projectForRepo`, `scopeContextForRepo`), mirrors `trust-config.ts` |
| `src/ownership/index.ts` | **NEW** — barrel export |
| `schemas/autonomous-dev-config.schema.json` | +`ownership` top-level property (org/projects/repos/tags) |
| `config_defaults.json` | +`"ownership": { "org": null, "projects": [], "repos": [] }` |
| `src/agent-factory/types.ts` | `ParsedAgent` += `scope?: ArtifactScope`, `managed?: boolean`; `AgentRecord` unchanged; add `ArtifactScope`, `ScopeContext` types |
| `src/agent-factory/parser.ts` | `mapToParsedAgent()` extracts + validates `scope`/`managed` (~line 437) |
| `src/agent-factory/registry.ts` | key by `(scope,name)`; per-scope uniqueness; `isManaged()`; scope-aware `getForTask()`/`get()`; `shadow()` managed guard |
| `src/agent-factory/improvement/observation-trigger.ts` | managed guard in `check()` (~82) + `forceCheck()` (~148) |
| `src/agent-factory/cli.ts` | managed guard in `commandAnalyze()` (~951) + `commandImprove()` (~1303); new `project`/`repo` verbs |
| `src/agent-factory/promotion/promoter.ts` | managed guard in `validatePrerequisites()` (~477) |
| `intake/standards/types.ts` | `RuleSource` += `'project'` |
| `intake/standards/resolver.ts` | `resolveStandards()` gains a `projectRules` tier (~line 45) |
| `intake/adapters/cli_adapter_standards.ts` | load project standards from `~/.claude/autonomous-dev/standards/<project-id>.yaml` |
| `tests/...` | new unit/integration tests (see §8) |

No portal change (Phase 3). No skill/command registry built (Phase 2).

### 3.2 Component diagram (textual)

```
  ~/.claude/autonomous-dev.json
    ├── repositories.allowlist            (existing)
    ├── trust                             (existing)
    ├── notifications                     (existing)
    └── ownership            ◄── NEW
          ├── org: "acme" | null
          ├── projects[]: { id, name, tags{} }
          └── repos[]:    { id, path?, remote?, projectId|null, tags{} }
                                   │
        src/ownership/loader.ts ───┘  loadOwnershipConfig()
                                      projectForRepo(repoId) -> projectId|null
                                      scopeContextForRepo(repoId) -> ScopeContext
                                                │
   agents/*.md frontmatter                      │  ScopeContext = { repoId?, projectId? }
     scope: repo:acme/api                        ▼
     managed: false          ──► parser ──► AgentRegistry (keyed by `${scope}::${name}`)
                                                │
   request targets repo R  ──► getForTask(desc, domain, scopeContext)
                                                │  filter eligible scopes, group by name,
                                                ▼  pick most-specific (repo>project>global)
                                       Effective agent set
                                                │
   improvement / shadow / promote ─► isManaged(record)?  ── false ─► SKIP (authoritative)
                                                                └ true ─► normal lifecycle

   standards: resolveStandards(default, org, PROJECT, repo, request)
              default → org → project → repo → request   (most-specific-wins)
```

### 3.3 Data flow (request dispatch, post-Phase-0)

1. Daemon receives a request targeting repo path `P`.
2. `loadOwnershipConfig()` → derive `repoId` from `P` (remote `owner/name` or
   path basename, ADR-8) → `scopeContextForRepo(repoId)` → `{ repoId, projectId }`.
3. `registry.getForTask(description, domain, scopeContext)` returns the
   effective agents (scope-filtered, most-specific-wins).
4. If an improvement/shadow/promotion is attempted on any selected agent,
   `isManaged()` gates it; `managed:false` ⇒ skip with an audit log line.
5. Reviewer phase: `resolveStandards()` unions default/org/project/repo rules
   for `repoId`; `rule-set-enforcement-reviewer` enforces the resolved set.

Back-compat: empty `ownership` ⇒ `scopeContext = {}` ⇒ every agent is `global`
⇒ `getForTask` returns today's flat set; `resolveStandards` sees empty project
rules ⇒ today's `default→org→repo` behavior.

---

## 4. Detailed Design

### 4.1 Ownership module (`src/ownership/`)

```ts
// types.ts
export interface Tags { [key: string]: string }          // flexible grouping (ADR-9)
export interface Project { id: string; name: string; tags: Tags }
export interface Repo {
  id: string;                 // slug: remote "owner/name" or path basename (ADR-8)
  path?: string;              // local absolute path (allowlist entry)
  remote?: string;            // e.g. "github.com/acme/api"
  projectId: string | null;   // membership; null = standalone
  tags: Tags;
}
export interface Ownership { org: string | null; projects: Project[]; repos: Repo[] }
export interface ScopeContext { repoId?: string; projectId?: string }
export type ArtifactScope =                                   // shared with agent-factory
  | 'global' | `project:${string}` | `repo:${string}`;
```

```ts
// loader.ts  (mirrors src/trust/trust-config.ts: ConfigProvider + default + load())
export const DEFAULT_OWNERSHIP: Ownership = { org: null, projects: [], repos: [] };

export function loadOwnershipConfig(raw: Record<string, unknown> | undefined): Ownership;
//  - tolerant parse; unknown/missing => DEFAULT_OWNERSHIP (NFR-1)
//  - validates: every repo.projectId references an existing project.id, else
//    a loud warning + the dangling membership is dropped to null (FR-A5/B3)

export function projectForRepo(o: Ownership, repoId: string): string | null;
export function scopeContextForRepo(o: Ownership, repoId: string): ScopeContext;
//  - returns { repoId, projectId? } used by the registry resolver
export function repoIdForPath(o: Ownership, absPath: string): string | undefined;
//  - reverse lookup path -> repoId (daemon knows the target path, not the id)
```

The loader is **pure** over an injected `raw` object (the parsed config JSON),
so tests never touch live `~/.claude/autonomous-dev.json` (NFR-4). A thin
`readOwnershipFromDisk()` wrapper (used only by the CLI/daemon) reads + parses
the manifest, identical to how `trust-config.ts` is wired.

### 4.2 `ParsedAgent` + parser (`scope`/`managed`)

```ts
// types.ts (agent-factory)  — ParsedAgent gains:
  scope?: ArtifactScope;   // default 'global' applied at parse time
  managed?: boolean;       // default true applied at parse time
```

`mapToParsedAgent()` (parser.ts ~437) extracts both with validation:
- `scope`: must match `^(global|project:[a-z0-9-]+|repo:[a-z0-9/._-]+)$`; absent
  ⇒ `'global'`. Invalid ⇒ parse error (rejected at load Step 3, consistent with
  other field validation).
- `managed`: boolean; absent ⇒ `true`. Non-boolean ⇒ parse error.

No existing agent file declares these ⇒ all default `global`/`managed:true` ⇒
identical load result to today (NFR-1). The 40+ shipped agent files are **not**
edited in Phase 0 (NG5); defaults cover them.

### 4.3 Registry: per-scope keying + resolution (FR-C)

**Internal key.** Replace `Map<name, AgentRecord>` with a key of
`scopeKey = `${scope}::${name}``. Add helpers `keyOf(scope,name)` and a
secondary `byName: Map<name, AgentRecord[]>` index built during register.

**Load uniqueness (Step 5)** changes from "name unique" to "(scope,name)
unique." Two agents may share a `name` iff their `scope` differs. Same
`(scope,name)` twice ⇒ the existing uniqueness rejection (RULE_001 safety net).

**`get(name, ctx?)`** — without `ctx`, returns the `global` record if present
(today's behavior for global-only agents). With `ctx`, returns the
most-specific eligible record (repo > project > global).

**`getForTask(description, domain?, ctx?: ScopeContext)`** — new optional 3rd
arg:
1. Filter to **scope-eligible** records for `ctx`:
   - `global` ⇒ always eligible;
   - `project:<id>` ⇒ eligible iff `id === ctx.projectId`;
   - `repo:<id>` ⇒ eligible iff `id === ctx.repoId`.
2. **Resolve by name** (most-specific-wins): group eligible records by bare
   `name`; for each name keep the single most-specific scope
   (`repo` > `project` > `global`). This yields the effective set **before**
   the existing exact/semantic ranking runs (ADR-3, OQ-3 — precedence is
   independent of the `managed` flag).
3. Run the existing two-pass ranking (unchanged) over the effective set;
   `ACTIVE`-only filter unchanged.

`ctx` omitted/empty ⇒ only `global` agents are eligible and each name appears
once ⇒ **identical** to today's flat behavior (NFR-1).

### 4.4 `managed:false` lifecycle skip (FR-D) — central predicate + guards

**Predicate (single source of truth):**
```ts
// registry.ts
isManaged(name: string, ctx?: ScopeContext): boolean {
  const rec = this.get(name, ctx);
  return rec ? rec.agent.managed !== false : true;  // unknown => treat as managed (no-op)
}
```

**Guards (mirror the 5 existing FROZEN checks; add managed check beside each):**

| Site | File:line (HEAD) | Guard |
|------|------------------|-------|
| auto-trigger | `improvement/observation-trigger.ts:82-91` (`check`) | `if (!registry.isManaged(agentName)) return { triggered:false, reason:'agent is not managed (managed:false)' }` |
| force-trigger | `improvement/observation-trigger.ts:148-157` (`forceCheck`) | same |
| CLI analyze | `cli.ts:951-954` (`commandAnalyze`) | `if (rec.agent.managed===false) return 'Error: '<name>' is managed:false (authoritative) — cannot analyze.'` |
| CLI improve | `cli.ts:1303-1306` (`commandImprove`) | same message, improve |
| promote | `promotion/promoter.ts:477` (`validatePrerequisites`) | fail prerequisite if target agent `managed===false` |
| shadow | `registry.ts:388` (`shadow`) | throw `Cannot shadow '<name>': managed:false` |

`managed:false` does **not** block: load, `getForTask` selection/use (FR-D2 —
authoritative agents are used), `freeze`/`unfreeze` (orthogonal disable). It
**only** blocks the improvement/shadow/promote/modify lifecycle (FR-D1).

**Transition into managed only by explicit operator action (FR-D3):** there is
no automated path that flips `managed`; it is a file property. Changing it
requires editing the artifact file + reload (audited via `registry_reload`).

### 4.5 Standards project-tier (FR-E)

`RuleSource` gains `'project'`. `resolveStandards()` signature:
```ts
resolveStandards(
  defaultRules, orgRules, projectRules /* NEW */, repoRules, requestOverrides, opts?
): { rules: Map<string,Rule>; source: Map<string,RuleSource> }
```
Merge order **default → org → project → repo → request** (each overrides prior
by `rule.id`). Immutability check extended: an `immutable` org **or project**
rule cannot be overridden by a less-specific-than-it tier (repo/request).
`projectRules` empty ⇒ behavior identical to today (NFR-1).

Loading: `cli_adapter_standards.ts` reads
`~/.claude/autonomous-dev/standards/<project-id>.yaml` (project id from
`scopeContextForRepo`) via the existing `loadStandardsFile()` (1 MB cap, AJV,
FAILSAFE_SCHEMA — unchanged). `rule-set-enforcement-reviewer.md` needs **no**
change; it consumes the resolved set.

### 4.6 CLI verbs (FR-A5)

New verbs on the main CLI (mirror `cli_adapter_standards.ts` dispatch):
- `autonomous-dev project add <id> --name <name> [--tag k=v ...]`
- `autonomous-dev project list`
- `autonomous-dev repo assign <repoId|path> --project <projectId>`
- `autonomous-dev repo tag <repoId|path> --set k=v | --list`
All mutate the `ownership` tree in the manifest atomically (read-modify-write
with the same tmp+rename idiom used elsewhere) and run loader validation
(reject dangling references, FR-A5/B3).

---

## 5. API Specification (new/changed signatures)

```ts
// src/ownership/loader.ts
loadOwnershipConfig(raw?: Record<string, unknown>): Ownership
projectForRepo(o: Ownership, repoId: string): string | null
scopeContextForRepo(o: Ownership, repoId: string): ScopeContext
repoIdForPath(o: Ownership, absPath: string): string | undefined

// src/agent-factory/registry.ts  (additive / widened)
get(name: string, ctx?: ScopeContext): AgentRecord | undefined        // ctx optional, back-compat
getForTask(description: string, domain?: string, ctx?: ScopeContext): RankedAgent[]
isManaged(name: string, ctx?: ScopeContext): boolean                  // NEW

// intake/standards/resolver.ts  (one new positional param)
resolveStandards(defaultRules, orgRules, projectRules, repoRules, requestOverrides, opts?)
```

All changed signatures keep prior call sites valid: `get`/`getForTask` add
**optional trailing** params; `resolveStandards` callers are updated in the
same change (small, enumerated in §12).

---

## 6. Data Design

- **Manifest `ownership` tree** — JSON under `~/.claude/autonomous-dev.json`.
  Versionless but additive; absence ⇒ default. Validated by the config JSON
  schema (additive property) + loader runtime checks.
- **Ids (OQ-1, ADR-8):** `project.id` = kebab slug (`^[a-z0-9-]+$`).
  `repo.id` = remote `owner/name` lowercased, else path basename slug. Stable
  across sessions; used verbatim in `scope: repo:<id>`.
- **Artifact `scope`/`managed`** — frontmatter strings/bool; no separate store.
- **Standards project file** — `~/.claude/autonomous-dev/standards/<id>.yaml`,
  same schema as org/repo standards (`standards-v1.json`).
- **No SQLite/graph, no migration, no schema bump** (NFR-2, ADR-1).

---

## 7. Error Handling

| Failure | Detection | Action | Req |
|---------|-----------|--------|-----|
| Malformed `ownership` JSON | loader parse | fall back to `DEFAULT_OWNERSHIP` + warn | NFR-1, FR-A4 |
| `repo.projectId` dangling | loader cross-check | drop to `null` + loud warn (or reject on CLI mutate) | FR-A5, FR-B3 |
| Invalid `scope` frontmatter | parser regex | parse error ⇒ artifact rejected at load (visible in load errors) | FR-B1 |
| `scope` references unknown id | registry on first resolve | loud warn; record stays loadable but only matches its literal scope | FR-B3 |
| Same `(scope,name)` twice | load Step 5 | uniqueness rejection (existing) | FR-C |
| Improve/shadow/promote on managed:false | `isManaged` guard | skip + audit log (`managed_skip`), non-fatal | FR-D1 |
| Project standards file absent | loader | treat as empty project tier (no error) | FR-E, NFR-1 |

Principle: every fallback preserves today's behavior and emits exactly one
audit/warn line; no new fatal path is introduced.

---

## 8. Testing Strategy

All tests isolated from live operator state (NFR-4): ownership loader is pure
over injected JSON; registry tests use temp `agents/` fixtures; standards tests
use temp YAML. CI judged by touched-file tests + no new failing gate (NFR-5).

### 8.1 Ownership (unit)
- O1: `loadOwnershipConfig(undefined)` ⇒ `DEFAULT_OWNERSHIP`.
- O2: valid tree round-trips; `projectForRepo`/`scopeContextForRepo` correct.
- O3: dangling `projectId` ⇒ dropped to null + warn.
- O4: `repoIdForPath` resolves allowlist paths; unknown ⇒ undefined.
- O5: flexible tags — arbitrary keys (`team`,`domain`,`tier`) preserved (AC4).

### 8.2 Parser (unit)
- P1: agent with no `scope`/`managed` ⇒ `'global'`/`true` (NFR-1).
- P2: `scope: repo:acme/api`, `managed: false` parsed correctly.
- P3: invalid `scope` ⇒ parse error; non-bool `managed` ⇒ parse error.

### 8.3 Registry resolution (unit — the AC3 matrix)
- R1: global-only registry + no ctx ⇒ identical `getForTask` result to pre-change (golden).
- R2: same `name` at `global` and `repo:R`; ctx={repoId:R} ⇒ repo wins; ctx={} ⇒ global.
- R3: `project:P` agent eligible iff ctx.projectId===P; repo>project>global ordering.
- R4: explicit override logged; precedence independent of `managed` (OQ-3) — a `managed:false` repo agent still overrides a `managed:true` global of the same name.
- R5: per-scope uniqueness — `(global,x)` and `(repo:R,x)` coexist; `(repo:R,x)` twice rejected.

### 8.4 managed:false lifecycle skip (integration — mirror frozen tests)
Mirror `tests/agent-factory/improvement/observation-trigger.test.ts`
`test_trigger_skips_frozen_agent`:
- M1: `managed:false` agent ⇒ `observation-trigger.check()` returns
  `triggered:false, reason:'agent is not managed (managed:false)'`.
- M2: `forceCheck()` likewise.
- M3: `commandAnalyze`/`commandImprove` on managed:false ⇒ error string, no proposal generated.
- M4: `registry.shadow(managedFalse)` throws.
- M5: `promoter.validatePrerequisites` fails for a managed:false target.
- M6 (FR-D2 — POSITIVE): a managed:false agent **is loaded** and **is returned**
  by `getForTask` (used, not improved).
- M7 (distinctness, ADR-6): a `managed:false` agent that is NOT frozen has
  state `ACTIVE`; a `frozen:true` agent is `FROZEN`; the two flags are
  independent (truth table test).

### 8.5 Standards project-tier (unit)
- S1: empty project tier ⇒ resolver output identical to pre-change (NFR-1 golden).
- S2: project rule overrides org (non-immutable), is overridden by repo.
- S3: `immutable` project rule cannot be overridden by repo/request.
- S4: `source` map reports `'project'` for project-sourced rules (AC5).

### 8.6 CLI (integration)
- C1: `project add` + `repo assign` persist to a temp manifest; reload reflects it (AC1).
- C2: `repo assign` to a non-existent project ⇒ rejected (FR-A5).
- C3: `repo tag --set team=payments` then `--list` ⇒ shows it; vocabulary not constrained (AC4).

### 8.7 Suite-integrity gate (NFR-5)
Run the agent-factory jest/node suites + the standards suite. New code's
touched-file tests green; no new failing gate vs the pre-existing-red baseline
(memory `autonomous-dev-ci-gate-debt`).

---

## 9. Security Considerations
- **Authoritative integrity:** `managed:false` is the security-relevant new
  state — it guarantees user-owned artifacts are never auto-mutated. Guards are
  defense-in-depth (5 sites + central predicate); M1–M5 assert each.
- **No new external surface:** all changes are local config + in-process
  registry; no network, no new secrets, no new file outside the documented set.
- **Input validation:** scope/id regexes are anchored kebab/slug; manifest is
  read with the same trust boundary as today (operator-owned file).
- **No privilege change:** the daemon still runs from the cache against
  allowlisted repos; ownership does not widen the allowlist.

## 10. Performance Considerations
- Registry resolution adds an O(n) scope filter + group-by-name over already
  in-memory records — negligible vs the existing token-overlap pass.
- Ownership/standards loads are bounded file reads (1 MB cap on standards),
  done once per request, not in a hot loop.
- No caching added; no measurable latency budget concern (NFR-2-adjacent).

---

## 11. Architecture Decision Records

**ADR-1 — Ownership in the JSON manifest, not a new DB.** *Context:* PRD NG6,
substrate decision deferred to Phase 1. *Decision:* extend
`~/.claude/autonomous-dev.json`; new `src/ownership/` mirrors `trust-config.ts`.
*Consequences:* zero new deps, trivial back-compat, easy migration later if a
graph is chosen. *Drives:* FR-A, NFR-2.

**ADR-2 — `scope`/`managed` in frontmatter; registry is resolution authority.**
*Context:* OQ-2; agents are already frontmatter+`ParsedAgent`. *Decision:*
parse into `ParsedAgent`; resolve in the registry. *Consequences:* uniform with
`frozen`; no parallel store. *Drives:* FR-B.

**ADR-3 — Key registry by `(scope,name)`; most-specific-wins; precedence
independent of `managed`.** *Context:* OQ-3, AC3; today the map is `name`-keyed
with global uniqueness, which forbids same-name overrides. *Options:* (a)
composite key; (b) `Map<name, Record[]>`. *Decision:* (a) `${scope}::${name}` +
a `byName` index. Precedence uses scope specificity only; the `managed` flag
governs lifecycle eligibility, never resolution. *Consequences:* a repo
authoritative agent can shadow a global managed one by name; uniqueness relaxes
to per-scope. *Drives:* FR-C, OQ-3.

**ADR-4 — `managed` defaults true; declarative + write-once.** *Decision:*
absent ⇒ managed; only an explicit file edit changes it; no automated flip.
*Drives:* FR-B1, FR-D3.

**ADR-5 — Reuse the standards resolver; insert a project tier.** *Context:* OQ-4;
`resolveStandards` already does default→org→repo→request with immutability.
*Decision:* add a `projectRules` positional tier between org and repo; extend
`RuleSource`. *Consequences:* no new validation/loader code; one signature
change with enumerated call-site updates. *Drives:* FR-E.

**ADR-6 — `managed:false` is DISTINCT from `FROZEN`.** *Context:* the lifecycle
already has `FROZEN` (mutable runtime state, toggled by `freeze/unfreeze`, or
seeded by `frozen:true`). *Decision:* `managed` is a separate, independent
declarative property; an artifact may be `{managed:false, state:ACTIVE}`
(authoritative + live) — which `FROZEN` cannot express (frozen agents are
AI-owned-but-paused, still improvable after unfreeze). *Consequences:* guards
check `agent.managed`, not `state`; M7 truth-table test pins the independence.
*Drives:* FR-D, PRD §3.B distinction.

**ADR-7 — Phase 0 = agents end-to-end; skills/commands = convention only.**
*Context:* the factory registry loads only `agents/*.md`; skills/commands are
not lifecycle-tracked until Phase 2. *Decision:* implement scope/managed
resolution + lifecycle-skip for agents; define the same frontmatter convention
for skills/commands (documented) but defer active resolution/enforcement to
Phase 2. *Consequences:* tight Phase 0; no premature skill/command registry.
*Risk surfaced to operator* (scope cut). *Drives:* PRD NG2, handoff #498.

**ADR-8 — Repo id = remote `owner/name`, else path basename slug.** *Context:*
OQ-1; daemon knows the target path, scope strings need a stable id. *Decision:*
derive id from git remote when available, else slugified basename; `repoIdForPath`
does the reverse lookup. *Drives:* FR-A1, §6.

**ADR-9 — Grouping is a flexible `Tags` map, not an enum.** *Context:* ratified
decision (flexible tag dimension). *Decision:* `tags: { [k]: v }` on projects
and repos; default surfaced key `"team"`; no schema constraint on keys.
*Consequences:* `domain`/`product-line`/`business-unit` work with no change.
*Drives:* FR-A3, AC4.

---

## 12. Implementation Plan

| # | Task | Files | Depends | Acceptance | Est |
|---|------|-------|---------|------------|-----|
| T1 | Ownership types + loader (+pure validation) | `src/ownership/*` | — | O1–O5 | M |
| T2 | Config schema + defaults `ownership` | `schemas/autonomous-dev-config.schema.json`, `config_defaults.json` | T1 | schema validates sample | XS |
| T3 | `ParsedAgent` + parser `scope`/`managed` | `agent-factory/types.ts`, `parser.ts` | — | P1–P3 | S |
| T4 | Registry per-scope keying + `get`/`getForTask` resolution | `registry.ts` | T3 | R1–R5 | L |
| T5 | `isManaged` + lifecycle guards (5 sites) | `registry.ts`, `observation-trigger.ts`, `cli.ts`, `promoter.ts` | T3,T4 | M1–M7 | M |
| T6 | Standards project tier | `intake/standards/types.ts`, `resolver.ts`, `cli_adapter_standards.ts` | — | S1–S4 | M |
| T7 | CLI `project`/`repo` verbs | `cli.ts` / cli adapter | T1,T2 | C1–C3 | M |
| T8 | Skill/command frontmatter convention (docs only) | `docs/` + `templates/` | T3 | doc present (ADR-7) | XS |
| T9 | Full suite + release-readiness | CI | T1–T8 | §8.7 green | S |

Critical path: T3 → T4 → T5 (the registry + lifecycle core). T1/T2, T6, T7
parallelizable. T4 is the highest-risk edit (registry data structure) — land it
behind R1's golden test first.

**Back-compat / breaking changes:** none externally. Internal signature
widenings (`get`/`getForTask` optional args; `resolveStandards` +1 param) are
updated at all enumerated call sites in the same change. Empty ownership + no
new frontmatter ⇒ byte-for-byte today's behavior where observable.

**Rollout:** clone build → full tests → version bump → staged deploy → daemon
restart-without-upgrader-race (memory `autonomous-dev-release-deploy`).

---

## 13. Open Questions
- **OQ-A (T4, impl):** composite string key `${scope}::${name}` vs nested
  `Map<scope, Map<name,…>>`. §4.3 picks the flat composite + `byName` index for
  simpler iteration; revisit if profiling shows churn (it won't at this scale).
- **OQ-B (T7):** should `repo assign`/`project add` auto-create a repo entry
  from an allowlist path if absent? Lean yes (convenience) — confirm in spec.
- **OQ-C (T6):** project standards path
  `~/.claude/autonomous-dev/standards/<id>.yaml` vs a per-project dir. §4.5
  picks the flat file; revisit if projects need multiple standard files.
- **OQ-D (operator):** ADR-7 scope cut (skills/commands = convention only in
  Phase 0). Surfaced in the loop summary; proceed unless the operator wants
  skills/commands resolution pulled into Phase 0.

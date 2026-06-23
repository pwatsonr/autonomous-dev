# Scope & `managed` — artifact ownership conventions (ONBOARD Phase 0)

> Epic #583 · Phase 0 (#584). This documents the frontmatter conventions and the
> ownership model introduced by Phase 0. **For agents these are enforced
> end-to-end today; for skills and commands the fields are a recorded
> convention, with active resolution/enforcement arriving in Phase 2** (ratified
> scope decision OQ-D).

## Ownership model: Org → Project → Repo (+ flexible tags)

The config manifest `~/.claude/autonomous-dev.json` carries an `ownership` tree:

```json
{
  "ownership": {
    "org": "acme",
    "projects": [
      { "id": "payments", "name": "Payments Platform", "tags": { "team": "core" } }
    ],
    "repos": [
      { "id": "acme/api", "path": "/work/api", "projectId": "payments",
        "tags": { "tier": "critical" } }
    ]
  }
}
```

- A **repo** belongs to at most one **project** (or is standalone, `projectId: null`).
- **Grouping is a flexible tag map** — the default surfaced key is `team`, but
  `domain`, `product-line`, `business-unit`, or any key works with no schema
  change. Absent an `ownership` tree, behavior is identical to before Phase 0.

### CLI

```
autonomous-dev project add <id> [--name <name>] [--tag k=v ...]
autonomous-dev project list
autonomous-dev repo assign <repoId> --project <projectId> [--path <p>] [--remote <r>]
autonomous-dev repo tag <repoId> --set k=v [--set k=v ...]
autonomous-dev repo list [--project <projectId>]
```

Mutations are atomic read-modify-writes of the `ownership` key (other config
keys preserved) and reject dangling references (e.g. assigning to an unknown
project).

## `scope` — where an artifact applies

Agents/skills/commands may declare a `scope` in frontmatter:

```yaml
scope: global            # (default) applies everywhere
scope: project:payments  # applies only to repos in project "payments"
scope: repo:acme/api     # applies only to repo "acme/api"
```

**Resolution is most-specific-wins:** for a request targeting repo `R` in
project `P`, a `repo:R` artifact overrides a same-named `project:P` artifact,
which overrides a same-named `global` one. With no scope context, only `global`
artifacts apply (back-compat). Precedence is **independent of `managed`**.

> Phase 0 implements scope resolution in the **agent registry**
> (`src/agent-factory/registry.ts`, keyed by `(scope, name)`). Skills and
> commands record `scope` but are not yet registry-resolved (Phase 2).

## `managed` — who may modify an artifact

```yaml
managed: true   # (default) AI-managed: the agent-factory lifecycle may
                # baseline/shadow/improve/promote it.
managed: false  # user-authoritative: loaded and USED, but NEVER analyzed,
                # improved, shadowed, promoted, or modified by the AI.
```

`managed: false` is the home for **user-owned context the AI must honor but
must not change** — business/quarterly goals, architecture/language
constraints, compliance. It is a **declarative, write-once** property, distinct
from the mutable `FROZEN` runtime state:

| | `FROZEN` | `managed: false` |
|---|---|---|
| nature | runtime state (toggle via `agent freeze/unfreeze`) | declarative file property |
| meaning | "don't improve right now" (still AI-owned) | "never improve — user-authoritative" |
| can be `ACTIVE` + live? | no (frozen = paused) | yes (used, just never improved) |

For **agents**, `managed: false` is enforced at every lifecycle chokepoint
(observation-trigger auto/force, `agent analyze`/`agent improve`, promotion,
shadow). For skills/commands the field is recorded for Phase 2.

### Authoritative constraints via `standards.yaml`

User constraints that are *rules* (rather than agents) map onto scoped
`.autonomous-dev/standards.yaml` enforced by `rule-set-enforcement-reviewer`.
The inheritance resolver merges **default → org → project → repo → request**
(the `project` tier added in Phase 0); an `immutable` org or project rule cannot
be overridden by a less-authoritative tier. Loading project-level standards
from ingestion pairs with **Phase 1**.

## Status summary

| Capability | Phase 0 |
|---|---|
| Org/Project/Repo + flexible tags + CLI | ✅ enforced |
| `scope`/`managed` on **agents** + resolution + lifecycle guards | ✅ enforced |
| `scope`/`managed` on **skills/commands** | 📝 convention only → Phase 2 |
| Standards `project` tier in the resolver | ✅ supported |
| Loading project standards from ingestion | → Phase 1 |

# PLAN-038 — Open Questions Resolutions (2026-05-11)

Investigation report against the live state on this machine to resolve the 6 open questions promoted to plan-level blockers in PLAN-038.

**4 of 6 resolved**. **1 needs an operator decision** before TASK-014 can start (request-ledger architecture). **1 deferred to empirical measurement** during implementation.

---

## O.Q. #1 — Perf p95 ≤ 50ms realism

**Status**: Deferred to TASK-010/011 empirical measurement, as planned. Not blocking.

---

## O.Q. #2 — Request-ledger actual daemon-written path

**Status**: **RESOLVED — and the resolution is a significant plan finding.**

**Reality**: The daemon does **not** write a `requests-ledger.json` file. `git grep` returns no writer anywhere in `plugins/autonomous-dev/src/` or `plugins/autonomous-dev-portal/server/`. `~/.autonomous-dev/portal/` on this machine contains only `portal.log` — no requests file.

The TDD's NG-3707 stated "the daemon's writer for `requests-ledger.json` already exists." **That claim is wrong.** No such writer exists. The current Requests surface handler at `server/routes/requests.ts:87` reads `loadDashboardStub()` because there is no real source.

**What does exist for request state**:
- `state-paths.ts:requestActionsDir()` → `~/.autonomous-dev/portal/request-actions/<id>.json` — per-request-action JSON files (one per gate action: approve / reject / request-changes)
- `state-paths.ts:gateDecisionsDir()` → `~/.autonomous-dev/portal/gate-decisions/<repo>/<id>.json` — per-repo/per-request gate-decision state
- `state-paths.ts:approvalsQueuePath()` → `~/.autonomous-dev/approvals-queue.json` — pending approvals list
- `~/.autonomous-dev/portal-audit.log` — append-only log of every portal-mutating action

**Recommended pivot** (operator decision required before TASK-014 starts):

| Option | Pros | Cons | Recommendation |
|--------|------|------|----------------|
| **A. Aggregate from request-actions + gate-decisions dirs** | No daemon change; uses existing files | Reader complexity; "completed" requests fall out of this view as soon as the action JSON is rotated | **Preferred** — fits NG-3707 |
| **B. Tail the portal-audit.log + reduce to in-memory ledger** | Single source; captures everything | Append-only log → unbounded growth; reader must rebuild state on every cold start | Use as fallback if A is insufficient |
| **C. Add a daemon-side `requests-ledger.json` writer** | Clean schema; matches TDD's original assumption | Violates NG-3707; expands TDD scope; needs daemon-side PR | **Not recommended** in this TDD; track as a future PRD |
| **D. Accept that Requests page is in-process / per-session only** | Zero new code | The kit screenshot's "8 active requests" badge becomes unreproducible in real installs | Acceptable for MVP but disappointing |

**Recommendation: A.** Add `wiring/request-ledger-reader.ts` that:
1. Lists `${stateDirRoot()}/portal/request-actions/*.json`
2. Reads each file, extracts `{id, repo, phase, status, costSoFar, createdAt}`
3. Joins with `gateDecisionsDir()` files for in-gate / decided state
4. Returns a deduped `RequestRow[]` (one entry per request id, latest action wins)

**Plan impact**:
- TASK-008 — `requestLedgerPath()` is not added (no such file). Instead add `requestLedgerSources()` returning `{actionsDir, decisionsDir}`.
- TASK-010 — `request-ledger-reader.ts` becomes "aggregate from two dirs" not "read one file". Estimate stays 1h.
- TDD NG-3707 — should be amended to remove the false claim. Will land in TDD-037 v1.2 (follow-up doc PR).

---

## O.Q. #3 — agent-states.json schema

**Status**: **RESOLVED**. Real file on this machine:

```json
{
  "v": 1,
  "frozen": [],
  "shadowed": ["code-executor"],
  "updatedAt": "2026-05-11T14:49:42.332Z"
}
```

Writer: `plugins/autonomous-dev/bin/agent-cli.ts:21`. Only `frozen[]` and `shadowed[]` are tracked. The rich fields the TDD's `AgentsPageData` assumes (`runs30d`, `fpRate`, `lastDispatchAt`) are **not** tracked by the daemon.

**Resolution**: The agents reader composes from two sources:

1. **Canonical agent list** — scan `plugins/autonomous-dev/agents/*.md` (the actual agents directory; verified present with `code-executor.md`, `code-reviewer.md`, etc.). Read frontmatter for `name` and `description`. There is no `version` field in the agent frontmatter — derive from plugin manifest.
2. **State overlay** — cross-reference each agent name with `agent-states.json.frozen` and `agent-states.json.shadowed`. Default `status: "baseline"` if not in either list.
3. **Untrackable fields** — `runs30d`, `fpRate`, `lastDispatchAt` render as `—` (em-dash) in the view. Document as "not tracked by daemon" in the surface.

**Plan impact**:
- TASK-007 — `AgentsPageData` field types change: `runs30d?: number`, `fpRate?: number`, `lastDispatchAt?: string | null` — all optional. View renders `—` when absent.
- TASK-010 — `agent-states-reader.ts` does the manifest-scan composition described above.
- TASK-009 — `kit-parity/agent-states.json` only needs the thin schema; the richer fields come from the manifest fixture (or are also `—` in screenshots).

---

## O.Q. #4 — Static-file authority for 3 differing files

**Status**: **RESOLVED**. Authority direction is **per-file**, not global.

| File              | server/static/ size | static/ size | Newer-by-content | Authority winner |
|-------------------|---------------------|--------------|------------------|------------------|
| `gate-actions.js` | (has SPEC-037-7-04) | (has SPEC-036-3-06 only) | server | **server wins** |
| `shell.css`       | 391 lines           | 155 lines    | server (much fuller) | **server wins** |
| `theme-toggle.js` | 114 lines           | 175 lines    | static (fuller)  | **static wins** |

**Plan impact**:
- TASK-002 — sweep script needs per-file handling, not a blanket `rsync server/static/ static/`. Updated procedure:
  1. `cp server/static/gate-actions.js static/gate-actions.js`
  2. `cp server/static/shell.css static/shell.css`
  3. `cp server/static/modal.js static/modal.js` (only in server/static; needed by gate-actions.js per its header comment)
  4. `cp server/static/icons/sliders.svg static/icons/sliders.svg` (only in server/static)
  5. **Do NOT** touch `static/theme-toggle.js` (already newer).
  6. Then `git rm -r server/static/`.

---

## O.Q. #5 — Empty-state copy strings

**Status**: Deferred to TASK-022 visual review, as planned. Not blocking.

Provisional strings (R-22/R-23 compliant — sentence case, no emoji, no exclamation marks):
- Dashboard: `No active requests`
- Approvals: `No approvals waiting`
- Requests: `No active requests yet`
- Costs: `No cost data — daemon has not run yet`
- Ops daemon: `Daemon stopped`
- Ops MCP: `No MCP servers configured`
- Settings allowlist: `No repositories in the allowlist — add one to get started`
- Agents: `No agents have been frozen or shadowed`
- Repos: `No repositories in the allowlist`

---

## O.Q. #6 — Cost-ledger reviewer mapping

**Status**: **RESOLVED — but with a finding similar to O.Q. #2.**

Reality (verified on this machine and in `daemon-readers.ts:46-50`):

```ts
interface CostLedgerFile {
  daily?: Record<string, { total_usd?: number } | undefined>;
}
```

The cost ledger tracks **only daily totals**. There is no `per_request`, no `per_reviewer`, no `phase_breakdown` field. The kit screenshot's reviewer table with `qa-edge-case · 142 runs · 6% FP · $28.40` is fictional; nothing on disk can populate that table.

**Plan impact**:
- TASK-016 (Costs surface) — the reviewer table cannot be data-driven. Options:
  1. **Hide the table** on a normal install; show only the daily-spend chart (which IS data-driven). Render the table only with `kit-parity` fixtures so the kit screenshot regression still works.
  2. **Mark as "not tracked"** — render the table headers with an empty body and a "Reviewer-level cost tracking not enabled — see Settings" link.
  3. **Aggregate by phase** instead of reviewer — phase totals could come from a future ledger extension.

**Recommendation: option 2** — the empty-state table preserves the layout (kit-shape compliance, R-18) while honestly disclosing that reviewer cost attribution is a future feature. TASK-016 description amended accordingly.

---

## Summary of plan amendments needed

| Task | Original | Amendment | Reason |
|------|----------|-----------|--------|
| TASK-002 | `rsync server/static/ static/` blanket | Per-file copy; preserve `theme-toggle.js` in static/ | O.Q. #4 |
| TASK-007 | `runs30d: number; fpRate: number; lastDispatchAt: string | null` | Make all three optional | O.Q. #3 |
| TASK-008 | `requestLedgerPath()` | `requestLedgerSources()` returning `{actionsDir, decisionsDir}` | O.Q. #2 |
| TASK-010 | `request-ledger-reader` reads one file | Aggregates from request-actions + gate-decisions dirs | O.Q. #2 |
| TASK-016 | Reviewer table driven by cost-ledger | Empty-state table with "not tracked" disclosure on normal install | O.Q. #6 |

Also: **TDD-037 needs a v1.2 follow-up** to amend NG-3707 (false claim about daemon writer for requests-ledger).

---

## Decision required before implementation starts

**Single operator decision blocking TASK-014**:

> The TDD assumed `~/.autonomous-dev/portal/requests-ledger.json` is a real daemon-written file. It is not. Proceed with **Option A** (aggregate from `request-actions/` + `gate-decisions/`)? Or amend the TDD to scope-in a daemon writer (Option C)?

**Recommendation**: A. It fits NG-3707, doesn't expand TDD scope, and the resulting `RequestRow[]` shape is identical to what the surface would consume either way.

---

## Provenance

Generated by Claude during PLAN-038 open-question resolution sweep on 2026-05-11. All findings verified by reading code and live state on this machine. No assumptions; every claim traceable to a file path or grep result.

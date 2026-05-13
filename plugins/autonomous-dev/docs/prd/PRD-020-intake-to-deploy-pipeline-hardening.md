# Product Requirements Document: Intake-to-Deploy Pipeline Hardening

| Field | Value |
|-------|-------|
| **PRD ID** | PRD-020 |
| **Title** | Intake-to-Deploy Pipeline Hardening (PRD-019 follow-up) |
| **Version** | 1.0 |
| **Date** | 2026-05-12 |
| **Parent** | PRD-019 (intake-to-deploy-e2e-pipeline) — delivered via PLAN-039, PRs #251–#258 |
| **Source** | A real end-to-end test of PLAN-039 on 2026-05-12 (a "hello world" feature request walked through 9 phases with live Claude agents). Findings logged in `plugins/autonomous-dev/docs/triage/PLAN-039-SMOKE-TEST-FINDINGS.md` (B-01 … B-11). |
| **Plugin** | autonomous-dev (+ autonomous-dev-portal) |

---

## 1. Executive Summary

PLAN-039 made the intake → daemon → phase-dispatch pipeline functional: a submitted request now persists, the daemon picks it up, dispatches the right agent per phase via the *real* `claude` CLI, and `advance_phase` walks it forward. A live test confirmed the doc phases (PRD → review → TDD → review → Plan → review → Spec → review) all work with real agents producing real artifacts. But the test surfaced two **HIGH-severity** defects that prevent the pipeline from reaching its PRD-019 goal ("advance the request through every phase to a merged commit"), plus a cluster of portal/observability gaps. PRD-020 closes them.

## 2. Problem Statement

After PLAN-039, the pipeline runs but cannot complete:

- **Phases get skipped.** Some agents (esp. reviewers) mutate `state.json.current_phase` themselves; the daemon's `advance_phase` then re-reads the (already-changed) phase and double-advances. In the test, the `code` phase was never dispatched — `code-executor` never ran, no implementation was written, no PR created.
- **The pipeline can't reach the end.** `resolve_agent` (the phase→agent map) and `LEGACY_PHASES` (the actual phase sequence the daemon walks) are out of sync: the sequence ends `… code code_review test test_review validate` but `resolve_agent` has no mapping for `test`/`test_review`/`validate` (and has `security_review`/`deploy`, which aren't in the sequence). Every request — since `state_json_writer` writes `phase_overrides: []` → legacy fallback — would hit `test`, find no agent, error, retry, and `fail`. TDD-038 §7.1's transition table is likewise out of sync.
- **The portal can't surface what the daemon does.** Clicking a request from `/requests` → 404 (the request-detail route can't resolve a request from the `request-actions/` ledger + the target repo's `state.json`). `/approvals` is empty even when the dashboard counts an awaiting-approval gate, because the daemon never writes the `gate-decisions/<repo>__<id>.json` files that page reads. No webhook-add UI. Per-request cost shows `$0` because `state.json.cost_accrued_usd` is never updated (the real spend is correctly in `cost-ledger.json`).
- **Operator log noise.** Every request logs a misleading `WARN … lacks phase_overrides, using legacy sequence` because `phase_overrides: []` is the *normal* initial value.

Impact: an operator running a real request gets a half-completed pipeline (no code, no PR), a portal that 404s on the request, and a noisy log — i.e. PRD-019's "watch it advance to a merged commit" is not achievable yet.

## 3. Goals & Success Metrics

- **Primary Goal:** A submitted feature request advances autonomously through *every* phase — including a real `code` phase that writes the implementation + tests and opens a PR — to a terminal `done` state, with the portal accurately reflecting status, gates, and cost at every step.
- **Key Metrics:**
  - [ ] A "hello world" feature request (`autonomous-dev request submit "…" --repo <repo> --type feature`) reaches terminal `done` with `code-executor` having run and a PR (or, for a remote-less test repo, a committed branch) produced — verified by re-running the PLAN-039 manual verification runbook.
  - [ ] No phase is skipped: `events.jsonl` shows exactly one `phase_advance` per phase, the dispatched phase always matches the phase whose `phase-result-<phase>.json` is consumed.
  - [ ] `resolve_agent` covers every phase the daemon can route to (no "no agent for phase X" → error path reachable on a normal request); the phase sequence has a single source of truth.
  - [ ] Portal: clicking any request from `/requests` opens its detail page (no 404); `/approvals` lists every request in a `gate` state; per-request cost on the portal matches `cost-ledger.json`.
  - [ ] `WARN … lacks phase_overrides …` fires only when the `phase_overrides` key is genuinely absent (not when it's `[]`).

## 4. User Personas

- **Operator** — runs the daemon, submits requests, approves gates from the portal, watches cost.
- **Maintainer** — debugs the daemon/portal; relies on `events.jsonl`, logs, and the portal being internally consistent.

## 5. User Stories & Requirements

### Must Have (P0)

- **FR-020-01 (B-08)** — As the daemon, I MUST own all phase transitions. Agents MUST NOT modify `state.json.current_phase` or `.status`; their only transition-relevant output is `phase-result-<phase>.json` = `{status: "pass"|"fail", feedback?, artifacts?}`. The phase prompts (`resolve_phase_prompt` in `bin/supervisor-loop.sh`) must say this explicitly (replacing the current "update the state file to reflect your progress" instruction). `dispatch_phase_session` must record the *dispatched* phase, and `advance_phase` must advance from that recorded phase (and consume `phase-result-<dispatched_phase>.json`), not from a possibly-mutated `state.json.current_phase`. (PRD-019's Non-Goal forbids agent `.md` spec changes — this is done via the prompt + the daemon, not the agent specs.)
- **FR-020-02 (B-09)** — As the daemon, I MUST be able to route every phase in the canonical sequence to an agent, and the canonical sequence MUST have one source of truth. Reconcile `resolve_agent` (`bin/supervisor-loop.sh`), `LEGACY_PHASES` (`bin/lib/phase-legacy.sh`), the `PHASE_OVERRIDE_MATRIX` (`intake/types/phase-override.ts` — declared canonical), and TDD-038 §7.1's transition table. Recommended: `state_json_writer` populates `phase_overrides[]` from the TS matrix for every request (so `next_phase_for_state` and `resolve_agent` work off the same explicit list), and `resolve_agent` covers exactly that list. Either way: no `test`/`test_review`/`validate` (or any sequence member) without an agent mapping.
- **FR-020-03 (B-06)** — As the portal `/approvals` page, I MUST list every request the daemon has parked in a `gate` state. When `advance_phase` enters a `*_review`/`gate` state, the daemon MUST write `${state_dir}/gate-decisions/<repo>__<id>.json` with `state: "pending"`, `waitedMin`, `phase` (the portal's `request-ledger-reader.ts` already overlays these). And/or `/approvals` reads `request-actions/*.json` with `status == "gate"`. (Daemon-side write is preferred.)
- **FR-020-04 (B-01 / B-05)** — As an operator, clicking a request from `/requests` (or "Review the review" from a gate card) MUST open that request's detail page, not 404. The request-detail route MUST resolve a request from the `request-actions/` ledger entry (`id`, `repo`, `phase`, `status`) and/or the target repo's `state.json` at `<repo>/.autonomous-dev/requests/<id>/state.json`, and the requests-list links MUST use a route shape the detail handler accepts.

### Should Have (P1)

- **FR-020-05 (B-03 / B-10)** — As the portal, the per-request cost I display MUST match real spend. The main-loop post-session block (or `advance_phase`) MUST roll `session_cost` into `state.json.cost_accrued_usd` before `write_portal_request_action`, so the request-action `cost` is non-zero.
- **FR-020-06 (B-04)** — As an operator reading logs, I MUST NOT see the `lacks phase_overrides, using legacy sequence` warning for normal requests. `next_phase_for_state` / `warn_legacy_fallback_once` must warn only when the `phase_overrides` key is *absent* from the JSON; a present-but-empty `[]` silently means "use the default sequence". (Largely moot if FR-020-02 has `state_json_writer` populate `phase_overrides[]`.)
- **FR-020-07 (B-02)** — As a maintainer, pipeline artifacts SHOULD live in the repo's normal docs tree, not buried under `.autonomous-dev/requests/<id>/`. Decide the convention (likely `docs/prd/<slug>.md`, `docs/tdd/…`, etc.) and have the phase prompts tell each agent the exact output path. Align `SPEC-039-4-01`, the smoke `mock-claude.sh`, `docs/INTEGRATION.md`, and PRD-019 FR-019-19 to whatever's chosen. (If the chosen convention stays `<req_dir>/<phase>.md`, fix the docs/tests instead.)

### Nice to Have (P2)

- **FR-020-08 (B-07)** — Wire a webhook-add form in the portal's Settings → Notifications tab to a POST handler.
- **FR-020-09 (B-11)** — Give `write_synthesized_phase_result` a consistent shape (include `phase` and a `summary: "synthesized from exit code N"`), or define one canonical `phase-result-*.json` schema both the agents and the synthesizer conform to.
- **FR-020-10** — Doc cleanup: amend SPEC-039-2-01/02/03/08 + SPEC-039-3-01 to the real `claude` CLI contract and the `${state_dir}/request-actions/` path (currently only captured in RESEARCH-039); DRY the duplicated `resolve_phase_prompt`/`resolve_phase_budget` between `bin/supervisor-loop.sh` and `bin/spawn-session.sh`; add a `node` wrapper so the `submit` CLI runs ad-hoc (today only the built `cli_adapter.js` runs under Node — `bun cli_adapter.ts` can't load `better-sqlite3`).

## 6. Scope & Boundaries

### In Scope
- The daemon (`bin/supervisor-loop.sh`, `bin/spawn-session.sh`, `bin/lib/phase-legacy.sh`), the phase prompts it emits, `intake/lib/state_json_writer.ts`, `intake/types/phase-override.ts`.
- The portal request-detail route, `/approvals` page, request-ledger reader, and the daemon-side `gate-decisions/` writes that feed them.
- TDD-038 §7.1 / §6.2 amendments and the SPEC-039-* doc amendments (FR-020-10).

### Out of Scope
- Changing agent `.md` specs (FR-020-01 is achieved via prompts + daemon, per PRD-019's Non-Goal).
- The portal *visual* redesign (PRD-018 territory).
- New deploy backends or the `deploy` phase's behavior beyond making it routable.
- Multi-repo concurrency, per-request cost attribution beyond the single `cost_accrued_usd` field, the agent self-improvement loop.

## 7. Dependencies & Assumptions

- **Dependencies:** PLAN-039 merged to main (PRs #251–#258 — done); the portal's `request-ledger-reader.ts` gate-decision overlay (already present).
- **Assumptions:** the `claude` CLI contract documented in RESEARCH-039 is stable; `intake/types/phase-override.ts` is (or can be made) the canonical phase sequence; the fixes are implemented by hand / via the code agents directly — **not** by running the autopilot on PRD-020 (the autopilot is the thing being fixed).

## 8. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Prompt change (FR-020-01) doesn't fully stop agents mutating `state.json` (they're free-running Claude agents) | Med | High | Defense-in-depth: also make `advance_phase` ignore post-agent `current_phase` and advance from the recorded dispatched phase — so even if an agent mutates state.json, the daemon stays correct. |
| Reconciling 4 phase-sequence definitions (FR-020-02) misses one and a phase silently drops | Med | High | Add a CI check (or a daemon startup assertion) that every phase in `PHASE_OVERRIDE_MATRIX` / `LEGACY_PHASES` has a `resolve_agent` mapping, and vice-versa. |
| `gate-decisions/` write (FR-020-03) collides with the portal's own gate-decision writes (operator approvals) | Low | Med | Daemon writes `state: "pending"`; the portal overwrites with `approved`/`rejected` on operator action — latest-write-wins, no collision (matches the existing pattern). |
| Fixing the request-detail route (FR-020-04) is bigger than expected (route restructuring) | Low | Med | Scope to: detail handler reads from `request-actions/` + target-repo `state.json`; requests-list emits matching links. Defer any broader route redesign. |

## 9. Open Questions

- [ ] **OQ-020-1** — Single source of truth for the phase sequence: extend `LEGACY_PHASES` to match `resolve_agent`, or have `state_json_writer` always populate `phase_overrides[]` from `phase-override.ts` (then `LEGACY_PHASES` is only a true-legacy fallback)? Recommendation: the latter.
- [ ] **OQ-020-2** — Should the `deploy` phase be in the default sequence at all yet (no deploy backend configured by default)? If not, where does the sequence terminate — `validate`? `code_review`? Define the default terminal phase.
- [ ] **OQ-020-3** — Artifact location convention (FR-020-07): `docs/<phase>/<slug>.md` in the target repo, or keep `<req_dir>/<phase>.md`? Affects the agent prompts and several docs/tests.

## 10. Delivery Note

PRD-020 should be delivered by a normal TDD → Plan → Spec → implement cycle (or, given the fixes are well-scoped, implemented directly by the code agents working off this PRD + the bug doc). It must **not** be run through the autopilot loop, because the autopilot pipeline contains the very defects (B-08, B-09) this PRD fixes — the loop would skip its own `code` phase and die at `test`.

# Autopilot Handoff — PRD-019 / TDD-038 / PLAN-039 (2026-05-11)

## Status in one sentence

The autopilot pipeline for **completing the intake-to-deploy E2E pipeline** (so `autonomous-dev request submit` actually drives a request through PRD → ... → Deploy → merged commit) has landed **PRD, TDD, and Plan** to main. **Spec and Execute phases remain.** The plan is granular enough that Execute can run directly from PLAN-039 without a separate Spec phase if needed.

---

## What got done in the previous session

### Documents merged to main

| PR | Commit | Doc | Lines | RFC cycles |
|----|--------|-----|-------|------------|
| #248 | `6b496f0` | `plugins/autonomous-dev/docs/prd/PRD-019-intake-to-deploy-e2e-pipeline.md` | 391 | 1 (2 MAJOR → APPROVE) |
| #249 | `185ee40` | `plugins/autonomous-dev/docs/tdd/TDD-038-intake-to-deploy-e2e-pipeline.md` | 1412 | 1 (3 MAJOR → APPROVE) |
| #250 | `195b1e5` | `plugins/autonomous-dev/docs/plans/PLAN-039-intake-to-deploy-e2e-pipeline.md` | 525 | auto-approved |

### Earlier in the same session (context)

The session also shipped the **portal reality pass** (PLAN-038) and **3 polish rounds**:
- PRs #233-#247: PLAN-038 implementation (data wiring, real readers, 60 tests, brand fixes, 500→404, static-root sweep, agents/repos surfaces, etc.)
- PRs #242-#246: 3 polish rounds (favicon, kit-pattern compliance, modal contrast, Settings rewrite, nav-badge contrast)
- PR #247: built-in fix to `cli_adapter` submit/feedback positional-args bug + `build:cli` script

That work is **separate from this handoff** — it's complete and on main.

---

## The fundamental gap PRD-019 closes

An operator runs `autonomous-dev request submit "<description>" --repo <path> --type feature` and **nothing happens** — the request fails before persisting. Root cause: `initRouter()` in `plugins/autonomous-dev/intake/adapters/cli_adapter.ts:848-882` has a `TODO(PLAN-011-1)` — three optional dependencies (`claudeClient`, `duplicateDetector`, `injectionRules`) are wired as `undefined`. The submit handler already has graceful guards for them (verified by reading `intake/handlers/submit_handler.ts:92-196`), so the actual fix is just removing the TODO comment.

But that's not enough for end-to-end: the daemon (`bin/supervisor-loop.sh`) has **no logic** to pick up newly-persisted requests and dispatch them through the pipeline phases. PRD-019 + TDD-038 + PLAN-039 specify that complete dispatch layer.

---

## Locked decisions (do not re-litigate)

These came out of 2 rounds of RFC review on PRD and TDD. Don't reopen unless you have evidence the decision was wrong.

### From PRD-019 v1.1 review

1. **Agent dispatch**: `claude --agent <agent-name>` flag exists (verified by `claude --help`). Agent name resolves to `plugins/autonomous-dev/agents/<name>.md`. Don't try to inline agent content.
2. **Phase-result contract**: each agent writes `~/.autonomous-dev/portal/request-actions/<REQ-id>/phase-result-<phase>.json` with schema `{status: "pass"|"fail"|"error", feedback?, artifacts?, next_phase?}`.
3. **Submit handler is already correct**; ONLY `initRouter()` needs the `undefined` deps changed.
4. **`status` vs `current_phase` mapping**: SQLite + state.json both carry BOTH fields. `status ∈ {queued, running, gate, done, cancelled, failed}` (lifecycle). `current_phase ∈ {intake, prd, tdd, plan, spec, code, review, deploy}` (pipeline position). The daemon reads `.status` to filter actionable rows, then `.current_phase` to pick the agent.
5. **`intake` is bookkeeping only** — no agent session. First daemon pickup transitions `queued/intake` → `running/prd` directly.

### From TDD-038 v1.1 review

6. **Single dispatch path**: daemon's `dispatch_phase_session()` → existing `spawn_session_typed()` in `bin/spawn-session.sh` (line 110). DO NOT add a parallel `claude --print ...` invocation in `supervisor-loop.sh`.
7. **Code-phase prompt content**: includes branch (`autonomous/<request-id>`), conventional commits, `gh pr create`, and writing PR URL to `phase-result.json.artifacts[]`. This lives in the **phase prompt template** (data), not the agent spec (code). Agent specs in `agents/*.md` are NOT modified.
8. **OQ-019-05 / -06 resolved in TDD body**:
   - `code-executor` owns branch + commit + PR; `test-executor` runs integration tests against the PR branch; `deploy-executor` handles merge-to-main.
   - `waitedMin` computed from `state.json.current_phase_metadata.gate_entered_at`, delta computed at portal-write time (survives daemon restart).

### From PLAN-039 (synthesized from 3 planning agents)

9. **`MAX_RETRIES_PER_PHASE = 3`** then transition to `status: failed` (extending PRD enum — see TASK-031).
10. **30-minute wall-clock timeout** on each `claude` invocation via `timeout 30m` shell wrap (resolves OQ-039-3).
11. **FIFO by SQLite `created_at` ASC** for multi-request ordering — daemon stays single-threaded for v1 (resolves OQ-039-4).
12. **`CAPTURE_SPAWN_TO=<dir>` mock mode default for CI**; real API runs in a nightly gated job (resolves OQ-039-6).

---

## Known blockers / "validate during impl" items

### Critical — TASK-015 must run FIRST before TASK-009/014

**`claude --state <file>` semantics are unconfirmed.** The TDD design assumes the flag accepts an arbitrary state.json metadata blob. The TDD reviewer flagged that `--state` is documented as loading a conversation-state JSONL, not arbitrary JSON. If the assumption fails, the design needs to fall back to: pass phase prompt via `--prompt` AND have agent read state.json via the `Read` tool. **TASK-015 is a 1-hour research task that blocks Track B's TASK-009 and TASK-014. Run it first.**

### Trivial bug to fix at impl time

`bin/supervisor-loop.sh` `resolve_phase_prompt()` has a typo: `${status}` should be `${phase}` in the code-phase guard. Without the fix, the code-phase agent never sees the branch+PR instructions. **TASK-010 fixes this. 30 min.**

---

## PLAN-039 — 31 tasks across 4 tracks

### Track A — Submit handler + state.json (Sprint 1, ~10h)

| Task | Description | Files | Est | Deps |
|------|-------------|-------|-----|------|
| TASK-001 | Remove `TODO(PLAN-011-1)` comment | `cli_adapter.ts:843-844,879` | 30m | none |
| TASK-002 | `writeStateJson()` helper | `submit_handler.ts` + new `lib/state_json_writer.ts` | 3h | none |
| TASK-003 | Wire helper into `SubmitHandler.execute()` | `submit_handler.ts` | 1.5h | 002 |
| TASK-004 | Request `type` propagation | `submit_handler.ts` | 1h | 003 |
| TASK-023 | Request-directory `mkdir -p` helper | `lib/state_json_writer.ts` | 1h | 002 |
| TASK-028 | Orphan reconciliation (SQLite ↔ state.json) | `supervisor-loop.sh`, `db/repository.ts` | 3h | 002, 008 |
| TASK-030 | Shell-escape request_id in git/gh commands | `supervisor-loop.sh` (prompt template) | 1h | 011 |

### Track B — Daemon dispatch + state machine (Sprint 1-2, ~22h)

| Task | Description | Files | Est | Deps |
|------|-------------|-------|-----|------|
| TASK-015 | **Research `claude --state` semantics** | `docs/research/RESEARCH-039-claude-state-semantics.md` | 1h | none (run FIRST) |
| TASK-031 | Define `failed` terminal state (PRD amendment) | `prd/PRD-019-*.md` + state validators | 2h | none |
| TASK-008 | `resolve_agent()` with 12-entry phase→agent map | `supervisor-loop.sh` | 1.5h | none |
| TASK-009 | `dispatch_phase_session()` delegates to `spawn_session_typed` | `supervisor-loop.sh` | 3h | 008, 015 |
| TASK-010 | Fix `${status}`→`${phase}` typo in code-phase guard | `supervisor-loop.sh` | 30m | none |
| TASK-011 | Code-phase prompt content (branch+commits+PR) | `supervisor-loop.sh` `resolve_phase_prompt()` | 2h | 010 |
| TASK-012 | `advance_phase()` reads phase-result, updates state | `supervisor-loop.sh` | 4h | 009, 031 |
| TASK-013 | `intake`→`prd` auto-transition | `supervisor-loop.sh` main loop | 1h | 012 |
| TASK-014 | Phase-result.json synthesis fallback | `spawn-session.sh` | 1.5h | 012 |
| TASK-025 | Wire dispatch + advance into main loop | `supervisor-loop.sh` | 2h | 009, 012, 013, 018 |
| TASK-026 | Error handling in `dispatch_phase_session` | `supervisor-loop.sh` | 1.5h | 009 |
| TASK-029 | Apply `claude --state` fallback if needed | `spawn-session.sh` (potentially) | 2h | 015 |

### Track C — Portal sync (Sprint 2, ~4h)

| Task | Description | Files | Est | Deps |
|------|-------------|-------|-----|------|
| TASK-018 | `write_portal_request_action()` | `supervisor-loop.sh` | 2h | 012 |
| TASK-019 | `waitedMin` computation | `supervisor-loop.sh` | 1h | 018 |
| TASK-024 | Portal directory `mkdir -p` init | `supervisor-loop.sh` | 30m | 018 |

### Track D — Tests + smoke + docs (interleaved, ~16h)

| Task | Description | Files | Est | Deps |
|------|-------------|-------|-----|------|
| TASK-005 | Unit: `initRouter` graceful degradation | `__tests__/unit/cli_adapter_initrouter.test.ts` | 2h | 001 |
| TASK-006 | Unit: `writeStateJson` (path traversal, schema, atomicity) | `__tests__/unit/state_json_writer.test.ts` | 2.5h | 002 |
| TASK-007 | Integration: submit → state.json | `__tests__/integration/submit_to_state.test.ts` | 2h | 004 |
| TASK-016 | Bats: `resolve_agent` (12 mappings) | `tests/bats/resolve_agent.bats` | 1.5h | 008 |
| TASK-017 | Bats: `advance_phase` (all transition modes) | `tests/bats/advance_phase.bats` | 3h | 012 |
| TASK-020 | Smoke E2E (FR-019-19) | `test/e2e/smoke-e2e.sh` | 4h | 013, 018, 025 |
| TASK-022 | Manual verification | N/A | 2h | 020 |
| TASK-027 | Integration docs | `docs/INTEGRATION.md` (new) | 1.5h | 022 |

### Critical path (28h single-threaded longest chain)

```
TASK-015 (1h)
  → TASK-031 (2h)
    → TASK-009 (3h)
      → TASK-012 (4h)
        → TASK-014 (1.5h)
          → TASK-018 (2h)
            → TASK-020 (4h)
              → TASK-022 (2h)
                → TASK-027 (1.5h)
```

Total: ~58 engineering hours. With parallelism across Tracks A + D: **~9-11 days for one author, ~5 days for two**.

### Suggested 5-PR strategy

1. **PR-1: Submit + state.json (Track A + research)** — TASK-001, 002, 003, 004, 015, 023, 028, 030, 005, 006, 007, 031
2. **PR-2: Daemon dispatch foundation (Track B early)** — TASK-008, 009, 010, 011, 016, 026, 029
3. **PR-3: State machine + transition (Track B late)** — TASK-012, 013, 014, 017, 025
4. **PR-4: Portal sync (Track C)** — TASK-018, 019, 024
5. **PR-5: Smoke E2E + docs (Track D close)** — TASK-020, 022, 027

---

## How to resume in a fresh session

### Option A — Continue the autopilot loop (recommended)

```
/universal-dev:autopilot-resume
```

This reads `.claude/autopilot-state.json` (which says `current_phase: spec`) and continues from the spec phase. It dispatches the spec-author agent for each track in PLAN-039, then advances to execute.

### Option B — Skip spec, execute directly from the plan

PLAN-039 is detailed enough that you can skip the spec layer and execute directly:

```
/universal-dev:execute plugins/autonomous-dev/docs/plans/PLAN-039-intake-to-deploy-e2e-pipeline.md
```

The plan has per-task file paths, ACs, deps, and a critical path. The execute step will dispatch code-executor agents per task and create PRs.

### Option C — Manual execution of TASK-015 first (recommended-first-step regardless of A/B)

TASK-015 is a 1-hour research task that **blocks the critical path** (TASK-009 + TASK-014 depend on it). Run it manually before any automated execution to lock in the `claude --state` semantics:

```bash
# 1. Read the flag doc
claude --help | grep -A 4 'agent\|state\|prompt'

# 2. Try a minimal repro
TMP_STATE=$(mktemp /tmp/state-XXXX.json)
echo '{"request_id":"REQ-000001","current_phase":"prd","status":"running","title":"smoke test"}' > "$TMP_STATE"
claude --agent prd-author --state "$TMP_STATE" --print --output-format json --max-turns 1 --prompt "Reply with the title from state.json"

# Document findings in plugins/autonomous-dev/docs/research/RESEARCH-039-claude-state-semantics.md
```

If `--state` accepts the JSON → TDD design holds. If not → TDD-038 §6.2 needs a small amendment (use `--prompt` carrying the phase prompt + have agent read state.json via Read tool from a known path).

---

## Pre-resume checklist

Run these once in the new session before kicking off automation:

```bash
cd /Users/pwatson/codebase/autonomous-dev

# 1. Confirm clean state
git status              # should be clean
git log --oneline -5    # most recent should be #250 PLAN-039 commit (195b1e5)

# 2. Verify the 3 docs are on main
ls plugins/autonomous-dev/docs/prd/PRD-019-*.md
ls plugins/autonomous-dev/docs/tdd/TDD-038-*.md
ls plugins/autonomous-dev/docs/plans/PLAN-039-*.md

# 3. Confirm autopilot state
cat .claude/autopilot-state.json | jq '.current_phase'
# expect: "spec"

# 4. Confirm daemon is alive
autonomous-dev daemon status

# 5. Run the build:cli to make sure the CLI works
cd plugins/autonomous-dev
bun run build:cli
# expect: "cli_adapter.js  ~0.67 MB"

# 6. Sanity-check the CLI still validates correctly
node intake/adapters/cli_adapter.js list
# expect: empty queue JSON
```

---

## Decisions matrix for the next session

| Question | If yes | If no |
|----------|--------|-------|
| Run TASK-015 (`claude --state` validation) first? | Critical-path blocker. Resolves before Track B starts. | Risk: implement TASK-009 against the wrong assumption and rework later. |
| Skip the spec phase? | Faster (PLAN-039 is detailed enough). | More agent overhead, but spec adds per-track code patterns + commit metadata. |
| Run Tracks A + D in parallel from Sprint 1? | Halves wall-clock. Use git worktrees or sequential PRs. | Simpler — single linear progression. |
| Use `CAPTURE_SPAWN_TO` for the smoke test? | CI runs cheap (no real API). Real run is a separate gated job. | Smoke test costs real API tokens on every CI run. |
| Extend PRD enum to add `failed` state (TASK-031)? | Operator UX is clearer. 1-line PRD amendment + portal mapping. | Reuse `cancelled` with a reason field — simpler, slightly less expressive. |

---

## Out-of-scope (do NOT touch in this work)

These are explicitly **Non-Goals** from PRD-019 / TDD-038:

- Modifying agent specs in `plugins/autonomous-dev/agents/*.md` (the 18 agents are pinned)
- Redesigning the portal (PLAN-038 just shipped — frozen)
- Changing deploy backends
- Multi-repo request routing (single-repo per request is fine for v1)
- Per-request cost attribution (cost-ledger tracks daily totals only)
- Parallel daemon execution (single-threaded for v1)
- Discord/Slack adapters beyond what already exists

If you find yourself touching these, the scope has drifted — pause and re-evaluate.

---

## Open questions tracked in PLAN-039 (resolution paths below)

| ID | Question | Resolution path |
|----|----------|-----------------|
| OQ-039-1 | `claude --state` accepts arbitrary JSON? | TASK-015 (research); fallback in TASK-029 |
| OQ-039-2 | Terminal state on retry-exhausted? | TASK-031: extend enum to include `failed` (recommended) |
| OQ-039-3 | Per-phase wall-clock timeout? | 30 min via `timeout 30m` shell wrap (locked) |
| OQ-039-4 | Multi-submit ordering rule? | SQLite `created_at` ASC, FIFO (locked) |
| OQ-039-5 | SQLite ↔ state.json reconciliation? | TASK-028 — orphan-reconciliation pass (locked) |
| OQ-039-6 | API key in CI for smoke test? | `CAPTURE_SPAWN_TO` mock mode default; gated real-API job (locked) |

Only OQ-039-1 (and its dependent OQ-039-2) carry real uncertainty. OQ-039-3 through -6 are locked.

---

## Definition of done (whole PRD-019 effort)

PLAN-039 is complete and PRD-019 is delivered when:

- [ ] All 31 tasks marked completed in PLAN-039
- [ ] All 20 ACs (AC-038-01..AC-038-20) green from TDD-038
- [ ] CI green: typecheck, lint, unit, integration, bats
- [ ] `bash test/e2e/smoke-e2e.sh` exits 0 in mock mode (CAPTURE_SPAWN_TO set)
- [ ] At least one real-API smoke run produced a `docs/prd/*.md` artifact in a test repo
- [ ] `git grep "TODO.PLAN-011-1"` returns nothing
- [ ] `autonomous-dev request submit "Add /health endpoint" --repo /tmp/test-repo --type feature` succeeds and the daemon advances the request through at least PRD phase (or further)

---

## Key file paths (cheat sheet)

```
# Source under change
plugins/autonomous-dev/intake/adapters/cli_adapter.ts                     # initRouter at 848-882
plugins/autonomous-dev/intake/handlers/submit_handler.ts                  # already has guards
plugins/autonomous-dev/intake/lib/state_json_writer.ts                    # NEW — TASK-002
plugins/autonomous-dev/bin/supervisor-loop.sh                             # most of Track B
plugins/autonomous-dev/bin/spawn-session.sh                               # spawn_session_typed at 110
plugins/autonomous-dev/agents/*.md                                        # 18 specs, DO NOT MODIFY

# State and config
~/.autonomous-dev/intake-auth.yaml                                        # RBAC config (already set up)
~/.autonomous-dev/portal/request-actions/<REQ-id>.json                    # flat file, portal action
~/.autonomous-dev/portal/request-actions/<REQ-id>/phase-result-<phase>.json  # subdir, per phase
<target_repo>/.autonomous-dev/requests/<id>/state.json                    # per-repo state

# Authoritative docs (on main)
plugins/autonomous-dev/docs/prd/PRD-019-intake-to-deploy-e2e-pipeline.md     # 391 lines, v1.1
plugins/autonomous-dev/docs/tdd/TDD-038-intake-to-deploy-e2e-pipeline.md     # 1412 lines, v1.1
plugins/autonomous-dev/docs/plans/PLAN-039-intake-to-deploy-e2e-pipeline.md  # 525 lines

# Autopilot state
.claude/autopilot-state.json                                              # current_phase: spec

# Portal (don't touch)
plugins/autonomous-dev-portal/server/wiring/request-ledger-reader.ts      # reads portal action files
```

---

## Next-session opening prompt (paste this verbatim)

```
Pick up the PRD-019 autopilot pipeline. Read
plugins/autonomous-dev/docs/triage/AUTOPILOT-PRD-019-HANDOFF.md first.
PRD/TDD/Plan are merged. Next phases: Spec + Execute.

Recommended first action: run TASK-015 (claude --state validation,
~1h) before any code work — it blocks the critical path. Then either
/universal-dev:autopilot-resume (continues from spec phase) or
/universal-dev:execute plugins/autonomous-dev/docs/plans/PLAN-039-intake-to-deploy-e2e-pipeline.md
(skips spec, goes straight to per-task implementation).

PR-1 scope (Track A + research): TASK-001, 002, 003, 004, 015, 023,
028, 030, 005, 006, 007, 031. ~10 engineering hours.

Do NOT touch agent specs (agents/*.md). Do NOT redesign the portal.
Single-threaded daemon for v1.
```

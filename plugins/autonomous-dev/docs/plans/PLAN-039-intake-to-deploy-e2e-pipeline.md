---
governance:
  status: ready-for-review
  created_at: "2026-05-11T20:30:00Z"
  updated_at: "2026-05-11T20:30:00Z"
  phase: plan
  jira_epic: ""
  slug: intake-to-deploy-e2e-pipeline
  tdd_ref: intake-to-deploy-e2e-pipeline
  prd_ref: intake-to-deploy-e2e-pipeline
---

# PLAN-039: Intake-to-Deploy E2E Pipeline — Implementation Plan

| Field          | Value                                                            |
|----------------|------------------------------------------------------------------|
| **Plan ID**    | PLAN-039                                                         |
| **Title**      | Intake-to-Deploy E2E Pipeline — Implementation Plan              |
| **Version**    | 1.0                                                              |
| **Date**       | 2026-05-11                                                       |
| **Parent TDD** | TDD-038 (intake-to-deploy-e2e-pipeline, v1.1, APPROVED)          |
| **Parent PRD** | PRD-019 (intake-to-deploy-e2e-pipeline, v1.1, APPROVED)          |
| **Plugin**     | autonomous-dev                                                   |
| **Authoring**  | Synthesized from 3 parallel planning agents via `/universal-dev:taskPlan` |

---

## Overview

TDD-038 closes the gap between request submission (built in PRD-008) and pipeline dispatch. After this plan executes, an operator runs `autonomous-dev request submit "<description>" --repo <path>` and the daemon advances the request through PRD → TDD → Plan → Spec → Code → Review → Deploy to a merged commit.

This plan decomposes TDD-038's 3 release phases into **31 tasks across 4 parallel tracks**, totalling ~58 engineering hours with a 28-hour critical path. Per-task acceptance criteria map back to TDD AC-038-NN identifiers.

**Synthesis of 3 planning agents**:
- **Feature Decomposition** produced the 27-task spine. Refined here.
- **Technical Architecture** flagged 2 CRITICAL + 1 MEDIUM concerns that became explicit tasks: orphan reconciliation, `claude --state` validation, shell-escape for request_id.
- **Risk & Testing** contributed a 24-test matrix + 8-risk register + 6 open questions that map to specific tasks below.

---

## Context

- **Branch this plan lives on**: `docs/plan/intake-to-deploy-e2e-pipeline`
- **Suggested implementation branch**: `feat/PLAN-039-intake-to-deploy-e2e-pipeline` (or per-task feature branches per the parallel tracks)
- **Estimated complexity**: Large (~58 hours, 31 tasks, 2 sprints)
- **Lint commands**: `bun run typecheck && bun run lint` (or `bash -n` for shell scripts)
- **Test runners**: `bun test` (TypeScript), `bats tests/bats/` (shell)
- **Smoke test**: `bash test/e2e/smoke-e2e.sh` (FR-019-19 acceptance)

---

## Agent assignment

Most implementation work is **TypeScript + shell + SQLite** on Bun. There's no python/java/kafka/graphql here, so the standard universal-dev agent table doesn't cleanly apply. All implementation tasks route to **`code-executor`** with the TDD as authoritative spec. Code review on every PR via **`code-reviewer`** (and **`security-reviewer`** for the path-traversal / injection tasks).

---

## Parallel tracks

| Track | Theme | Tasks | Hours | Depends on |
|-------|-------|-------|-------|------------|
| A — Submit handler + state.json | Submit pipeline fix; `writeStateJson` + path-traversal guard | TASK-001..004, 023, 028 (orphan recon), 030 (shell-escape) | ~10 | nothing |
| B — Daemon dispatch + state machine | `dispatch_phase_session`, `advance_phase`, retries, terminal states | TASK-008..014, 025, 026, 029 (claude --state validation), 031 (terminal-failed state) | ~22 | TASK-015 (validation) early |
| C — Portal sync | Portal request-action writes + waitedMin | TASK-018, 019, 024 | ~4 | TASK-012 |
| D — Tests + smoke + docs | Unit + integration + bats + smoke E2E + docs | TASK-005, 006, 007, 016, 017, 020, 022, 027 | ~16 | per-task track |

Track B is the long pole. Tracks A and D run in parallel from Sprint 1; B starts after TASK-015 lands; C piggybacks on B's `advance_phase` task.

---

## Open questions (must resolve before listed tasks start)

These came from the three planning agents. Each blocks a specific task.

| # | Question | Blocks | Resolution path |
|---|----------|--------|-----------------|
| OQ-039-1 | Does `claude --state <file>` accept arbitrary state.json metadata, or only conversation-state JSONL? | TASK-009, TASK-014 | TASK-015 (research task: `claude --help` + targeted test); fallback: pass phase prompt via `--prompt` and have agent read state.json via Read tool |
| OQ-039-2 | What's the terminal state when a phase fails after `MAX_RETRIES_PER_PHASE` is exhausted? PRD's `status` enum has no `failed` — only `{queued, running, gate, done, cancelled}`. | TASK-012 | TASK-031: extend PRD's enum to add `failed`, OR map retry-exhausted → `cancelled` with `cancelled_reason: "max-retries-exceeded"`. **Recommendation**: extend to include `failed`, since it conveys different operator semantics from a user-issued cancel. |
| OQ-039-3 | What is the per-phase wall-clock timeout? `--max-turns N` is per-turn, not wall-clock. Hung Claude sessions block the daemon indefinitely. | TASK-009, TASK-014 | Recommendation: 30-minute wall-clock per phase via `timeout` shell command wrapping the `claude` invocation in `spawn_session_typed`. |
| OQ-039-4 | What's the FIFO ordering rule when multiple requests are submitted between daemon polls? The daemon is single-threaded in v1. | TASK-012, TASK-025 | TASK-008 selects the oldest `queued` request by SQLite `created_at` ASC, processes it to completion (or gate), then re-polls. |
| OQ-039-5 | Reconciliation between SQLite and state.json filesystem layer — what happens when SQLite INSERT succeeds but state.json write fails (orphan SQLite row), or vice versa? | TASK-002, TASK-028 | TASK-028: daemon reconciliation pass at startup + every N polls: query SQLite for rows whose state.json doesn't exist on disk; mark as `cancelled` with `cancelled_reason: "state-file-lost"`. Conversely, state.json without SQLite row → daemon logs WARN and skips. |
| OQ-039-6 | Should ANTHROPIC_API_KEY be required for CI to run the smoke test (real API calls cost money), or should there be a mock mode? | TASK-020 | TASK-020 supports `CAPTURE_SPAWN_TO=<dir>` env var (TDD §10): when set, `spawn_session_typed` writes the would-be `claude` argv to that dir instead of invoking. CI default: mock mode. Real Claude calls run nightly in a separate gated job. |

---

## Tasks

### Track A — Submit handler + state.json

#### TASK-001 — Remove `TODO(PLAN-011-1)` comment in `cli_adapter.ts`
- **Description**: The TDD review confirmed `initRouter()` already passes `undefined` for the three optional deps. The only change needed is removing the TODO comment lines 843-844 and 879. No functional change.
- **Files**: `plugins/autonomous-dev/intake/adapters/cli_adapter.ts`
- **Owner**: `code-executor`
- **Dependencies**: none
- **Lint**: `bun run typecheck`
- **Test**: `bun test intake/__tests__/unit/cli_adapter_initrouter.test.ts` (added by TASK-005)
- **AC**:
  - [ ] AC-038-01 — `initRouter()` resolves without throwing when all three deps are undefined
  - [ ] TODO comment removed from lines 843-844 and 879
  - [ ] `bun run build:cli` succeeds
- **Estimate**: 30 min

#### TASK-002 — `writeStateJson()` helper in submit_handler
- **Description**: New helper that, after `insertRequest()` returns, writes `<target_repo>/.autonomous-dev/requests/<id>/state.json` atomically (`${file}.tmp.$$` + rename). Includes `phase_overrides: []`, `current_phase: "intake"`, `status: "queued"`, request id regex check, path-traversal guard on `target_repo`.
- **Files**: `plugins/autonomous-dev/intake/handlers/submit_handler.ts` (new helper) + new `intake/lib/state_json_writer.ts` (if extraction makes sense)
- **Owner**: `code-executor`
- **Dependencies**: none
- **Lint**: `bun run typecheck`
- **Test**: `bun test intake/__tests__/unit/state_json_writer.test.ts` (added by TASK-006)
- **AC**:
  - [ ] AC-038-05 — atomic tmp+rename
  - [ ] AC-038-06 — schema includes all 19 fields from TDD §6.1
  - [ ] AC-038-07 — path-traversal guard rejects `..`, symlinks outside target, absolute paths outside allowlist
  - [ ] `phase_overrides: []` present (SUGGESTION-1 from TDD review)
- **Estimate**: 3 hr

#### TASK-003 — Wire `writeStateJson()` into `SubmitHandler.execute()`
- **Description**: Call `writeStateJson()` between `insertRequest()` (line 227) and queue position query (line 229). Extract `target_repo` from flags. Per-TDD §6 SQLite-first ordering preserved (rationale in MINOR-1 from review: SQLite-first is safer than PRD's stated order).
- **Files**: `plugins/autonomous-dev/intake/handlers/submit_handler.ts`
- **Owner**: `code-executor`
- **Dependencies**: TASK-002
- **Lint**: `bun run typecheck`
- **Test**: `bun test intake/__tests__/integration/submit_to_state.test.ts` (added by TASK-007)
- **AC**:
  - [ ] After submit, both SQLite row and state.json exist with matching fields
  - [ ] SQLite-first ordering preserved
- **Estimate**: 1.5 hr

#### TASK-004 — Request `type` propagation
- **Description**: Ensure the `--type` flag (`feature|bug|infra|refactor|hotfix`) flows from CLI into the state.json `type` field and the SQLite row.
- **Files**: `plugins/autonomous-dev/intake/handlers/submit_handler.ts`
- **Owner**: `code-executor`
- **Dependencies**: TASK-003
- **Lint**: `bun run typecheck`
- **Test**: extend `state_json_writer.test.ts`
- **AC**:
  - [ ] Type appears in SQLite row AND state.json
- **Estimate**: 1 hr

#### TASK-023 — Request-directory creation helper
- **Description**: `mkdir -p <target_repo>/.autonomous-dev/requests/<id>/` before writing state.json. Handle permission errors with actionable error messages.
- **Files**: `plugins/autonomous-dev/intake/lib/state_json_writer.ts`
- **Owner**: `code-executor`
- **Dependencies**: TASK-002
- **AC**:
  - [ ] Creates directory if missing; preserves permissions of target repo
  - [ ] Returns a typed error on permission denied (not a stack trace)
- **Estimate**: 1 hr

#### TASK-028 — Reconciliation for orphan SQLite rows / orphan state.json files (NEW — from Architecture agent)
- **Description**: Address Architecture agent's CRITICAL finding. At daemon startup AND every N polls (default: every 60th poll, configurable), run a reconciliation pass:
  1. Query SQLite for rows in `status='queued'` with `created_at > 24h ago`. For each, check if state.json exists on disk at the expected path. If missing → mark request `cancelled` with `cancelled_reason: "state-file-lost"`, log warning.
  2. Scan all state.json files under known target-repo paths. For each, check SQLite for matching row. If missing → log WARN once per file ("orphan state.json, no SQLite record — daemon will not dispatch this request"). Do NOT auto-delete.
- **Files**: `plugins/autonomous-dev/bin/supervisor-loop.sh` (new `reconcile_orphans()` function), `intake/db/repository.ts` (new query method)
- **Owner**: `code-executor`
- **Dependencies**: TASK-002 (state.json exists) and TASK-008 (resolve_agent exists)
- **Lint**: `bash -n bin/supervisor-loop.sh && bun run typecheck`
- **Test**: `bats tests/bats/reconcile_orphans.bats` (new)
- **AC**:
  - [ ] Resolves OQ-039-5
  - [ ] Reconciliation pass runs on daemon start and every N polls (config: `RECONCILE_EVERY_N_POLLS=60`)
  - [ ] No false positives: a state.json that DOES have a matching SQLite row is never flagged
- **Estimate**: 3 hr

#### TASK-030 — Shell-escape request_id in `gh pr create` and `git checkout -b` (NEW — from Architecture agent)
- **Description**: Architecture agent flagged that request_id flows into `git checkout -b autonomous/<id>` and `gh pr create --title "<title with id>"` without explicit escaping. While the request_id regex is `^REQ-\d{6}$` (no shell metacharacters), the safety belt is to use single-quoted arguments and verify the regex is enforced at the prompt-template construction site too.
- **Files**: `plugins/autonomous-dev/bin/supervisor-loop.sh` (`resolve_phase_prompt()` for code phase)
- **Owner**: `code-executor`
- **Dependencies**: TASK-011
- **AC**:
  - [ ] Request id is single-quoted in the prompt template
  - [ ] Prompt template construction validates `request_id` matches `^REQ-[0-9]{6}$` before substitution
- **Estimate**: 1 hr

### Track B — Daemon dispatch + state machine

#### TASK-008 — `resolve_agent()` function with 12-entry phase-to-agent map
- **Description**: New shell function in `supervisor-loop.sh` mapping each phase name → agent name. Per TDD §6.2 the table is hardcoded: `prd → prd-author`, `tdd → tdd-author`, etc. Unknown phase → empty string + daemon skips.
- **Files**: `plugins/autonomous-dev/bin/supervisor-loop.sh`
- **Owner**: `code-executor`
- **Dependencies**: none
- **Lint**: `bash -n bin/supervisor-loop.sh`
- **Test**: `bats tests/bats/resolve_agent.bats` (added by TASK-016)
- **AC**:
  - [ ] AC-038-10 — all 12 phase→agent mappings correct
  - [ ] Unknown phase returns empty string (daemon skips, logs WARN)
- **Estimate**: 1.5 hr

#### TASK-009 — `dispatch_phase_session()` function
- **Description**: New shell function that reads `current_phase` from state.json (not `.status`), calls `resolve_agent(current_phase)`, writes phase prompt context into `state.json.current_phase_metadata`, then delegates to the existing `spawn_session_typed()` in `spawn-session.sh`. **Important**: this is per TDD MAJOR-1 — single dispatch path via `spawn-session.sh`, NOT a parallel `claude --print ...` invocation.
- **Files**: `plugins/autonomous-dev/bin/supervisor-loop.sh`
- **Owner**: `code-executor`
- **Dependencies**: TASK-008, TASK-015 (validation of `claude --state` semantics)
- **Lint**: `bash -n bin/supervisor-loop.sh`
- **Test**: `bats tests/bats/dispatch_phase.bats`
- **AC**:
  - [ ] AC-038-11 — `dispatch_phase_session` calls `spawn_session_typed`, never `claude` directly
  - [ ] Reads `current_phase` (not `.status`) for agent selection
  - [ ] Wraps `claude` invocation in `timeout 30m` (resolves OQ-039-3)
- **Estimate**: 3 hr

#### TASK-010 — Fix `${status}` → `${phase}` typo in code-phase guard
- **Description**: TDD reviewer flagged this as MINOR. The code-phase guard at supervisor-loop.sh references `${status}` where it should be `${phase}` (or whatever the local variable name in the actual function body is). Without this fix, code-phase agents would never see the branch+PR instructions.
- **Files**: `plugins/autonomous-dev/bin/supervisor-loop.sh` (`resolve_phase_prompt()`)
- **Owner**: `code-executor`
- **Dependencies**: none
- **AC**:
  - [ ] Code-phase guard uses correct variable; code-phase prompt appends branch+PR instructions when `phase == code`
- **Estimate**: 30 min

#### TASK-011 — Code-phase prompt template content
- **Description**: Per TDD MAJOR-3 resolution: append code-phase-specific instructions to the prompt — `autonomous/<request-id>` branch, conventional commits, `gh pr create --base main --head autonomous/<id> --title <conventional> --body <summary>`, write PR URL to `phase-result.json.artifacts[]`. Single-quoted request id (per TASK-030).
- **Files**: `plugins/autonomous-dev/bin/supervisor-loop.sh` (`resolve_phase_prompt()`)
- **Owner**: `code-executor`
- **Dependencies**: TASK-010
- **AC**:
  - [ ] AC-038-12 — code-phase prompt contains branch/commit/PR instructions
  - [ ] No agent-spec changes (preserves Non-Goal)
- **Estimate**: 2 hr

#### TASK-012 — `advance_phase()` function
- **Description**: Reads `phase-result-<phase>.json`, decides next phase, atomically updates `state.json` (new phase + status), appends event to `events.jsonl`, triggers portal sync (TASK-018). Per OQ-039-2 resolution: on retry-exhausted, set `status: failed` (extending PRD enum — see TASK-031).
- **Files**: `plugins/autonomous-dev/bin/supervisor-loop.sh`
- **Owner**: `code-executor`
- **Dependencies**: TASK-009, TASK-031
- **Test**: `bats tests/bats/advance_phase.bats` (added by TASK-017)
- **AC**:
  - [ ] AC-038-13 — successful phase transitions write to state.json + events.jsonl atomically
  - [ ] AC-038-14 — review failure retries up to `MAX_RETRIES_PER_PHASE`; on exhaustion → `status: failed`
  - [ ] Missing phase-result.json → treat as `pass`, log WARN
- **Estimate**: 4 hr

#### TASK-013 — `intake` → `prd` auto-transition
- **Description**: First daemon pickup of a `queued/intake` request transitions to `running/prd` without spawning a session. Per PRD FR-019-09: `intake` is bookkeeping only.
- **Files**: `plugins/autonomous-dev/bin/supervisor-loop.sh` (main loop)
- **Owner**: `code-executor`
- **Dependencies**: TASK-012
- **AC**:
  - [ ] AC-038-09 — request transitions queued/intake → running/prd on first poll
  - [ ] Events.jsonl records the transition
- **Estimate**: 1 hr

#### TASK-014 — Phase-result.json synthesis fallback in `spawn-session.sh`
- **Description**: When `spawn_session_typed` invokes an agent that doesn't write `phase-result-<phase>.json` natively, the wrapper synthesizes one from exit code (`0 → pass`, nonzero → `fail`). Architecture agent flagged that exit code 0 ≠ semantic success; explicitly document this risk and recommend agents always write the file.
- **Files**: `plugins/autonomous-dev/bin/spawn-session.sh`
- **Owner**: `code-executor`
- **Dependencies**: TASK-012
- **AC**:
  - [ ] If agent doesn't write `phase-result.json`, wrapper synthesizes one with `status: "pass"|"fail"` from exit code
  - [ ] Synthesized result includes `synthesized: true` flag so the daemon can log "trusting exit code, not agent output"
- **Estimate**: 1.5 hr

#### TASK-015 — Research: `claude --state` semantics (OQ-039-1)
- **Description**: Reviewer's SUGGESTION blocking Phase 2: validate whether `claude --state <file>` accepts arbitrary state.json metadata or only conversation-state JSONL. Run `claude --help`, then try a targeted test. Document findings in a one-page research note.
- **Files**: `plugins/autonomous-dev/docs/research/RESEARCH-039-claude-state-semantics.md` (new)
- **Owner**: `code-executor` + maybe `web-researcher`
- **Dependencies**: none — should run FIRST, blocks TASK-009 + TASK-014
- **AC**:
  - [ ] Confirms `--state` behavior with a minimal repro
  - [ ] If `--state` doesn't accept arbitrary JSON: documents the fallback (`--prompt <phase-prompt>` plus agent reads state.json via Read tool); updates TDD-038 §6.2 accordingly via a follow-up doc PR
- **Estimate**: 1 hr

#### TASK-025 — Main loop integration
- **Description**: Wire `dispatch_phase_session` and `advance_phase` into the daemon's main loop in the correct sequence: select → dispatch → wait → advance → portal-sync → repeat.
- **Files**: `plugins/autonomous-dev/bin/supervisor-loop.sh` (main_loop)
- **Owner**: `code-executor`
- **Dependencies**: TASK-009, TASK-012, TASK-013, TASK-018
- **AC**:
  - [ ] main_loop calls `dispatch_phase_session` (not old `spawn_session`)
  - [ ] `advance_phase` called after each session completion
  - [ ] FIFO by SQLite `created_at` (resolves OQ-039-4)
- **Estimate**: 2 hr

#### TASK-026 — Error handling in `dispatch_phase_session`
- **Description**: Robust error handling: unknown phase → skip + log; `spawn_session_typed` failure → mark state as `failed` + log; daemon never crashes on dispatch errors.
- **Files**: `plugins/autonomous-dev/bin/supervisor-loop.sh`
- **Owner**: `code-executor`
- **Dependencies**: TASK-009
- **AC**:
  - [ ] Daemon survives all dispatch failure modes; logs include actionable info
- **Estimate**: 1.5 hr

#### TASK-029 — Validate `claude --state` semantics + apply fallback if needed (NEW — from Architecture agent)
- **Description**: Per TASK-015's findings, apply whichever path is needed. If `--state` works as TDD assumes → no code change. If it doesn't → update `spawn_session_typed` to pass `--prompt <phase-prompt>` AND have the daemon write the phase prompt into a file the agent reads (or via Read tool on the state.json itself).
- **Files**: `plugins/autonomous-dev/bin/spawn-session.sh` (potentially)
- **Owner**: `code-executor`
- **Dependencies**: TASK-015
- **AC**:
  - [ ] Phase prompt reaches the agent regardless of `--state` semantics
  - [ ] If TDD design held: no change. If not: TDD-038 amended via doc PR.
- **Estimate**: 2 hr (worst case)

#### TASK-031 — Define `failed` terminal state (NEW — from Architecture agent)
- **Description**: PRD-019's status enum is `{queued, running, gate, done, cancelled}`. There's no `failed`. TDD-038's `advance_phase` needs a terminal state when retries are exhausted. Two options:
  1. **Extend PRD enum** to `{queued, running, gate, done, cancelled, failed}`. Update PRD via short amendment, update portal's request-ledger-reader to map `failed`.
  2. **Reuse `cancelled`** with `cancelled_reason: "max-retries-exceeded"`.
  Recommendation: extend to `failed`. Operator semantics are different ("agent gave up" vs "user cancelled"). Requires a 1-line PRD amendment + state-machine extension.
- **Files**: `plugins/autonomous-dev/docs/prd/PRD-019-intake-to-deploy-e2e-pipeline.md` (amendment), state validators in `intake/db/`, `bin/supervisor-loop.sh`
- **Owner**: `code-executor`
- **Dependencies**: none for the decision; TASK-012 depends on this
- **AC**:
  - [ ] Status enum extended; PRD-019 amended (or option 2 documented)
  - [ ] Portal correctly displays `failed` requests
- **Estimate**: 2 hr

### Track C — Portal sync

#### TASK-018 — `write_portal_request_action()` function
- **Description**: New shell function that writes/updates `~/.autonomous-dev/portal/request-actions/<REQ-id>.json` (flat file at the canonical layout) on each state transition. Uses `${file}.tmp.$$` + rename. The TDD's per-phase `<REQ-id>/phase-result-<phase>.json` is a separate filesystem node (directory) and doesn't collide.
- **Files**: `plugins/autonomous-dev/bin/supervisor-loop.sh`
- **Owner**: `code-executor`
- **Dependencies**: TASK-012
- **AC**:
  - [ ] AC-038-16 — every state transition writes a portal-action file
  - [ ] Atomic write pattern
  - [ ] No `<REQ-id>` directory/file collision (subdir for phase-results, flat .json for portal action)
- **Estimate**: 2 hr

#### TASK-019 — `waitedMin` computation
- **Description**: Resolution of OQ-019-06: compute time-in-gate from `state.json.current_phase_metadata.gate_entered_at`. Delta is computed at portal-write time (not in-memory) so it survives daemon restart.
- **Files**: `plugins/autonomous-dev/bin/supervisor-loop.sh`
- **Owner**: `code-executor`
- **Dependencies**: TASK-018
- **AC**:
  - [ ] `waitedMin` accurate after daemon restart (since `gate_entered_at` is persisted)
- **Estimate**: 1 hr

#### TASK-024 — Portal directory init
- **Description**: `mkdir -p ~/.autonomous-dev/portal/request-actions/` on daemon startup so the first write doesn't ENOENT.
- **Files**: `plugins/autonomous-dev/bin/supervisor-loop.sh`
- **Owner**: `code-executor`
- **Dependencies**: TASK-018
- **AC**:
  - [ ] Directory exists before first portal write
- **Estimate**: 30 min

### Track D — Tests + smoke + docs

#### TASK-005 — Unit: `initRouter` graceful-degradation
- **Description**: Verify `initRouter()` returns a working router when all three optional deps are undefined.
- **Files**: `plugins/autonomous-dev/intake/__tests__/unit/cli_adapter_initrouter.test.ts`
- **Owner**: `code-executor`
- **Dependencies**: TASK-001
- **AC**:
  - [ ] AC-038-01..03 — submit-with-undefined-deps tests pass
- **Estimate**: 2 hr

#### TASK-006 — Unit: `writeStateJson`
- **Description**: Path traversal, regex enforcement, atomic write, schema completeness, `phase_overrides: []`.
- **Files**: `plugins/autonomous-dev/intake/__tests__/unit/state_json_writer.test.ts`
- **Owner**: `code-executor`
- **Dependencies**: TASK-002
- **AC**:
  - [ ] AC-038-05, 06, 07 covered; SUGGESTION-1 covered
- **Estimate**: 2.5 hr

#### TASK-007 — Integration: submit → state.json
- **Description**: CLI argv → initRouter → SubmitHandler → SQLite + state.json + portal-action. Validates `select_request()` would find the written state file.
- **Files**: `plugins/autonomous-dev/intake/__tests__/integration/submit_to_state.test.ts`
- **Owner**: `code-executor`
- **Dependencies**: TASK-004
- **AC**:
  - [ ] AC-038-08 — daemon's `select_request` finds the written state.json
- **Estimate**: 2 hr

#### TASK-016 — Bats: `resolve_agent`
- **Description**: All 12 mappings + unknown-phase fallback.
- **Files**: `plugins/autonomous-dev/tests/bats/resolve_agent.bats`
- **Owner**: `code-executor`
- **Dependencies**: TASK-008
- **Estimate**: 1.5 hr

#### TASK-017 — Bats: `advance_phase`
- **Description**: pass → next phase; fail → retry; retry-exhausted → `failed`; missing result → WARN + pass.
- **Files**: `plugins/autonomous-dev/tests/bats/advance_phase.bats`
- **Owner**: `code-executor`
- **Dependencies**: TASK-012
- **Estimate**: 3 hr

#### TASK-020 — Smoke E2E test (FR-019-19)
- **Description**: `test/e2e/smoke-e2e.sh` — fresh TMP_REPO, submits a request, daemon `--once` picks it up, verifies PRD-phase artifact `docs/prd/*.md` exists, hard-fails if not (Step 8a from the TDD review). Supports `CAPTURE_SPAWN_TO=<dir>` for CI mock mode (resolves OQ-039-6).
- **Files**: `plugins/autonomous-dev/test/e2e/smoke-e2e.sh`
- **Owner**: `code-executor`
- **Dependencies**: TASK-013, TASK-018, TASK-025
- **AC**:
  - [ ] AC-038-19 — completes < 10 min; hard-fails on missing PRD artifact
- **Estimate**: 4 hr

#### TASK-022 — Manual verification
- **Description**: Manual smoke run end-to-end: submit, watch logs, verify portal shows the request with correct status transitions.
- **Files**: N/A
- **Owner**: operator + `code-executor` to script the verification
- **Dependencies**: TASK-020
- **Estimate**: 2 hr

#### TASK-027 — Integration docs
- **Description**: Update README + add `docs/INTEGRATION.md` covering: state.json schema, phase-to-agent table, portal sync behavior, troubleshooting.
- **Files**: `plugins/autonomous-dev/docs/INTEGRATION.md` (new) + `plugins/autonomous-dev/README.md` (link)
- **Owner**: `code-executor`
- **Dependencies**: TASK-022
- **Estimate**: 1.5 hr

---

## Dependency graph (critical path)

```
TASK-015 (claude --state research) ──┐
                                     │
TASK-001 ─→ TASK-005                 │
TASK-031 (failed-state decision) ────┼─→ TASK-012 ──┐
                                     │              │
TASK-002 ─→ TASK-003 ─→ TASK-004 ─→ TASK-007       ├─→ TASK-013 ──┐
TASK-002 ─→ TASK-023 + TASK-028                    │              │
                                                   │              │
TASK-008 ─→ TASK-016                               │              │
TASK-008 + TASK-015 ─→ TASK-009 ───────────────────┘              ├─→ TASK-025 ──┐
TASK-010 ─→ TASK-011 + TASK-030                                   │              │
TASK-012 + TASK-009 ─→ TASK-014 + TASK-017                        │              │
TASK-009 ─→ TASK-026 + TASK-029                                   │              │
                                                                  │              │
                                                                  │              │
TASK-012 ─→ TASK-018 ─→ TASK-019 + TASK-024                       │              │
                                                                  │              ↓
                                                                  └─→ TASK-020 (smoke E2E)
                                                                                 │
                                                                                 ↓
                                                                              TASK-022 → TASK-027
```

**Critical path** (28 h single-threaded longest chain):
TASK-015 (1h) → TASK-031 (2h) → TASK-009 (3h) → TASK-012 (4h) → TASK-014 (1.5h) → TASK-018 (2h) → TASK-020 (4h) → TASK-022 (2h) → TASK-027 (1.5h)

Plus parallel chains on Tracks A + D add coverage; wall-clock with parallelism: ~9-11 days for one author or ~5 days for two.

---

## Risk register (from planning agents)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Smoke test brittleness (real API calls in CI) | High | Medium | `CAPTURE_SPAWN_TO` mock mode default in CI; real runs in nightly gated job (TASK-020) |
| State.json corruption between SQLite + rename | Medium | High | SQLite-first + atomic temp-rename + orphan reconciliation (TASK-028) |
| Agent wall-clock timeout absence | High | Medium | `timeout 30m` wrap on `claude` invocation (TASK-009) |
| Concurrency race (multi-submit between polls) | Medium | High | FIFO by SQLite `created_at`; single-threaded v1 (TASK-025) |
| Prompt injection via description | Medium | Medium | `injectionRules` wired in initRouter; basic template escaping (TASK-001 baseline; richer rules out-of-scope) |
| Permission error on target repo | Low | High | Early validation in `writeStateJson()` returns typed error (TASK-023) |
| Partial phase-result.json writes by agents | Medium | Medium | Agents write atomically (`${file}.tmp.$$`); wrapper synthesizes on missing (TASK-014) |
| `claude --state` semantic mismatch | Medium-high | High | TASK-015 validation + TASK-029 fallback |
| Orphan SQLite row OR orphan state.json | Medium | High | Reconciliation pass at startup + every N polls (TASK-028) |
| Shell-injection via request_id in git/gh commands | Low | High | Single-quote args + regex enforcement (TASK-030) |
| Retry-budget exhaustion → infinite loop | Medium | High | `MAX_RETRIES_PER_PHASE=3` + `failed` terminal state (TASK-031) |

---

## Test matrix (24 tests across unit / integration / E2E / bats)

| Test | Type | Verifies | AC |
|------|------|----------|----|
| `cli_adapter_initrouter.test.ts::initRouter_with_undefined_deps` | unit | Router resolves with all 3 deps undefined | AC-038-01 |
| `cli_adapter_initrouter.test.ts::submit_skips_nlp` | unit | Raw description → title when claudeClient undefined | AC-038-02 |
| `cli_adapter_initrouter.test.ts::submit_skips_dedup` | unit | Same desc twice both succeed when duplicateDetector undefined | AC-038-03 |
| `state_json_writer.test.ts::atomic_pattern` | unit | SQLite-first + temp+rename | AC-038-05 |
| `state_json_writer.test.ts::path_traversal_guard` | unit | Rejects `..` / out-of-allowlist | AC-038-07 |
| `state_json_writer.test.ts::schema_compliance` | unit | Generated state.json passes `validate_state_file()` | AC-038-06 |
| `state_json_writer.test.ts::phase_overrides_present` | unit | `phase_overrides: []` always included | SUGGESTION-1 |
| `resolve_agent.bats` | bats | All 12 phase→agent mappings | AC-038-10 |
| `dispatch_phase.bats` | bats | Reads `current_phase` (not `.status`); delegates to spawn_session_typed | AC-038-11 |
| `advance_phase.bats::success_path` | bats | prd→prd_review with status=gate | AC-038-13 |
| `advance_phase.bats::review_failure` | bats | prd_review fail → prd with feedback | AC-038-14 |
| `advance_phase.bats::missing_result` | bats | Missing phase-result.json → pass + WARN | AC-038-14 |
| `advance_phase.bats::retry_exhausted` | bats | After MAX_RETRIES → `failed` | TASK-031 |
| `reconcile_orphans.bats` | bats | Orphan SQLite row marked `cancelled`; orphan state.json logged | TASK-028 |
| `portal_request_action_write.bats` | bats | Every transition writes portal file atomically | AC-038-16 |
| `portal_waitedMin.bats` | bats | gate_entered_at → correct waitedMin after restart | TASK-019 |
| `submit_to_state.test.ts` | integration | Full CLI→SQLite+state.json | AC-038-08 |
| `daemon_picks_up_state_file.test` | integration | `select_request()` finds new state | AC-038-08 |
| `intake_to_prd.test` | integration | Auto-transition queued/intake → running/prd | AC-038-09 |
| `agent_dispatch_command_assembly.test` | integration | `spawn_session_typed` builds correct argv | AC-038-11 |
| `phase_result_synthesis.test` | integration | wrapper synthesizes on missing result | TASK-014 |
| `concurrency_fifo.test` | integration | Multi-submit processed in FIFO order | OQ-039-4 |
| `timeout_handling.test` | integration | 30-min wall-clock terminates hung session | OQ-039-3 |
| `smoke_e2e.sh` | E2E | Submit → daemon → PRD phase → `docs/prd/*.md` artifact | AC-038-19 |

---

## Recommended PR strategy

The 31 tasks split naturally into **5 PRs** mapped to tracks + sequencing:

1. **PR-1: Submit handler + state.json** (Track A + research) — TASK-001, 002, 003, 004, 015, 023, 028, 030, 005, 006, 007, 031
2. **PR-2: Daemon dispatch foundation** (Track B early) — TASK-008, 009, 010, 011, 016, 026, 029
3. **PR-3: State machine + transition** (Track B late) — TASK-012, 013, 014, 017, 025
4. **PR-4: Portal sync** (Track C) — TASK-018, 019, 024
5. **PR-5: Smoke E2E + docs** (Track D close) — TASK-020, 022, 027

---

## Definition of done

PLAN-039 is complete when **all 20 acceptance criteria from PRD-019** (AC-038-01..AC-038-20) are green AND:

- [ ] All 31 tasks marked completed
- [ ] All 6 Open Questions resolved (OQ-039-1..6)
- [ ] CI: typecheck, lint, unit, integration, bats all pass
- [ ] Smoke E2E (`bash test/e2e/smoke-e2e.sh`) exits 0 in mock mode
- [ ] Real-API smoke run executed at least once and produced a `docs/prd/*.md` artifact in a test repo
- [ ] `git grep TODO.PLAN-011-1` returns nothing (the originating TODO comment is gone)
- [ ] `autonomous-dev request submit "..." --repo /path/to/test/repo --type feature` succeeds and the daemon advances the request through at least the PRD phase

---

## Provenance

Synthesized from 3 parallel planning agents dispatched 2026-05-11:

- **Feature Decomposition** agent: 27 tasks across 4 tracks, 54h total, 28h critical path
- **Technical Architecture** agent: 5 issues — orphan reconciliation (CRITICAL), `claude --state` validation (CRITICAL), shell-escape (MEDIUM), phase-result reliability (MEDIUM), terminal state (MINOR)
- **Risk & Testing** agent: 24-test matrix, 8-risk register, 6 open questions

Architectural concerns from Agent 2 promoted to explicit tasks (028, 029, 030, 031). All 6 open questions surfaced as plan-level blockers with named resolution paths. Total task count rose from Agent 1's 27 to PLAN-039's 31.

**Source documents**:
- `plugins/autonomous-dev/docs/prd/PRD-019-intake-to-deploy-e2e-pipeline.md` (v1.1, APPROVED)
- `plugins/autonomous-dev/docs/tdd/TDD-038-intake-to-deploy-e2e-pipeline.md` (v1.1, APPROVED 2026-05-12)

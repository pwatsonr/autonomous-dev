# SPEC-039-2-08: Apply `claude --state` research outcome

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-029
- **Dependencies**: SPEC-039-2-01, SPEC-039-2-03
- **Estimated effort**: 2 hours (worst case; 0.5h if Scenario A)
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

Apply the outcome of SPEC-039-2-01 (the research artifact). If Scenario A held (`--state` accepts arbitrary JSON): no code change, just close OQ-039-1 in PLAN-039 notes. If Scenario B/C: update `spawn_session_typed()` to use `--prompt <phase-prompt-file>` AND ensure the daemon writes the phase prompt to a side file the agent reads, OR have the agent open `state.json.current_phase_metadata.phase_prompt` via Read tool.

## Acceptance Criteria

1. Phase prompt reaches the agent regardless of `--state` semantics.
2. Code path matches the research outcome (Scenario A: no change; Scenario B/C: documented fallback applied).
3. If TDD-038 §6.2 needed amending, the amendment lands as a doc-PR linked from this spec.
4. End-to-end smoke run (SPEC-039-4-01) proves the agent sees the phase context.

## Implementation

**Scenario A (no change)**
- `dispatch_phase_session()` continues to pass `--state <state.json>`.
- This spec is a no-op except for closing OQ-039-1.

**Scenario B (JSONL only)**
- Modify `spawn_session_typed()` to invoke `claude --agent <name> --prompt-file <phase-prompt-file>`.
- `dispatch_phase_session()` writes `<requests-dir>/<id>/phase-prompt-<phase>.txt` containing the phase prompt text + an instruction "Read state.json for full request context".
- The agent reads `state.json` via the Read tool — no agent-spec change needed because all agents already have Read.

**Scenario C (other constraint)**
- Document specific shape in the research artifact and choose the closest fallback (likely a hybrid of A + B).

**Files modified (Scenario B/C)**
- `plugins/autonomous-dev/bin/spawn-session.sh`
- `plugins/autonomous-dev/bin/supervisor-loop.sh`
- (No agent-spec changes — preserves Non-Goal)

**TDD amendment (if Scenario B/C)**
- Update TDD-038 §6.2 with the new invocation shape, linked from PR.

## Tests

**Files extended**
- `plugins/autonomous-dev/tests/bats/dispatch_phase.bats` — re-run with the chosen path; assert prompt reaches the agent (verify via captured `claude` argv when `CAPTURE_SPAWN_TO` set).

**Test cases**
1. `agent_sees_phase_prompt_in_captured_argv` — argv contains either `--state .../state.json` (Scenario A) or `--prompt-file .../phase-prompt-prd.txt` (Scenario B).
2. `agent_sees_state_via_read_tool` (Scenario B/C only) — bind-mounted agent stub reads state.json and emits expected sentinel.

## Verification

- `bash -n bin/spawn-session.sh bin/supervisor-loop.sh`
- `bats tests/bats/dispatch_phase.bats`
- Run SPEC-039-4-01 smoke test; assert PRD artifact produced.

## Open Questions resolved

- OQ-039-1 — resolved by this spec's chosen path.

## Amendment (PRD-020)

The real `claude` CLI contract is `claude --print --output-format json --agent <name> --add-dir <req_dir> --add-dir <project> --permission-mode bypassPermissions --max-budget-usd <amt> "<prompt>"` (no `--state`/`--bug-context-path`/`--expedited`/`--max-turns`/`--prompt`/`--project-directory`) — see `docs/research/RESEARCH-039-claude-state-semantics.md`. (`bypassPermissions` per B-12.)

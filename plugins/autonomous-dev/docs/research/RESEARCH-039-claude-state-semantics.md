# RESEARCH-039: `claude --state` semantics

| Field | Value |
|-------|-------|
| **Research ID** | RESEARCH-039 |
| **Resolves** | OQ-039-1 (PLAN-039) |
| **Blocks** | TASK-009, TASK-014, TASK-029 (SPEC-039-2-03, -2-07, -2-08) |
| **Date** | 2026-05-12 |
| **`claude` version tested** | 2.1.139 (Claude Code) |

## Question

TDD-038 §6.2 assumes the daemon can invoke `claude --agent <name> --state <state.json>` to pass the per-request `state.json` metadata into the agent session. Is `--state <file>` a real flag, and does it accept arbitrary JSON metadata?

## Method

```
claude --help
```
Searched the full flag list for `--state`, `--session-id`, `--resume`, `--continue`, `--input-format`, `--system-prompt`, and related context-passing flags.

## Result — **Scenario B (no `--state` flag exists)**

`claude --help` (v2.1.139) has **no `--state` flag**. The relevant context-passing flags that DO exist:

| Flag | Purpose |
|------|---------|
| `-r, --resume [session-id]` | Resume a prior conversation by session id (conversation-state JSONL, not arbitrary metadata) |
| `-c, --continue` | Continue the most recent conversation in the cwd |
| `--session-id <uuid>` | Use a specific session id for the conversation |
| `--fork-session` | When resuming, fork to a new session id |
| `--system-prompt <prompt>` / `--system-prompt-file` | Replace the system prompt |
| `--append-system-prompt <prompt>` / `--append-system-prompt-file` | Append to the system prompt |
| `-p, --print` | Non-interactive; prompt comes via positional arg or stdin |
| `--input-format text\|stream-json` | Input format for `--print` |
| `--add-dir <dirs...>` | Grant tool access to additional directories |
| `--agent <agent>` | Select the agent (this part of the TDD assumption IS valid) |
| `--bug-context-path <path>` | **Not present in `claude --help`** — see "Pre-existing bug" below |

Conclusion: `--state` and `--bug-context-path` are **not** `claude` CLI flags. The TDD-038 §6.2 design as written would fail at runtime with an "unknown option" error.

## Pre-existing bug discovered

`plugins/autonomous-dev/bin/spawn-session.sh` (lines 81, 138, 140, current `main`) already passes `--state "${state_file}"` to `claude`, and lines 57/130 pass `--bug-context-path "${state_file}"`. **Neither flag exists** — so `spawn_session_typed()` would fail on any real (non-`CAPTURE_SPAWN_TO`) invocation. This has been masked because the daemon's dispatch path was never wired (the very gap PRD-019 closes), so `spawn_session_typed()` has only ever run in capture/test mode.

This means TASK-029 (SPEC-039-2-08) is **not optional** — it must replace the `--state` / `--bug-context-path` flags with a working mechanism before the daemon can dispatch a real session.

## Recommended approach for TASK-009 / TASK-029

Use **`--print` + positional prompt + `--add-dir`**, with the phase prompt naming the state file path:

```bash
claude --print \
       --agent "${agent}" \
       --add-dir "$(dirname "${state_file}")" \
       --append-system-prompt-file "${phase_prompt_file}" \
       "Read your request context from ${state_file}, then perform the ${phase} phase. \
        Write your phase result to ${result_file} as JSON: {status, feedback?, artifacts?, next_phase?}."
```

Rationale:
- `--add-dir` ensures the agent's Read tool can open `state.json` even though it lives outside the agent's cwd.
- The phase prompt (the existing `resolve_phase_prompt()` output) goes into `--append-system-prompt-file` OR the positional prompt — either works; positional is simplest.
- No agent-spec changes needed: every agent already has the Read tool (preserves the PRD Non-Goal).
- The `--bug-context-path` rule (bug + tdd) collapses into the same mechanism: the prompt mentions the state file, and `state.json` already carries the bug context fields.
- For `CAPTURE_SPAWN_TO` mode, the captured argv changes shape — the bats snapshot tests in `test_spawn_session_flags.bats` must be re-baselined as part of TASK-029.

Alternative considered and rejected: `--resume <session-id>` — wrong semantics (it replays a conversation JSONL, not metadata) and would require the daemon to pre-create a session, adding complexity for no benefit.

## Impact on TDD-038

TDD-038 §6.2 needs a one-paragraph amendment replacing `--state <file>` with the `--print` + `--add-dir` + prompt mechanism above. Filed as a follow-up doc-PR (referenced from SPEC-039-2-08). The rest of §6.2 (agent selection via `--agent`, the phase-to-agent table, the 30-min `timeout` wrapper) is unaffected.

## Full flag audit (PR-2)

Survey of actual `claude --help` (v2.1.139) revealed these bogus flags in existing code:

### Bogus flags in current codebase

| Function | File | Line | Bogus Flag | Status |
|----------|------|------|------------|--------|
| `spawn_session()` | `bin/supervisor-loop.sh` | ~1035 | `--max-turns`, `--project-directory`, `--prompt` | Invalid |
| `spawn_session_typed()` | `bin/spawn-session.sh` | 81, 138, 140 | `--state`, `--bug-context-path`, `--expedited` | Invalid |

### Corrected canonical invocation

The working `claude` invocation for phase dispatch is:

```bash
claude --print --output-format json \
       --agent "${agent}" \
       --add-dir "${req_dir}" --add-dir "${project}" \
       --permission-mode acceptEdits \
       --max-budget-usd "${phase_budget}" \
       "${phase_prompt}"
```

Where:
- `req_dir` = `dirname(state_file)` (makes state.json readable via Read tool)
- `project` = project root (makes codebase readable)
- `phase_prompt` = positional arg containing instructions to Read state.json and perform the phase
- `phase_budget` = per-phase cost cap (replaces `--max-turns`)

### Flag mapping changes

| Old (bogus) | New (working) | Notes |
|-------------|---------------|-------|
| `--state <file>` | `--add-dir <dirname>` + prompt mentions file | State data via Read tool |
| `--bug-context-path <file>` | (collapsed) | Bug fields already in state.json |
| `--expedited` | `--append-system-prompt "Expedited..."` | When expedited + review phase |
| `--max-turns <N>` | `--max-budget-usd <amount>` | Cost capping via budget |
| `--prompt <text>` | positional arg | Prompt as final argument |
| `--project-directory <dir>` | `--add-dir <dir>` | Directory access |

### Snapshot fixture impact

The bats snapshot fixtures (`tests/fixtures/snapshots/spawn-*.txt`) were re-baselined as part of PR-2 to reflect the corrected command shape. The old snapshots expected `--state` and `--bug-context-path`; the new ones show `--add-dir` and `--max-budget-usd`.

### Amendment requirement

TDD-038 §6.2 + SPEC-039-2-01/02/03/08 need a follow-up amendment doc-PR to match the corrected claude flags discovered in this audit.

## Status

- OQ-039-1: **RESOLVED** — `--state` does not exist; use `--print` + positional prompt + `--add-dir`.
- Action item: TASK-029 is now mandatory (not conditional) and must also re-baseline `test_spawn_session_flags.bats`.
- Action item: TDD-038 §6.2 amendment doc-PR.

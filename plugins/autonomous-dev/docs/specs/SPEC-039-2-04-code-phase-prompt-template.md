# SPEC-039-2-04: Code-phase prompt template

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-010, TASK-011
- **Dependencies**: SPEC-039-2-02
- **Estimated effort**: 2.5 hours
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

(1) Fix the `${status}` → `${phase}` variable-name typo in `resolve_phase_prompt()`'s code-phase guard that, uncorrected, causes the code-phase prompt's branch/commit/PR instructions to never be appended (TASK-010 from TDD MINOR). (2) Append the code-phase-specific instructions (TASK-011): `autonomous/<request-id>` branch, conventional commits, `gh pr create`, write PR URL to `phase-result.json.artifacts[]`. Per TDD MAJOR-3, the content lives in the phase-prompt template — NOT in any agent spec (preserves the "no agent-spec changes" Non-Goal).

## Acceptance Criteria

1. `resolve_phase_prompt()` correctly tests against `${phase}` (or the actual local variable, fixed if different).
2. (AC-038-12) When phase == `code`, the resolved prompt contains: branch instruction, conventional-commit instruction, `gh pr create` instruction, and instruction to write PR URL to `phase-result.json.artifacts[]`.
3. No changes to any file under `agents/*.md` (Non-Goal preserved).
4. Single-quoted request_id in branch and PR head ref (consumed by SPEC-039-1-05).

## Implementation

**Files modified**
- `plugins/autonomous-dev/bin/supervisor-loop.sh` — `resolve_phase_prompt()` only.

**Template content (code phase append)**
- Append after the base phase prompt:
  - "Create branch `autonomous/<request-id>` (single-quoted in any shell command)."
  - "Make commits using Conventional Commits format (`feat:`, `fix:`, `docs:`, etc.)."
  - "When implementation is done: `gh pr create --base main --head 'autonomous/<request-id>' --title <conventional-title> --body <summary>`."
  - "Write the resulting PR URL into `phase-result.json.artifacts[].url` with `kind: 'github_pr'`."

**Variable-typo fix** — exact line(s) discovered during implementation; the bug is described in TDD-038 review MINOR. The fix is a one-char-ish edit but covered by the new bats test in this spec to prevent regression.

## Tests

**Files created/extended**
- `plugins/autonomous-dev/tests/bats/code_phase_prompt.bats` (new).

**Test cases**
1. `code_phase_prompt_contains_branch_instruction` — phase=`code` → prompt contains `autonomous/REQ-` substring (AC-038-12).
2. `code_phase_prompt_contains_pr_instruction` — prompt contains `gh pr create`.
3. `code_phase_prompt_contains_artifact_instruction` — prompt mentions `phase-result.json` AND `artifacts`.
4. `non_code_phase_lacks_code_instructions` — phase=`prd` → no `gh pr create` in prompt.
5. `regression_guard_variable_name` — assert the code-phase block runs by deliberately wiring an injected sentinel string; absence indicates the variable-typo regression.

## Verification

- `bash -n bin/supervisor-loop.sh`
- `bats tests/bats/code_phase_prompt.bats`
- Spot check: `grep -A5 "code)" bin/supervisor-loop.sh` shows the appended template lines.

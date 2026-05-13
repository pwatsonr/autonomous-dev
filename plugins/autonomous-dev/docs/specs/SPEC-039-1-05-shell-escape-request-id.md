# SPEC-039-1-05: Shell-escape request_id in git + gh

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-030
- **Dependencies**: SPEC-039-2-04
- **Estimated effort**: 1 hour
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

Address Architecture-review MEDIUM finding: although the request_id regex `^REQ-\d{6}$` allows no shell metacharacters, defense-in-depth requires single-quoted args and regex validation at the prompt-template construction site (the failure mode being: a future change loosens the regex and re-opens injection).

## Acceptance Criteria

1. The code-phase prompt template wraps `request_id` substitutions in single quotes (`'REQ-NNNNNN'`).
2. `resolve_phase_prompt()` validates `request_id` against `^REQ-[0-9]{6}$` BEFORE substitution; on mismatch returns empty + logs ERROR.
3. `dispatch_phase_session()` validates `request_id` early and returns a hard failure rather than calling resolve_phase_prompt with bad input.
4. `shellcheck bin/supervisor-loop.sh` reports zero new findings related to quoting around `${request_id}`.

## Implementation

**Files modified**
- `plugins/autonomous-dev/bin/supervisor-loop.sh` — `resolve_phase_prompt()` and `dispatch_phase_session()`.

**Validation function**
```bash
validate_request_id() {
  local id="$1"
  [[ "$id" =~ ^REQ-[0-9]{6}$ ]]
}
```

**Resolve-phase-prompt code-branch (excerpt)**
- For phase `code`, the appended template must contain `'autonomous/REQ-NNNNNN'` (single-quoted) for the `git checkout -b` line.
- `gh pr create --head 'autonomous/REQ-NNNNNN' --title ...` — single-quoted head ref.
- PR title body construction never interpolates raw `${request_id}` outside quotes.

**Defense-in-depth**
- Add `set -o noglob` scope (or `--` separator) around any `git`/`gh` invocation that takes user-derivable values.
- Document in the function header comment that request_id format is guaranteed by upstream validation AND re-validated here.

## Tests

**Files created**
- `plugins/autonomous-dev/tests/bats/shell_escape.bats`

**Test cases**
1. `valid_request_id_accepted` — `REQ-123456` passes; generated prompt contains `'autonomous/REQ-123456'`.
2. `invalid_request_id_rejected` — values containing `;`, `$()`, backticks, spaces, or non-conforming format produce empty output + ERROR log.
3. `template_uses_single_quotes` — grep generated prompt for double-quoted request_id; assert absent.
4. `dispatch_validates_early` — `dispatch_phase_session "bad-id"` returns nonzero before reaching `resolve_phase_prompt`.

## Verification

- `bash -n bin/supervisor-loop.sh`
- `shellcheck bin/supervisor-loop.sh`
- `bats tests/bats/shell_escape.bats`

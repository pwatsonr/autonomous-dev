# SPEC-018-3-05: Test Suite — Unit, Interactive, and End-to-End

## Metadata
- **Parent Plan**: PLAN-018-3
- **Tasks Covered**: Task 8 (CLI parsing/validation unit tests), Task 9 (interactive flow unit tests), Task 10 (E2E bug submission → TDD generation)
- **Estimated effort**: 9.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-018-3-05-tests-unit-interactive-e2e.md`

## Description
Lock in the behavior delivered across SPEC-018-3-01 through SPEC-018-3-04 with three layers of automated tests: (1) unit tests for CLI parsing and validation across the type enum and bug-context rejection paths, (2) unit tests for the `submit-bug` interactive prompt flow using a mock TTY, (3) one end-to-end test that submits a bug via CLI, runs the supervisor for one iteration with mocked Claude responses, and asserts the TDD-author produced a bug-template TDD with `bug_context` intact in state. Coverage target is ≥90% on every CLI file modified by PLAN-018-3.

The unit tests run in CI on every PR. The E2E test runs in CI but uses mocked Claude responses to keep the run free, deterministic, and offline.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/cli/test-request-submit-types.test.ts` | Create | All five types accepted, invalid rejected, bug-context required, immutability |
| `plugins/autonomous-dev/tests/cli/test-submit-bug-interactive.test.ts` | Create | Mock-TTY interactive flow, abort, validation rejection, non-interactive flag mode |
| `plugins/autonomous-dev/tests/e2e/test-bug-end-to-end.test.ts` | Create | Bug CLI → daemon iteration → TDD-author → bug template TDD |
| `plugins/autonomous-dev/tests/fixtures/bug-fixture.json` | Create | Canonical valid `BugReport` payload reused across all three suites |
| `plugins/autonomous-dev/tests/fixtures/mock-claude-bug-tdd.txt` | Create | Fixed TDD response for the E2E mock |
| `plugins/autonomous-dev/package.json` | Modify | Add `inquirer-test@^3.0.0` devDep for interactive testing |

## Implementation Details

### Test Runner

All tests use the project's existing Vitest setup. No new framework introduced. Vitest's `describe`/`it`/`expect` plus `vi.mock` for mocking the intake router client and Claude SDK.

### `test-request-submit-types.test.ts`

Test cases (each its own `it` block):

| # | Case | Assertion |
|---|------|-----------|
| 1 | `--type feature` | exit 0, payload has `request_type: 'feature'` |
| 2 | `--type bug --bug-context-path <valid>` | exit 0, payload has `request_type: 'bug'`, `bug_context` populated |
| 3 | `--type infra` | exit 0, `request_type: 'infra'` |
| 4 | `--type refactor` | exit 0, `request_type: 'refactor'` |
| 5 | `--type hotfix` | exit 0, `request_type: 'hotfix'` |
| 6 | `--type xyz` | exit 1, stderr exactly `Error: invalid type 'xyz'. Valid: feature, bug, infra, refactor, hotfix` |
| 7 | no `--type` | exit 0, `request_type: 'feature'` (default) |
| 8 | `--type bug` (no context) | exit 1, stderr exactly `Error: bug-typed requests require bug context. Use 'autonomous-dev request submit-bug' or pass --bug-context-path <file>` |
| 9 | `--type bug --bug-context-path /missing` | exit 1, stderr `Error: bug context file not found: /missing` |
| 10 | `--type bug --bug-context-path <invalid-json>` | exit 1, stderr `Error: bug context file is not valid JSON: <path>` |
| 11 | `--type bug --bug-context-path <fails-schema>` | exit 1, stderr starts `Error: bug context validation failed:` and includes AJV path |
| 12 | `--help` | exit 0, stdout contains all five values: `feature`, `bug`, `infra`, `refactor`, `hotfix` |
| 13 | `request edit REQ-... --type infra` (currently bug) | exit 1, stderr `Error: request_type is immutable after submission`, audit event written |
| 14 | `request edit REQ-... --priority high` | exit 0, priority persisted, no rejection event |

Cases 8 and 13 assert error text **character-for-character** (no slack on whitespace, capitalization, or punctuation).

### `test-submit-bug-interactive.test.ts`

Use `inquirer-test` to drive the interactive prompts with a scripted answer sequence.

Test cases:

1. **Happy path interactive**: scripted answers for all 13 prompts; assert resulting payload matches the fixture; assert exit 0.
2. **Abort on Ctrl-C**: simulate `SIGINT` after the title prompt; assert exit 130, stderr ends with `Cancelled — no request submitted.`, no state file written.
3. **Empty repro_steps re-prompt**: first answer to `reproduction_steps` is empty; assert prompt re-issued with `At least one reproduction step is required`; second answer succeeds.
4. **Validation rejection on title length**: scripted title is 201 chars; assert prompt re-issued with length error.
5. **Severity defaults**: skip the severity prompt by accepting default; assert payload has `severity: 'medium'`.
6. **Optional fields skipped**: skip `affected_components`, `labels`, `user_impact`; assert payload has those fields absent (not `undefined`, not `null`).
7. **Non-interactive flag mode**: stdin closed; provide all required flags; assert no prompt issued; payload matches fixture; exit 0.
8. **Non-interactive missing required flag**: provide all flags except `--title`; assert exit 1, stderr starts `Error: bug report validation failed:`.
9. **Repeatable flags**: pass `--repro-step "1" --repro-step "2" --repro-step "3"`; assert `reproduction_steps: ["1","2","3"]` in order.
10. **Auto-detected env defaults**: in interactive mode, accept defaults for `environment.os` etc.; assert payload contains `process.platform`-derived OS string and `node ${process.version}` runtime.

### `test-bug-end-to-end.test.ts`

End-to-end harness:

1. **Setup**: spin up an isolated test workspace under `/tmp/autonomous-dev-e2e-<uuid>`. Initialize an empty `.state.json` and an empty audit log.
2. **Mock Claude SDK**: intercept all SDK calls; return the contents of `tests/fixtures/mock-claude-bug-tdd.txt` for any `tdd-author` invocation. Assert the SDK was invoked with `--bug-context-path` flag pointing to the test workspace's state file.
3. **Submit bug**: invoke `autonomous-dev request submit-bug --repo /tmp/.../e2e --title T --description D --repro-step S --expected E --actual A` non-interactively.
4. **Run supervisor for one iteration**: `autonomous-dev daemon iterate --once --test-mode`. This triggers the daemon's `select_request` (PLAN-018-2) which routes the bug to tdd-author with the right flag.
5. **Assertions**:
   - Request advanced from `intake` to `tdd` state.
   - A TDD file was written to the workspace.
   - The TDD's first H1 heading is exactly `# Bug Analysis Summary`.
   - No PRD file was written anywhere in the workspace.
   - `bug_context` survives intact in `.state.json` (deep-equal to the originally submitted `BugReport`).
   - The Claude SDK mock recorded an invocation with `--bug-context-path` set; the path resolves to a JSON file containing the same `bug_context`.
   - Total mocked-Claude cost is `0` (mocks return precomputed strings).

### Coverage Configuration

Update `vitest.config.ts` (or equivalent) to enforce a per-file 90% line coverage threshold on:
- `src/cli/commands/request-submit.ts`
- `src/cli/commands/submit-bug.ts`
- `src/cli/commands/request-edit.ts`
- `src/cli/lib/bug-prompts.ts`
- `src/cli/lib/bug-context-loader.ts`
- `src/types/bug-report.ts`

CI fails if any file falls below the threshold.

## Acceptance Criteria

- [ ] All 14 cases in `test-request-submit-types.test.ts` pass.
- [ ] Cases 6, 8, and 13 assert error strings **byte-exactly** (no `.toContain`; use `.toBe` or equivalent).
- [ ] All 10 cases in `test-submit-bug-interactive.test.ts` pass.
- [ ] Interactive tests run without spawning a real TTY (use `inquirer-test` or equivalent harness).
- [ ] Ctrl-C test asserts exit code is exactly 130.
- [ ] E2E test passes deterministically across 10 consecutive runs (no flake).
- [ ] E2E test asserts the TDD's first H1 is exactly `# Bug Analysis Summary` (string equality).
- [ ] E2E test asserts no PRD file exists anywhere under the test workspace after the iteration.
- [ ] E2E test asserts the Claude SDK mock was invoked with `--bug-context-path <path>` where the path resolves to a JSON file deep-equal to the originally submitted `bug_context`.
- [ ] Coverage report shows ≥90% line coverage on each of the 6 listed CLI files.
- [ ] CI fails the build if any covered file drops below 90%.
- [ ] `tests/fixtures/bug-fixture.json` validates clean against `schemas/bug-report.json` (asserted in a smoke test).
- [ ] No new test relies on network access; all are offline-runnable.

## Dependencies

- **Blocking**: SPEC-018-3-01, SPEC-018-3-02, SPEC-018-3-03 (the code under test).
- **Blocking**: PLAN-018-1 (state schema), PLAN-018-2 (daemon iterate `--test-mode` and `--bug-context-path` propagation).
- **Optional**: SPEC-018-3-04 (multi-channel parity test lives in its own file `tests/parity/test-multi-channel-bug-parity.test.ts`; not in scope here).
- `inquirer-test@^3.0.0` (new devDep).
- Vitest (existing).
- Existing Claude SDK mock harness (from prior plans' E2E scaffolding).

## Notes

- **No real Claude calls** in any test — the E2E mock returns a fixed string, keeping CI free and deterministic. Live-Claude smoke testing is a manual operator workflow documented in PLAN-018-3 testing strategy.
- The `inquirer-test` library is unmaintained but functional with `inquirer@9.x`; if it breaks in CI, the fallback is to test `bug-prompts.ts` by importing the prompt definitions directly and exercising their `validate` functions in isolation. That fallback is documented in the test file's comments.
- The 90% coverage threshold is a floor, not a ceiling. The PRD test for case 8 (the precise error message) is intentionally fragile — operators rely on that exact string for scripting, so any change must be deliberate and update both code and test.
- The E2E test workspace lives under `/tmp` and is cleaned up in an `afterEach` hook; on test failure the workspace path is logged so operators can inspect leftover state.
- Snapshot tests for the agent prompt's BUG MODE block and the bug template (referenced in SPEC-018-3-03) live in this spec's E2E test file as additional `it` blocks: one snapshot of `templates/tdd-bug.md`, one snapshot of the BUG MODE section extracted from `agents/tdd-author.md`. Snapshot review is part of PR review.
- Future spec: a separate "live smoke" test that exercises real Claude SDK calls with cost capped — out of scope here; tracked as a follow-up to PLAN-018-3.

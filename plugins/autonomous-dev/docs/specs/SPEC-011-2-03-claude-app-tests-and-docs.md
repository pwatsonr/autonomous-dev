# SPEC-011-2-03: Claude App Tests, Bridge Contract Documentation & Manual Verification

## Metadata
- **Parent Plan**: PLAN-011-2
- **Tasks Covered**: Task 6 (bridge contract documentation), Task 7 (unit tests for bridge error handling), Task 8 (integration test for command discovery), Task 9 (manual verification checklist)
- **Estimated effort**: 6.5 hours

## Description
Provide test coverage and authoritative documentation for the Claude App slash-command surface delivered by SPEC-011-2-01 and SPEC-011-2-02. Unit tests exercise every error path in `claude_command_bridge.ts` (missing modules, SQLite connection failures, version mismatch, unknown subcommands, malformed args). An integration test loads the plugin and asserts all 10 commands are discoverable. The bridge contract document (`docs/bridge_contract.md`) is the single source of truth that downstream channel adapters (Discord/Slack in PLAN-011-3/4) and external tooling depend on; it specifies the input command shape, output JSON schemas, env-var requirements, and exit-code semantics with at least one example pair per command.

A short manual-verification checklist closes the loop: load the plugin in Claude Code, walk through autocomplete, and verify the "bridge not built" path produces actionable messaging before and after `npm run build`.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `tests/unit/claude_command_bridge.test.ts` | Create | Jest unit tests covering all 6 error codes + happy path |
| `tests/integration/claude_commands.test.ts` | Create | Plugin-load integration test asserting all 10 commands discoverable |
| `tests/fixtures/bridge/missing_module/` | Create | Fixture directory simulating missing `intake/router` import |
| `tests/fixtures/bridge/locked_db.sqlite3` | Create | Read-only SQLite file used to provoke `DATABASE_CONNECTION` |
| `docs/bridge_contract.md` | Create | Bridge contract: input/output schemas, env vars, exit codes, 10 example pairs |
| `docs/manual_verification/PLAN-011-2.md` | Create | Manual-verification checklist for plugin reload + autocomplete |

## Implementation Details

### Task 7: Unit Tests (`tests/unit/claude_command_bridge.test.ts`)

Jest test suite. Each test invokes `main(argv)` directly (in-process) where possible; for tests that require subprocess behavior (env-var passing), use `child_process.spawnSync('node', [bridgePath, ...args], { env })`.

Required test cases:

| # | Name | Setup | Assert |
|---|------|-------|--------|
| 1 | `unknown subcommand returns exit 1 with UNKNOWN_SUBCOMMAND` | `main(['nonsense'])` | exit code 1, stdout JSON has `errorCode === 'UNKNOWN_SUBCOMMAND'` |
| 2 | `missing required arg returns exit 1 with INVALID_ARGUMENT` | `main(['status'])` (no request_id) | exit 1, `errorCode === 'INVALID_ARGUMENT'`, message names the missing arg |
| 3 | `unknown flag returns exit 1 with INVALID_ARGUMENT` | `main(['status', 'REQ-000001', '--bogus=x'])` | exit 1, `errorCode === 'INVALID_ARGUMENT'` |
| 4 | `MODULE_NOT_FOUND when router import fails` | Mock `IntakeRouter` import to throw `Error{code:'MODULE_NOT_FOUND', message:'Cannot find module ../router'}` | exit 2, `errorCode === 'MODULE_NOT_FOUND'`, `resolution` contains `npm install && npm run build` |
| 5 | `DATABASE_CONNECTION on SQLITE_ error` | Mock router handler to throw `Error{message:'SQLITE_CANTOPEN: unable to open'}` | exit 2, `errorCode === 'DATABASE_CONNECTION'`, `resolution` mentions DB path and permissions |
| 6 | `VERSION_MISMATCH when env disagrees with package.json` | Set `AUTONOMOUS_DEV_EXPECTED_VERSION='99.99.99'`, run any command | exit 2, `errorCode === 'VERSION_MISMATCH'`, `resolution` includes `npm run build` |
| 7 | `VERSION_MISMATCH skipped when env unset` | Unset `AUTONOMOUS_DEV_EXPECTED_VERSION`, run `submit --description=foo` | exit 0, no version error |
| 8 | `happy path returns CommandResult with stub data` | `main(['submit', '--description=hello'])` | exit 0, stdout JSON `ok === true`, `data.stub === true`, `data.subcommand === 'submit'` |
| 9 | `env-var pass-through populates IncomingCommand` | spawnSync with `CLAUDE_COMMAND_SOURCE=claude-app, CLAUDE_SESSION_ID=sess-42` | result `data.args` (or trace) reflects the session ID propagated through router |
| 10 | `INTERNAL_ERROR for unexpected exception` | Mock router handler to throw `new Error('boom')` | exit 2, `errorCode === 'INTERNAL_ERROR'`, message includes `'boom'` |

Use `jest.mock('../../intake/router', ...)` for cases 4, 5, 10. Cases 1–3, 6–8 run in-process without mocks. Case 9 requires `spawnSync` to capture environment propagation.

### Task 8: Integration Test (`tests/integration/claude_commands.test.ts`)

The test must:

1. Load the plugin's `commands/` directory and parse every `.md` file's YAML frontmatter (using a strict YAML parser like `js-yaml` in safe-load mode).
2. Assert exactly 10 files matching `commands/autonomous-dev-*.md`.
3. For each, assert the frontmatter contains:
   - `name` matching `^autonomous-dev-(submit|status|list|cancel|pause|resume|priority|logs|feedback|kill)$`
   - non-empty `description`
   - `arguments` array (may be empty for no-arg commands; here, all have at least one)
   - `allowed_tools` containing `Bash(bash:*)`
4. Assert `commands/_shared/bridge_proxy.sh` exists and is readable.
5. With the bridge intentionally unbuilt (delete `dist/` before this test or use a fixture pluginDir), spawn one of the proxy bodies (`commands/autonomous-dev-status.md`'s bash block) with `--request_id=REQ-000001` and assert exit code 2 with the documented "bridge not built" message on stderr.
6. After running `npm run build`, re-spawn the proxy with `--request_id=REQ-000001` and assert exit code 0 with stub-handler JSON on stdout.

The test must clean up after itself (no leftover `dist/` artifacts that affect later tests).

### Task 6: Bridge Contract Documentation (`docs/bridge_contract.md`)

Sections, in order:

1. **Overview** — one paragraph describing the bridge's role between Claude App `.md` commands and the IntakeRouter.
2. **Invocation** — `node dist/intake/adapters/claude_command_bridge.js <subcommand> [args...]`; required env vars (`CLAUDE_COMMAND_SOURCE`, `CLAUDE_SESSION_ID`); exit-code table.
3. **Input Schema** — TypeScript interface block reproducing `IncomingCommand` from SPEC-011-2-02.
4. **Output Schema (success)** — `CommandResult` interface; example JSON.
5. **Output Schema (error)** — `ErrorResponse` interface; the 6 `errorCode` values with their exit-code mapping.
6. **Environment Variables** — table:

   | Var | Required | Default | Purpose |
   |-----|----------|---------|---------|
   | `CLAUDE_COMMAND_SOURCE` | No | `claude-app` | Channel identifier |
   | `CLAUDE_SESSION_ID` | No | `unknown` | Correlates to the Claude Code session |
   | `AUTONOMOUS_DEV_EXPECTED_VERSION` | No | (unset → check skipped) | Version-pinning guard |
   | `AUTONOMOUS_DEV_DB` | No | `~/.autonomous-dev/intake.sqlite3` | SQLite DB path |

7. **Example Pairs** — for each of the 10 subcommands, provide:
   - Sample invocation: `node bridge.js submit --description='Refactor auth'`
   - Sample success output: `{"ok": true, "data": {...}}`
   - Sample failure output for one realistic error per command

8. **Exit Codes** — restate the table from SPEC-011-2-02.
9. **Versioning** — describe how `VERSION_MISMATCH` is detected and resolved.

### Task 9: Manual Verification (`docs/manual_verification/PLAN-011-2.md`)

A short, dated checklist for the engineer who lands the work. Each checklist item must have a bash command or specific UI step.

```markdown
# Manual Verification: PLAN-011-2

Run on macOS and Linux before marking PLAN-011-2 complete.

- [ ] `cd plugins/autonomous-dev && rm -rf dist`
- [ ] Reload the plugin in Claude Code (Cmd+Shift+P → "Plugins: Reload")
- [ ] In any thread, type `/autonomous-dev-` and confirm 10 entries appear
- [ ] Run `/autonomous-dev-submit description="hello"` — confirm "bridge not built" error with `npm install && npm run build` guidance
- [ ] Run `npm install && npm run build` in plugin directory
- [ ] Re-run `/autonomous-dev-submit description="hello"` — confirm success JSON with `data.stub === true`
- [ ] Run `/autonomous-dev-status` (no args) — confirm `INVALID_ARGUMENT` error naming `request_id`
- [ ] Run `/autonomous-dev-priority REQ-000001 urgent` — confirm `INVALID_ARGUMENT` error citing the priority enum
- [ ] Repeat all of the above on the other OS
```

## Acceptance Criteria

- [ ] `tests/unit/claude_command_bridge.test.ts` exists with all 10 test cases above; `npm test -- claude_command_bridge` passes
- [ ] Each of the 6 `errorCode` values is exercised by at least one unit test
- [ ] `tests/integration/claude_commands.test.ts` exists and asserts exactly 10 command `.md` files with correct frontmatter
- [ ] Integration test verifies the "bridge not built" → exit 2 path and the "after build" → exit 0 path
- [ ] Integration test cleans up generated `dist/` artifacts
- [ ] `docs/bridge_contract.md` exists with all 9 sections in the documented order
- [ ] Bridge contract includes one example pair per subcommand (10 pairs total)
- [ ] Bridge contract's `IncomingCommand`, `CommandResult`, `ErrorResponse` interfaces match SPEC-011-2-02 exactly (verified by a reviewer; ideally an automated diff in CI)
- [ ] Bridge contract's exit-code table matches SPEC-011-2-02
- [ ] `docs/manual_verification/PLAN-011-2.md` exists with the documented checklist
- [ ] Manual checklist is executed on macOS and Linux; results recorded in the PR description
- [ ] Test fixtures (`tests/fixtures/bridge/...`) are committed and used only by tests in this spec

## Dependencies

- SPEC-011-2-01 — supplies the 10 `.md` files and `bridge_proxy.sh` consumed by the integration test.
- SPEC-011-2-02 — supplies the bridge entrypoint, error classes, and IntakeRouter integration that the unit tests exercise; supplies the typed interfaces that the contract doc reproduces.
- Jest ≥ 29 (already in repo `package.json`).
- `js-yaml` (or equivalent strict YAML parser) — add as a dev dependency if not already present; the integration test parses frontmatter.
- `child_process.spawnSync` from Node stdlib — used for env-var pass-through tests.
- TDD-011 §6 — referenced by the contract document for cross-link to architectural intent.

## Notes

- The contract document is the load-bearing artifact for downstream PLAN-011-3 (Discord) and PLAN-011-4 (Slack); they will write adapters that produce `IncomingCommand` shapes matching what's documented here. Errors in this doc propagate. Treat it as production-grade prose, not internal notes.
- Avoid time-sensitive assertions in unit tests (no real `setTimeout`-based waits). Mock the clock if needed.
- Integration test's "rebuild and re-run" cycle is slow (~5–15 s). Mark it with Jest's `@long-running` tag if the project has one, so it can be skipped during fast feedback loops.
- The manual-verification checklist exists because some failure modes (Claude Code's plugin-discovery cache, OS-specific `node` resolution) are hard to assert programmatically. Do not delete it after one successful run.
- Test fixtures should be small and self-explanatory. The `locked_db.sqlite3` fixture should be created with `chmod 0444` in a `beforeAll` rather than committed pre-locked, since git does not preserve write bits perfectly across platforms.

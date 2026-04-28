# PLAN-011-1: CLI Dispatcher request-* Subcommands

## Metadata
- **Parent TDD**: TDD-011-multi-channel-intake-adapters
- **Estimated effort**: 2-3 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0

## Objective
Implement the CLI dispatcher extension for all 10 request management subcommands (submit, status, list, cancel, pause, resume, priority, logs, feedback, kill) with secure subprocess invocation, comprehensive validation, and TTY/color detection. Delivers the bash dispatcher routing layer and the TypeScript CLI adapter that processes commands through the existing IntakeRouter.

## Scope
### In Scope
- Add `request` case to main command switch in `bin/autonomous-dev.sh`
- Implement `cmd_request_delegate` bash function with regex validation for request IDs (`^REQ-\d{6}$`) and priority enums
- Implement TTY detection and `NO_COLOR` environment variable handling per Unix conventions
- Secure Node.js subprocess invocation via `execFile` pattern (no shell interpolation)
- Create `intake/adapters/cli_adapter.ts` with `commander.js` argument parsing for all 10 subcommands
- Wire CLI adapter to existing `IntakeRouter` with proper `IncomingCommand` construction
- Exit code semantics (0=success, 1=user error, 2=system error)
- Help text for `autonomous-dev request --help` per FR-804

### Out of Scope
- Claude App `.md` command stubs (PLAN-011-2)
- Discord/Slack service implementations (PLAN-011-3, PLAN-011-4)
- State persistence and handoff mechanism (PLAN-012-*)
- IntakeRouter modifications (consumed as-is)

## Tasks

1. **Extend bash dispatcher with `request` command routing** -- Add `request` case to main command switch in `autonomous-dev.sh`; implement `cmd_request_delegate` that validates subcommands and routes to Node.js execution.
   - Files: `bin/autonomous-dev.sh`
   - Acceptance: `autonomous-dev request submit "..."` routes to Node subprocess; unknown subcommand exits 1; `--help` works.
   - Effort: 1h

2. **Implement request ID validation in bash layer** -- Add `validate_request_id` enforcing `REQ-\d{6}` regex; apply to status/cancel/pause/resume/priority/logs/feedback subcommands.
   - Files: `bin/autonomous-dev.sh`
   - Acceptance: REQ-000001 passes; "invalid-id", REQ-12345 (5 digits), REQ-1234567 (7 digits) all rejected with format error.
   - Effort: 1h

3. **Implement priority enum validation** -- Validate priority values for the `priority` subcommand: `high|normal|low`.
   - Files: `bin/autonomous-dev.sh`
   - Acceptance: valid priorities pass; invalid value exits 1 with enum error listing valid values.
   - Effort: 0.5h

4. **Implement TTY and color detection** -- Check `NO_COLOR`, TTY connection, `--no-color` flag; export env vars for Node.js consumption.
   - Files: `bin/autonomous-dev.sh`
   - Acceptance: `NO_COLOR=1` disables color; piped stdout disables color; `--no-color` disables color; normal terminal enables color.
   - Effort: 1h

5. **Implement secure Node.js subprocess invocation** -- Use `execFile` pattern with explicit argument array (no shell interpretation) per TDD-011 §5.2.
   - Files: `bin/autonomous-dev.sh`
   - Acceptance: adversarial input `$(rm -rf /)` is treated as literal string; missing node command exits 2 with clear message.
   - Effort: 1.5h

6. **Create CLI adapter TypeScript skeleton** -- `intake/adapters/cli_adapter.ts` with `commander.js`-based argument parsing for all 10 request subcommands.
   - Files: `intake/adapters/cli_adapter.ts` (new)
   - Acceptance: compiles without errors; all 10 subcommands defined with proper argument schemas; `commander.js` help generation works.
   - Effort: 3h

7. **Implement IncomingCommand construction** -- Wire CLI adapter to construct proper `IncomingCommand` objects per TDD-011 §16.1; route through existing `IntakeRouter`.
   - Files: `intake/adapters/cli_adapter.ts`
   - Acceptance: each subcommand handler constructs `IncomingCommand` with correct shape; integration with `IntakeRouter` succeeds.
   - Effort: 2h

8. **Implement comprehensive argument validation** -- TypeScript-level validation for ISO dates, repo formats, priority; clear errors with exit code 1.
   - Files: `intake/adapters/cli_adapter.ts`
   - Acceptance: invalid `--deadline` rejected; invalid `--repo` format rejected; all errors use exit code 1.
   - Effort: 2h

9. **Implement help text and error UX** -- Comprehensive `--help` for parent and subcommands; consistent error formatting; correct exit codes.
   - Files: `bin/autonomous-dev.sh`, `intake/adapters/cli_adapter.ts`
   - Acceptance: `autonomous-dev request --help` shows complete usage; per-subcommand help works; consistent error messages.
   - Effort: 1.5h

10. **Write bash dispatcher tests** -- bats tests for validation, routing, subprocess invocation; mock environments for TTY detection.
    - Files: `tests/test_cli_dispatcher.bats` (new)
    - Acceptance: tests pass on macOS and Linux; cover regex validation, TTY detection, argument array construction.
    - Effort: 4h

11. **Write CLI adapter Jest tests** -- comprehensive Jest tests for argument parsing, validation, IncomingCommand construction, IntakeRouter integration.
    - Files: `tests/cli_adapter.test.ts` (new)
    - Acceptance: all 10 subcommands tested; mocked IntakeRouter integration; error handling verified.
    - Effort: 5h

## Test Plan

### Unit Tests
- Bash validation functions (request ID regex, priority enum)
- TTY detection across mock terminal environments
- Argument array construction (no shell interpretation)

### Integration Tests
- All 10 subcommands with various argument combinations
- IncomingCommand construction matches TDD-011 §16.1 schema
- Error propagation: validation errors at both bash and TS layers produce correct exit codes
- Help text completeness for main + all subcommands

### Security Tests
- Command injection prevention with adversarial inputs (`$(...)`, `; rm`, `|`, backticks)
- Argument sanitization before subprocess invocation
- Path traversal prevention in `--repo` argument

### End-to-End Tests
- Complete request submission flow from bash to IntakeRouter
- Color output suppression under various terminal conditions
- Error message clarity for common mistakes

## Acceptance Criteria

- [ ] All 10 request subcommands route from bash to TypeScript CLI adapter
- [ ] Request ID validation enforces `REQ-\d{6}` format
- [ ] Priority validation enforces enum (high|normal|low)
- [ ] TTY detection: NO_COLOR, --no-color, non-TTY all suppress color
- [ ] Node.js subprocess invocation uses execFile (no shell interpretation)
- [ ] CLI adapter constructs proper IncomingCommand objects
- [ ] Integration with existing IntakeRouter succeeds
- [ ] Exit codes follow Unix conventions
- [ ] Help text complete for `--help` at every level
- [ ] Security tests pass (no shell injection)
- [ ] All bats and Jest tests pass
- [ ] No TypeScript errors; no shellcheck warnings at `--severity=warning`

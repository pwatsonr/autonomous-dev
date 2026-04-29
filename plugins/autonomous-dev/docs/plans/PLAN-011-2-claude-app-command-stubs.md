# PLAN-011-2: Claude App .md Command Stubs and Command Bridge

## Metadata
- **Parent TDD**: TDD-011-multi-channel-intake-adapters
- **Estimated effort**: 2 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0

## Objective
Deliver 10 Claude Code slash commands (`.md` files) that proxy to the intake layer via an enhanced command bridge. Each command provides YAML frontmatter and a bash proxy script that invokes the TypeScript bridge. The bridge handles missing dependencies gracefully with clear installation guidance.

## Scope
### In Scope
- Create 10 `.md` slash command stubs in `commands/`: `autonomous-dev-{submit,status,list,cancel,pause,resume,priority,logs,feedback,kill}.md`
- YAML frontmatter per TDD-011 §6.2 (name, description, arguments, allowed_tools)
- Bash proxy body per TDD-011 §6.3 (Node.js subprocess invocation with error handling)
- Enhance `intake/adapters/claude_command_bridge.ts` per §6.4: ModuleNotFoundError handling, DatabaseConnectionError, version mismatch detection, "run npm install && npm run build" guidance
- Bridge contract documentation: input/output schemas, error format, environment variables
- Comprehensive error handling for bridge-not-built, missing dependencies, invalid arguments

### Out of Scope
- CLI dispatcher (PLAN-011-1)
- Discord/Slack services (PLAN-011-3, PLAN-011-4)
- State.json handoff (PLAN-012-*)
- IntakeRouter handler implementations

## Tasks

1. **Define shared frontmatter template and argument schemas** -- DRY frontmatter template for all 10 commands; argument schemas matching TDD-011.
   - Files: `commands/_shared/command_template.yaml`, `commands/_shared/arg_schemas.yaml` (new)
   - Acceptance: template covers name/description/arguments/allowed_tools; schemas match TDD-011 submit/status/list specs exactly.
   - Effort: 1h

2. **Create autonomous-dev-submit.md with full implementation** -- Reference example with both frontmatter and bash proxy body.
   - Files: `commands/autonomous-dev-submit.md` (new)
   - Acceptance: valid YAML with description/priority/repo/deadline arguments; proxy extracts basename, builds Node args, handles bridge errors; Claude Code discovers command on plugin reload.
   - Effort: 2h

3. **Generate remaining 9 command stub files** -- status/list/cancel/pause/resume/priority/logs/feedback/kill.
   - Files: 9 `.md` files in `commands/` (new)
   - Acceptance: each file has command-specific frontmatter (per TDD-011); identical bash proxy logic differing only in basename; all 10 commands appear in Claude Code slash command list.
   - Effort: 1.5h

4. **Implement shared bash proxy script template** -- Reusable bash logic for bridge path resolution, Node.js detection, error formatting, subprocess execution.
   - Files: `commands/_shared/bridge_proxy.sh` (new)
   - Acceptance: handles `PLUGIN_DIR` resolution, bridge path validation, Node.js dependency check, env-var passing (CLAUDE_COMMAND_SOURCE, CLAUDE_SESSION_ID), consistent exit codes (1=user error, 2=system error).
   - Effort: 1.5h

5. **Enhance claude_command_bridge.ts error handling** -- Per TDD-011 §6.4: ModuleNotFoundError, DatabaseConnectionError, version mismatch detection.
   - Files: `intake/adapters/claude_command_bridge.ts`
   - Acceptance: missing modules trigger "run npm install && npm run build" message with working directory; DB connection failures include SQLite path + permission guidance; version mismatch triggers rebuild instruction.
   - Effort: 2h

6. **Document bridge contract** -- input command format, output JSON schema, error response format, env-var requirements.
   - Files: `docs/bridge_contract.md` (new)
   - Acceptance: documents IncomingCommand interface, CommandResult/ErrorResponse schemas, required env vars, exit code semantics, example pairs for each command.
   - Effort: 1h

7. **Write unit tests for bridge error handling** -- Jest tests covering missing dependencies, malformed args, bridge-not-built scenarios.
   - Files: `tests/unit/claude_command_bridge.test.ts` (new)
   - Acceptance: ModuleNotFoundError produces correct error message; invalid arguments rejected before TS layer; missing bridge file returns exit 2 with installation guidance.
   - Effort: 2.5h

8. **Create integration test for command discovery** -- verify Claude Code discovers all 10 commands when plugin reloaded.
   - Files: `tests/integration/claude_commands.test.ts` (new)
   - Acceptance: test loads plugin, verifies 10 commands in registry; submit command with valid/invalid args triggers correct error path when bridge not built.
   - Effort: 3h

9. **Manual verification** -- load plugin in Claude Code, verify command discovery, test submit happy path and error scenarios.
   - Acceptance: all 10 commands in Claude Code autocomplete; submit with valid args returns "bridge not built" error with installation instructions; after npm install && build, commands reach TS layer.
   - Effort: 1h

## Test Plan

- **Unit:** bridge error handling, argument validation, env-var processing
- **Integration:** command discovery, proxy script execution, error formatting
- **Manual:** plugin reload, autocomplete verification, error message clarity
- **Failure modes:** missing Node.js, missing bridge file, malformed args, permission errors

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Claude Code plugin discovery mechanism changes | Low | High | Pin to known working version; CI tests with actual Claude Code |
| Node.js subprocess differs across macOS/Linux | Medium | Medium | Test on both platforms; use portable Node invocation |
| TypeScript build path varies | Low | Medium | Relative path resolution from plugin dir; fallback search paths |
| YAML frontmatter parsing strict | Medium | Low | Validate with strict parser in tests; minimal frontmatter |

## Acceptance Criteria

- [ ] 10 `.md` files in `commands/` with valid YAML frontmatter
- [ ] Each has bash proxy body that resolves bridge path and invokes Node.js
- [ ] `claude_command_bridge.ts` handles ModuleNotFoundError/DatabaseConnectionError
- [ ] Bridge provides clear "npm install && npm run build" guidance when not built
- [ ] Bridge contract documented (input/output schema, error format, env vars)
- [ ] All unit tests pass
- [ ] Integration tests verify command discovery
- [ ] Manual: all 10 commands in Claude Code autocomplete
- [ ] Error messages actionable with specific resolution steps
- [ ] Exit codes Unix-conventional
- [ ] No bash warnings at shellcheck `--severity=warning`

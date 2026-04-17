# PLAN-008-2: Claude App Native Adapter

## Metadata
- **Parent TDD**: TDD-008-intake-layer
- **Estimated effort**: 5 days
- **Dependencies**: PLAN-008-1 (core infrastructure)
- **Blocked by**: PLAN-008-1
- **Priority**: P0

## Objective

Implement the Claude App native adapter -- the first concrete channel adapter that wires the Claude Code plugin slash command system to the core IntakeRouter. This delivers the first end-to-end usable channel: operators can submit requests, view status, manage lifecycle, and receive terminal-formatted notifications entirely within the Claude Code CLI. This plan also validates the `IntakeAdapter` interface contract that Discord and Slack adapters will implement in subsequent plans.

## Scope

### In Scope
- `ClaudeAdapter` implementing the `IntakeAdapter` interface
- Registration of all 10 slash commands under the `autonomous-dev:` namespace (`submit`, `status`, `list`, `cancel`, `pause`, `resume`, `priority`, `logs`, `feedback`, `kill`)
- Command argument parser with quoted string, named flag (`--priority high`), and boolean flag (`--force`) support
- Request ID validation (`REQ-NNNNNN` regex)
- User identity resolution from OS user (`$USER` / `os.userInfo().username`) with auto-provisioning (first user = admin, subsequent = viewer)
- CLI notification formatter (ANSI escape codes for terminal rendering, progress bars, box-drawing characters)
- `ClaudeAdapter.sendMessage` implementation (terminal output)
- `ClaudeAdapter.promptUser` implementation (interactive terminal prompt with timeout)
- `ClaudeAdapter.start` and `shutdown` implementations
- Input validation (description length enforcement at adapter level)
- Wiring the adapter to `IntakeRouter` for full end-to-end flow
- Adapter-level unit tests
- End-to-end integration tests through the Claude App channel

### Out of Scope
- Discord adapter -- PLAN-008-3
- Slack adapter -- PLAN-008-4
- Notification engine (proactive push, digest) -- PLAN-008-5
- Conversation manager (bidirectional mid-pipeline communication) -- PLAN-008-5
- Rich formatters for Discord/Slack -- PLAN-008-3, PLAN-008-4
- `--as <identity>` impersonation flag (TQ-10, deferred)

## Tasks

1. **Implement ClaudeAdapter class** -- Core adapter class implementing `IntakeAdapter` interface per TDD section 3.2.
   - Files to create: `intake/adapters/claude_adapter.ts`
   - Acceptance criteria: Implements `start()`, `sendMessage()`, `promptUser()`, `shutdown()`. `channelType` is `'claude_app'`. `start()` registers all slash commands and returns a disposable `AdapterHandle`. `shutdown()` completes any in-flight command before resolving.
   - Estimated effort: 4 hours

2. **Register all slash commands** -- Define and register the 10 command definitions per TDD section 3.2 command table.
   - Files to create/modify: `intake/adapters/claude_adapter.ts`
   - Acceptance criteria: All commands registered with correct names (`autonomous-dev:submit`, etc.), argument definitions (name, type, required, description), and flag definitions (name, type, default, description). Commands are discoverable in the Claude Code slash command palette.
   - Estimated effort: 3 hours

3. **Implement argument parser** -- Parse raw command string into structured args and flags per TDD section 3.2.
   - Files to create: `intake/adapters/claude_arg_parser.ts`
   - Acceptance criteria: Tokenizer handles double-quoted strings (preserves spaces within quotes), `--flag value` pairs, boolean `--flag` (presence = true), positional arguments. `parseCommandArgs` returns `{ args: string[], flags: Record<string, string | boolean> }`. Handles edge cases: empty input, special characters, unclosed quotes (error), consecutive flags.
   - Estimated effort: 3 hours

4. **Implement user identity resolution** -- Map OS user to internal identity per TDD section 3.2.
   - Files to create: `intake/adapters/claude_identity.ts`
   - Acceptance criteria: Reads `os.userInfo().username`. Looks up `user_identities` table by `claude_user` column. If not found and no users exist, auto-provisions as `admin`. If not found and other users exist, auto-provisions as `viewer`. Returns internal user ID for the router.
   - Estimated effort: 2 hours

5. **Implement CLI notification formatter** -- ANSI terminal formatting per TDD section 3.2 status box example.
   - Files to create: `intake/notifications/formatters/cli_formatter.ts`
   - Acceptance criteria: Formats status as a box-drawing character bordered card with: request ID + title header, phase with progress bar (block characters), priority, age (human-readable duration), blocker, and artifact links. Supports `FormattedMessage` contract. Provides `fallbackText` as plain text without ANSI codes. Colors: green for success phases, blue for generation, orange for review, red for failures, yellow for paused.
   - Estimated effort: 4 hours

6. **Implement ClaudeAdapter.sendMessage** -- Render formatted messages to terminal.
   - Files to create/modify: `intake/adapters/claude_adapter.ts`
   - Acceptance criteria: Writes the `FormattedMessage.payload` (ANSI string) to stdout. Returns `DeliveryReceipt` with `success: true`. Falls back to `fallbackText` if terminal does not support ANSI.
   - Estimated effort: 1 hour

7. **Implement ClaudeAdapter.promptUser** -- Interactive terminal prompts with timeout.
   - Files to create/modify: `intake/adapters/claude_adapter.ts`
   - Acceptance criteria: Renders the prompt content and options (if any) to terminal. Waits for user input from stdin with configurable timeout. If timeout expires, returns `TimeoutExpired`. If user responds, returns `UserResponse` with content and optional `selectedOption`. For button-style options, displays numbered list and accepts number input.
   - Estimated effort: 3 hours

8. **Wire adapter to IntakeRouter** -- Connect command dispatch end-to-end.
   - Files to create: `intake/adapters/claude_command_bridge.ts`
   - Acceptance criteria: When a slash command is invoked, constructs `IncomingCommand` from parsed args/flags and `CommandSource` (channelType = `'claude_app'`, userId from identity resolver, timestamp = now). Passes to `IntakeRouter.route()`. Formats the `CommandResult` using the CLI formatter and outputs to terminal. Handles all error codes gracefully.
   - Estimated effort: 3 hours

9. **Implement input validation at adapter level** -- Per TDD section 3.12.2.
   - Files to create/modify: `intake/adapters/claude_adapter.ts`
   - Acceptance criteria: Description length enforcement (max 10,000 chars) runs before passing to router. Request ID format validation (`/^REQ-\d{6}$/`) on all commands that accept a request ID. Priority value validation (must be `high`, `normal`, or `low`). Repo format validation (`/^[\w.-]+\/[\w.-]+$/`). Deadline format validation (ISO-8601, must be in the future). Clear error messages for each validation failure.
   - Estimated effort: 2 hours

10. **Write adapter unit tests** -- Per TDD section 8.3.
    - Files to create: `intake/__tests__/adapters/claude_adapter.test.ts`, `intake/__tests__/adapters/claude_arg_parser.test.ts`, `intake/__tests__/adapters/claude_identity.test.ts`
    - Acceptance criteria: Arg parser tests: quoted strings, flags, edge cases (empty, special chars, unclosed quotes), all flag types. Identity resolver tests: first user auto-admin, subsequent auto-viewer, existing user lookup. Formatter tests: output contains box characters, progress bar renders correctly, colors applied, fallback text has no ANSI codes.
    - Estimated effort: 5 hours

11. **Write end-to-end integration tests** -- Full flow through Claude App adapter.
    - Files to create: `intake/__tests__/integration/claude_app_e2e.test.ts`
    - Acceptance criteria: Submit a request via adapter, verify request created in DB with correct fields, verify queue position returned. Status query returns formatted output. Pause/resume cycle works. Cancel with confirmation works. Priority change updates queue position. Kill requires admin and "CONFIRM". Feedback delivered to conversation messages table.
    - Estimated effort: 4 hours

## Dependencies & Integration Points

- **PLAN-008-1 (Core Infrastructure)**: All core components (IntakeRouter, AuthzEngine, RateLimiter, Sanitizer, NLP Parser, RequestQueue, Repository) must be complete.
- **Claude Code plugin system**: The adapter registers commands via the plugin slash command API. Must conform to the plugin's command registration contract (name, description, args, flags).
- **Terminal capabilities**: The CLI formatter needs to detect terminal ANSI support. Use `process.stdout.isTTY` and `process.env.TERM` for detection.

## Testing Strategy

- **Unit tests**: Direct function calls to the adapter components. Test arg parsing with diverse inputs. Test CLI formatter output strings for correct ANSI sequences and box-drawing characters. Test identity resolution with mocked database.
- **Integration tests**: Use real SQLite database. Invoke commands through the adapter, verify database state and terminal output. Mock stdin for `promptUser` tests.
- **No network mocking needed**: The Claude App adapter is entirely local -- no external API calls from the adapter itself (NLP parsing is in the core, already tested in PLAN-008-1).

## Risks

1. **Claude Code plugin API stability**: The slash command registration API may change between Claude Code versions. Mitigation: pin the plugin API version; isolate registration logic in a single function for easy updates.
2. **Terminal ANSI compatibility**: Not all terminals support the full ANSI escape code set (e.g., some Windows terminals, CI environments). Mitigation: fallback to plain text when `isTTY` is false; test with common terminals (iTerm2, Terminal.app, VS Code integrated terminal).
3. **Interactive prompt in non-interactive contexts**: If Claude Code is running in a non-interactive mode (piped input, background), `promptUser` cannot read stdin. Mitigation: detect non-interactive mode and auto-timeout with a logged warning.

## Definition of Done

- [ ] `ClaudeAdapter` implements all `IntakeAdapter` methods
- [ ] All 10 slash commands registered and discoverable in Claude Code command palette
- [ ] Argument parser handles quoted strings, named flags, boolean flags, and edge cases
- [ ] User identity auto-provisioned from OS user (first = admin, subsequent = viewer)
- [ ] CLI formatter renders ANSI box-drawing status cards with color-coded phases and progress bars
- [ ] `sendMessage` writes formatted output to terminal with ANSI fallback
- [ ] `promptUser` supports interactive input with timeout and option selection
- [ ] Full end-to-end flow works: submit -> status -> pause -> resume -> cancel -> kill
- [ ] Input validation rejects malformed request IDs, oversized descriptions, invalid priorities, bad repo formats, and past deadlines
- [ ] Unit tests pass for arg parser, identity resolver, and CLI formatter
- [ ] Integration tests pass for full lifecycle through the Claude App adapter
- [ ] Phase 1 exit criteria met: full submit-to-done lifecycle through Claude App with status updates, clarifying questions, pause/resume/cancel, rate limiting, and authorization

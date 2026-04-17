# SPEC-008-2-04: Command Bridge, Unit Tests & End-to-End Tests

## Metadata
- **Parent Plan**: PLAN-008-2
- **Tasks Covered**: Task 8, Task 10, Task 11
- **Estimated effort**: 12 hours

## Description

Implement the command bridge that wires Claude App slash commands to the IntakeRouter for full end-to-end flow, write the adapter-level unit tests, and write the end-to-end integration tests that verify the complete lifecycle through the Claude App channel.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/adapters/claude_command_bridge.ts` | Create |
| `intake/__tests__/adapters/claude_adapter.test.ts` | Create |
| `intake/__tests__/adapters/claude_arg_parser.test.ts` | Create |
| `intake/__tests__/adapters/claude_identity.test.ts` | Create |
| `intake/__tests__/integration/claude_app_e2e.test.ts` | Create |

## Implementation Details

### Task 8: Command Bridge

The bridge sits between the Claude Code slash command callback and the `IntakeRouter`. It translates raw command invocations into typed `IncomingCommand` objects and formats the results for terminal output.

```typescript
class ClaudeCommandBridge {
  constructor(
    private router: IntakeRouter,
    private identityResolver: ClaudeIdentityResolver,
    private argParser: typeof parseCommandArgs,
    private formatter: CLIFormatter,
    private validators: Record<string, ValidationFn>,
  ) {}

  async handleCommand(commandName: string, rawArgs: string): Promise<string> {
    // 1. Parse arguments
    const { args, flags } = this.argParser(rawArgs);

    // 2. Validate at adapter level
    const shortName = commandName.replace('autonomous-dev:', '');
    const validator = this.validators[shortName];
    if (validator) {
      try {
        validator(args, flags);
      } catch (err) {
        return this.formatter.formatError({
          success: false,
          error: err.message,
          errorCode: 'VALIDATION_ERROR',
        }).fallbackText;
      }
    }

    // 3. Resolve user identity
    const userId = await this.identityResolver.resolve();

    // 4. Construct IncomingCommand
    const command: IncomingCommand = {
      commandName: shortName,
      args,
      flags,
      rawText: rawArgs,
      source: {
        channelType: 'claude_app',
        userId,
        timestamp: new Date(),
      },
    };

    // 5. Route through IntakeRouter
    const result = await this.router.route(command);

    // 6. Format result
    if (result.success) {
      return this.formatSuccess(shortName, result);
    } else {
      return this.formatter.formatError(result as ErrorResponse).fallbackText;
    }
  }

  private formatSuccess(commandName: string, result: CommandResult): string {
    switch (commandName) {
      case 'submit':
        return this.formatter.formatSubmitSuccess(result.data).payload as string;
      case 'status':
        return this.formatter.formatStatusCard(result.data).payload as string;
      case 'list':
        return this.formatter.formatList(result.data).payload as string;
      default:
        return this.formatter.formatGenericSuccess(result).payload as string;
    }
  }
}
```

**Error handling in the bridge:**
- `ValidationError` from arg parser or validators -> formatted error with `VALIDATION_ERROR` code.
- `AuthzDenied` from router -> formatted error with `AUTHZ_DENIED` code.
- `RateLimited` from router -> formatted error with `RATE_LIMITED` code and retry time.
- Unexpected errors -> generic "An internal error occurred" message.

All errors are formatted via the `CLIFormatter` and returned as a string for terminal output.

### Task 10: Adapter Unit Tests

**`claude_adapter.test.ts`:**
- Test `start()` registers all 10 commands (mock plugin API).
- Test `shutdown()` sets `shuttingDown` flag and waits.
- Test `sendMessage()` writes to stdout (TTY and non-TTY).
- Test `promptUser()` with mocked stdin (response, timeout, non-interactive).

**`claude_arg_parser.test.ts`:**
- All test cases from SPEC-008-2-02 (23 cases).
- Additional edge cases: very long strings (10,000 chars), Unicode characters, empty quoted strings (`""`).

**`claude_identity.test.ts`:**
- Mock database.
- Test first user auto-admin provisioning.
- Test subsequent user auto-viewer provisioning.
- Test existing user lookup returns stored ID.
- Test OS username resolution from `os.userInfo()`.

### Task 11: End-to-End Integration Tests

**`claude_app_e2e.test.ts`:**

Uses a real in-memory SQLite database, real `IntakeRouter`, real `AuthzEngine`, real `RateLimiter`, mock NLP parser.

**Test scenarios:**

1. **Submit and verify DB state**: Submit via the bridge with `"Build user auth" --priority high --repo myorg/api`. Verify:
   - Request exists in DB with status `queued`, priority `high`, target_repo `myorg/api`.
   - Request ID matches `/^REQ-\d{6}$/`.
   - Queue position is 1.
   - Activity log has `request_submitted` entry.
   - Embedding stored.

2. **Status query**: Submit a request, then query status via bridge. Verify:
   - Output contains the request ID.
   - Output contains the current phase.
   - Output contains priority.

3. **Pause/resume cycle**: Submit, manually set to `active`, pause via bridge, verify status is `paused`. Resume via bridge, verify status is `active`.

4. **Cancel with confirmation**: Submit, manually set to `active`, cancel via bridge (first call returns confirmation prompt). Cancel again with confirmation (request cancelled). Verify status is `cancelled`.

5. **Priority change**: Submit (status `queued`), change priority to `high` via bridge. Verify priority updated and new queue position returned.

6. **Kill requires admin and CONFIRM**: As admin user, call kill without CONFIRM (returns prompt). Call kill with "CONFIRM" (all active requests paused).

7. **Feedback delivery**: Submit, set to `active`, send feedback via bridge. Verify `conversation_messages` table has the feedback entry.

8. **Viewer cannot submit**: Provision a viewer user. Attempt submit. Verify `AUTHZ_DENIED` error.

9. **Rate limit enforcement**: Submit 11 times rapidly (default 10/hour limit). Verify 11th returns `RATE_LIMITED`.

10. **Invalid request ID**: Query status with `BAD-ID`. Verify `VALIDATION_ERROR` before it hits the router.

## Acceptance Criteria

1. Command bridge correctly translates raw command strings to `IncomingCommand` and routes through `IntakeRouter`.
2. Validation errors are caught at the bridge level and formatted for terminal output.
3. Router errors (authz, rate limit, internal) are formatted correctly.
4. All adapter unit tests pass covering arg parser, identity, and adapter methods.
5. All 10 e2e scenarios pass with real SQLite database and real core components.
6. Full lifecycle (submit -> status -> pause -> resume -> cancel) works end-to-end.
7. Authorization enforcement verified through the full stack.
8. Rate limit enforcement verified through the full stack.
9. Input validation verified at the adapter boundary.

## Test Cases

| File | Test Count |
|------|-----------|
| `claude_adapter.test.ts` | 8 |
| `claude_arg_parser.test.ts` | 26 |
| `claude_identity.test.ts` | 4 |
| `claude_app_e2e.test.ts` | 10 |
| **Total** | **48** |

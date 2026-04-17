# SPEC-008-2-01: ClaudeAdapter Class & Slash Command Registration

## Metadata
- **Parent Plan**: PLAN-008-2
- **Tasks Covered**: Task 1, Task 2
- **Estimated effort**: 7 hours

## Description

Implement the `ClaudeAdapter` class that implements the `IntakeAdapter` interface for the Claude App native channel, and register all 10 slash commands under the `autonomous-dev:` namespace using the Claude Code plugin system.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/adapters/claude_adapter.ts` | Create |

## Implementation Details

### Task 1: ClaudeAdapter Class

```typescript
class ClaudeAdapter implements IntakeAdapter {
  readonly channelType: ChannelType = 'claude_app';
  private handle: AdapterHandle | null = null;
  private shuttingDown = false;
  private inFlightCount = 0;

  constructor(
    private router: IntakeRouter,
    private identityResolver: ClaudeIdentityResolver,
    private formatter: CLIFormatter,
  ) {}

  async start(): Promise<AdapterHandle> {
    this.registerCommands();
    this.handle = { dispose: () => this.shutdown() };
    return this.handle;
  }

  async sendMessage(target: MessageTarget, payload: FormattedMessage): Promise<DeliveryReceipt> {
    // Implementation in Task 6 (SPEC-008-2-02)
  }

  async promptUser(target: MessageTarget, prompt: StructuredPrompt): Promise<UserResponse | TimeoutExpired> {
    // Implementation in Task 7 (SPEC-008-2-02)
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    // Wait for in-flight commands to complete (max 10s)
    const deadline = Date.now() + 10_000;
    while (this.inFlightCount > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
}
```

**Key behaviors:**
- `start()` registers all 10 slash commands and returns a disposable handle.
- `shutdown()` sets the `shuttingDown` flag, waits up to 10 seconds for in-flight commands to complete.
- When `shuttingDown` is true, new command invocations return an error: "System is shutting down."
- `inFlightCount` is incremented before command execution and decremented after (in a `finally` block).

### Task 2: Slash Command Registration

All 10 commands are registered using the Claude Code plugin slash command API. The definitions are from TDD section 3.2:

```typescript
const COMMANDS: CommandDefinition[] = [
  {
    name: 'autonomous-dev:submit',
    description: 'Submit a new request to the autonomous development pipeline',
    args: [
      { name: 'description', type: 'string', required: true,
        description: 'Natural-language description of the feature or task' }
    ],
    flags: [
      { name: 'priority', type: 'string', default: 'normal',
        description: 'Priority level: high, normal, or low' },
      { name: 'repo', type: 'string',
        description: 'Target repository (defaults to current working directory repo)' },
      { name: 'deadline', type: 'string',
        description: 'ISO-8601 date deadline' },
      { name: 'force', type: 'boolean', default: false,
        description: 'Skip duplicate detection confirmation' },
    ]
  },
  {
    name: 'autonomous-dev:status',
    description: 'View the current state and progress of a request',
    args: [
      { name: 'request-id', type: 'string', required: true }
    ]
  },
  {
    name: 'autonomous-dev:list',
    description: 'List all active requests with their states and priorities',
    flags: [
      { name: 'priority', type: 'string', description: 'Filter by priority' },
      { name: 'status', type: 'string', description: 'Filter by status' },
    ]
  },
  {
    name: 'autonomous-dev:cancel',
    description: 'Cancel a request and clean up all associated artifacts',
    args: [{ name: 'request-id', type: 'string', required: true }]
  },
  {
    name: 'autonomous-dev:pause',
    description: 'Pause a request at the next phase boundary',
    args: [{ name: 'request-id', type: 'string', required: true }]
  },
  {
    name: 'autonomous-dev:resume',
    description: 'Resume a paused request',
    args: [{ name: 'request-id', type: 'string', required: true }]
  },
  {
    name: 'autonomous-dev:priority',
    description: 'Change a request priority',
    args: [
      { name: 'request-id', type: 'string', required: true },
      { name: 'level', type: 'string', required: true,
        description: 'high, normal, or low' }
    ]
  },
  {
    name: 'autonomous-dev:logs',
    description: 'View activity log for a request',
    args: [{ name: 'request-id', type: 'string', required: true }],
    flags: [{ name: 'all', type: 'boolean', default: false }]
  },
  {
    name: 'autonomous-dev:feedback',
    description: 'Send feedback or context to an active request',
    args: [
      { name: 'request-id', type: 'string', required: true },
      { name: 'message', type: 'string', required: true }
    ]
  },
  {
    name: 'autonomous-dev:kill',
    description: 'Emergency stop all running requests (admin only)',
    flags: []
  },
];
```

**Registration pattern:**
- Each command definition is registered via the plugin's `registerCommand()` API.
- The callback for each command receives the raw argument string.
- The callback: (a) checks `shuttingDown`, (b) increments `inFlightCount`, (c) parses args, (d) resolves identity, (e) constructs `IncomingCommand`, (f) routes via `IntakeRouter`, (g) formats the result, (h) outputs to terminal, (i) decrements `inFlightCount` in `finally`.

## Acceptance Criteria

1. `ClaudeAdapter` implements all 4 methods of `IntakeAdapter`.
2. `channelType` returns `'claude_app'`.
3. `start()` registers exactly 10 slash commands with the correct names.
4. Each command has the correct args (name, type, required) and flags (name, type, default) per the definition table.
5. `shutdown()` waits for in-flight commands before returning.
6. New commands during shutdown return an error message.
7. All commands are discoverable in the Claude Code slash command palette.

## Test Cases

1. **start() registers commands**: Mock the plugin registration API. Call `start()`. Verify `registerCommand` was called 10 times with the correct command names.
2. **Command definition correctness**: For each of the 10 commands, verify the registered definition matches the TDD spec (arg count, flag names, required flags).
3. **shutdown() waits for in-flight**: Start a command (mock slow execution), call `shutdown()` concurrently; verify shutdown resolves only after the command completes (or after 10s timeout).
4. **Rejection during shutdown**: Set `shuttingDown = true`, invoke a command; verify error response returned.
5. **InFlightCount tracking**: Invoke 3 concurrent commands; verify `inFlightCount` is 3 during execution and 0 after.
6. **AdapterHandle dispose**: Call `handle.dispose()`; verify it delegates to `shutdown()`.

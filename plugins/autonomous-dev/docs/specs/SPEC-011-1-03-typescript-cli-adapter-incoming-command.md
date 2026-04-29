# SPEC-011-1-03: TypeScript CLI Adapter & IncomingCommand Construction

## Metadata
- **Parent Plan**: PLAN-011-1
- **Tasks Covered**: Task 6 (CLI adapter skeleton), Task 7 (IncomingCommand construction), Task 8 (TS-level validation)
- **Estimated effort**: 7 hours

## Description
Implement `intake/adapters/cli_adapter.ts` as the TypeScript CLI surface layer for all 10 request subcommands using `commander.js` for argument parsing. Construct `IncomingCommand` objects per the TDD-011 §16.1 contract and route them through the existing `IntakeRouter`. Apply TypeScript-level validation for ISO-8601 deadlines, repository identifier formats, and any free-form arguments not already validated by the bash layer (SPEC-011-1-01). The adapter is the boundary where bash hands off to the typed core; everything past this point operates on validated, typed data.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/adapters/cli_adapter.ts` | Create | New adapter for the CLI channel |
| `intake/adapters/cli_adapter.test.ts` | Create | Stub (full tests in SPEC-011-1-04) |
| `package.json` | Modify | Add `commander` ^11.x to dependencies |

## Implementation Details

### Task 6: CLI Adapter Skeleton

Module shape:

```typescript
// intake/adapters/cli_adapter.ts
import { Command, InvalidArgumentError } from 'commander';
import { IntakeRouter } from '../core/router';
import { IncomingCommand, ChannelType } from './adapter_interface';

const program = new Command();
const router = new IntakeRouter(); // singleton; constructor reads env config

program
  .name('autonomous-dev request')
  .description('Manage autonomous-dev request lifecycle')
  .exitOverride(); // throw instead of process.exit so we control exit codes
```

Define each of the 10 subcommands as a sibling `.command(...)` registration. Each handler is async; uncaught exceptions exit 1 (user error) or 2 (system error) via a top-level catch.

```typescript
program
  .command('submit <description>')
  .description('Submit a new request')
  .option('--repo <repo>', 'Target repository (org/repo or absolute path)')
  .option('--priority <priority>', 'Priority: high|normal|low', 'normal')
  .option('--deadline <iso8601>', 'Deadline (ISO 8601 timestamp)')
  .option('--type <type>', 'Request type (default feature)', 'feature')
  .action(async (description, opts) => { /* construct IncomingCommand */ });
```

The remaining 9 subcommands (status, list, cancel, pause, resume, priority, logs, feedback, kill) follow the same pattern.

### Task 7: IncomingCommand Construction

Per TDD-011 §16.1, every command produces an `IncomingCommand`:

```typescript
interface IncomingCommand {
  channelType: ChannelType;          // always 'cli' for this adapter
  commandType: string;               // e.g. 'submit', 'status', ...
  requestId?: string;                // present for ID-bearing commands
  payload: Record<string, unknown>;  // command-specific parameters
  source: {
    operatorId: string;              // os.userInfo().username
    invokedAt: string;               // ISO 8601, generated at action()
    cwd: string;                     // process.cwd()
  };
}
```

Construction helper:

```typescript
function buildCommand(
  commandType: string,
  payload: Record<string, unknown>,
  requestId?: string
): IncomingCommand {
  return {
    channelType: 'cli',
    commandType,
    requestId,
    payload,
    source: {
      operatorId: os.userInfo().username,
      invokedAt: new Date().toISOString(),
      cwd: process.cwd(),
    },
  };
}
```

Each subcommand's handler builds its specific payload. Examples:

| Subcommand | requestId | payload |
|-----------|-----------|---------|
| submit | (none) | `{description, repo?, priority, deadline?, type}` |
| status | `REQ-000001` | `{}` |
| list | (none) | `{state?: 'active' \| 'all', limit?: number}` |
| cancel | `REQ-000001` | `{reason?: string}` |
| pause | `REQ-000001` | `{}` |
| resume | `REQ-000001` | `{}` |
| priority | `REQ-000001` | `{priority: 'high' \| 'normal' \| 'low'}` |
| logs | `REQ-000001` | `{follow?: boolean, lines?: number}` |
| feedback | `REQ-000001` | `{message: string}` |
| kill | `REQ-000001` | `{}` |

After construction:

```typescript
const result = await router.route(command);
process.stdout.write(formatResult(result));
process.exit(0);
```

`formatResult(result: RouterResult): string` produces channel-appropriate text output. For CLI: a tabular summary or compact one-liner depending on subcommand. Color use is gated by `process.env.AUTONOMOUS_DEV_COLOR === '1'` (set by SPEC-011-1-02).

### Task 8: TypeScript-Level Validation

Most validation is already done at the bash layer (SPEC-011-1-01) — the TS adapter trusts that `requestId` matches `REQ-\d{6}` and `priority` is one of `{high, normal, low}`. But TS-level validation is required for inputs that bash cannot conveniently check:

#### `--deadline <iso8601>` validation

```typescript
function parseDeadline(value: string): Date {
  // Strict ISO 8601: YYYY-MM-DDTHH:MM:SSZ or with offset
  const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;
  if (!isoRegex.test(value)) {
    throw new InvalidArgumentError(`'${value}' is not a valid ISO 8601 timestamp`);
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new InvalidArgumentError(`'${value}' is not a parseable date`);
  }
  if (date.getTime() < Date.now()) {
    throw new InvalidArgumentError(`deadline '${value}' is in the past`);
  }
  return date;
}
```

#### `--repo <repo>` validation

Two valid forms:
- GitHub-style: `org/repo` (matches `^[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+$`)
- Absolute path: starts with `/`, must exist on disk (`fs.existsSync(value) && fs.statSync(value).isDirectory()`)

```typescript
function parseRepo(value: string): string {
  const ghRegex = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/;
  if (ghRegex.test(value)) return value;
  if (value.startsWith('/')) {
    if (!fs.existsSync(value) || !fs.statSync(value).isDirectory()) {
      throw new InvalidArgumentError(`repo path '${value}' does not exist or is not a directory`);
    }
    return value;
  }
  throw new InvalidArgumentError(
    `'${value}' is not a valid repo identifier. Use 'org/repo' or an absolute path`
  );
}
```

#### `--type <type>` validation

```typescript
function parseType(value: string): string {
  const valid = ['feature', 'bug', 'infra', 'refactor', 'hotfix'];
  if (!valid.includes(value)) {
    throw new InvalidArgumentError(`type '${value}' invalid. Valid: ${valid.join(', ')}`);
  }
  return value;
}
```

These validators wire into commander via the second arg of `.option`:

```typescript
.option('--deadline <iso8601>', 'Deadline', parseDeadline)
.option('--repo <repo>', 'Target repository', parseRepo)
.option('--type <type>', 'Request type', parseType, 'feature')
```

`commander` invokes the validator and forwards `InvalidArgumentError` to a top-level error handler that prints the message and exits 1.

### Top-Level Error Handler

```typescript
program.parseAsync(process.argv).catch((err) => {
  if (err instanceof InvalidArgumentError) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    process.exit(1);
  }
  if (err instanceof CommanderError) {
    // commander already printed its own help/error
    process.exit(err.exitCode || 1);
  }
  process.stderr.write(`ERROR: ${err.message || String(err)}\n`);
  process.exit(2); // unexpected — system error
});
```

## Acceptance Criteria

- [ ] `intake/adapters/cli_adapter.ts` compiles without errors under TS strict mode
- [ ] All 10 subcommands registered with commander; each has a description and option list
- [ ] `IncomingCommand` construction matches the TDD-011 §16.1 schema for every subcommand
- [ ] Invalid `--deadline 2020-01-01T00:00:00Z` (past) exits 1 with the documented error
- [ ] Invalid `--deadline notadate` exits 1 with the documented error
- [ ] Invalid `--repo /nonexistent` exits 1 with the documented error
- [ ] Invalid `--type xyz` exits 1 with the documented error listing valid types
- [ ] `--repo torvalds/linux` accepted (GitHub-style)
- [ ] `--repo /Users/me/myrepo` accepted (absolute path) when directory exists
- [ ] Top-level errors that aren't `InvalidArgumentError` exit 2 (system error)

## Dependencies

- `commander` ^11.x (added to `package.json`)
- Node.js stdlib: `os`, `fs`, `process`
- Existing `IntakeRouter` from `intake/core/router.ts` (TDD-008 / PLAN-008-1)
- `IncomingCommand` and `ChannelType` types from `intake/adapters/adapter_interface.ts` (PLAN-008-1)

## Notes

- Validators throw `InvalidArgumentError` (commander's typed error) so the framework formats the error consistently with its own help-on-error output.
- The CLI adapter does NOT reuse the bash layer's regex for request IDs — bash already validated it. The TS layer's job is to validate things bash can't (paths, dates, complex types).
- `os.userInfo().username` is the operator identity for the CLI channel; this maps to `actor` in the IntakeRouter audit log.
- `formatResult` is intentionally underspecified here — it's a presentation concern. Each subcommand's output format is a separate UX decision tracked in operator documentation, not in the contract.

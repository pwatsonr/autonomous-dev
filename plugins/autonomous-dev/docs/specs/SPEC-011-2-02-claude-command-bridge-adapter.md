# SPEC-011-2-02: Claude Command Bridge Adapter & IntakeRouter Integration

## Metadata
- **Parent Plan**: PLAN-011-2
- **Tasks Covered**: Task 5 (enhance `claude_command_bridge.ts` error handling), Task 6 (bridge contract documentation source-of-truth surfaces)
- **Estimated effort**: 3 hours

## Description
Enhance the TypeScript Claude App adapter at `intake/adapters/claude_command_bridge.ts` so it can be invoked as a Node.js subprocess by the bash proxy from SPEC-011-2-01, parse the incoming subcommand and arguments into a typed `IncomingCommand`, and forward it to the `IntakeRouter`. Add structured error handling for the three failure modes called out in TDD-011 §6.4: `ModuleNotFoundError` (missing TypeScript dependencies), `DatabaseConnectionError` (SQLite path invalid or permission denied), and version mismatch between the built bridge and runtime expectations. Every error path must emit an actionable message naming the resolution command (e.g., `npm install && npm run build`).

This spec defines the typed contract surface that the proxy script and downstream router both depend on. The adapter does NOT implement business logic for individual subcommands — it routes to existing handlers in the IntakeRouter. The router-handler implementations themselves are out of scope (PLAN-012-* and elsewhere).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/adapters/claude_command_bridge.ts` | Modify | Add CLI entrypoint, error classes, env-var parsing, IntakeRouter dispatch |
| `intake/adapters/types.ts` | Modify | Add `IncomingCommand`, `CommandResult`, `ErrorResponse` interfaces |
| `intake/router.ts` | Modify | Add `route(cmd: IncomingCommand)` method dispatching to subcommand handlers |
| `package.json` | Modify | Ensure `dist/intake/adapters/claude_command_bridge.js` is built by `npm run build` |

## Implementation Details

### Type Definitions (`intake/adapters/types.ts`)

```typescript
export type CommandSource = 'claude-app' | 'cli' | 'discord' | 'slack';

export interface IncomingCommand {
  subcommand: 'submit' | 'status' | 'list' | 'cancel' | 'pause'
            | 'resume' | 'priority' | 'logs' | 'feedback' | 'kill';
  args: Record<string, string | number | boolean>;
  source: CommandSource;
  sessionId: string;
  receivedAt: string;            // ISO-8601 UTC
}

export interface CommandResult {
  ok: true;
  data: unknown;                 // subcommand-specific payload
}

export interface ErrorResponse {
  ok: false;
  errorCode:
    | 'INVALID_ARGUMENT'
    | 'UNKNOWN_SUBCOMMAND'
    | 'MODULE_NOT_FOUND'
    | 'DATABASE_CONNECTION'
    | 'VERSION_MISMATCH'
    | 'INTERNAL_ERROR';
  message: string;               // human-readable, actionable
  resolution?: string;           // suggested fix command, when applicable
}
```

### Error Classes (`intake/adapters/claude_command_bridge.ts`)

```typescript
export class BridgeError extends Error {
  constructor(public readonly code: ErrorResponse['errorCode'],
              message: string,
              public readonly resolution?: string) {
    super(message);
    this.name = 'BridgeError';
  }
}
```

### CLI Entrypoint

The compiled bridge is invoked as `node dist/intake/adapters/claude_command_bridge.js <subcommand> [args...]`. The entrypoint must:

```
main(argv: string[]) -> Promise<number>   // returns exit code
```

Behavior:
1. Validate that `argv[0]` is one of the 10 allowed subcommands. If not, emit an `UNKNOWN_SUBCOMMAND` `ErrorResponse` to stdout as JSON and return exit code 1.
2. Parse `argv[1..]` into a `Record<string, string | number | boolean>` using a deterministic positional+flag scheme matching `arg_schemas.yaml`:
   - First positional → first required arg (e.g., `request_id` for status)
   - `--key=value` and `--flag` for optional args
   - Unknown flags → `INVALID_ARGUMENT` exit 1
3. Read environment variables:
   - `CLAUDE_COMMAND_SOURCE` (default `claude-app`)
   - `CLAUDE_SESSION_ID` (default `unknown`)
4. Construct `IncomingCommand` with `receivedAt = new Date().toISOString()`.
5. Dispatch to `IntakeRouter.route(cmd)` (see below). On success, write `JSON.stringify(result)` to stdout, return 0.
6. On `BridgeError`: write `ErrorResponse` JSON to stdout, return code 1 (user errors) or 2 (system errors per the table below).

Error → exit-code mapping:

| `errorCode` | Exit |
|-------------|------|
| `INVALID_ARGUMENT` | 1 |
| `UNKNOWN_SUBCOMMAND` | 1 |
| `MODULE_NOT_FOUND` | 2 |
| `DATABASE_CONNECTION` | 2 |
| `VERSION_MISMATCH` | 2 |
| `INTERNAL_ERROR` | 2 |

### Three Required Error Paths (TDD-011 §6.4)

#### `MODULE_NOT_FOUND`

Wrap the `IntakeRouter` import in a try/catch. On `Error` whose `code === 'MODULE_NOT_FOUND'` or whose message matches `/Cannot find module/`:

```typescript
throw new BridgeError(
  'MODULE_NOT_FOUND',
  `Required module not installed (${err.message}).`,
  `cd ${pluginDir} && npm install && npm run build`
);
```

`pluginDir` is resolved via `path.resolve(__dirname, '..', '..', '..')` from the compiled `dist/` location.

#### `DATABASE_CONNECTION`

When the IntakeRouter throws an error whose name matches `DatabaseConnectionError` or whose message matches `/SQLITE_/`:

```typescript
throw new BridgeError(
  'DATABASE_CONNECTION',
  `SQLite database connection failed: ${err.message}`,
  `Verify file exists and is writable: ${process.env.AUTONOMOUS_DEV_DB ?? defaultDbPath}. ` +
  `Check directory permissions; SQLite needs read+write on the file and its parent directory.`
);
```

`defaultDbPath` is `${process.env.HOME}/.autonomous-dev/intake.sqlite3`.

#### `VERSION_MISMATCH`

At entrypoint, read `package.json`'s `version` field via `require('../../../package.json').version`. Compare against `process.env.AUTONOMOUS_DEV_EXPECTED_VERSION` (set by upstream tooling). Mismatch:

```typescript
throw new BridgeError(
  'VERSION_MISMATCH',
  `Bridge version ${actual} does not match expected ${expected}.`,
  `cd ${pluginDir} && npm run build`
);
```

If `AUTONOMOUS_DEV_EXPECTED_VERSION` is unset, skip the check (do not fail).

### IntakeRouter Integration (`intake/router.ts`)

Add the dispatch method:

```typescript
class IntakeRouter {
  async route(cmd: IncomingCommand): Promise<CommandResult> {
    const handler = this.handlers[cmd.subcommand];
    if (!handler) {
      throw new BridgeError(
        'UNKNOWN_SUBCOMMAND',
        `Subcommand '${cmd.subcommand}' has no registered handler.`,
        'Implementation pending in PLAN-012-*'
      );
    }
    return handler(cmd);
  }
}
```

For this spec, all 10 handler entries are stub implementations that return:

```typescript
{ ok: true, data: { stub: true, subcommand: cmd.subcommand, args: cmd.args, receivedAt: cmd.receivedAt } }
```

This keeps the bridge end-to-end testable while deferring real handler work to downstream plans.

### Build Configuration

Confirm `package.json` has:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json"
  }
}
```

And `tsconfig.json`'s `outDir` is `dist/`, `rootDir` is `.` (or appropriately configured) so the compiled bridge lands at `dist/intake/adapters/claude_command_bridge.js` — matching the path resolved by SPEC-011-2-01's `bridge_proxy.sh`.

## Acceptance Criteria

- [ ] `intake/adapters/types.ts` exports `IncomingCommand`, `CommandResult`, `ErrorResponse`, `CommandSource` with the exact shapes defined above
- [ ] `BridgeError` class extends `Error` with `code` and `resolution` fields
- [ ] CLI entrypoint accepts `node claude_command_bridge.js <subcommand> [args...]` and dispatches correctly
- [ ] Unknown subcommand returns exit 1 with `UNKNOWN_SUBCOMMAND` `ErrorResponse` JSON on stdout
- [ ] `--key=value` and `--flag` parsing matches `arg_schemas.yaml` for all 10 commands
- [ ] `CLAUDE_COMMAND_SOURCE` and `CLAUDE_SESSION_ID` are read from env and embedded in `IncomingCommand`
- [ ] `MODULE_NOT_FOUND` path triggers when `IntakeRouter` import fails; message includes plugin dir and `npm install && npm run build`
- [ ] `DATABASE_CONNECTION` path triggers on `SQLITE_*` errors; message includes the database path and permission guidance
- [ ] `VERSION_MISMATCH` path triggers when `AUTONOMOUS_DEV_EXPECTED_VERSION` is set and disagrees with `package.json` version; suggests rebuild
- [ ] `VERSION_MISMATCH` is skipped (no error) when `AUTONOMOUS_DEV_EXPECTED_VERSION` is unset
- [ ] `IntakeRouter.route(cmd)` dispatches to a handler keyed by `cmd.subcommand` and returns `CommandResult`
- [ ] All 10 stub handlers return `{ ok: true, data: { stub: true, subcommand, args, receivedAt } }`
- [ ] `npm run build` produces `dist/intake/adapters/claude_command_bridge.js` (path matches SPEC-011-2-01 expectations)
- [ ] Exit code mapping matches the table (1 for user errors, 2 for system errors)
- [ ] No `console.log` outside of the JSON-stdout result/error emission

## Dependencies

- SPEC-011-2-01 — supplies the bash proxy that invokes this entrypoint and sets the documented env vars.
- TDD-011 §6.4 — authoritative spec for the three required error paths (ModuleNotFoundError, DatabaseConnectionError, version mismatch).
- Existing `IntakeRouter` class in `intake/router.ts` — extended with the `route()` method here. If the class does not yet exist, create a minimal class with `handlers: Record<string, (cmd: IncomingCommand) => Promise<CommandResult>>` and the `route()` method.
- TypeScript ≥ 5.0 toolchain (already present in the repo's `package.json`).
- No new runtime npm packages introduced.

## Notes

- All errors flow as JSON on stdout (not stderr). The bash proxy treats stdout as the result channel; stderr is reserved for proxy-level failures (bridge missing, node missing). This separation lets downstream automation parse a single JSON document per invocation.
- The `resolution` field is what makes errors actionable — if you find yourself adding a `BridgeError` without a `resolution`, reconsider; users seeing the error need to know the next command to run.
- The 10 stub handlers exist solely to keep the surface end-to-end testable. They will be replaced by real handlers in PLAN-012-* without changing the public bridge contract defined here.
- Avoid introducing dynamic `require()` of subcommand handlers — the static `handlers` map keeps the surface auditable and the test in SPEC-011-2-03 deterministic.
- Logging within the bridge (operational telemetry) is out of scope for this spec; if added later it must write to stderr to preserve the stdout JSON contract.

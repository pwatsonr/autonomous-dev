# Claude Command Bridge — Contract

The Claude Command Bridge is the boundary between the Claude App slash
commands (`commands/autonomous-dev-*.md`) and the canonical
`IntakeRouter` (TDD-008). The bash proxy in
`commands/_shared/bridge_proxy.sh` invokes the compiled bridge as a
subprocess; the bridge constructs an `IncomingCommand`, dispatches it,
and emits a single-line JSON envelope on stdout.

This document describes the input contract (argv + env), the output
contract (stdout JSON envelope + exit code), and the per-subcommand
expected I/O.

## Source of truth

| Layer            | File                                                       |
|------------------|------------------------------------------------------------|
| Bash proxy       | `commands/_shared/bridge_proxy.sh`                         |
| TypeScript bridge | `intake/adapters/claude_command_bridge.ts` (CLI surface, line 187+) |
| Frontmatter template | `commands/_shared/command_template.yaml`               |
| Arg schemas      | `commands/_shared/arg_schemas.yaml`                        |
| Specs            | SPEC-011-2-01, SPEC-011-2-02, SPEC-011-2-03 (`docs/specs/`) |

## Invocation

The bridge is intended to be invoked via:

```bash
node dist/intake/adapters/claude_command_bridge.js <subcommand> [args...]
```

The bash proxy resolves `dist/intake/adapters/claude_command_bridge.js`
relative to the plugin root. If the compiled file is missing the proxy
emits a typed error envelope and exits 2 (system error).

## Allowed subcommands

The bridge accepts exactly the 10 subcommand names listed in
`ALLOWED_SUBCOMMANDS`:

```
submit  status  list  cancel  pause  resume  priority  logs  feedback  kill
```

Any other first argument exits 1 with `errorCode: UNKNOWN_SUBCOMMAND`.

## Argv parsing rules

- `--key=value` → `flags[key] = value`
- `--key value` (next token does not begin with `--`) → `flags[key] = value`
- `--flag` (next token absent or begins with `--`) → `flags[flag] = true`
- bare token → appended to `positionals[]`
- empty flag name (`--`, `--=value`) → `INVALID_ARGUMENT` (exit 1)

## Environment variables

| Var                                  | Required | Purpose                                                |
|--------------------------------------|----------|--------------------------------------------------------|
| `CLAUDE_SESSION_ID`                  | optional | `IncomingCommand.source.userId`. Defaults to `unknown`. |
| `AUTONOMOUS_DEV_DB`                  | optional | SQLite path. Defaults to `~/.autonomous-dev/intake.sqlite3`. |
| `AUTONOMOUS_DEV_AUTH_CONFIG`         | optional | Auth config YAML path. Defaults to `<plugin>/config/intake-auth.yaml`. |
| `AUTONOMOUS_DEV_EXPECTED_VERSION`    | optional | Skipped if unset. If set, must match `package.json#version` or the bridge exits 2 with `VERSION_MISMATCH`. |

## Stdout JSON envelope

The bridge writes exactly one JSON line to stdout. Stderr is reserved
for the bash proxy's diagnostic noise; the bridge itself never writes
to stderr.

### Success

```json
{ "ok": true, "data": <unknown> }
```

`data` is the value returned by `IntakeRouter.route()`'s `result.data`
field; its shape depends on the subcommand and is the responsibility of
the relevant handler under `intake/handlers/`.

### Error

```json
{ "ok": false, "errorCode": "<CliErrorCode>", "message": "<string>", "resolution": "<string?>" }
```

`resolution` is included whenever the bridge can suggest a concrete
remediation step.

## Error codes and exit-code mapping

| `errorCode`            | Exit | Meaning                                                                  |
|------------------------|------|--------------------------------------------------------------------------|
| `INVALID_ARGUMENT`     | 1    | argv parse error or per-subcommand validation failed                     |
| `UNKNOWN_SUBCOMMAND`   | 1    | first positional was missing or not in the 10-subcommand allowlist       |
| `MODULE_NOT_FOUND`     | 2    | a `require()` inside `initRouter()` could not resolve a dependency       |
| `DATABASE_CONNECTION`  | 2    | better-sqlite3 raised an `SQLITE_*` error opening the DB                 |
| `VERSION_MISMATCH`     | 2    | `AUTONOMOUS_DEV_EXPECTED_VERSION` was set and did not match `pkg.version`|
| `INTERNAL_ERROR`       | 2    | catch-all for unclassified failures, including router-level errors       |

User errors (bad input) exit 1; system errors (broken environment) exit
2. The bash proxy collapses both into the operator-visible error and
preserves the exit code so calling shells can branch on it.

## IncomingCommand mapping

The `IncomingCommand` shape used internally by the router is the
canonical one defined in `intake/adapters/adapter_interface.ts`. The
bridge constructs it as follows:

| Field                       | Source                                                       |
|-----------------------------|--------------------------------------------------------------|
| `commandName`               | first argv positional (one of the 10 allowed subcommands)    |
| `args[0]` (when applicable) | the request_id (positional or `--request_id`) lifted from argv |
| `args[1]` (priority/feedback) | the priority value or feedback message                     |
| `flags`                     | remaining `--key value` pairs, with lifted keys removed; non-boolean values coerced to strings |
| `rawText`                   | `argv.join(' ')`                                             |
| `source.channelType`        | always `'claude_app'`                                        |
| `source.userId`             | `process.env.CLAUDE_SESSION_ID ?? 'unknown'`                 |
| `source.timestamp`          | `new Date()` at construction time                            |

The mapping diverges from the spec's literal `{subcommand, args:
Record<...>, source: 'claude-app'}` shape because the canonical shape
already exists and is shared across every channel adapter (CLI, Discord,
Slack). The header comment on `claude_command_bridge.ts` carries the
same explanation.

## Per-subcommand example pairs

Each row shows the operator-visible argv (after the bash proxy splices
in the subcommand) and the success envelope a happy-path router returns.
Error envelopes are illustrative; production responses depend on the
handler.

### 1. `submit`

```
argv: submit "build a thing" --priority=high --repo=acme/widgets
out:  { "ok": true, "data": { "request_id": "REQ-000123" } }
exit: 0
```

### 2. `status`

```
argv: status REQ-000123
out:  { "ok": true, "data": { "request_id": "REQ-000123", "state": "active" } }
exit: 0
```

### 3. `list`

```
argv: list --state=active --limit=10
out:  { "ok": true, "data": { "items": [...], "total": 7 } }
exit: 0
```

### 4. `cancel`

```
argv: cancel REQ-000123
out:  { "ok": true, "data": { "request_id": "REQ-000123", "state": "cancelled" } }
exit: 0
```

### 5. `pause`

```
argv: pause REQ-000123
out:  { "ok": true, "data": { "request_id": "REQ-000123", "state": "paused" } }
exit: 0
```

### 6. `resume`

```
argv: resume REQ-000123
out:  { "ok": true, "data": { "request_id": "REQ-000123", "state": "active" } }
exit: 0
```

### 7. `priority`

```
argv: priority REQ-000123 high
out:  { "ok": true, "data": { "request_id": "REQ-000123", "priority": "high" } }
exit: 0
```

### 8. `logs`

```
argv: logs REQ-000123 --lines=50
out:  { "ok": true, "data": { "lines": [...] } }
exit: 0
```

### 9. `feedback`

```
argv: feedback REQ-000123 "please add tests"
out:  { "ok": true, "data": { "feedback_id": "FB-000099" } }
exit: 0
```

### 10. `kill`

```
argv: kill REQ-000123
out:  { "ok": true, "data": { "request_id": "REQ-000123", "killed": true } }
exit: 0
```

## Failure examples

### Unknown subcommand

```
argv: frobnicate
out:  { "ok": false, "errorCode": "UNKNOWN_SUBCOMMAND",
        "message": "Unknown subcommand 'frobnicate'.",
        "resolution": "Allowed subcommands: submit, status, list, cancel, ..." }
exit: 1
```

### Missing required argument

```
argv: status
out:  { "ok": false, "errorCode": "INVALID_ARGUMENT",
        "message": "Missing required argument 'request_id' for subcommand 'status'.",
        "resolution": "Provide --request_id=REQ-NNNNNN or pass it as the first positional." }
exit: 1
```

### Bridge not built / module missing

```
argv: status REQ-000123        (with dist/ wiped)
out:  { "ok": false, "errorCode": "MODULE_NOT_FOUND",
        "message": "Required module not installed (Cannot find module ...).",
        "resolution": "cd <plugin-dir> && npm install && npm run build" }
exit: 2
```

### Stale bridge (version mismatch)

```
env:  AUTONOMOUS_DEV_EXPECTED_VERSION=1.2.3
argv: status REQ-000123
out:  { "ok": false, "errorCode": "VERSION_MISMATCH",
        "message": "Bridge version 1.2.0 does not match expected 1.2.3.",
        "resolution": "cd <plugin-dir> && npm run build" }
exit: 2
```

### SQLite open failure

```
argv: status REQ-000123        (with AUTONOMOUS_DEV_DB pointing at /unwritable/path)
out:  { "ok": false, "errorCode": "DATABASE_CONNECTION",
        "message": "SQLite database connection failed: SQLITE_CANTOPEN: ...",
        "resolution": "Verify file exists and is writable: /unwritable/path. ..." }
exit: 2
```

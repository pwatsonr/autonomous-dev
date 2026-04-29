# SPEC-011-1-01: Bash Dispatcher Routing & Input Validation

## Metadata
- **Parent Plan**: PLAN-011-1
- **Tasks Covered**: Task 1 (request command routing), Task 2 (request ID validation), Task 3 (priority enum validation)
- **Estimated effort**: 2.5 hours

## Description
Extend the existing `bin/autonomous-dev.sh` dispatcher with a `request` command that routes to a delegated subcommand handler. Implement strict regex-based validation for request IDs (`^REQ-\d{6}$`) applied at the bash layer before any subprocess invocation. Implement priority enum validation (`high|normal|low`) for the `priority` subcommand. The bash layer is the first line of defense — invalid input must be rejected here with a clear, exit-code-1 error before any Node.js process spawns.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `bin/autonomous-dev.sh` | Modify | Add `request` case + `cmd_request_delegate` + validators |

## Implementation Details

### Task 1: `request` Command Routing

Add a new case to the main command switch statement in `bin/autonomous-dev.sh`:

```bash
case "$1" in
    daemon|config|cost|kill-switch|install-daemon|...)
        ;;
    request)
        shift
        cmd_request_delegate "$@"
        ;;
    *)
        echo "ERROR: Unknown command: $1" >&2
        usage
        exit 1
        ;;
esac
```

Implement `cmd_request_delegate(args: string[])`:

```
cmd_request_delegate(args: string[]) -> void
```

- Behavior:
  1. If `args` is empty or first arg is `--help`/`-h`: invoke `print_request_help` and exit 0.
  2. Capture the subcommand: `local subcmd="$1"; shift`.
  3. Validate `subcmd` against the allowlist `{submit, status, list, cancel, pause, resume, priority, logs, feedback, kill}`.
     - Unknown subcommand: log error `"ERROR: Unknown request subcommand: $subcmd. Run 'autonomous-dev request --help'"` to stderr, exit 1.
  4. For subcommands that take a request ID as their first positional arg (`status, cancel, pause, resume, priority, logs, feedback, kill`): call `validate_request_id "$1"` (Task 2) before proceeding.
  5. For `priority`: also call `validate_priority "$2"` (Task 3) on the second positional arg.
  6. Invoke the Node.js CLI adapter via `exec_node_cli "$subcmd" "$@"` (defined in SPEC-011-1-02 Task 5).

### Task 2: `validate_request_id` Function

```
validate_request_id(id: string) -> void
```

- Parameters: A single string argument (the candidate request ID).
- Behavior:
  - If `id` is empty: stderr `"ERROR: request ID is required"`, exit 1.
  - If `id` does not match the regex `^REQ-[0-9]{6}$`: stderr `"ERROR: invalid request ID '$id'. Format: REQ-NNNNNN (6 digits)"`, exit 1.
  - On match: return 0 (no output).
- Implementation note: Use `[[ "$id" =~ ^REQ-[0-9]{6}$ ]]` (bash 4 regex). Do not use `grep` (subprocess overhead).

Test matrix to embed in SPEC-011-1-04:

| Input | Expected exit |
|-------|---------------|
| `REQ-000001` | 0 |
| `REQ-999999` | 0 |
| `REQ-12345` (5 digits) | 1 |
| `REQ-1234567` (7 digits) | 1 |
| `req-123456` (lowercase) | 1 |
| `REQ123456` (no hyphen) | 1 |
| `REQ-12345A` (non-digit) | 1 |
| empty string | 1 |

### Task 3: `validate_priority` Function

```
validate_priority(value: string) -> void
```

- Parameters: A single string argument (the candidate priority).
- Behavior:
  - If `value` is empty: stderr `"ERROR: priority value is required"`, exit 1.
  - Define `local valid_priorities="high normal low"`.
  - If `value` is not in the space-separated list: stderr `"ERROR: invalid priority '$value'. Valid: high, normal, low"`, exit 1.
  - On match: return 0.
- Implementation note: Use `[[ " $valid_priorities " == *" $value "* ]]` for safe membership check (no subprocess).

### Help Text

Implement `print_request_help()`:

```
print_request_help() -> void  (writes to stdout)
```

Output format (verbatim, ≤80 columns per line):

```
Usage: autonomous-dev request <subcommand> [args]

Manage autonomous-dev request lifecycle.

Subcommands:
  submit <description>    Submit a new request (returns REQ-NNNNNN)
  status <REQ-id>         Show current status of a request
  list [--state <state>]  List recent requests (default: active only)
  cancel <REQ-id>         Cancel a request
  pause <REQ-id>          Pause a request
  resume <REQ-id>         Resume a paused request
  priority <REQ-id> <p>   Change priority (high|normal|low)
  logs <REQ-id>           Tail logs for a request
  feedback <REQ-id> <msg> Submit clarifying feedback
  kill <REQ-id>           Force-terminate a request

Run 'autonomous-dev request <subcommand> --help' for subcommand-specific options.
```

## Acceptance Criteria

- [ ] `autonomous-dev request --help` exits 0 with the usage text above
- [ ] `autonomous-dev request submit "..."` routes through `cmd_request_delegate` and reaches the Node delegation point
- [ ] Unknown subcommand (`autonomous-dev request foo`) exits 1 with the documented error message
- [ ] All 8 entries in the request-ID test matrix produce the documented exit code
- [ ] Priority `high|normal|low` accepted; `urgent` rejected with the documented error
- [ ] No subprocesses spawned for invalid input — validation is pure bash
- [ ] Shellcheck passes at `--severity=warning` on the modified script

## Dependencies

- Existing `usage()` function in `bin/autonomous-dev.sh` — extended to include the `request` command in the top-level help output.
- Existing logging infrastructure (`log_info`, `log_error`) — used for diagnostic output.
- No external dependencies introduced; uses only bash 4 builtins.

## Notes

- Validation is intentionally STRICT: `req-000001` (lowercase) is rejected even though the underlying intake-router could canonicalize it. The CLI is the contract surface; operators see consistent format errors regardless of which channel they use.
- Priority validation matches the Discord and Slack adapters' priority handling exactly — single source of truth maintained via the documented enum.
- The subcommand allowlist is hardcoded in this script; adding a new subcommand requires updating this script, the help text, and the TS adapter (SPEC-011-1-03).

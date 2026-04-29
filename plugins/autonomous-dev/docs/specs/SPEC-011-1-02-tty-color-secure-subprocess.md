# SPEC-011-1-02: TTY/Color Detection & Secure Node.js Subprocess Invocation

## Metadata
- **Parent Plan**: PLAN-011-1
- **Tasks Covered**: Task 4 (TTY/color detection), Task 5 (secure execFile)
- **Estimated effort**: 2.5 hours

## Description
Implement Unix-conventional TTY and color detection in `bin/autonomous-dev.sh` honoring `NO_COLOR`, `--no-color`, and stdout-pipe detection. Export the detected color preference as an environment variable consumed by the Node.js CLI adapter. Implement the secure Node.js subprocess invocation pattern using `exec` with an explicit argument array that prevents shell interpolation — no command-injection vector reaches the child process even when arguments contain shell metacharacters.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `bin/autonomous-dev.sh` | Modify | Add `detect_color`, `exec_node_cli` functions |

## Implementation Details

### Task 4: TTY and Color Detection

Implement `detect_color(args: string[]) -> string` that returns `1` (color enabled) or `0` (color disabled):

```
detect_color(args: string[]) -> string
```

Decision tree (evaluated in order):

1. If `NO_COLOR` env var is set (regardless of value, per https://no-color.org): return `0`.
2. If any argument equals `--no-color`: return `0`.
3. If `[ ! -t 1 ]` (stdout is NOT a TTY — e.g., piped or redirected): return `0`.
4. If `TERM` env var equals `dumb` or is empty: return `0`.
5. Otherwise: return `1`.

The function must NOT consume the `--no-color` arg from `$@`; the Node.js adapter also needs visibility into it. Detection is read-only.

Export the result as `AUTONOMOUS_DEV_COLOR` for the Node subprocess:

```bash
local color
color=$(detect_color "$@")
export AUTONOMOUS_DEV_COLOR="$color"
```

### Task 5: Secure Node.js Subprocess Invocation

Implement `exec_node_cli(subcmd: string, args: string[]) -> void`:

```
exec_node_cli(subcmd: string, args: string[]) -> exit
```

- Parameters:
  - `subcmd`: validated subcommand name (one of the 10 allowlisted in SPEC-011-1-01)
  - `args`: remaining positional + flag arguments, passed-through verbatim
- Behavior:
  1. Compute the path to the CLI adapter: `local cli_path="${PLUGIN_DIR}/intake/adapters/cli_adapter.js"`. Use the compiled JS path (not `.ts`) — TypeScript is compiled at install time.
  2. Verify the file exists: if `[ ! -f "$cli_path" ]`, stderr `"ERROR: CLI adapter not found at $cli_path. Run plugin install or rebuild."`, exit 2.
  3. Verify `node` is on PATH: if `! command -v node >/dev/null 2>&1`, stderr `"ERROR: node command not found. Install Node.js 18+ to use request subcommands."`, exit 2.
  4. Invoke node WITH `exec` and an argv array (no shell interpretation):
     ```bash
     exec node "$cli_path" "$subcmd" "$@"
     ```
     The `exec` replaces the bash process (saving a fork). The `"$@"` quoting preserves each argument as a separate argv element — shell metacharacters in argument values become literal strings.
- Exit codes:
  - 0 (from node): success
  - 1 (from node): user error (validation, not found, etc.)
  - 2 (from node OR this function): system error (missing file, missing node)
  - The function's `exec` propagates the child's exit code automatically.

### Adversarial Input Test Matrix

These inputs must all be passed as LITERAL strings to the Node CLI adapter (verified by inspecting `process.argv` in the child):

| Input | Risk | Expected behavior |
|-------|------|-------------------|
| `'$(rm -rf /)'` | command substitution | Passed as literal `$(rm -rf /)`; never executed |
| `';rm -rf /'` | command chain | Passed as literal `;rm -rf /` |
| `\`whoami\`` | backtick substitution | Passed as literal backticks |
| `' \| cat /etc/passwd'` | pipe injection | Passed as literal pipe-and-text |
| `'../../../etc/passwd'` | path traversal | Passed as literal; rejected by Node-side validation (SPEC-011-1-03) |
| arg containing `\n` (newline) | log-injection | Passed as literal newline |

The `exec node "$cli_path" "$subcmd" "$@"` pattern accomplishes this BECAUSE `"$@"` expands to one quoted token per arg, and `exec` does not invoke a shell — it directly invokes the binary with the argv array.

**FORBIDDEN PATTERNS** (must NOT appear anywhere in this script):

- `node $cli_path $subcmd $@` (unquoted — risks word splitting and globbing)
- `eval "node $cli_path $subcmd $@"` (eval with interpolation — full RCE)
- `bash -c "node $cli_path $subcmd $@"` (shell wrapping — same risk)
- `node $cli_path "$subcmd $@"` (concatenated arg — wrong shape)

Shellcheck enforces these via SC2086 (unquoted), SC2294 (eval with array). CI must run shellcheck and fail on these warnings.

### `--no-color` Argument Pass-Through

After exporting `AUTONOMOUS_DEV_COLOR`, the `--no-color` flag is still passed to Node so the TS adapter can independently disable color in its own libraries (e.g., commander.js uses its own color logic). Do NOT strip the flag in bash.

## Acceptance Criteria

- [ ] `NO_COLOR=1 autonomous-dev request status REQ-000001` produces uncolored output
- [ ] `autonomous-dev request status REQ-000001 --no-color` produces uncolored output
- [ ] `autonomous-dev request status REQ-000001 | cat` produces uncolored output
- [ ] `autonomous-dev request status REQ-000001` in a real terminal produces colored output
- [ ] All 6 adversarial inputs from the test matrix appear as literal strings in the child's `process.argv`
- [ ] Missing `cli_adapter.js` exits 2 with the documented error
- [ ] Missing `node` exits 2 with the documented error
- [ ] Shellcheck passes at `--severity=warning`; SC2086 and SC2294 are NOT silenced anywhere

## Dependencies

- `PLUGIN_DIR` constant from the dispatcher's existing constants block (resolves to plugin root)
- `command -v` builtin (POSIX-compliant)
- Node.js 18+ on the operator's PATH (precondition documented in plugin install README)

## Notes

- The `exec` (rather than plain `node ...`) is intentional: it saves one process fork and makes the bash dispatcher's exit code the SAME as the Node adapter's exit code without any propagation logic.
- `AUTONOMOUS_DEV_COLOR` is the canonical env var name; matches `NO_COLOR` convention but is namespaced to avoid conflicts with other tools the operator may have.
- The `--no-color` flag mirroring (env + arg) is standard practice — some libraries respect env, others respect the flag, both are honored.
- Any future expansion that needs a different runtime (e.g., a Python adapter) follows the same pattern: validate args in bash, exec the runtime with argv array.

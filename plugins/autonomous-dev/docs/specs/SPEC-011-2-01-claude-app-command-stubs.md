# SPEC-011-2-01: Claude App Slash-Command Format & Stub Files

## Metadata
- **Parent Plan**: PLAN-011-2
- **Tasks Covered**: Task 1 (shared frontmatter template & arg schemas), Task 2 (`autonomous-dev-submit.md` reference example), Task 3 (remaining 9 stub files), Task 4 (shared bash proxy script)
- **Estimated effort**: 6 hours

## Description
Deliver the user-facing Claude Code slash-command surface for `autonomous-dev`: 10 `.md` command files in `commands/` that Claude Code discovers on plugin load, plus the shared YAML/bash assets they consume. Each `.md` file is a thin proxy: YAML frontmatter declares the command (name, description, arguments, allowed_tools) and the bash body delegates to the TypeScript bridge via the shared `bridge_proxy.sh` script. This spec is concerned only with the Claude App-side artifacts; the TypeScript adapter that receives these invocations is covered in SPEC-011-2-02.

The frontmatter and proxy logic are factored into shared assets to keep the 10 command files DRY: each command file differs only in its frontmatter `name`/`description`/`arguments` and the basename it passes to the bridge. Strict YAML and shellcheck-clean bash are required so Claude Code's plugin loader and downstream automation never see malformed inputs.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `commands/_shared/command_template.yaml` | Create | Reference frontmatter template (name/description/arguments/allowed_tools) |
| `commands/_shared/arg_schemas.yaml` | Create | Argument schemas for all 10 commands per TDD-011 §6.2 |
| `commands/_shared/bridge_proxy.sh` | Create | Shared bash proxy logic sourced by every command body |
| `commands/autonomous-dev-submit.md` | Create | Reference command (description/priority/repo/deadline args) |
| `commands/autonomous-dev-status.md` | Create | Status command (request_id arg) |
| `commands/autonomous-dev-list.md` | Create | List command (state/limit args) |
| `commands/autonomous-dev-cancel.md` | Create | Cancel command (request_id arg) |
| `commands/autonomous-dev-pause.md` | Create | Pause command (request_id arg) |
| `commands/autonomous-dev-resume.md` | Create | Resume command (request_id arg) |
| `commands/autonomous-dev-priority.md` | Create | Priority command (request_id, priority args) |
| `commands/autonomous-dev-logs.md` | Create | Logs command (request_id, lines args) |
| `commands/autonomous-dev-feedback.md` | Create | Feedback command (request_id, message args) |
| `commands/autonomous-dev-kill.md` | Create | Kill command (request_id args) |

## Implementation Details

### Task 1: Shared Frontmatter Template & Arg Schemas

`commands/_shared/command_template.yaml` defines the canonical structure each `.md` file's frontmatter follows:

```yaml
# Template — DO NOT include directly in a .md file. Use as reference.
name: autonomous-dev-{subcommand}
description: One-sentence imperative description (≤ 120 chars)
arguments:
  - name: <arg_name>
    type: string | enum | integer
    required: true | false
    description: <arg description>
    enum: [...]            # only when type == enum
    default: <value>       # only when required == false
allowed_tools:
  - Bash(bash:*)
```

`commands/_shared/arg_schemas.yaml` enumerates the per-command argument shape. Schemas must match TDD-011 §6.2 exactly:

```yaml
submit:
  - { name: description, type: string,  required: true,  description: "Free-form request description" }
  - { name: priority,    type: enum,    required: false, enum: [high, normal, low], default: normal }
  - { name: repo,        type: string,  required: false, description: "Repository slug, e.g. owner/repo" }
  - { name: deadline,    type: string,  required: false, description: "ISO-8601 deadline (optional)" }
status:
  - { name: request_id,  type: string,  required: true,  description: "REQ-NNNNNN identifier" }
list:
  - { name: state,       type: enum,    required: false, enum: [active, completed, all], default: active }
  - { name: limit,       type: integer, required: false, default: 20 }
cancel:    [{ name: request_id, type: string, required: true }]
pause:     [{ name: request_id, type: string, required: true }]
resume:    [{ name: request_id, type: string, required: true }]
priority:
  - { name: request_id,  type: string,  required: true }
  - { name: priority,    type: enum,    required: true,  enum: [high, normal, low] }
logs:
  - { name: request_id,  type: string,  required: true }
  - { name: lines,       type: integer, required: false, default: 100 }
feedback:
  - { name: request_id,  type: string,  required: true }
  - { name: message,     type: string,  required: true,  description: "Clarifying feedback message" }
kill:      [{ name: request_id, type: string, required: true }]
```

### Task 4: Shared Bash Proxy Script

`commands/_shared/bridge_proxy.sh` is sourced by each command's bash body. It encapsulates path resolution, dependency checks, env-var passing, and exit-code conventions so the per-command body is two lines.

Function signature:

```
bridge_proxy_invoke(subcommand: string, args: string[]) -> exit_code
```

Behavior:
1. Resolve `PLUGIN_DIR` as `$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)`.
2. Resolve `BRIDGE_PATH="${PLUGIN_DIR}/dist/intake/adapters/claude_command_bridge.js"`.
3. If `BRIDGE_PATH` does not exist, print to stderr (and exit 2):
   ```
   ERROR: autonomous-dev bridge not built.
   Run: cd "$PLUGIN_DIR" && npm install && npm run build
   ```
4. If `command -v node` is empty, print to stderr (and exit 2):
   ```
   ERROR: Node.js not found on PATH.
   Install Node.js >= 20.x and re-run.
   ```
5. Export environment variables for the child process:
   - `CLAUDE_COMMAND_SOURCE=claude-app`
   - `CLAUDE_SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"` (preserve existing if set)
6. Invoke: `node "$BRIDGE_PATH" "$subcommand" "$@"` and propagate the exit code.

Exit-code contract:
- `0` — success
- `1` — user error (validation, unknown subcommand, missing required arg)
- `2` — system error (bridge missing, node missing, runtime crash)

Shellcheck must pass at `--severity=warning`.

### Task 2: `autonomous-dev-submit.md` (Reference Example)

```markdown
---
name: autonomous-dev-submit
description: Submit a new autonomous-dev request (returns REQ-NNNNNN identifier)
arguments:
  - name: description
    type: string
    required: true
    description: Free-form request description
  - name: priority
    type: enum
    required: false
    enum: [high, normal, low]
    default: normal
  - name: repo
    type: string
    required: false
    description: Repository slug, e.g. owner/repo
  - name: deadline
    type: string
    required: false
    description: ISO-8601 deadline (optional)
allowed_tools:
  - Bash(bash:*)
---

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_shared/bridge_proxy.sh
source "${SCRIPT_DIR}/_shared/bridge_proxy.sh"
bridge_proxy_invoke "submit" "$@"
```
```

### Task 3: Remaining 9 Stub Files

Each stub follows the exact structure of `autonomous-dev-submit.md`, differing only in:
- Frontmatter `name` (e.g. `autonomous-dev-status`)
- Frontmatter `description` (one-line imperative phrasing)
- Frontmatter `arguments` (from `arg_schemas.yaml`)
- Bash body's `bridge_proxy_invoke` first arg (the subcommand basename)

Authoritative description strings (verbatim):

| Command | Description |
|---------|-------------|
| status | Show current status of an autonomous-dev request |
| list | List recent autonomous-dev requests (default: active only) |
| cancel | Cancel an in-flight autonomous-dev request |
| pause | Pause an autonomous-dev request |
| resume | Resume a paused autonomous-dev request |
| priority | Change priority of an autonomous-dev request (high\|normal\|low) |
| logs | Tail logs for an autonomous-dev request |
| feedback | Submit clarifying feedback to an autonomous-dev request |
| kill | Force-terminate an autonomous-dev request |

## Acceptance Criteria

- [ ] All 10 `.md` files exist in `commands/` with valid YAML frontmatter (parses with strict YAML parser)
- [ ] All 3 shared assets exist in `commands/_shared/` (`command_template.yaml`, `arg_schemas.yaml`, `bridge_proxy.sh`)
- [ ] `bridge_proxy.sh` is executable and shellcheck-clean at `--severity=warning`
- [ ] Each command's frontmatter `arguments` block matches `arg_schemas.yaml` exactly for its subcommand
- [ ] Each command's bash body sources `_shared/bridge_proxy.sh` and calls `bridge_proxy_invoke` with the correct subcommand
- [ ] `autonomous-dev-submit.md` accepts the 4 documented arguments (description required; priority/repo/deadline optional)
- [ ] When `dist/intake/adapters/claude_command_bridge.js` is missing, the proxy exits 2 with the documented "bridge not built" message
- [ ] When `node` is not on PATH, the proxy exits 2 with the documented "Node.js not found" message
- [ ] Environment variables `CLAUDE_COMMAND_SOURCE=claude-app` and `CLAUDE_SESSION_ID` are exported to the child node process
- [ ] All 10 commands appear in Claude Code's slash-command autocomplete after plugin reload (manual verification)

## Dependencies

- TDD-011 §6.2 (frontmatter contract) and §6.3 (bash proxy contract) — authoritative source for shapes specified above.
- SPEC-011-2-02 — supplies the compiled bridge entrypoint at `dist/intake/adapters/claude_command_bridge.js`. The proxy gracefully degrades when this dependency is absent (exit 2 with installation guidance).
- Claude Code plugin loader — discovers `.md` files in `commands/` (no auxiliary registration required).
- No new npm packages introduced by this spec.

## Notes

- The 10 `.md` files are intentionally minimal — all logic lives in `_shared/bridge_proxy.sh` so that adding a new command requires only a new `.md` file with appropriate frontmatter.
- `allowed_tools: [Bash(bash:*)]` is the minimum capability required; do not broaden.
- The proxy script is the contract surface seen by users when the bridge is unbuilt, so its error messages must be actionable. Vague messages like "command failed" are not acceptable.
- The argument schema YAML is consumed by SPEC-011-2-03's documentation generator; keep field ordering stable.
- Shellcheck is mandatory because the bash bodies execute on every invocation; warnings here become user-visible failures.

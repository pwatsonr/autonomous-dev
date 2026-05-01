# autonomous-dev-portal

## Overview

`autonomous-dev-portal` is a local web UI for monitoring `autonomous-dev`
requests, runs, and audit logs. It is intended for a single operator on a
workstation or homelab. It ships as a separate Claude Code plugin (rather than
being merged into `autonomous-dev`) because it is optional, requires a Bun
runtime, and has a larger on-disk footprint than the base plugin.

## Prerequisites

- The `autonomous-dev` base plugin must be installed (declared in this plugin's
  manifest via `extends`; Claude Code refuses to load this plugin without it).
- Bun >= 1.0 on `PATH`. See `bin/check-runtime.sh` (added in SPEC-013-1-03)
  for the version check the SessionStart hook performs at session start.
- A free TCP port. The default is `19280`; configurable via the `port`
  userConfig key.

## Install

Claude Code discovers plugins through its marketplace mechanism. After this
plugin is registered with the marketplace path Claude Code is configured to
read, enable it from the Claude Code plugin list. On the first session start
after install, the SessionStart hook (added in SPEC-013-1-02) runs `bun
install` once to populate `node_modules/`. Subsequent session starts skip the
install when `package.json` is unchanged (hashed and cached).

## Configuration

All configuration is exposed through Claude Code's userConfig mechanism. Edit
the values from the Claude Code plugin settings UI.

| Key | Type | Default | Notes |
|---|---|---|---|
| `port` | integer | `19280` | TCP port the portal binds to. Range 1024-65535. |
| `auth_mode` | string enum | `localhost` | One of `localhost`, `tailscale`, `oauth`. |
| `tailscale_tailnet` | string | `""` | Required when `auth_mode=tailscale`. |
| `oauth_provider` | string enum | `""` | Required when `auth_mode=oauth`. One of `github`, `google`. |
| `sse_update_interval_seconds` | integer | `5` | Server-sent events update cadence. Range 1-60. |
| `portal.path_policy.allowed_roots` | array | `[]` | Absolute paths the portal may read. Empty disables file access. |

Example: localhost-only (default, safest):

```
auth_mode = "localhost"
port = 19280
```

Example: Tailscale-fronted access from another machine on the tailnet:

```
auth_mode = "tailscale"
tailscale_tailnet = "tail-abc123.ts.net"
```

Example: OAuth (GitHub):

```
auth_mode = "oauth"
oauth_provider = "github"
```

Conditional validation (enforced by the SessionStart hook in SPEC-013-1-02):

- `auth_mode=tailscale` requires non-empty `tailscale_tailnet`.
- `auth_mode=oauth` requires `oauth_provider` set to `github` or `google`.
- Each entry in `portal.path_policy.allowed_roots` must begin with `/`.

## Paths

The portal distinguishes two filesystem roots that Claude Code injects as
environment variables. Confusing them is the most common source of operational
bugs, so this section documents them deliberately.

### `${CLAUDE_PLUGIN_ROOT}` — read-only, ships with the plugin

Files under `${CLAUDE_PLUGIN_ROOT}` are part of the plugin distribution and
must be treated as read-only at runtime. Plugin updates replace this tree.

Examples:

- `${CLAUDE_PLUGIN_ROOT}/server/server.ts` — TypeScript entry point.
- `${CLAUDE_PLUGIN_ROOT}/static/` — bundled UI assets shipped with the plugin.
- `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/hooks/session-start.sh` — hook script.
- `${CLAUDE_PLUGIN_ROOT}/bin/check-runtime.sh` — runtime pre-flight check.

### `${CLAUDE_PLUGIN_DATA}` — operator-writable, persists across updates

Files under `${CLAUDE_PLUGIN_DATA}` belong to the operator. Plugin updates
preserve this tree. All runtime writes (logs, caches, session data) MUST go
here.

Examples:

- `${CLAUDE_PLUGIN_DATA}/install.log` — append-only log of install attempts.
- `${CLAUDE_PLUGIN_DATA}/.last-install-hash` — cached SHA256 of the last
  successfully-installed `package.json`. Skip-install fast-path key.
- `${CLAUDE_PLUGIN_DATA}/sessions/<id>.jsonl` — per-session event journal
  (added in PLAN-013-2).

If you need to reset the install cache for any reason, delete
`${CLAUDE_PLUGIN_DATA}/.last-install-hash`. The next session start re-runs
`bun install`.

## Standalone Mode

`bin/start-standalone.sh` (added in SPEC-013-1-03) launches the portal outside
Claude Code, e.g. as a `systemd` unit or in a `tmux` pane on a homelab. This
is not the canonical path for Claude Code users; it exists for operators who
want the portal running independently.

## Troubleshooting

**Port already in use** — change the `port` userConfig value to an unused TCP
port (range 1024-65535). The default `19280` was chosen to avoid common
defaults but conflicts remain possible.

**Bun not found** — install Bun >= 1.0. See `bin/check-runtime.sh` for the
per-OS install commands the runtime check prints when Bun is missing.

**Plugin will not start** — confirm the `autonomous-dev` base plugin is
installed and enabled. This plugin declares `extends: ["autonomous-dev"]`;
Claude Code refuses to load it without the base.

**`bun install` fails repeatedly** — inspect
`${CLAUDE_PLUGIN_DATA}/install.log`. The SessionStart hook does NOT update the
hash cache on failure, so every subsequent session retries. Delete
`${CLAUDE_PLUGIN_DATA}/.last-install-hash` after manually fixing the
underlying problem to force a clean retry.

**MCP server keeps restarting** — Claude Code restarts a crashed MCP server
up to 3 times per session (configured in `.mcp.json`). After 3 failures the
operator must re-enable the plugin manually. Check the Claude Code MCP log
for the underlying error.

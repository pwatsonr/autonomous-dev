# SPEC-013-1-01: Plugin Manifest & Directory Layout for autonomous-dev-portal

## Metadata
- **Parent Plan**: PLAN-013-1
- **Tasks Covered**: Task 1 (scaffold plugin directory), Task 2 (author plugin.json), Task 6 (define userConfig schema), Task 7 (document path conventions)
- **Estimated effort**: 3 hours

## Description
Create the new `autonomous-dev-portal` sibling plugin's on-disk shape: directory tree, plugin manifest, userConfig schema, and operator-facing README. This spec is purely declarative — no runtime code, no hooks, no MCP wiring (covered in SPEC-013-1-02). The output is a fully-loadable Claude Code plugin shell that registers with the Claude Code plugin loader, declares its dependency on `autonomous-dev`, advertises a typed userConfig surface, and explains the `${CLAUDE_PLUGIN_ROOT}` vs `${CLAUDE_PLUGIN_DATA}` distinction to operators. Subsequent specs in PLAN-013-1 fill in the lifecycle scripts, MCP entry, and runtime checks.

The plugin must be valid JSON, parse cleanly with Claude Code's plugin loader, and refuse to start when the autonomous-dev base plugin is not installed. userConfig validation is declared here (schema + defaults) but enforced by Claude Code's loader, not by custom code in this spec.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-portal/.claude-plugin/plugin.json` | Create | Manifest with extends, version, userConfig schema |
| `plugins/autonomous-dev-portal/README.md` | Create | Operator docs: install, config, paths, troubleshooting |
| `plugins/autonomous-dev-portal/.gitignore` | Create | Excludes `node_modules/`, `.last-install-hash`, `*.log` |
| `plugins/autonomous-dev-portal/server/.gitkeep` | Create | Placeholder so empty dir is tracked |
| `plugins/autonomous-dev-portal/static/.gitkeep` | Create | Placeholder so empty dir is tracked |
| `plugins/autonomous-dev-portal/contrib/.gitkeep` | Create | Placeholder so empty dir is tracked |
| `plugins/autonomous-dev-portal/.claude-plugin/hooks/.gitkeep` | Create | Hook scripts land here in SPEC-013-1-02 |
| `plugins/autonomous-dev-portal/bin/.gitkeep` | Create | Bash entrypoints land here in SPEC-013-1-03 |

## Implementation Details

### Directory Layout

```
plugins/autonomous-dev-portal/
├── .claude-plugin/
│   ├── plugin.json
│   └── hooks/                  # populated in SPEC-013-1-02
├── bin/                        # populated in SPEC-013-1-03
├── server/                     # populated in PLAN-013-2/3/4
├── static/                     # populated in PLAN-013-4
├── contrib/                    # operator-extensible (out of scope for MVP)
├── .gitignore
└── README.md
```

### `plugin.json` Manifest

The manifest must be valid JSON (no comments, no trailing commas) and conform to Claude Code's plugin schema:

```json
{
  "name": "autonomous-dev-portal",
  "version": "0.1.0",
  "description": "Local web portal for monitoring autonomous-dev requests, runs, and audit logs.",
  "author": "autonomous-dev contributors",
  "extends": ["autonomous-dev"],
  "userConfig": {
    "port": {
      "type": "integer",
      "default": 19280,
      "minimum": 1024,
      "maximum": 65535,
      "description": "TCP port the portal binds to (loopback by default)."
    },
    "auth_mode": {
      "type": "string",
      "enum": ["localhost", "tailscale", "oauth"],
      "default": "localhost",
      "description": "Authentication mode for incoming portal connections."
    },
    "tailscale_tailnet": {
      "type": "string",
      "default": "",
      "description": "Required when auth_mode=tailscale. Tailnet name (e.g. 'tail-abc123.ts.net')."
    },
    "oauth_provider": {
      "type": "string",
      "enum": ["", "github", "google"],
      "default": "",
      "description": "Required when auth_mode=oauth. OAuth provider identifier."
    },
    "sse_update_interval_seconds": {
      "type": "integer",
      "default": 5,
      "minimum": 1,
      "maximum": 60,
      "description": "Server-sent events update cadence."
    },
    "portal.path_policy.allowed_roots": {
      "type": "array",
      "items": { "type": "string" },
      "default": [],
      "description": "Absolute paths the portal is permitted to read. Empty list disables file access."
    }
  }
}
```

Conditional validation rules (documented; enforced by SPEC-013-1-02 lifecycle):
- `auth_mode == "tailscale"` requires non-empty `tailscale_tailnet`.
- `auth_mode == "oauth"` requires `oauth_provider` set to `github` or `google`.
- Each entry in `portal.path_policy.allowed_roots` must be absolute (begins with `/`).

### `.gitignore`

```
node_modules/
.last-install-hash
install.log
*.log
.env
.env.local
```

### `README.md` Structure

The README must include the following sections, in order:

1. **Overview** — One paragraph: what the portal is (local web UI for autonomous-dev), who it is for (single operator on a workstation/homelab), and why it is a separate plugin (optional, runs Bun, larger footprint).
2. **Prerequisites** — `autonomous-dev` plugin installed; Bun >= 1.0 (see SPEC-013-1-03 for install instructions); a free TCP port (default 19280).
3. **Install** — How Claude Code discovers the plugin (marketplace path); how to enable it; what happens at first session start (`bun install` runs once).
4. **Configuration** — Table of every userConfig key, its type, default, and what it controls. Examples for each `auth_mode`.
5. **Paths** — Section dedicated to the `${CLAUDE_PLUGIN_ROOT}` vs `${CLAUDE_PLUGIN_DATA}` distinction:
   - `${CLAUDE_PLUGIN_ROOT}` → read-only files that ship with the plugin (server source, static assets, hooks).
   - `${CLAUDE_PLUGIN_DATA}` → operator-writable data directory (sessions, audit log, install hash cache, runtime logs). Survives plugin updates.
   - Concrete examples: where `install.log` lands, where `.last-install-hash` lives, where session JSONL files would go.
6. **Standalone Mode** — One-line summary pointing to `bin/start-standalone.sh` (defined in SPEC-013-1-03); not the canonical path for Claude Code users.
7. **Troubleshooting** — At minimum: "port already in use" (configurable via `port`), "Bun not found" (link to install), "plugin won't start" (check that `autonomous-dev` is installed first).

The README must be ≤ 200 lines and free of marketing language. Operator-facing reference, not promotion.

## Acceptance Criteria

- [ ] `plugins/autonomous-dev-portal/.claude-plugin/plugin.json` exists, parses with `jq -e .` exit 0, and has `name=autonomous-dev-portal` and `version=0.1.0`.
- [ ] `extends` is exactly `["autonomous-dev"]`.
- [ ] All 6 userConfig keys (`port`, `auth_mode`, `tailscale_tailnet`, `oauth_provider`, `sse_update_interval_seconds`, `portal.path_policy.allowed_roots`) are present with the documented type, default, and (where applicable) enum/range.
- [ ] `port` schema rejects values < 1024 or > 65535 at load (verified by feeding a test config).
- [ ] `auth_mode` schema rejects values outside `[localhost, tailscale, oauth]`.
- [ ] All declared subdirectories (`server/`, `static/`, `contrib/`, `.claude-plugin/hooks/`, `bin/`) exist and contain at minimum a `.gitkeep`.
- [ ] `.gitignore` excludes `node_modules/`, `.last-install-hash`, and `*.log`.
- [ ] README contains all 7 documented sections in order; section headings use `##` (h2) at top level.
- [ ] README explicitly distinguishes `${CLAUDE_PLUGIN_ROOT}` from `${CLAUDE_PLUGIN_DATA}` with at least one concrete example for each.
- [ ] No JSON comments or trailing commas in `plugin.json` (would break the loader).
- [ ] Plugin appears in Claude Code's plugin list after marketplace discovery (manual verification).

## Dependencies

- `autonomous-dev` plugin must already be installed for the portal to run; this is enforced by Claude Code's `extends` dependency resolution at plugin load time.
- Claude Code's plugin loader (current marketplace contract) — consumes the manifest.
- No new npm/Bun packages introduced by this spec.

## Notes

- This spec deliberately ships an empty plugin: no MCP entry yet (SPEC-013-1-02), no Bun runtime check (SPEC-013-1-03). Splitting it this way isolates the manifest contract from the lifecycle contract so each can be reviewed and tested independently.
- userConfig defaults are chosen for the safest local-first install: `auth_mode=localhost` means the portal binds to loopback only; `allowed_roots=[]` means file reading is disabled until the operator opts in.
- Conditional validation (e.g. `auth_mode=tailscale` requires `tailscale_tailnet`) cannot be expressed in the JSON Schema this loader supports; SPEC-013-1-02's lifecycle script performs this validation at session start and aborts with a clear error message if violated.
- The `contrib/` directory is reserved for operator-supplied extensions (custom auth backends, themes); MVP ships it empty with a `.gitkeep`.
- The default port `19280` was chosen to avoid common dev defaults (3000, 8080, 8000, 5173) and IANA-registered ports; conflicts remain possible and are configurable.

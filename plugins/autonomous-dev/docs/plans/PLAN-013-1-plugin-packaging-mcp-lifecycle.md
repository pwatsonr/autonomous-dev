# PLAN-013-1: Plugin Packaging + MCP Server Lifecycle

## Metadata
- **Parent TDD**: TDD-013-portal-server-foundation
- **Estimated effort**: 2-3 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0

## Objective
Establish the new `autonomous-dev-portal` plugin as a distinct sibling plugin with proper Claude Code packaging: directory structure, plugin manifest, MCP server registration, lifecycle hooks (SessionStart for `bun install`, shutdown coordination on session end), and userConfig schema. Includes Bun runtime detection with Node.js fallback messaging.

## Scope
### In Scope
- Directory layout `plugins/autonomous-dev-portal/{server/, static/, .claude-plugin/, contrib/}`
- `.claude-plugin/plugin.json` with `name=autonomous-dev-portal`, `version=0.1.0`, `extends: ["autonomous-dev"]`, declared userConfig schema
- `.mcp.json` server entry: `{"command": "bun", "args": ["${CLAUDE_PLUGIN_ROOT}/server/server.ts"]}` (Claude Code starts/stops with session)
- SessionStart hook bash script that runs `bun install` only when `package.json` hash changes (cached at `${CLAUDE_PLUGIN_DATA}/.last-install-hash`)
- Standalone mode: `bun run server.ts` for portal-only deployment outside Claude Code session
- userConfig keys: `port` (default 19280), `auth_mode` (default localhost; tailscale/oauth optional), `tailscale_tailnet`, `oauth_provider`, `sse_update_interval_seconds` (default 5), `portal.path_policy.allowed_roots`
- Bun runtime version check (require >=1.0); document Node.js compatibility status (untested for MVP)
- Plugin shutdown coordination: portal process receives SIGTERM on Claude Code session end; uses lifecycle.ts to drain in-flight + cleanup

### Out of Scope
- Server bootstrap + Hono setup (PLAN-013-2)
- Routing + templates (PLAN-013-3)
- Static assets + error pages (PLAN-013-4)
- All security middleware (PLAN-014-*)
- Live data + SSE (PLAN-015-*)

## Tasks

1. **Scaffold plugin directory structure** -- Create `plugins/autonomous-dev-portal/` with subdirectories per the layout above.
   - Files: directory + placeholder README.md
   - Acceptance: directory exists; gitignore excludes node_modules + .last-install-hash; basic README documents purpose + dependency on autonomous-dev plugin.
   - Effort: 0.5h

2. **Author plugin.json** -- Plugin manifest with metadata, version, declared userConfig, dependency declaration.
   - Files: `plugins/autonomous-dev-portal/.claude-plugin/plugin.json`
   - Acceptance: valid JSON; `extends: ["autonomous-dev"]`; userConfig schema covers all keys listed above with types and defaults; description; version 0.1.0.
   - Effort: 1h

3. **Configure .mcp.json server entry** -- MCP server registration so Claude Code starts the portal with each session.
   - Files: `plugins/autonomous-dev-portal/.mcp.json`
   - Acceptance: command=bun, args reference `${CLAUDE_PLUGIN_ROOT}/server/server.ts`; restart-on-crash configured; shutdown timeout 10s.
   - Effort: 0.5h

4. **Implement SessionStart hook** -- Bash script that conditionally runs `bun install` based on package.json hash change.
   - Files: `plugins/autonomous-dev-portal/.claude-plugin/hooks/session-start.sh` (new, executable)
   - Acceptance: computes SHA256 of package.json; compares to cached value at `${CLAUDE_PLUGIN_DATA}/.last-install-hash`; runs `bun install` only on mismatch; updates cache after success; logs to `${CLAUDE_PLUGIN_DATA}/install.log`; idempotent.
   - Effort: 1.5h

5. **Implement standalone mode launcher** -- Documented path for operators who want the portal running outside Claude Code (e.g., on a homelab).
   - Files: `plugins/autonomous-dev-portal/bin/start-standalone.sh` (new, executable)
   - Acceptance: validates Bun installed (else clear install instructions); validates required env (PORTAL_DATA_DIR, etc.); execs `bun run server.ts`; signal-handles SIGTERM for graceful shutdown.
   - Effort: 1h

6. **Define userConfig schema in plugin.json** -- All portal-level configuration keys with validation rules.
   - Files: `plugin.json` (extend)
   - Acceptance: `port` integer 1024-65535; `auth_mode` enum [localhost,tailscale,oauth]; `sse_update_interval_seconds` integer 1-60; `portal.path_policy.allowed_roots` array of absolute paths; conditional fields validated when auth_mode requires them.
   - Effort: 1h

7. **Document path conventions** -- Operator-facing docs explaining `${CLAUDE_PLUGIN_ROOT}` (read-only, ships with plugin) vs `${CLAUDE_PLUGIN_DATA}` (operator data: sessions, audit log, cache).
   - Files: `plugins/autonomous-dev-portal/README.md`
   - Acceptance: README covers install, config, paths, standalone mode, troubleshooting.
   - Effort: 0.5h

8. **Implement Bun runtime version check** -- Pre-flight check at SessionStart and standalone launch.
   - Files: `plugins/autonomous-dev-portal/bin/check-runtime.sh` (new)
   - Acceptance: checks bun >=1.0 (semver compare); on missing/old bun emits actionable install instructions per OS (macOS/Linux); exit code 0 ok / 1 not-installed / 2 too-old.
   - Effort: 1h

9. **Implement lifecycle.ts** -- TS module that wires shutdown handling for the portal process.
   - Files: `plugins/autonomous-dev-portal/server/lifecycle.ts` (new)
   - Acceptance: registers SIGTERM/SIGINT handlers; provides `registerResource()` API for future server.ts use; orchestrates ordered cleanup (HTTP server → SSE connections → file watchers); exits within 10s of signal or force-exits.
   - Effort: 2h

10. **Write lifecycle + hook tests** -- Unit tests for SessionStart hook hash detection, standalone launcher arg parsing, lifecycle resource cleanup ordering.
    - Files: `tests/lifecycle.test.ts`, `tests/session-start.test.bats`
    - Acceptance: cache-hit skips install; cache-miss runs install; resources cleanup in priority order; SIGTERM exits within 10s.
    - Effort: 3h

## Test Plan

- **Plugin install + reload cycle**: Claude Code discovers plugin, registers MCP server, starts portal at session start, stops at session end.
- **SessionStart hash detection**: no-op when unchanged, install when changed.
- **Standalone run**: `bun run server.ts` starts without Claude Code; SIGTERM shuts down within 10s.
- **userConfig validation**: invalid `port` rejected at load; invalid `auth_mode` rejected; conditional fields validated per mode.
- **Cross-plugin dependency**: portal plugin refuses to start if autonomous-dev plugin not installed.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Bun unavailable on operator's system | Medium | High | Clear install instructions per OS; fail-fast with actionable error |
| MCP server crash on bun install failure | Medium | Medium | Hook captures install errors; degraded-but-running mode if cached install valid |
| package.json hash collision unrealistic but theoretical | Low | Low | SHA256 is collision-resistant; recompute on plugin update |
| Port conflict with another local service | Medium | Medium | Default 19280 unusual; configurable via userConfig; clear error on bind failure |

## Acceptance Criteria

- [ ] Plugin installs from local marketplace and appears in Claude Code plugin list
- [ ] MCP server starts when Claude Code session opens
- [ ] MCP server stops cleanly when Claude Code session closes (within 10s)
- [ ] SessionStart hook runs `bun install` only when package.json changes
- [ ] Standalone mode (`bun run server.ts`) works outside Claude Code
- [ ] userConfig validation rejects invalid values with clear errors
- [ ] Plugin refuses to start if Bun unavailable (clear install instructions)
- [ ] Documentation covers paths, config, troubleshooting
- [ ] All tests pass
- [ ] No shellcheck warnings

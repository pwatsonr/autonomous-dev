# SPEC-013-1-02: MCP Server Lifecycle Hooks (Start, Stop, Healthcheck)

## Metadata
- **Parent Plan**: PLAN-013-1
- **Tasks Covered**: Task 3 (configure .mcp.json), Task 4 (SessionStart hook), Task 9 (lifecycle.ts shutdown coordinator)
- **Estimated effort**: 5 hours

## Description
Wire the `autonomous-dev-portal` plugin into Claude Code's MCP lifecycle: register the portal as an MCP server (started/stopped per session), implement the SessionStart hook that conditionally runs `bun install` when `package.json` changes, and implement the in-process `lifecycle.ts` module that orchestrates ordered shutdown when the server receives `SIGTERM` or `SIGINT`. This is the runtime glue that makes the empty plugin shell from SPEC-013-1-01 actually start and stop a real process.

Three concerns are bundled here because they share a single contract: Claude Code starts the MCP server (via `.mcp.json`), the SessionStart hook prepares dependencies, and `lifecycle.ts` ensures clean shutdown when Claude Code sends a termination signal. None of these concerns is meaningful without the others.

This spec does NOT cover: the actual server bootstrap or HTTP routes (PLAN-013-2/3/4), the Bun runtime version check (SPEC-013-1-03 — which is invoked from the SessionStart hook), or production resource cleanup logic for SSE/file-watchers (PLAN-015-*; this spec defines only the framework).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-portal/.mcp.json` | Create | MCP server registration |
| `plugins/autonomous-dev-portal/.claude-plugin/hooks/session-start.sh` | Create | Executable; conditional `bun install` |
| `plugins/autonomous-dev-portal/server/lifecycle.ts` | Create | Shutdown coordinator (TypeScript) |
| `plugins/autonomous-dev-portal/server/lifecycle.test.ts` | Create | Unit tests (smoke; full coverage in SPEC-013-1-04) |

## Implementation Details

### Task 3: `.mcp.json` Server Entry

```json
{
  "mcpServers": {
    "autonomous-dev-portal": {
      "command": "bun",
      "args": ["${CLAUDE_PLUGIN_ROOT}/server/server.ts"],
      "env": {
        "CLAUDE_PLUGIN_DATA": "${CLAUDE_PLUGIN_DATA}",
        "CLAUDE_PLUGIN_ROOT": "${CLAUDE_PLUGIN_ROOT}"
      },
      "restart": {
        "onCrash": true,
        "maxRetries": 3,
        "backoffSeconds": 2
      },
      "shutdown": {
        "signal": "SIGTERM",
        "timeoutSeconds": 10,
        "killAfterTimeout": true
      }
    }
  }
}
```

- `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` are interpolated by Claude Code at server-spawn time.
- `restart.onCrash=true` with `maxRetries=3` and exponential-ish backoff; on the 4th failure within a session the entry is marked failed and the operator must manually re-enable.
- `shutdown.timeoutSeconds=10` matches the lifecycle.ts force-exit deadline.

### Task 4: SessionStart Hook (`session-start.sh`)

Executable bash script (chmod 0755). Strict mode: `set -euo pipefail`.

Function-level pseudocode:

```
session_start() -> exit_code
  1. log "[$(date -u +%FT%TZ)] session-start invoked" -> ${CLAUDE_PLUGIN_DATA}/install.log
  2. require ${CLAUDE_PLUGIN_ROOT} and ${CLAUDE_PLUGIN_DATA} both set; else exit 2
  3. invoke bin/check-runtime.sh (SPEC-013-1-03); if non-zero, exit non-zero immediately
  4. compute current_hash = sha256sum ${CLAUDE_PLUGIN_ROOT}/package.json | awk '{print $1}'
  5. cached_hash = (cat ${CLAUDE_PLUGIN_DATA}/.last-install-hash 2>/dev/null || echo "")
  6. if [[ "$current_hash" == "$cached_hash" ]]; then
       log "package.json unchanged; skipping bun install"
       exit 0
     fi
  7. log "package.json hash changed: '$cached_hash' -> '$current_hash'; running bun install"
  8. cd ${CLAUDE_PLUGIN_ROOT}
  9. if bun install >> ${CLAUDE_PLUGIN_DATA}/install.log 2>&1; then
       echo "$current_hash" > ${CLAUDE_PLUGIN_DATA}/.last-install-hash
       log "bun install succeeded"
       exit 0
     else
       log "bun install FAILED — preserving previous hash for retry"
       exit 1
     fi
```

Required behaviors:
- Idempotent: two consecutive invocations with no `package.json` change must perform exactly one filesystem read and zero subprocess spawns (other than the hash computation and the `check-runtime.sh` call).
- Logs are append-only; never truncates `install.log`.
- Hash file write is atomic: write to `.last-install-hash.tmp` then `mv` (so a crash mid-write never leaves a partially-overwritten cache).
- Failure of `bun install` does NOT update the cache, so the next session retries.
- All paths use `${CLAUDE_PLUGIN_DATA}` (NOT `${CLAUDE_PLUGIN_ROOT}`) for writes — the plugin root is read-only.

Conditional userConfig validation:
- After step 3, before step 4: validate `auth_mode` conditional fields (declared in SPEC-013-1-01).
  - If `auth_mode=tailscale` and `tailscale_tailnet` empty → log error `"ERROR: auth_mode=tailscale requires non-empty tailscale_tailnet"`, exit 1.
  - If `auth_mode=oauth` and `oauth_provider` not in `[github, google]` → log error, exit 1.
  - For each `portal.path_policy.allowed_roots[i]` not starting with `/` → log error, exit 1.
- userConfig values are read from environment variables Claude Code injects (`CLAUDE_PLUGIN_USERCONFIG_*`). Document the exact env-var naming convention used by the loader; if Claude Code uses a single JSON blob env var, parse it with `jq` (already required dependency).

Shellcheck must pass at `--severity=warning`.

### Task 9: `lifecycle.ts` Shutdown Coordinator

TypeScript module exporting two public functions and one type:

```typescript
type CleanupHandler = () => Promise<void> | void;

interface RegisteredResource {
  name: string;
  priority: number;       // lower number = earlier in shutdown order
  cleanup: CleanupHandler;
}

export function registerResource(resource: RegisteredResource): void;
export function initLifecycle(): void;
```

`initLifecycle()` behavior:
1. Idempotent — calling twice in the same process is a no-op (logs a warning the second time).
2. Registers process-level signal handlers for `SIGTERM` and `SIGINT`.
3. On signal:
   - Log `"[lifecycle] received <signal>; initiating shutdown"` (stderr).
   - Set a hard deadline timer of 10000ms; if not exited by then, `process.exit(1)`.
   - Sort registered resources ascending by `priority`.
   - For each resource, await its `cleanup()` — but each individual cleanup gets a 2000ms timeout. If a single cleanup hangs, log a warning and proceed to the next resource.
   - After all cleanups (or all timed out), `process.exit(0)`.
4. Subsequent signals during shutdown are ignored (debounced) — the first signal wins.

Default registered resources (added by `initLifecycle`):
- `{ name: "stdin", priority: 0, cleanup: () => process.stdin.pause() }` — earliest, prevent new input.
- `{ name: "logger", priority: 100, cleanup: flushLogs }` — last (assuming `flushLogs` is exposed by the logging module; if absent in MVP, register a no-op stub and add a TODO comment).

Future modules (HTTP server, SSE manager, file watchers) call `registerResource` from their own startup code with priorities `10`, `20`, `30` respectively. This spec does not implement those resources — only the framework.

`registerResource` validation:
- Throws if `name` is empty or `priority` is not an integer.
- Throws if `cleanup` is not a function.

The module exports a `_resourcesForTest()` accessor used only by `lifecycle.test.ts` to inspect the registered list — exposed under that exact underscore-prefixed name to signal "internal".

### `lifecycle.test.ts` (smoke)

This spec ships a thin test suite (3 tests) just to validate the framework; comprehensive coverage lives in SPEC-013-1-04.

1. `registerResource adds entries in priority order` — register 3 resources with priorities `[20, 10, 30]`, assert `_resourcesForTest()` returns them sorted ascending after init.
2. `initLifecycle is idempotent` — call twice; assert second call logs a warning and does not duplicate handlers.
3. `registerResource validates inputs` — empty name, non-function cleanup, non-integer priority each throw.

## Acceptance Criteria

- [ ] `.mcp.json` parses with `jq -e .`, has exactly one entry under `mcpServers`, named `autonomous-dev-portal`.
- [ ] `.mcp.json` `command` is `"bun"` and `args[0]` references `${CLAUDE_PLUGIN_ROOT}/server/server.ts`.
- [ ] `.mcp.json` declares `restart.onCrash=true`, `restart.maxRetries=3`, `shutdown.timeoutSeconds=10`.
- [ ] `session-start.sh` is executable (mode 0755) and shellcheck passes at `--severity=warning`.
- [ ] First invocation (no cached hash) computes hash, runs `bun install`, writes hash file atomically.
- [ ] Second invocation with unchanged `package.json` exits 0 without invoking `bun install` (verifiable by absence of `bun install` in `install.log` for that timestamp).
- [ ] `bun install` failure does NOT update `.last-install-hash` (verified: hash file unchanged after a forced failure).
- [ ] SessionStart hook validates `auth_mode=tailscale` requires non-empty `tailscale_tailnet`; rejects with documented error.
- [ ] SessionStart hook validates `auth_mode=oauth` requires `oauth_provider` in `[github, google]`; rejects with documented error.
- [ ] `lifecycle.ts` exports `registerResource`, `initLifecycle`, and `_resourcesForTest` with the documented signatures.
- [ ] `initLifecycle()` is idempotent (second call logs warning, does not double-register signal handlers — verified via `process.listenerCount('SIGTERM')`).
- [ ] On `SIGTERM`, registered resources' cleanups run in ascending priority order.
- [ ] A cleanup hanging > 2000ms is timed out and the next resource still runs.
- [ ] Process exits within 10000ms of `SIGTERM` even if all cleanups hang.
- [ ] All 3 smoke tests in `lifecycle.test.ts` pass under `bun test`.

## Dependencies

- SPEC-013-1-01 — supplies the plugin directory shape and `${CLAUDE_PLUGIN_ROOT}/${CLAUDE_PLUGIN_DATA}` contract.
- SPEC-013-1-03 — supplies `bin/check-runtime.sh`, invoked at the top of `session-start.sh`. The hook gracefully fails if this script is missing (clear error pointing at SPEC-013-1-03).
- `jq` — required at runtime for parsing userConfig from the env var Claude Code injects. Document this in the SessionStart hook header.
- `sha256sum` (Linux) / `shasum -a 256` (macOS) — the hook detects which is available and uses it.
- Bun >= 1.0 — assumed installed by SPEC-013-1-03's pre-flight check.

## Notes

- The 10-second shutdown budget is set by Claude Code's MCP contract. Going over forfeits cleanup; staying under guarantees no orphaned ports/files. The lifecycle.ts force-exit timer is the safety net.
- Per-resource 2-second cleanup timeout is generous enough for real disk flushes but short enough that one hung resource cannot eat the entire shutdown budget.
- The signal-debounce behavior (first signal wins, subsequent ignored) prevents Claude Code's "send SIGTERM, then SIGKILL after 10s" pattern from interrupting our orderly shutdown.
- Atomic hash-file write via `mv` of a `.tmp` sibling is mandatory. A non-atomic write that crashes between truncate and write leaves the cache empty, forcing every subsequent session to re-run `bun install` until the operator notices.
- When `${CLAUDE_PLUGIN_USERCONFIG_*}` env-var convention is undocumented for the current Claude Code version, fall back to reading a JSON blob from `${CLAUDE_PLUGIN_USERCONFIG}` (single env var). The hook supports both shapes for forward compatibility; the actual shape used in MVP is documented in SPEC-013-1-04's integration tests.
- `lifecycle.ts` is intentionally framework-only — actual HTTP server, SSE, and file-watcher cleanups are added by their owning modules in PLAN-013-2 / PLAN-015-*.

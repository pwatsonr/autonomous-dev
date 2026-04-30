# SPEC-019-1-04: SIGUSR1 Reload and Plugin CLI Subcommands

## Metadata
- **Parent Plan**: PLAN-019-1
- **Tasks Covered**: Task 6 (SIGUSR1 reload wiring), Task 7 (`plugin list` and `plugin reload` CLI subcommands)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-1-04-sigusr1-reload-and-cli.md`

## Description
Wire the discovery + registry primitives into the running daemon: a SIGUSR1 trap in `bin/supervisor-loop.sh` triggers a re-scan of the plugin directory, the registry is replaced atomically (in-flight executions complete with the OLD snapshot), and the diff (added/removed/changed hooks) is logged. Two new CLI subcommands — `autonomous-dev plugin list` and `autonomous-dev plugin reload` — give operators visibility and control without restarting the daemon. Communication between CLI and daemon flows through a Unix domain socket at `~/.autonomous-dev/daemon.sock` (POSIX-only; Windows support is an explicit non-goal per PLAN-019-1's risk register).

This spec is the "operator-facing" face of PLAN-019-1: everything below the API surface (types, discovery, registry, executor) is invisible until this layer exposes it.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/hooks/reload-controller.ts` | Create | Encapsulates reload + diff logic |
| `plugins/autonomous-dev/src/hooks/ipc-server.ts` | Create | Unix socket server inside daemon |
| `plugins/autonomous-dev/src/hooks/ipc-client.ts` | Create | CLI-side socket client |
| `plugins/autonomous-dev/bin/reload-plugins.js` | Create | Shim invoked from supervisor-loop.sh |
| `plugins/autonomous-dev/bin/supervisor-loop.sh` | Modify | Add SIGUSR1 trap |
| `plugins/autonomous-dev/src/cli/commands/plugin.ts` | Create | `list` + `reload` subcommands |
| `plugins/autonomous-dev/src/cli/dispatcher.ts` | Modify | Register `plugin` subcommand group |

## Implementation Details

### `src/hooks/reload-controller.ts`

```ts
import { PluginDiscovery } from './discovery';
import { HookRegistry } from './registry';
import type { HookPoint } from './types';

export interface ReloadDiff {
  added: Array<{ pluginId: string; hookPoint: HookPoint; hookId: string; priority: number }>;
  removed: Array<{ pluginId: string; hookPoint: HookPoint; hookId: string; priority: number }>;
  changed: Array<{ pluginId: string; hookPoint: HookPoint; hookId: string; before: number; after: number }>;
}

export class ReloadController {
  constructor(
    private readonly discovery: PluginDiscovery,
    private readonly registry: HookRegistry,
    private readonly pluginRoot: string,
  ) {}

  async reload(): Promise<ReloadDiff> { /* ... */ }
}
```

Behavior contract:

1. Capture `before = registry.snapshot()`.
2. Build a NEW empty `HookRegistry` instance (do not mutate the live one yet).
3. Run `await discovery.scan(pluginRoot)`. For each successful result, `newRegistry.register(manifest, pluginRoot/<name>)`.
4. Capture `after = newRegistry.snapshot()`.
5. Compute diff: identity is `(pluginId, hookId)`; "changed" means same identity but different priority; "added"/"removed" follow naturally.
6. **Atomic swap**: replace the live registry's internal map with the new registry's map in a single synchronous assignment. Existing snapshot references continue to work (they are independent frozen views).
7. Log a single INFO line: `reload: +N -M ~K` (N added, M removed, K changed) followed by per-hook DETAIL lines at INFO if any change is non-zero.
8. Debounce: rapid successive `reload()` calls within 100ms collapse into a single execution (the controller holds an in-flight Promise; concurrent callers `await` the same Promise).

### `src/hooks/ipc-server.ts`

```ts
import * as net from 'node:net';

export interface IpcRequest {
  command: 'list' | 'reload';
}
export interface IpcResponse {
  status: 'ok' | 'error';
  payload?: unknown;
  error?: string;
}
```

- Listens on `~/.autonomous-dev/daemon.sock` (path is `${process.env.HOME}/.autonomous-dev/daemon.sock`). Creates the parent directory with mode `0700` if absent.
- On startup, removes stale socket file if present (after verifying no daemon is listening — connect attempt fails fast).
- Accepts newline-delimited JSON requests, returns newline-delimited JSON responses, then closes the connection.
- `command: 'list'` → returns `payload: RegistrySnapshot` flattened into an array of `{ pluginId, pluginVersion, hookPoint, hookId, priority, failureMode }`.
- `command: 'reload'` → invokes `ReloadController.reload()`, returns `payload: ReloadDiff`.
- Permissions: socket file mode `0600`. Loopback-only by nature of UDS.

### `src/hooks/ipc-client.ts`

- Connects to the same socket path. If the socket is missing, prints a friendly message: "daemon is not running (no socket at ~/.autonomous-dev/daemon.sock)" and exits 1.
- Sends a single request, awaits a single response, prints the result.
- 5-second timeout on connect; 30-second timeout on response (covers worst-case reload of 50 plugins).

### `bin/reload-plugins.js`

A 30-line Node shim invoked from the shell trap:

```js
#!/usr/bin/env node
const client = require('../src/hooks/ipc-client');
client.send({ command: 'reload' })
  .then(r => process.exit(r.status === 'ok' ? 0 : 1))
  .catch(() => process.exit(1));
```

### `bin/supervisor-loop.sh` modifications

Add (near the top, after existing trap declarations):

```sh
trap 'node "$(dirname "$0")/reload-plugins.js" >> "$LOG_FILE" 2>&1 &' USR1
```

The trailing `&` keeps the trap non-blocking so the supervisor loop continues immediately. Reload completes asynchronously; the log line is the source of truth for "reload done."

### `src/cli/commands/plugin.ts`

Two subcommands under the `plugin` group:

**`autonomous-dev plugin list [--json]`**:
- Sends `{ command: 'list' }` over IPC.
- Default rendering: a table with columns `Plugin ID | Version | Hook Point | Priority | Failure Mode`. Sorted by `(hookPoint, -priority, pluginId)`.
- `--json`: prints the raw payload array.
- Empty registry: prints `(no plugins registered)` (or `[]` with `--json`).
- Daemon not running: exit 1, message on stderr.

**`autonomous-dev plugin reload`**:
- Sends `{ command: 'reload' }` over IPC.
- Awaits the response containing the diff.
- Prints a one-line summary `reload complete: +N -M ~K` followed by per-change detail lines.
- Exit 0 on `status: 'ok'`, exit 1 on `'error'` or timeout (30s).

### `src/cli/dispatcher.ts`

Add a route entry mapping `plugin` to the new `plugin` command group; reuses the existing dispatcher pattern (see PLAN-001-1's CLI scaffolding).

## Acceptance Criteria

### Reload

- [ ] Sending `kill -USR1 <daemon-pid>` triggers a reload that completes in < 500ms for a fixture directory with 3 plugins (per TDD-019 §16).
- [ ] The daemon log records exactly one `reload: +N -M ~K` line per SIGUSR1 (debounced).
- [ ] Adding a new plugin file then sending SIGUSR1 results in a diff with `added.length === <new hook count>` and `removed.length === 0`.
- [ ] Removing a plugin directory then sending SIGUSR1 results in a diff with `removed.length === <removed hook count>` and `added.length === 0`.
- [ ] Bumping a hook's `priority` in its manifest then SIGUSR1 produces a `changed` entry with correct `before` and `after`.
- [ ] In-flight `executor.executeHooks` calls running at the moment of reload complete with the OLD snapshot (verified by a fixture hook that sleeps 200ms while a reload fires at t=50ms; the call still returns the original hook list's outcomes).
- [ ] Two SIGUSR1s within 100ms produce ONE reload (debounced); the diff reflects the final on-disk state.
- [ ] Reload of a directory containing a malformed plugin: the malformed plugin is skipped (logged as error), other plugins reload normally, daemon does not crash.

### IPC + CLI

- [ ] `autonomous-dev plugin list` against a daemon with the 3 fixture plugins prints a table with the right rows; sort order is by `(hookPoint, -priority, pluginId)`.
- [ ] `autonomous-dev plugin list --json` emits a parseable JSON array (`jq -e .` exit 0) whose length equals the total registered hook count.
- [ ] `autonomous-dev plugin list` against an empty registry prints `(no plugins registered)` and exits 0.
- [ ] `autonomous-dev plugin reload` exits 0 after the daemon log confirms reload (the IPC response IS the confirmation; no log-tailing required).
- [ ] `autonomous-dev plugin reload` against a daemon that takes > 30s to reload exits 1 with a timeout message on stderr.
- [ ] `autonomous-dev plugin list` when no daemon is running exits 1 within 5s with `daemon is not running` on stderr.
- [ ] Socket file `~/.autonomous-dev/daemon.sock` is created with mode `0600`.
- [ ] Socket parent directory `~/.autonomous-dev/` is created with mode `0700` if absent.
- [ ] Stale socket from a prior crashed daemon is removed and replaced on daemon startup; the running CLI's old connection (if any) gets ECONNREFUSED, not silent hang.

### Supervisor

- [ ] `bin/supervisor-loop.sh` passes `shellcheck` with no warnings.
- [ ] The SIGUSR1 trap does NOT block the supervisor's main loop (verified by sending SIGUSR1 while a long-running supervised process is active; supervised process is unaffected).
- [ ] `bin/reload-plugins.js` is executable (`chmod +x`) and has the `#!/usr/bin/env node` shebang.

## Dependencies

- SPEC-019-1-01 (types), SPEC-019-1-02 (discovery), SPEC-019-1-03 (registry + executor) — all imported.
- Node ≥ 18 (`net.createServer` UDS support).
- Existing supervisor-loop.sh from PLAN-001-2 (modified).
- Existing CLI dispatcher from PLAN-001-1 (extended).

## Notes

- POSIX-only is by design. The Windows compatibility issue is captured in PLAN-019-1's risk register and tracked as a future open question. Operators on Windows can install via WSL2 today.
- The reload-controller's "atomic swap" is a single JavaScript assignment to the registry's internal `byPoint` field, exposed via a `_replaceInternal(map)` method on `HookRegistry` that is documented as "for ReloadController only." This is intentionally not part of the public API.
- The 100ms debounce is implemented via a single shared in-flight `Promise<ReloadDiff>` field on the controller. New `reload()` calls within the window get the same Promise. After resolution, the field is cleared.
- The IPC protocol is intentionally minimal (newline-delimited JSON, two commands). PLAN-019-2/3/4 may add commands (`plugin trust`, `plugin verify`); the dispatcher in `ipc-server.ts` is structured as a switch so adding a case is a 5-line change.
- Operators should add `kill -USR1 $(cat ~/.autonomous-dev/daemon.pid)` to any deployment script that updates plugin manifests; this is documented in the README addition that ships with PLAN-019-1's docs spec (out of scope here).
- Logging passes through `console.info` placeholders identical to SPEC-019-1-02; PLAN-001-3's logger swap-in is a follow-up.

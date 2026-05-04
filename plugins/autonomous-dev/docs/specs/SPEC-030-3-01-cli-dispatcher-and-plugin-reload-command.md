# SPEC-030-3-01: CLI Dispatcher + `plugin reload` Command Module

## Metadata
- **Parent Plan**: PLAN-030-3 (TDD-019 plugin-reload CLI closeout)
- **Parent TDD**: TDD-030 §7, §7.3, §7.4
- **Tasks Covered**: TASK-001 (dispatcher.ts + commands/plugin.ts)
- **Estimated effort**: 1 day
- **Depends on**: none (first spec in PLAN-030-3)
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-030-3-01-cli-dispatcher-and-plugin-reload-command.md`

## Description

Create the two new modules that implement the CLI surface for `plugin reload`: a pure dispatcher that maps `argv` to commands, and a command module that issues the daemon-reload RPC and returns a structured exit code.

Per TDD-030 §7 / OQ-30-04, the as-built path is `intake/cli/...` (PRD-016 originally cited `src/cli/...`; TDD-031 will amend the SPEC). This spec uses `intake/cli/...` exclusively.

The implementation uses **deterministic invalidation** — an explicit reload message to the daemon — NOT file-watcher-driven reload (TDD-030 §7.4 / PRD-016 R-06; NG-3006 forbids the watcher path here).

Both modules are **pure** in the sense relevant for testing: they accept `argv` and a logger, return a number, and never call `process.exit` (per PRD-016 FR-1660). The thin wrapper at `bin/reload-plugins.js` (SPEC-030-3-02) is the **only** place `process.exit` is permitted in this plan.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/intake/cli/dispatcher.ts` | Create | `dispatch(argv, deps?) → Promise<number>` |
| `plugins/autonomous-dev/intake/cli/commands/plugin.ts` | Create | Implements `plugin reload <name>`; returns exit code |
| `plugins/autonomous-dev/intake/cli/dispatcher.test.ts` | Create | Pure unit tests for argv routing + exit codes |
| `plugins/autonomous-dev/intake/cli/commands/plugin.test.ts` | Create | Pure unit tests with a fake daemon-reload hook |

The plan calls for the integration test in TASK-003 (SPEC-030-3-03). The two unit tests added here cover the pure behaviors of the dispatcher and command module without spawning a daemon — they ride alongside the integration test, not in place of it.

## Implementation Details

### Exit-code contract (TDD-030 §7.3)

| Exit code | Meaning |
|-----------|---------|
| `0` | Success — daemon confirmed reload of the named plugin |
| `1` | Transient failure — daemon unreachable, RPC timeout, or daemon returned a retriable error |
| `2` | Configuration / usage error — unknown command, malformed argv, invalid plugin name, manifest unparseable, daemon returned a non-retriable error |

Unhandled errors thrown from inside the command module are caught at the dispatcher boundary and mapped to exit 2.

### `intake/cli/dispatcher.ts`

```ts
// SPDX: per repo
import { runPluginReload, type PluginReloadDeps } from './commands/plugin';

export interface DispatcherDeps {
  logger?: Pick<Console, 'log' | 'error' | 'warn'>;
  pluginReload?: PluginReloadDeps;
}

const USAGE = `\
Usage:
  reload-plugins <plugin-name>           # equivalent to: plugin reload <plugin-name>
  reload-plugins plugin reload <name>

Exit codes:
  0  Success
  1  Transient failure (daemon unreachable / timeout)
  2  Configuration error (unknown command, invalid args, bad manifest)
`;

export async function dispatch(
  argv: ReadonlyArray<string>,
  deps: DispatcherDeps = {},
): Promise<number> {
  const log = deps.logger ?? console;

  // Accept both `plugin reload <name>` and the bare `<name>` shorthand
  // (the bin/ wrapper is named reload-plugins so the verb is implied).
  let pluginName: string | undefined;
  if (argv.length === 1) {
    pluginName = argv[0];
  } else if (argv.length === 3 && argv[0] === 'plugin' && argv[1] === 'reload') {
    pluginName = argv[2];
  } else {
    log.error(USAGE);
    return 2;
  }

  if (!pluginName || !/^[A-Za-z0-9._-]+$/.test(pluginName)) {
    log.error(`Invalid plugin name: ${JSON.stringify(pluginName)}`);
    log.error(USAGE);
    return 2;
  }

  try {
    return await runPluginReload(pluginName, deps.pluginReload, log);
  } catch (err) {
    // Defense-in-depth: any uncaught throw maps to exit 2.
    log.error(`reload-plugins: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}
```

Constraints:
- The dispatcher does NOT read `process.argv`, does NOT call `process.exit`, and does NOT touch the filesystem directly.
- The dispatcher's only input is the `argv` array and the optional `deps`.
- The dispatcher's only output is a `Promise<number>` and writes to `deps.logger` (default `console`).

### `intake/cli/commands/plugin.ts`

```ts
import type { Logger } from './types'; // or inline the type if no shared types module exists

export interface PluginReloadDeps {
  /** RPC client that issues the reload message to the daemon. */
  reloadHook: (pluginName: string, opts: { timeoutMs: number }) => Promise<ReloadResult>;
  /** Allow tests to inject a deterministic timeout. */
  timeoutMs?: number;
}

export type ReloadResult =
  | { kind: 'ok'; version: string }
  | { kind: 'transient'; message: string }   // daemon unreachable / timeout
  | { kind: 'config-error'; message: string }; // bad manifest / unknown plugin

const DEFAULT_TIMEOUT_MS = 5_000;

export async function runPluginReload(
  pluginName: string,
  deps: PluginReloadDeps | undefined,
  log: Pick<Console, 'log' | 'error'>,
): Promise<number> {
  if (!deps?.reloadHook) {
    log.error('reload-plugins: daemon reload hook not configured');
    return 2;
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = await deps.reloadHook(pluginName, { timeoutMs });

  switch (result.kind) {
    case 'ok':
      log.log(`reload-plugins: ${pluginName} reloaded (version ${result.version})`);
      return 0;
    case 'transient':
      log.error(`reload-plugins: transient failure: ${result.message}`);
      return 1;
    case 'config-error':
      log.error(`reload-plugins: configuration error: ${result.message}`);
      return 2;
  }
}
```

The `reloadHook` injection point is the seam the integration test (SPEC-030-3-03) uses to drive a real daemon, and the seam this spec's unit tests use to exercise each branch of the contract without spawning anything.

The **default** `reloadHook` (used by the production `bin/` wrapper) is a thin RPC client over whatever transport the daemon already exposes from TDD-019. **Before authoring**, the implementer MUST inspect the daemon source to confirm an importable reload hook exists. If it does not exist as a callable function, this task is **paused** and the gap is escalated; this plan does NOT invent new daemon mechanics (per PLAN-030-3 risk note).

Where the default hook lives: option A — it lives in `commands/plugin.ts` itself as a `defaultReloadHook` exported alongside `runPluginReload`. Option B — it lives in a new `intake/cli/clients/plugin-reload-client.ts`. The implementer picks A for first cut; refactor to B only if the file exceeds ~120 lines.

### `intake/cli/dispatcher.test.ts` — unit tests

```ts
import { dispatch } from './dispatcher';

const buffer = () => {
  const lines: string[] = [];
  return {
    log: (...a: unknown[]) => lines.push(`OUT:${a.join(' ')}`),
    error: (...a: unknown[]) => lines.push(`ERR:${a.join(' ')}`),
    warn: (...a: unknown[]) => lines.push(`WARN:${a.join(' ')}`),
    lines,
  };
};
```

| Case | argv | Mocked reloadHook | Expected exit | Expected stderr/stdout |
|------|------|--------------------|---------------|------------------------|
| Bare success | `['my-plugin']` | returns `{kind:'ok', version:'1.2.3'}` | 0 | stdout includes `1.2.3` |
| Verb form success | `['plugin','reload','my-plugin']` | same | 0 | same |
| Transient failure | `['my-plugin']` | returns `{kind:'transient', message:'ECONNREFUSED'}` | 1 | stderr includes `ECONNREFUSED` |
| Config-error from daemon | `['my-plugin']` | returns `{kind:'config-error', message:'manifest.json invalid'}` | 2 | stderr includes `manifest.json invalid` |
| Unknown command | `['foo','bar']` | _(not called)_ | 2 | stderr includes `Usage:` |
| Empty argv | `[]` | _(not called)_ | 2 | stderr includes `Usage:` |
| Bad plugin name (path traversal) | `['../etc/passwd']` | _(not called)_ | 2 | stderr includes `Invalid plugin name` |
| Bad plugin name (whitespace) | `['hello world']` | _(not called)_ | 2 | stderr includes `Invalid plugin name` |
| Hook throws | `['my-plugin']` | throws `new Error('boom')` | 2 | stderr includes `boom` |
| No hook configured | `['my-plugin']` | `deps` undefined | 2 | stderr includes `daemon reload hook not configured` |

Every test MUST verify the exit code is one of `0`, `1`, `2` — **never** any other number. Add a final guard test: `expect([0,1,2]).toContain(await dispatch(['my-plugin'], {pluginReload: {reloadHook: () => ({kind:'ok',version:'x'})}}))`.

### `intake/cli/commands/plugin.test.ts` — unit tests

Smaller test set — exercises the kind/exit-code mapping in isolation:

| Case | reloadHook returns | Expected exit |
|------|--------------------|---------------|
| ok | `{kind:'ok', version:'1.0.0'}` | 0 |
| transient | `{kind:'transient', message:'timeout'}` | 1 |
| config-error | `{kind:'config-error', message:'unknown plugin'}` | 2 |

Plus one test that asserts the timeout default is `5000` if `deps.timeoutMs` is unset (verify `reloadHook` was called with `{timeoutMs: 5000}`).

## Acceptance Criteria

- AC-1: `plugins/autonomous-dev/intake/cli/dispatcher.ts` exists and exports `dispatch(argv, deps?): Promise<number>`.
- AC-2: `plugins/autonomous-dev/intake/cli/commands/plugin.ts` exists and exports `runPluginReload(name, deps, log): Promise<number>` plus the `PluginReloadDeps` and `ReloadResult` types.
- AC-3: `dispatch(['plugin', 'reload', 'my-plugin'], deps)` resolves with `0` when the injected hook returns `{kind:'ok', ...}`, `1` for `{kind:'transient', ...}`, `2` for `{kind:'config-error', ...}`.
- AC-4: `dispatch(['my-plugin'], deps)` (the shorthand) routes to the same code path as the verb form.
- AC-5: Unknown command (`['foo','bar']`), empty argv (`[]`), invalid plugin name (path-traversal or whitespace), and uncaught hook throws all resolve with `2` and write a usage / error string to `deps.logger.error`.
- AC-6: Neither module calls `process.exit`. `grep -E "process\\.exit" intake/cli/dispatcher.ts intake/cli/commands/plugin.ts` returns zero hits.
- AC-7: Neither module reads `process.argv`. `grep -E "process\\.argv" intake/cli/dispatcher.ts intake/cli/commands/plugin.ts` returns zero hits.
- AC-8: Both modules pass `tsc --noEmit` from the autonomous-dev plugin.
- AC-9: `npx jest plugins/autonomous-dev/intake/cli/` from the plugin root exits 0; both unit-test files run.
- AC-10: The dispatcher caps return values to `0 | 1 | 2`. A test asserts `[0,1,2].includes(actual)` for at least one passing case.
- AC-11: The plugin-name validator rejects `..`, `/`, `\\`, and whitespace; accepts `[A-Za-z0-9._-]+`.
- AC-12: If the production daemon-reload hook is not importable from existing daemon source, the implementer pauses and escalates per PLAN-030-3 TASK-001 risk note. **The implementer does not invent a new daemon RPC mechanism in this spec.**

### Given/When/Then

```
Given a dispatcher and an injected reloadHook that returns { kind: 'ok', version: '1.2.3' }
When dispatch(['plugin', 'reload', 'my-plugin'], { pluginReload: { reloadHook } }) is awaited
Then the resolved value is 0
And the logger received a stdout line containing "1.2.3"

Given a dispatcher and an injected reloadHook that returns { kind: 'transient', message: 'ECONNREFUSED' }
When dispatch(['my-plugin'], { pluginReload: { reloadHook } }) is awaited
Then the resolved value is 1
And the logger received a stderr line containing "ECONNREFUSED"

Given a dispatcher
When dispatch(['some', 'unknown', 'command']) is awaited
Then the resolved value is 2
And the logger received a stderr line containing "Usage:"

Given a dispatcher
When dispatch(['../etc/passwd']) is awaited
Then the resolved value is 2
And the logger received a stderr line containing "Invalid plugin name"
And no reloadHook is invoked

Given a dispatcher and a reloadHook that throws Error('boom')
When dispatch(['my-plugin'], { pluginReload: { reloadHook } }) is awaited
Then the resolved value is 2
And the logger received a stderr line containing "boom"
```

## Test Requirements

The two unit-test files must:
1. Pass under `npx jest --runInBand`.
2. Run without spawning any subprocess; no `child_process` imports.
3. Inject a fake `reloadHook` rather than mocking modules.
4. Assert exit codes are exactly one of `0 | 1 | 2`.
5. Capture log output via an injected logger; never spy on `console`.

## Implementation Notes

- **Daemon hook discovery**: read TDD-019's daemon source first. The hook may be named `reloadPlugin`, `invalidatePlugin`, `hotReloadPlugin`, etc. The exact import path lives wherever TDD-019 placed it; do NOT guess.
- **Path-traversal validation**: the regex `^[A-Za-z0-9._-]+$` is intentionally strict. Plugin names with `/` or `..` would let a malicious operator address arbitrary daemon-side paths. Reviewer should treat any loosening of this regex as a security concern.
- **Exit-code arithmetic**: never `return -1` or `return 3`. The exit-code surface is exactly `{0, 1, 2}`. A test asserts the closed set.
- **Logger injection**: the `deps.logger` parameter exists primarily for the integration test (SPEC-030-3-03), which captures stderr/stdout into a buffer rather than swapping `process.stderr`. The unit tests use the same injection.
- **Async error handling**: every awaited call inside `dispatch` is wrapped in the outer `try/catch`. Synchronous throws in `runPluginReload` are also caught.
- **`bin/reload-plugins.js` is a separate spec** (SPEC-030-3-02). DO NOT add wrapper / shebang code here.
- **No file-watcher logic**: the reload is deterministic (explicit RPC). NG-3006 forbids file-watcher-driven reload here.
- The `intake/cli/types.ts` module mentioned in the example imports may not exist; if not, inline the `Logger` shape (`Pick<Console, 'log'|'error'|'warn'>`) and skip creating a shared types file.

## Rollout Considerations

Both modules are inert until imported — `bin/reload-plugins.js` (SPEC-030-3-02) is the activation point. Merging this spec alone does not change runtime behavior of any existing CLI or daemon. Revert by deleting the four files.

## Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| TDD-019's daemon reload hook does not exist as importable | Medium | High (blocking) | Inspect daemon source FIRST; if absent, escalate and pause; do not invent (per PLAN-030-3 TASK-001 risk) |
| Plugin-name regex too permissive (lets path traversal through) | Low | High (security) | Strict `^[A-Za-z0-9._-]+$`; reviewer treats any loosening as security review |
| Exit code outside {0,1,2} sneaks in | Low | Medium (contract) | Test asserts `[0,1,2].includes(actual)`; reviewer enforces |
| `process.exit` accidentally added to dispatcher | Low | Medium (FR-1660) | Pre-commit lint; grep AC-6 |
| The `deps.pluginReload.reloadHook` interface drifts vs the production hook signature | Medium | Medium | Type the production hook against the same `(name, opts) => Promise<ReloadResult>` shape; TS catches drift at compile time |
| Logger injection breaks an existing CLI that depends on `console` directly | Low | Low | The default `deps.logger` is `console`; existing call sites unaffected |
| The 5000 ms default timeout proves too short on slow CI | Low | Low | Tests inject `timeoutMs: 250`; the default is for production, not tests |

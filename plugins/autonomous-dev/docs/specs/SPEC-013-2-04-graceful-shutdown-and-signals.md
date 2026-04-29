# SPEC-013-2-04: Graceful Shutdown, Signal Handling, and Connection Draining

## Metadata
- **Parent Plan**: PLAN-013-2
- **Tasks Covered**: TASK-007 (graceful shutdown sequence + signal handlers + connection drain)
- **Estimated effort**: 4 hours

## Description
Implement the shutdown lifecycle that runs when the server receives `SIGTERM` or `SIGINT`. The server MUST stop accepting new connections immediately, allow in-flight requests up to a configurable grace period to complete, run a registered list of cleanup hooks (for future plans to attach to), and force-exit if the grace period is exceeded. Edge cases — second signal during shutdown, signal received before the server is fully bound, uncaught exceptions, unhandled promise rejections — are all routed through the same handler so the process never hangs and exit codes are deterministic (0 = clean, 1 = forced).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `server/lib/shutdown.ts` | Create | `setupGracefulShutdown` + `registerShutdownHook` + connection counter |
| `server/lib/connection-tracker.ts` | Create | Lightweight active-request counter middleware |
| `server/middleware/index.ts` | Modify | Insert `connectionCounter()` middleware as the first thing inside the chain |

## Implementation Details

### Task 1: Connection Counter Middleware (`connection-tracker.ts`)

Bun's `Server` does not expose an active-connections API at the connection level, but request-level tracking is sufficient for our drain semantics (we drain requests, not raw sockets). Implement a counter that increments on request entry and decrements on completion.

```ts
import type { MiddlewareHandler } from 'hono';

let active = 0;
let drainResolver: (() => void) | null = null;

export function connectionCounter(): MiddlewareHandler {
  return async (c, next) => {
    active++;
    try {
      await next();
    } finally {
      active--;
      if (active === 0 && drainResolver) {
        const r = drainResolver;
        drainResolver = null;
        r();
      }
    }
  };
}

export function getActiveRequestCount(): number {
  return active;
}

export function waitForDrain(timeoutMs: number): Promise<{ drained: boolean; remaining: number }> {
  if (active === 0) return Promise.resolve({ drained: true, remaining: 0 });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      drainResolver = null;
      resolve({ drained: false, remaining: active });
    }, timeoutMs);
    drainResolver = () => {
      clearTimeout(timer);
      resolve({ drained: true, remaining: 0 });
    };
  });
}
```

- Module-level state (`active`, `drainResolver`) is intentional. There is exactly one server instance per process; making this an instance class would add complexity without benefit. Tests reset state via an exported `__resetForTesting()` helper.
- `connectionCounter()` MUST be the FIRST middleware registered in `applyMiddlewareChain`, before `requestIdMiddleware`. This ensures the counter increments BEFORE any other work and decrements AFTER everything else in the chain (including the error boundary).

### Task 2: Modify `middleware/index.ts` (SPEC-013-2-02)

Insert the connection counter at the top of the chain:

```ts
import { connectionCounter } from '../lib/connection-tracker';

export function applyMiddlewareChain(app: Hono, config: PortalConfig): void {
  app.use('*', connectionCounter());                                 // 0. drain tracking (added by SPEC-013-2-04)
  app.use('*', requestIdMiddleware());                               // 1. correlation
  // ... rest of chain unchanged ...
}
```

### Task 3: Shutdown Coordinator (`server/lib/shutdown.ts`)

```ts
import type { Server } from 'bun';
import type { ServerState } from '../server';
import type { PortalConfig } from './config';
import { waitForDrain, getActiveRequestCount } from './connection-tracker';

export type ShutdownHook = (signal: string) => Promise<void> | void;
const hooks: ShutdownHook[] = [];

export function registerShutdownHook(hook: ShutdownHook): void {
  hooks.push(hook);
}

export function __resetHooksForTesting(): void {
  hooks.length = 0;
}

export function setupGracefulShutdown(
  server: Server,
  state: ServerState,
  config: PortalConfig,
): void {
  const log = (phase: string, extra: Record<string, unknown> = {}) =>
    process.stderr.write(JSON.stringify({
      ts: new Date().toISOString(), phase, ...extra,
    }) + '\n');

  let signalCount = 0;

  const shutdown = async (signal: string): Promise<void> => {
    signalCount++;
    if (signalCount === 2) {
      log('shutdown_force_signal', { signal });
      process.exit(1);
    }
    if (signalCount > 2) return;

    if (state.shutdownInProgress) return;
    state.shutdownInProgress = true;

    const t0 = Date.now();
    log('shutdown_initiated', { signal, active_requests: getActiveRequestCount() });

    // Hard timeout regardless of progress.
    const forceTimer = setTimeout(() => {
      log('shutdown_force_timeout', {
        elapsed_ms: Date.now() - t0,
        remaining: getActiveRequestCount(),
      });
      process.exit(1);
    }, config.shutdown.force_timeout_ms);

    try {
      // 1. Stop accepting new connections immediately.
      server.stop();
      log('shutdown_listener_stopped');

      // 2. Drain in-flight requests up to grace_period_ms.
      const drainResult = await waitForDrain(config.shutdown.grace_period_ms);
      log('shutdown_drain_complete', drainResult);

      // 3. Run registered hooks sequentially. Hook errors are logged but do not abort.
      for (const hook of hooks) {
        try {
          await hook(signal);
        } catch (err) {
          log('shutdown_hook_failed', { message: (err as Error).message });
        }
      }
      log('shutdown_hooks_complete', { hook_count: hooks.length });

      clearTimeout(forceTimer);
      log('shutdown_complete', { elapsed_ms: Date.now() - t0, exit_code: 0 });
      process.exit(0);
    } catch (err) {
      clearTimeout(forceTimer);
      log('shutdown_error', { message: (err as Error).message });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    log('uncaught_exception', { message: err.message, stack: err.stack });
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log('unhandled_rejection', { reason: String(reason) });
    void shutdown('unhandledRejection');
  });
}

export function setupShutdownPreBoot(): void {
  // For the window between process start and `setupGracefulShutdown`,
  // a pre-boot handler ensures signals exit immediately rather than being ignored.
  const preBoot = (sig: string) => {
    process.stderr.write(JSON.stringify({
      ts: new Date().toISOString(),
      phase: 'shutdown_pre_boot',
      signal: sig,
    }) + '\n');
    process.exit(1);
  };
  process.once('SIGTERM', () => preBoot('SIGTERM'));
  process.once('SIGINT',  () => preBoot('SIGINT'));
}
```

- The `setupGracefulShutdown` function REPLACES `process.on('SIGTERM'|'SIGINT')` listeners by attaching new ones AFTER `setupShutdownPreBoot` has detached its `once` handlers (Node `once` removes the listener after firing). To make this clean, when `setupGracefulShutdown` runs it MUST call `process.removeAllListeners('SIGTERM')` and `process.removeAllListeners('SIGINT')` before attaching its own. Add those two lines at the start of the function.
- `setupShutdownPreBoot()` is called from `server/server.ts` at the very top of `startServer()`, BEFORE `loadPortalConfig`. This handles the "signal during startup" edge case from the plan.
- The second signal forces `process.exit(1)` immediately. This matches operator expectations: pressing Ctrl+C twice on a hung shutdown should kill the process.
- Hook failures are logged but never abort the shutdown sequence. A misbehaving plugin must not block process exit.

### Task 4: Wire Shutdown into Bootstrap

Modify `server/server.ts` (SPEC-013-2-01):

```ts
import { setupGracefulShutdown, setupShutdownPreBoot } from './lib/shutdown';

export async function startServer(): Promise<Server> {
  setupShutdownPreBoot();                                           // FIRST line in startServer
  // ... existing flow ...
  setupGracefulShutdown(server, state, config);                     // pass config now (signature change from SPEC-013-2-01)
  return server;
}
```

The `setupGracefulShutdown` signature in SPEC-013-2-01 originally took `(server, state)`. This spec extends it to `(server, state, config)`. The bootstrap import line is updated accordingly.

## Acceptance Criteria

- [ ] Sending `SIGTERM` to a running server with no active requests results in exit code 0 within 1 second
- [ ] Sending `SIGTERM` to a server with one in-flight 5-second request waits for that request to complete (up to `grace_period_ms`), responds to the client successfully, then exits 0
- [ ] Sending `SIGTERM` with a request that exceeds `grace_period_ms` (10 s) but completes before `force_timeout_ms` (15 s) emits `shutdown_drain_complete` with `drained: false, remaining: 1` and proceeds to hooks (eventually exiting 0 if hooks finish in time, else 1 via the force timer)
- [ ] Sending two consecutive `SIGINT` signals causes immediate `process.exit(1)` with `shutdown_force_signal` log line
- [ ] After `server.stop()`, new TCP connections to the port receive `ECONNREFUSED` (verified by attempting a fresh `curl` post-shutdown)
- [ ] `registerShutdownHook(async (sig) => { ... })` registers a hook that fires during shutdown with the triggering signal name
- [ ] A hook that throws an error logs `shutdown_hook_failed` and does NOT prevent subsequent hooks or process exit
- [ ] An uncaught synchronous exception in a request handler triggers `uncaught_exception` log followed by the standard shutdown sequence
- [ ] An unhandled promise rejection triggers `unhandled_rejection` log followed by the standard shutdown sequence
- [ ] Sending `SIGINT` BEFORE `setupGracefulShutdown` is called (i.e., during `loadPortalConfig`) produces a `shutdown_pre_boot` log and exits 1
- [ ] `getActiveRequestCount()` returns 0 between requests, increments on entry, decrements on completion (including when the handler throws)
- [ ] Forcing the timeout (request that never completes, e.g., a hanging `await new Promise(() => {})`) produces a `shutdown_force_timeout` log with `remaining > 0` and exits 1
- [ ] Connection counter middleware is registered as the FIRST entry in the middleware chain (verified by behavioral test in SPEC-013-2-05)

## Dependencies

- **Consumes**: `PortalConfig.shutdown` from SPEC-013-2-03 (provides `grace_period_ms` and `force_timeout_ms`); `ServerState` from SPEC-013-2-01.
- **Modifies**: `server/middleware/index.ts` from SPEC-013-2-02 (adds `connectionCounter()` as middleware position 0); `server/server.ts` from SPEC-013-2-01 (calls `setupShutdownPreBoot()` first; passes `config` to `setupGracefulShutdown`).
- **Exposes**: `setupGracefulShutdown(server, state, config)`, `setupShutdownPreBoot()`, `registerShutdownHook(hook)`, `getActiveRequestCount()`, `waitForDrain(ms)` — `registerShutdownHook` is the integration point for future plans (TDD-015 SSE connections, file watchers, etc.).

## Notes

- Bun does not yet expose a connection-level drain primitive (as of Bun 1.0). Tracking active **requests** via middleware is correct for our use case: the only "connections" we care about are those running through the Hono app. Long-lived SSE connections introduced by TDD-015 will register their own shutdown hook and close their streams from inside that hook; the connection counter middleware does not need to know about them.
- Module-level state in `connection-tracker.ts` is acceptable because there is exactly one server instance per Bun process. The `__resetForTesting()` export exists solely to allow unit tests in SPEC-013-2-05 to clear state between tests.
- We deliberately do NOT use the abstract `SignalManager` class shown in the plan's reference snippet. A flat function with a `signalCount` closure variable is simpler, easier to test, and covers every documented edge case.
- The pre-boot signal handler (`setupShutdownPreBoot`) is registered with `process.once`. When `setupGracefulShutdown` runs, it explicitly removes listeners before attaching its own, so even if the `once` handlers were never triggered they cannot fire after the real shutdown logic is wired up.
- Exit codes: `0` for clean shutdown via grace-period drain + hooks, `1` for forced shutdown (timeout, second signal, hook-loop exception, pre-boot signal, uncaughtException, unhandledRejection).

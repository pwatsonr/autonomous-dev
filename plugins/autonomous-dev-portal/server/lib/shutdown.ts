// SPEC-013-2-04 §Task 3 — Graceful shutdown coordinator.
//
// Sequence on SIGTERM/SIGINT:
//   1. server.stop() — refuse new connections immediately
//   2. waitForDrain(grace_period_ms) — let in-flight requests complete
//   3. Run registered shutdown hooks sequentially (errors logged, not fatal)
//   4. process.exit(0) on clean drain + hooks; process.exit(1) on force
//
// Edge cases all routed through the same handler:
//   - Second signal during shutdown → immediate process.exit(1)
//   - Signal before bootstrap finishes → setupShutdownPreBoot exits 1
//   - Uncaught exception / unhandled rejection → routed through shutdown
//
// Hooks are ordered by registration. A failing hook does not abort the
// sequence — a misbehaving plugin must not block process exit.

import type { Server } from "bun";

import { getActiveRequestCount, waitForDrain } from "./connection-tracker";
import type { PortalConfig } from "./config";
import type { ServerState } from "../server";

export type ShutdownHook = (signal: string) => Promise<void> | void;

const hooks: ShutdownHook[] = [];

export function registerShutdownHook(hook: ShutdownHook): void {
    hooks.push(hook);
}

/** Test-only: clear the hook registry. */
export function __resetHooksForTesting(): void {
    hooks.length = 0;
}

function logPhase(phase: string, extra: Record<string, unknown> = {}): void {
    process.stderr.write(
        JSON.stringify({
            ts: new Date().toISOString(),
            phase,
            ...extra,
        }) + "\n",
    );
}

export function setupGracefulShutdown(
    server: Server<unknown>,
    state: ServerState,
    config: PortalConfig,
): void {
    // Replace the pre-boot once-handlers (if still attached) with the
    // real shutdown handlers. Removing all listeners is the cleanest way
    // to ensure pre-boot handlers cannot fire after this returns even if
    // they happened to never trigger.
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");

    let signalCount = 0;

    const shutdown = async (signal: string): Promise<void> => {
        signalCount++;
        if (signalCount === 2) {
            logPhase("shutdown_force_signal", { signal });
            process.exit(1);
        }
        if (signalCount > 2) return;

        if (state.shutdownInProgress) return;
        state.shutdownInProgress = true;

        const t0 = Date.now();
        logPhase("shutdown_initiated", {
            signal,
            active_requests: getActiveRequestCount(),
        });

        // Hard timeout regardless of progress.
        const forceTimer = setTimeout(() => {
            logPhase("shutdown_force_timeout", {
                elapsed_ms: Date.now() - t0,
                remaining: getActiveRequestCount(),
            });
            process.exit(1);
        }, config.shutdown.force_timeout_ms);

        try {
            // 1. Stop accepting new connections immediately.
            server.stop();
            logPhase("shutdown_listener_stopped");

            // 2. Drain in-flight requests up to grace_period_ms.
            const drainResult = await waitForDrain(
                config.shutdown.grace_period_ms,
            );
            logPhase("shutdown_drain_complete", drainResult);

            // 3. Run registered hooks sequentially. Hook errors are
            //    logged but do not abort.
            for (const hook of hooks) {
                try {
                    await hook(signal);
                } catch (err) {
                    logPhase("shutdown_hook_failed", {
                        message: (err as Error).message,
                    });
                }
            }
            logPhase("shutdown_hooks_complete", {
                hook_count: hooks.length,
            });

            clearTimeout(forceTimer);
            logPhase("shutdown_complete", {
                elapsed_ms: Date.now() - t0,
                exit_code: 0,
            });
            process.exit(0);
        } catch (err) {
            clearTimeout(forceTimer);
            logPhase("shutdown_error", { message: (err as Error).message });
            process.exit(1);
        }
    };

    process.on("SIGTERM", () => {
        void shutdown("SIGTERM");
    });
    process.on("SIGINT", () => {
        void shutdown("SIGINT");
    });
    process.on("uncaughtException", (err: Error) => {
        logPhase("uncaught_exception", {
            message: err.message,
            stack: err.stack,
        });
        void shutdown("uncaughtException");
    });
    process.on("unhandledRejection", (reason: unknown) => {
        logPhase("unhandled_rejection", { reason: String(reason) });
        void shutdown("unhandledRejection");
    });
}

/**
 * Pre-boot signal handler. For the window between process start and
 * setupGracefulShutdown(), an unhandled SIGTERM would otherwise cause
 * Node's default behavior; we log and exit 1 deterministically instead.
 *
 * Registered with `process.once`, and explicitly removed by
 * setupGracefulShutdown when the real handlers wire up.
 */
export function setupShutdownPreBoot(): void {
    const preBoot = (sig: string): void => {
        process.stderr.write(
            JSON.stringify({
                ts: new Date().toISOString(),
                phase: "shutdown_pre_boot",
                signal: sig,
            }) + "\n",
        );
        process.exit(1);
    };
    process.once("SIGTERM", () => {
        preBoot("SIGTERM");
    });
    process.once("SIGINT", () => {
        preBoot("SIGINT");
    });
}

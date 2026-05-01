// SPEC-013-2-01 stub — minimal shutdown wiring so server.ts type-checks.
// SPEC-013-2-04 replaces this with the full implementation: drain timer,
// connection-tracker integration, hook registry, second-signal force-exit,
// and uncaught-exception/unhandled-rejection plumbing.

import type { Server } from "bun";
import type { ServerState } from "../server";

export function setupGracefulShutdown(
    server: Server<unknown>,
    state: ServerState,
): void {
    // Minimal handler: stop the server on SIGTERM/SIGINT and exit.
    // The full lifecycle (grace period, drain, hooks, force-timeout) is
    // implemented in SPEC-013-2-04.
    const handler = (signal: NodeJS.Signals): void => {
        if (state.shutdownInProgress) return;
        state.shutdownInProgress = true;
        process.stderr.write(
            JSON.stringify({
                ts: new Date().toISOString(),
                phase: "shutdown_initiated",
                signal,
            }) + "\n",
        );
        try {
            server.stop();
        } catch {
            // ignore — server may already be stopping
        }
        process.exit(0);
    };
    process.on("SIGTERM", () => handler("SIGTERM"));
    process.on("SIGINT", () => handler("SIGINT"));
}

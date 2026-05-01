// TODO(PLAN-013-1 batch 4b): wire up tsconfig.json/jest.config so this
// module is type-checked and tested under the portal's own build. For now
// it stands alone with no compile/test integration; it is verified via the
// in-tree smoke test (lifecycle.test.ts) that PLAN-013-1 batch 4 runs once
// Bun is installed locally.
//
// SPEC-013-1-02 §Task 9 — shutdown coordinator for the autonomous-dev-portal
// MCP server. Provides ordered, time-bounded cleanup of registered resources
// when the process receives SIGTERM/SIGINT. Each registered resource gets at
// most 2000ms; the entire shutdown is hard-bounded at 10000ms to honor
// Claude Code's MCP shutdown contract.

export type CleanupHandler = () => Promise<void> | void;

export interface RegisteredResource {
    name: string;
    /** Lower number runs earlier in shutdown order. */
    priority: number;
    cleanup: CleanupHandler;
}

const PER_RESOURCE_TIMEOUT_MS = 2000;
const HARD_DEADLINE_MS = 10000;

const resources: RegisteredResource[] = [];
let lifecycleInitialized = false;
let shutdownInProgress = false;

/**
 * Append a resource to the registry. Throws synchronously on invalid input.
 * The order of registration does not matter — the shutdown sequence sorts
 * by priority ascending at signal time.
 */
export function registerResource(resource: RegisteredResource): void {
    if (typeof resource !== "object" || resource === null) {
        throw new TypeError("registerResource: resource must be an object");
    }
    if (typeof resource.name !== "string" || resource.name.length === 0) {
        throw new TypeError("registerResource: name must be a non-empty string");
    }
    if (
        typeof resource.priority !== "number" ||
        !Number.isInteger(resource.priority)
    ) {
        throw new TypeError("registerResource: priority must be an integer");
    }
    if (typeof resource.cleanup !== "function") {
        throw new TypeError("registerResource: cleanup must be a function");
    }
    resources.push({
        name: resource.name,
        priority: resource.priority,
        cleanup: resource.cleanup,
    });
}

/**
 * Run a single cleanup handler with a per-resource timeout. Returns a
 * promise that resolves to "ok" | "timeout" | "error" — never rejects.
 * Errors and timeouts are logged to stderr; callers proceed regardless.
 */
async function runCleanupWithTimeout(
    resource: RegisteredResource,
): Promise<"ok" | "timeout" | "error"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), PER_RESOURCE_TIMEOUT_MS);
    });

    try {
        const cleanupPromise = (async () => {
            await resource.cleanup();
            return "ok" as const;
        })();
        const result = await Promise.race([cleanupPromise, timeoutPromise]);
        if (result === "timeout") {
            // eslint-disable-next-line no-console
            console.error(
                `[lifecycle] cleanup '${resource.name}' timed out after ${PER_RESOURCE_TIMEOUT_MS}ms; proceeding`,
            );
        }
        return result;
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
            `[lifecycle] cleanup '${resource.name}' threw:`,
            err,
        );
        return "error";
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/**
 * Walk the registered resources in ascending priority order and run each
 * cleanup with a per-resource timeout. After all cleanups complete (or all
 * time out), exits the process with code 0. A hard deadline timer
 * guarantees process.exit(1) within HARD_DEADLINE_MS even if individual
 * timeouts misbehave.
 */
async function performShutdown(signal: NodeJS.Signals): Promise<void> {
    if (shutdownInProgress) {
        // eslint-disable-next-line no-console
        console.error(
            `[lifecycle] received ${signal} during shutdown; ignoring (debounced)`,
        );
        return;
    }
    shutdownInProgress = true;
    // eslint-disable-next-line no-console
    console.error(`[lifecycle] received ${signal}; initiating shutdown`);

    // Hard deadline — process.exit(1) if anything goes catastrophically wrong.
    const hardTimer = setTimeout(() => {
        // eslint-disable-next-line no-console
        console.error(
            `[lifecycle] hard deadline reached (${HARD_DEADLINE_MS}ms); force-exiting`,
        );
        process.exit(1);
    }, HARD_DEADLINE_MS);
    // The deadline timer must not keep the event loop alive on its own —
    // unrefing lets the process exit cleanly when cleanups finish first.
    if (typeof hardTimer.unref === "function") {
        hardTimer.unref();
    }

    const ordered = [...resources].sort((a, b) => a.priority - b.priority);
    for (const resource of ordered) {
        await runCleanupWithTimeout(resource);
    }

    // eslint-disable-next-line no-console
    console.error("[lifecycle] shutdown complete");
    clearTimeout(hardTimer);
    process.exit(0);
}

/**
 * Initialize the signal handlers and register the default resources
 * (stdin, logger). Idempotent — a second call logs a warning and returns
 * without double-registering.
 */
export function initLifecycle(): void {
    if (lifecycleInitialized) {
        // eslint-disable-next-line no-console
        console.error(
            "[lifecycle] initLifecycle called twice; ignoring second call",
        );
        return;
    }
    lifecycleInitialized = true;

    // Default resources: stdin pause earliest, logger flush last.
    registerResource({
        name: "stdin",
        priority: 0,
        cleanup: () => {
            // pause() is sync; wrap in noop for the Promise<void> contract.
            try {
                process.stdin.pause();
            } catch {
                // best-effort
            }
        },
    });
    registerResource({
        name: "logger",
        priority: 100,
        // TODO(PLAN-013-2): replace with the actual logger flush once the
        // logging module exists. For MVP the no-op stub keeps the priority
        // slot reserved so shutdown ordering is stable.
        cleanup: () => {},
    });

    const handler = (signal: NodeJS.Signals): void => {
        // Fire-and-forget; performShutdown manages its own deadline.
        void performShutdown(signal);
    };

    process.on("SIGTERM", handler);
    process.on("SIGINT", handler);
}

/**
 * Test-only accessor. Returns the registered resources sorted by priority
 * ascending — the same order they would run in during shutdown. Underscore
 * prefix signals "internal; do not import outside tests."
 */
export function _resourcesForTest(): readonly RegisteredResource[] {
    return [...resources].sort((a, b) => a.priority - b.priority);
}

/**
 * Test-only reset. Clears the registry and resets the init guard so the
 * test suite can exercise initLifecycle from a clean slate. Not intended
 * for production code.
 */
export function _resetForTest(): void {
    resources.length = 0;
    lifecycleInitialized = false;
    shutdownInProgress = false;
}

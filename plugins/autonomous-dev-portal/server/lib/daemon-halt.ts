// SPEC-035-3-03 §FR-8 / SPEC-035-3-04 §FR-3 — Daemon halt + reset wrappers.
//
// Thin shim around the `autonomous-dev kill-switch` CLI. Each wrapper
// throws on non-zero exit; callers in `server/routes/kill-switch.ts` MUST
// invoke inside a try/catch so the failure path can:
//   - log a structured ERROR event (`kill_switch_engage_failed` /
//     `kill_switch_reset_failed`)
//   - return an HTTP 500 + ks-error fragment (NOT mark the switch engaged)
//
// SAFETY-CRITICAL: this module never silently swallows a CLI failure.
// `ensureSuccess` reads exitCode + stderr and throws a `DaemonHaltError`
// with the captured stderr so the caller can include the daemon's own
// diagnostic in the ERROR log line.
//
// The handler functions are exported as a namespace (`operationsHandlers`)
// so route tests can replace them with spies without monkey-patching the
// route module. See tests/integration/kill-switch.test.ts §3.5.
//
// Subprocess invocation follows the same discipline as
// server/auth/tailscale-client.ts:
//   - Bun.spawn with array-arg form (no shell interpolation)
//   - Operator-controlled strings are NEVER passed as CLI args; the only
//     argument variation is the fixed `reason` string from the route
//     handler (`portal-operator-manual`).

const DEFAULT_KILL_SWITCH_CLI = "autonomous-dev";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Error class for daemon-halt failures. Carries the captured stderr so the
 * caller can surface the daemon's own diagnostic into the structured log
 * (and never swallow it).
 */
export class DaemonHaltError extends Error {
    constructor(
        message: string,
        public readonly exitCode: number,
        public readonly stderr: string,
    ) {
        super(message);
        this.name = "DaemonHaltError";
    }
}

/** Bun spawn surface narrowed to what we actually use. */
interface SpawnFn {
    (options: {
        cmd: string[];
        stdout: "pipe" | "inherit" | "ignore";
        stderr: "pipe" | "inherit" | "ignore";
    }): {
        exited: Promise<number>;
        kill: (signal?: number | NodeJS.Signals) => void;
        stdout: ReadableStream<Uint8Array>;
        stderr: ReadableStream<Uint8Array>;
    };
}

interface BunRuntime {
    spawn: SpawnFn;
}

function getBun(): BunRuntime {
    const g = globalThis as unknown as { Bun?: BunRuntime };
    if (g.Bun === undefined) {
        throw new DaemonHaltError(
            "Bun runtime unavailable; cannot invoke autonomous-dev CLI.",
            -1,
            "",
        );
    }
    return g.Bun;
}

async function readAllText(stream: ReadableStream<Uint8Array>): Promise<string> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
        }
    } finally {
        try {
            reader.releaseLock();
        } catch {
            // best-effort
        }
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
    }
    return new TextDecoder().decode(merged);
}

interface SpawnResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

async function runCli(
    cmd: string[],
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SpawnResult> {
    const bun = getBun();
    const proc = bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<number>((resolve) => {
        timer = setTimeout(() => {
            timedOut = true;
            try {
                proc.kill();
            } catch {
                // best-effort
            }
            resolve(124);
        }, timeoutMs);
    });
    const exitCode = await Promise.race([proc.exited, timeoutPromise]);
    if (timer !== null) clearTimeout(timer);
    const [stdout, stderr] = await Promise.all([
        readAllText(proc.stdout),
        readAllText(proc.stderr),
    ]);
    if (timedOut) {
        throw new DaemonHaltError(
            `autonomous-dev CLI timed out after ${String(timeoutMs)}ms`,
            124,
            stderr,
        );
    }
    return { exitCode, stdout, stderr };
}

/**
 * Resolve the autonomous-dev CLI binary path. Honors AUTONOMOUS_DEV_CLI
 * for tests and air-gapped deployments where the binary is shipped at a
 * non-default location.
 */
function cliPath(): string {
    const fromEnv = process.env["AUTONOMOUS_DEV_CLI"];
    if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
    return DEFAULT_KILL_SWITCH_CLI;
}

/**
 * Engage the kill switch via the autonomous-dev CLI. Throws
 * DaemonHaltError on non-zero exit, timeout, or runtime unavailability.
 *
 * The `reason` argument is the FIXED string from the route handler
 * (`portal-operator-manual` — see SPEC-035-3-03 §FR-8); it is NEVER
 * sourced from the request body, so command-injection surface is zero.
 */
export async function engageKillSwitch(opts: {
    reason: string;
}): Promise<void> {
    const result = await runCli([cliPath(), "kill-switch", "engage", "--reason", opts.reason]);
    if (result.exitCode !== 0) {
        throw new DaemonHaltError(
            `autonomous-dev kill-switch engage failed (exit ${String(result.exitCode)})`,
            result.exitCode,
            result.stderr,
        );
    }
}

/**
 * Reset (disengage) the kill switch via the autonomous-dev CLI. Throws
 * DaemonHaltError on non-zero exit. Idempotent: the daemon-side handler
 * is a no-op when the switch is already disengaged (see PLAN-035-3 risk
 * row 6), so consecutive resolves are normal and safe.
 */
export async function resetKillSwitch(): Promise<void> {
    const result = await runCli([cliPath(), "kill-switch", "reset"]);
    if (result.exitCode !== 0) {
        throw new DaemonHaltError(
            `autonomous-dev kill-switch reset failed (exit ${String(result.exitCode)})`,
            result.exitCode,
            result.stderr,
        );
    }
}

/**
 * Mutable handler bag — exported as a namespace so route tests can
 * replace `engageKillSwitch` / `resetKillSwitch` with spies via
 * `operationsHandlers.engageKillSwitch = mock(...)` without having to
 * intercept the route module's imports. The route handlers in
 * server/routes/kill-switch.ts call THROUGH this object, never the
 * module-level functions directly, so every test gets a clean slate.
 *
 * SAFETY-CRITICAL: this is the only injection point exposed to test
 * code. Production code must never reassign these fields.
 */
export const operationsHandlers: {
    engageKillSwitch: (opts: { reason: string }) => Promise<void>;
    resetKillSwitch: () => Promise<void>;
} = {
    engageKillSwitch,
    resetKillSwitch,
};

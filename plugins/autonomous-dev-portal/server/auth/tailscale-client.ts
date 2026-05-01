// SPEC-014-1-03 §Task 3.1 — Typed wrapper around the `tailscale` CLI.
//
// We call out to the Tailscale daemon's CLI rather than linking a library
// for two reasons: (1) the CLI is the documented public surface, (2) we
// avoid a heavyweight network library. Subprocess invocation is strictly
// `Bun.spawn` with array-arg form — no shell interpolation, every input
// argument validated as an IP literal before being passed to the CLI.

import { isIP } from "node:net";

import { SecurityError } from "./types";

export interface TailscaleClient {
    /** Throws TAILSCALE_CLI_UNAVAILABLE on missing binary or non-zero exit. */
    ensureAvailable(): Promise<void>;
    /** Throws TAILSCALE_NO_INTERFACE_IP if the IP cannot be resolved. */
    getInterfaceIp(): Promise<string>;
    /**
     * Returns the documented Tailscale CGNAT IPv4 range and ULA IPv6 range.
     * The daemon is probed via `status --json` to confirm liveness, but
     * the returned values are constants because the JSON schema has
     * shifted across releases.
     */
    getTailnetCIDRs(): Promise<string[]>;
    /** Resolves the peer's Tailscale identity, or null if not found. */
    whois(peerIp: string): Promise<TailscaleWhois | null>;
}

export interface TailscaleWhois {
    login: string;
    display_name: string;
}

export const TAILSCALE_CGNAT_V4 = "100.64.0.0/10";
export const TAILSCALE_ULA_V6 = "fd7a:115c:a1e0::/48";
const TAILSCALE_CIDRS = Object.freeze([TAILSCALE_CGNAT_V4, TAILSCALE_ULA_V6]);
const DEFAULT_CLI_PATH = "tailscale";
const DEFAULT_TIMEOUT_MS = 5000;
const TS_INTERFACE_IP_RE = /^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Bun's spawn type surface, narrowed to what we use. Keeps the Node typecheck happy. */
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
    if (!g.Bun) {
        throw new SecurityError(
            "TAILSCALE_CLI_UNAVAILABLE",
            "Tailscale auth requires the Bun runtime (Bun.spawn unavailable).",
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

async function runWithTimeout(
    bun: BunRuntime,
    cmd: string[],
    timeoutMs: number,
): Promise<SpawnResult> {
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
    let exitCode: number;
    try {
        exitCode = await Promise.race([proc.exited, timeoutPromise]);
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
    if (timedOut) {
        throw new SecurityError(
            "TAILSCALE_CLI_TIMEOUT",
            `tailscale CLI did not respond within ${timeoutMs}ms: ${cmd.join(
                " ",
            )}`,
        );
    }
    const [stdout, stderr] = await Promise.all([
        readAllText(proc.stdout),
        readAllText(proc.stderr),
    ]);
    return { exitCode, stdout, stderr };
}

export interface CliTailscaleClientOptions {
    cliPath?: string;
    timeoutMs?: number;
    /** Test seam: replace the spawn impl. */
    spawn?: SpawnFn;
}

export class CliTailscaleClient implements TailscaleClient {
    private readonly cliPath: string;
    private readonly timeoutMs: number;
    private readonly bun: BunRuntime;

    constructor(opts: CliTailscaleClientOptions = {}) {
        this.cliPath = opts.cliPath ?? DEFAULT_CLI_PATH;
        this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.bun = opts.spawn !== undefined ? { spawn: opts.spawn } : getBun();
    }

    async ensureAvailable(): Promise<void> {
        let res: SpawnResult;
        try {
            res = await runWithTimeout(
                this.bun,
                [this.cliPath, "version"],
                this.timeoutMs,
            );
        } catch (err) {
            if (err instanceof SecurityError) throw err;
            throw new SecurityError(
                "TAILSCALE_CLI_UNAVAILABLE",
                `tailscale CLI not found or failed to launch (${
                    (err as Error).message
                })`,
            );
        }
        if (res.exitCode !== 0) {
            throw new SecurityError(
                "TAILSCALE_CLI_UNAVAILABLE",
                `tailscale CLI exited ${String(res.exitCode)} for 'version' (${res.stderr.trim()})`,
            );
        }
    }

    async getInterfaceIp(): Promise<string> {
        const res = await runWithTimeout(
            this.bun,
            [this.cliPath, "ip", "--4"],
            this.timeoutMs,
        );
        if (res.exitCode !== 0) {
            throw new SecurityError(
                "TAILSCALE_NO_INTERFACE_IP",
                `tailscale ip --4 exited ${String(res.exitCode)}: ${res.stderr.trim()}`,
            );
        }
        const ip = res.stdout.split("\n")[0]?.trim() ?? "";
        if (!TS_INTERFACE_IP_RE.test(ip)) {
            throw new SecurityError(
                "TAILSCALE_NO_INTERFACE_IP",
                `tailscale ip --4 returned unrecognised output: '${ip}'`,
            );
        }
        return ip;
    }

    async getTailnetCIDRs(): Promise<string[]> {
        // The status call is a liveness probe; its parsed output is
        // intentionally ignored (the JSON schema is unstable across
        // tailscaled releases). On any non-zero exit we still surface a
        // clear error rather than silently returning constants.
        const res = await runWithTimeout(
            this.bun,
            [this.cliPath, "status", "--json"],
            this.timeoutMs,
        );
        if (res.exitCode !== 0) {
            throw new SecurityError(
                "TAILSCALE_CLI_UNAVAILABLE",
                `tailscale status --json exited ${String(
                    res.exitCode,
                )}: ${res.stderr.trim()}`,
            );
        }
        return [...TAILSCALE_CIDRS];
    }

    async whois(peerIp: string): Promise<TailscaleWhois | null> {
        if (typeof peerIp !== "string" || isIP(peerIp) === 0) {
            throw new SecurityError(
                "TAILSCALE_INVALID_PEER_IP",
                `whois requires a valid IP literal (got '${String(peerIp)}')`,
            );
        }
        const res = await runWithTimeout(
            this.bun,
            [this.cliPath, "whois", "--json", peerIp],
            this.timeoutMs,
        );
        if (res.exitCode !== 0) return null;
        let parsed: unknown;
        try {
            parsed = JSON.parse(res.stdout);
        } catch {
            return null;
        }
        if (parsed === null || typeof parsed !== "object") return null;
        const profile = (parsed as { UserProfile?: unknown }).UserProfile;
        if (profile === null || typeof profile !== "object") return null;
        const login = (profile as { LoginName?: unknown }).LoginName;
        const display = (profile as { DisplayName?: unknown }).DisplayName;
        if (typeof login !== "string" || login.length === 0) return null;
        return {
            login,
            display_name: typeof display === "string" && display.length > 0 ? display : login,
        };
    }
}

// SPEC-015-2-03 §IntakeRouterClient — Sole portal-side HTTP client for the
// intake router daemon. All portal mutation paths (gate actions, settings
// writes, daemon-reload signals) flow through this class.
//
// Design contract:
//   - Single chokepoint: no other module fetches the router directly.
//   - Localhost-only target (`http://127.0.0.1:<port>/router`); the router
//     binds 127.0.0.1 in TDD-008.
//   - Bun's native fetch + AbortController; no axios / undici / got.
//   - Retries are short on purpose: the only reason a localhost call can be
//     transiently broken is a daemon restart or fd exhaustion, both of which
//     resolve in seconds or never.
//   - No circuit breaker: surfacing failures fast is preferred over masking
//     them — the operator needs to know the daemon is down.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { classifyError } from "./intake-error-classifier";

// ---- Public surface --------------------------------------------------------

export type IntakeCommandKind =
    | "approve"
    | "request-changes"
    | "reject"
    | "config-set"
    | "daemon-reload"
    | "kill-switch"
    | "circuit-breaker-reset";

export interface IntakeCommand {
    command: IntakeCommandKind;
    /** UUID for THIS command (not the request being approved). */
    requestId: string;
    comment?: string;
    /** Always 'portal' — duplicated server-side as a defense-in-depth check. */
    source: "portal";
    sourceUserId: string;
    /** For 'config-set' only. */
    configChanges?: Record<string, unknown>;
    /** For destructive ops requiring typed-CONFIRM. */
    confirmationToken?: string;
    /** For approve / reject / request-changes — the REQ-* id being acted on. */
    targetRequestId?: string;
}

export interface IntakeResponse {
    success: boolean;
    commandId: string;
    error?: string;
    errorCode?: string;
    data?: unknown;
}

export interface HealthResult {
    healthy: boolean;
    version?: string;
    latencyMs?: number;
    error?: string;
}

export interface IntakeRouterClientOptions {
    /** When set, port discovery is skipped. */
    port?: number;
    /** Override the userConfig.json path. Production omits this; tests
     *  inject a temp file path so they never touch the operator's real
     *  config. */
    userConfigPath?: string;
}

// ---- Constants -------------------------------------------------------------

/** TDD-008 well-known port for the intake router. */
export const DEFAULT_INTAKE_ROUTER_PORT = 19279;

/** Sent in the User-Agent header so router logs can correlate. */
export const PORTAL_VERSION = "1.0";

/** Resolved relative to the portal package's CWD; matches the layout in
 *  plugins/autonomous-dev-portal/ → plugins/autonomous-dev/. */
const DEFAULT_USER_CONFIG_PATH =
    "../autonomous-dev/.claude-plugin/userConfig.json";

// ---- Implementation --------------------------------------------------------

/**
 * Sole HTTP client for portal → intake-router traffic.
 *
 * The constructor is synchronous and does at most one filesystem read (port
 * discovery). All network IO happens in `submitCommand` / `healthCheck`.
 */
export class IntakeRouterClient {
    private readonly baseUrl: string;
    private readonly timeoutMs = 5_000;
    private readonly retryAttempts = 3;
    private readonly initialBackoffMs = 200;
    private readonly maxBackoffMs = 2_000;

    /** Set to true after the first fallback warning so we emit it once. */
    private static fallbackWarned = false;

    constructor(opts: IntakeRouterClientOptions = {}) {
        const port =
            opts.port ?? this.discoverIntakePort(opts.userConfigPath);
        this.baseUrl = `http://127.0.0.1:${String(port)}/router`;
    }

    /** For diagnostics / tests. */
    get url(): string {
        return this.baseUrl;
    }

    /** Reset the warned-once flag — exposed for tests. */
    static resetFallbackWarning(): void {
        IntakeRouterClient.fallbackWarned = false;
    }

    private discoverIntakePort(userConfigPath?: string): number {
        const path = userConfigPath ?? DEFAULT_USER_CONFIG_PATH;
        try {
            const raw = readFileSync(path, "utf8");
            const parsed = JSON.parse(raw) as unknown;
            if (
                parsed !== null &&
                typeof parsed === "object" &&
                "router" in parsed
            ) {
                const router = (parsed as { router: unknown }).router;
                if (
                    router !== null &&
                    typeof router === "object" &&
                    "port" in router
                ) {
                    const port = (router as { port: unknown }).port;
                    if (
                        typeof port === "number" &&
                        Number.isInteger(port) &&
                        port > 0 &&
                        port < 65536
                    ) {
                        return port;
                    }
                }
            }
        } catch {
            // fall through to fallback path
        }
        if (!IntakeRouterClient.fallbackWarned) {
            IntakeRouterClient.fallbackWarned = true;
            // eslint-disable-next-line no-console
            console.warn(
                JSON.stringify({
                    event: "intake_router_port_fallback",
                    default_port: DEFAULT_INTAKE_ROUTER_PORT,
                    user_config_path: path,
                }),
            );
        }
        return DEFAULT_INTAKE_ROUTER_PORT;
    }

    /**
     * POST a command to the intake router with retries on transient failures.
     *
     * Local pre-checks short-circuit obviously-broken commands (wrong source
     * literal, missing operator id) without burning a network roundtrip.
     */
    async submitCommand(cmd: IntakeCommand): Promise<IntakeResponse> {
        if (cmd.source !== "portal") {
            return {
                success: false,
                commandId: "",
                error: 'source must be "portal"',
                errorCode: "CLIENT_VALIDATION",
            };
        }
        if (!cmd.sourceUserId) {
            return {
                success: false,
                commandId: "",
                error: "sourceUserId is required",
                errorCode: "CLIENT_VALIDATION",
            };
        }

        try {
            const response = await this.retry(() =>
                this.makeRequest("/command", cmd),
            );
            const body = (await this.safeJson(response)) as Record<
                string,
                unknown
            >;
            if (!response.ok) {
                return {
                    success: false,
                    commandId: this.stringField(body, "commandId") ?? "",
                    error:
                        this.stringField(body, "error") ??
                        `HTTP ${String(response.status)}`,
                    errorCode:
                        this.stringField(body, "errorCode") ??
                        `HTTP_${String(response.status)}`,
                };
            }
            return {
                success: true,
                commandId:
                    this.stringField(body, "commandId") ?? randomUUID(),
                data: body["data"],
            };
        } catch (err) {
            const klass = classifyError(err);
            const errorCode =
                klass === "transient" ? "NETWORK_TRANSIENT" : "NETWORK_PERMANENT";
            return {
                success: false,
                commandId: "",
                error: err instanceof Error ? err.message : "Unknown error",
                errorCode,
            };
        }
    }

    /**
     * Fast yes/no for the daemon's liveness. Uses a tighter timeout (2s) and
     * does NOT retry — the caller wants an immediate answer.
     */
    async healthCheck(): Promise<HealthResult> {
        const start = performance.now();
        try {
            const response = await this.makeRequest(
                "/health",
                {},
                { timeoutMs: 2_000 },
            );
            const latencyMs = Math.round(performance.now() - start);
            if (!response.ok) {
                return {
                    healthy: false,
                    latencyMs,
                    error: `HTTP ${String(response.status)}`,
                };
            }
            const body = (await this.safeJson(response)) as Record<
                string,
                unknown
            >;
            return {
                healthy: true,
                version: this.stringField(body, "version"),
                latencyMs,
            };
        } catch (err) {
            return {
                healthy: false,
                latencyMs: Math.round(performance.now() - start),
                error: err instanceof Error ? err.message : "Unknown",
            };
        }
    }

    private async makeRequest(
        path: string,
        body: unknown,
        opts: { timeoutMs?: number } = {},
    ): Promise<Response> {
        const ctrl = new AbortController();
        const timer = setTimeout(
            () => ctrl.abort(),
            opts.timeoutMs ?? this.timeoutMs,
        );
        try {
            return await fetch(`${this.baseUrl}${path}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": `autonomous-dev-portal/${PORTAL_VERSION}`,
                },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Wraps any operation that may fail transiently. Implements exponential
     * backoff with full jitter (200 / 400 / 800 ms upper bounds). Permanent
     * errors throw immediately so callers don't pay for the backoff.
     *
     * Also retries on 5xx/408/429/503 RESPONSES — `op` may return a Response
     * with a transient status code without throwing, in which case we throw
     * a synthetic error to drive the retry path.
     */
    private async retry<T>(op: () => Promise<T>): Promise<T> {
        let lastErr: unknown;
        for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
            try {
                const result = await op();
                if (result instanceof Response) {
                    const klass = classifyError(undefined, result);
                    if (klass === "transient" && !result.ok) {
                        // Force the retry path; subsequent attempts re-issue
                        // the request. The body is consumed once on success.
                        lastErr = new Error(
                            `HTTP ${String(result.status)}`,
                        );
                        if (attempt === this.retryAttempts - 1) {
                            return result; // last attempt: surface the response
                        }
                        await this.delay(this.computeBackoff(attempt));
                        continue;
                    }
                }
                return result;
            } catch (err) {
                lastErr = err;
                const klass = classifyError(err);
                if (klass === "permanent") throw err;
                if (attempt === this.retryAttempts - 1) throw err;
                await this.delay(this.computeBackoff(attempt));
            }
        }
        throw lastErr;
    }

    private computeBackoff(attempt: number): number {
        const upper = Math.min(
            this.maxBackoffMs,
            this.initialBackoffMs * Math.pow(2, attempt),
        );
        return Math.random() * upper;
    }

    private async delay(ms: number): Promise<void> {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
    }

    private async safeJson(response: Response): Promise<unknown> {
        try {
            return await response.json();
        } catch {
            return {};
        }
    }

    private stringField(
        body: Record<string, unknown>,
        key: string,
    ): string | undefined {
        const v = body[key];
        return typeof v === "string" ? v : undefined;
    }
}

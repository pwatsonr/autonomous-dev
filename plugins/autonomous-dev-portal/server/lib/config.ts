// SPEC-013-2-03 §Task 1 — Full PortalConfig loader.
//
// Layered config: defaults (JSON) → user file (JSON, optional) → env vars.
// deepMerge is right-biased on objects, replacement on arrays/scalars.
// Validation runs once on the merged result; errors throw PortalError so
// startServer().catch() logs them as `startup_failed`.

import { homedir } from "node:os";
import { readFile } from "node:fs/promises";

import { PortalError } from "../middleware/error-handler";
import { sanitizeErrorMessage } from "./sanitize";
import { validateConfig } from "./validation";
import type { OAuthConfig } from "./oauth-extension";

// SPEC-014-1-01 §Task 1.2 — `oauth-pkce` is the canonical literal going
// forward. The legacy `oauth` value is retained so config files written
// against PLAN-013-2 keep loading; the validator and providers normalize
// both to the same code path.
export type AuthMode = "localhost" | "tailscale" | "oauth-pkce" | "oauth";
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * SPEC-014-1-01 §Task 1.2 / SPEC-014-1-03 — Tailscale-mode tuning. Both
 * fields are optional; defaults match the spec (`require_whois_for_writes
 * = true`, `cli_path = 'tailscale'`).
 */
export interface TailscaleAuthConfig {
    require_whois_for_writes?: boolean;
    cli_path?: string;
}

/**
 * SPEC-014-1-01 §Task 1.2 / SPEC-014-1-04 — OAuth+PKCE configuration.
 * Secrets are NEVER inlined: `*_env` fields name an environment variable
 * whose value is the actual secret. Validators check `process.env[name]`
 * is set before startServer() opens the listening socket.
 */
export interface OAuthAuthConfig {
    provider: "github" | "google";
    client_id: string;
    /** Env var name (NOT the secret itself). */
    client_secret_env: string;
    /** Must be HTTPS unless bind_host === '127.0.0.1'. */
    redirect_url: string;
    /** Env var holding the HMAC key for signed session cookies. */
    cookie_secret_env: string;
    /** File-backed session directory; defaults to ${CLAUDE_PLUGIN_DATA}/sessions. */
    session_dir?: string;
}

export interface TlsConfig {
    cert_path: string;
    key_path: string;
}

export interface PortalConfig {
    port: number;
    auth_mode: AuthMode;
    /** Explicit override; only honored when auth_mode !== 'localhost'. */
    bind_host: string | null;
    allowed_origins: string[];
    logging: { level: LogLevel };
    paths: {
        state_dir: string;
        logs_dir: string;
        user_config: string;
    };
    shutdown: {
        grace_period_ms: number;
        force_timeout_ms: number;
    };
    /**
     * Legacy OAuth extension config (PLAN-013-2). Keeping the field name
     * compatible with existing user configs; SPEC-014-1-04 OAuth provider
     * uses {@link oauth_auth} for its richer schema.
     */
    oauth?: OAuthConfig;
    /** SPEC-014-1-03 Tailscale provider tuning. */
    tailscale?: TailscaleAuthConfig;
    /** SPEC-014-1-04 OAuth+PKCE provider configuration. */
    oauth_auth?: OAuthAuthConfig;
    /** SPEC-014-1-01 §Task 1.3 — required when bind_host !== '127.0.0.1'. */
    tls?: TlsConfig;
    /** SPEC-014-1-01 §Task 1.5 — gates X-Forwarded-For trust. Default: false. */
    trusted_reverse_proxy?: boolean;
}

interface DefaultsShape {
    port: number;
    auth_mode: AuthMode;
    bind_host: string | null;
    trusted_reverse_proxy: boolean;
    allowed_origins: string[];
    logging: { level: LogLevel };
    paths: {
        state_dir: string;
        logs_dir: string;
        user_config: string;
    };
    shutdown: { grace_period_ms: number; force_timeout_ms: number };
}

type JsonObject = Record<string, unknown>;

/** Replace a leading `~` with the current user's home directory. */
export function expandHome(p: string): string {
    if (p.startsWith("~/") || p === "~") {
        return p.replace(/^~/, homedir());
    }
    return p;
}

/**
 * Right-biased deep merge for plain objects. Arrays and scalars are
 * REPLACED by the right-hand value; nested objects are recursed into.
 * Inputs are not mutated.
 */
export function deepMerge<T extends JsonObject>(
    ...sources: ReadonlyArray<JsonObject | undefined>
): T {
    const out: JsonObject = {};
    for (const src of sources) {
        if (src === undefined) continue;
        for (const [key, value] of Object.entries(src)) {
            const existing = out[key];
            if (
                value !== null &&
                typeof value === "object" &&
                !Array.isArray(value) &&
                existing !== null &&
                typeof existing === "object" &&
                !Array.isArray(existing)
            ) {
                out[key] = deepMerge(
                    existing as JsonObject,
                    value as JsonObject,
                );
            } else {
                out[key] = value;
            }
        }
    }
    return out as T;
}

async function loadDefaults(): Promise<DefaultsShape> {
    const mod = (await import("../../config/portal-defaults.json", {
        with: { type: "json" },
    })) as { default: DefaultsShape };
    // Clone via JSON to ensure no shared references with the cached module.
    return JSON.parse(JSON.stringify(mod.default)) as DefaultsShape;
}

async function loadUserConfig(path: string): Promise<JsonObject> {
    try {
        const raw = await readFile(path, "utf8");
        try {
            const parsed = JSON.parse(raw) as unknown;
            if (
                parsed === null ||
                typeof parsed !== "object" ||
                Array.isArray(parsed)
            ) {
                throw new PortalError(
                    "INVALID_CONFIG_SYNTAX",
                    `User config at ${redactHome(path)} must be a JSON object`,
                    500,
                );
            }
            return parsed as JsonObject;
        } catch (err) {
            if (err instanceof PortalError) throw err;
            throw new PortalError(
                "INVALID_CONFIG_SYNTAX",
                `Malformed JSON in user config at ${redactHome(path)}: ${(err as Error).message}`,
                500,
            );
        }
    } catch (err) {
        if (err instanceof PortalError) throw err;
        const e = err as { code?: string };
        if (e.code === "ENOENT") {
            // Missing user config is intentional, not an error.
            return {};
        }
        throw err;
    }
}

function redactHome(p: string): string {
    return p.replace(homedir(), "~");
}

/**
 * Map a small set of env vars onto config fields. Throws PortalError with
 * INVALID_ENV_<VAR> on shape errors. Sensitive values are routed through
 * the message sanitizer before being included in error text.
 */
export function parseEnvOverrides(
    env: NodeJS.ProcessEnv = process.env,
): JsonObject {
    const out: JsonObject = {};

    const port = env["PORTAL_PORT"];
    if (port !== undefined) {
        const n = Number(port);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) {
            throw new PortalError(
                "INVALID_ENV_PORTAL_PORT",
                `PORTAL_PORT must be an integer in [1024, 65535], got '${sanitizeErrorMessage(port)}'`,
                500,
            );
        }
        out["port"] = n;
    }

    const mode = env["PORTAL_AUTH_MODE"];
    if (mode !== undefined) {
        if (
            mode !== "localhost" &&
            mode !== "tailscale" &&
            mode !== "oauth" &&
            mode !== "oauth-pkce"
        ) {
            throw new PortalError(
                "INVALID_ENV_PORTAL_AUTH_MODE",
                `PORTAL_AUTH_MODE must be one of localhost|tailscale|oauth|oauth-pkce, got '${sanitizeErrorMessage(mode)}'`,
                500,
            );
        }
        out["auth_mode"] = mode;
    }

    const level = env["PORTAL_LOG_LEVEL"];
    if (level !== undefined) {
        if (
            level !== "debug" &&
            level !== "info" &&
            level !== "warn" &&
            level !== "error"
        ) {
            throw new PortalError(
                "INVALID_ENV_PORTAL_LOG_LEVEL",
                `PORTAL_LOG_LEVEL must be one of debug|info|warn|error, got '${sanitizeErrorMessage(level)}'`,
                500,
            );
        }
        out["logging"] = { level };
    }

    const bind = env["PORTAL_BIND_HOST"];
    if (bind !== undefined) {
        if (bind.length === 0 || bind.length > 253 || /\s/.test(bind)) {
            throw new PortalError(
                "INVALID_ENV_PORTAL_BIND_HOST",
                `PORTAL_BIND_HOST must be a non-empty hostname or IP, got '${sanitizeErrorMessage(bind)}'`,
                500,
            );
        }
        out["bind_host"] = bind;
    }

    return out;
}

export async function loadPortalConfig(): Promise<PortalConfig> {
    const defaults = await loadDefaults();
    const userPath = expandHome(
        process.env["PORTAL_USER_CONFIG"] ?? defaults.paths.user_config,
    );
    const userOverrides = await loadUserConfig(userPath);
    const envOverrides = parseEnvOverrides();
    const merged = deepMerge<JsonObject>(
        defaults as unknown as JsonObject,
        userOverrides,
        envOverrides,
    ) as unknown as PortalConfig;
    validateConfig(merged);
    return merged;
}

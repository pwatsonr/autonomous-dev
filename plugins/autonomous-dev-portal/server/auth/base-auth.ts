// SPEC-014-1-01 §Task 1.3 — Shared base for auth providers.
//
// Holds the helpers every provider needs (structured logging, AuthContext
// construction). Concrete providers in localhost-auth.ts, tailscale-auth.ts,
// and oauth-auth.ts extend this class and implement `init` / `evaluate`.

import type { AuthContext, AuthDecision, AuthMode, AuthProvider } from "./types";

/** Minimal log surface; concrete providers receive an injected logger. */
export interface AuthLogger {
    info(event: string, fields?: Record<string, unknown>): void;
    warn(event: string, fields?: Record<string, unknown>): void;
    error(event: string, fields?: Record<string, unknown>): void;
}

/**
 * Default JSON-line logger. Mirrors the shape used by structuredLogger in
 * server/middleware/logging.ts so log aggregators see one schema for
 * access logs and auth events.
 */
export function defaultAuthLogger(): AuthLogger {
    function emit(level: "info" | "warn" | "error") {
        return (event: string, fields: Record<string, unknown> = {}): void => {
            const sink = level === "error" ? process.stderr : process.stdout;
            sink.write(
                JSON.stringify({
                    ts: new Date().toISOString(),
                    level,
                    event,
                    ...fields,
                }) + "\n",
            );
        };
    }
    return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}

export abstract class BaseAuthProvider implements AuthProvider {
    abstract readonly mode: AuthMode;
    abstract init(): Promise<void>;
    abstract evaluate(request: Request, peerIp: string): Promise<AuthDecision>;

    /**
     * Helper for providers to assemble a minimal `allow` decision. Keeps
     * field placement uniform across providers and frees callers from
     * re-spelling the AuthContext shape.
     */
    protected allow(
        source_user_id: string,
        display_name: string,
        details: Record<string, unknown>,
    ): AuthDecision {
        const context: AuthContext = {
            authenticated: true,
            mode: this.mode,
            source_user_id,
            display_name,
            details,
        };
        return { kind: "allow", context };
    }

    protected deny(
        status: 401 | 403,
        error_code: string,
        message: string,
    ): AuthDecision {
        return { kind: "deny", status, error_code, message };
    }

    protected redirect(location: string): AuthDecision {
        return { kind: "redirect", location };
    }
}

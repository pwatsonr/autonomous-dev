// SPEC-013-2-01 stub — placeholder so server.ts type-checks.
// SPEC-013-2-03 replaces this with the full implementation: auth-mode
// dispatch, Tailscale interface lookup, OAuth extension hook, port
// availability probe, and privilege checks.

import type { PortalConfig } from "./config";

export function resolveBindHostname(config: PortalConfig): string {
    if (config.auth_mode === "localhost") return "127.0.0.1";
    // tailscale and oauth modes are wired up in SPEC-013-2-03
    return "127.0.0.1";
}

export async function validateBindingConfig(config: PortalConfig): Promise<void> {
    // Stub: SPEC-013-2-03 adds full validation (auth-mode rules, port range,
    // privilege check, and port-in-use probe).
    if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
        throw new Error(
            `port must be integer in [1024, 65535], got ${String(config.port)}`,
        );
    }
}

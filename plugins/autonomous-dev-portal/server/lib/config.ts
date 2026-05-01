// SPEC-013-2-01 §Task 4 — thin stub for the portal config loader.
// The full multi-layer loader (defaults + user file + env overrides + validation)
// is implemented in SPEC-013-2-03. This stub MUST satisfy the PortalConfig
// interface so other specs can compile against it immediately.

export type AuthMode = "localhost" | "tailscale" | "oauth";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface PortalConfig {
    port: number;
    auth_mode: AuthMode;
    bind_host?: string | null;
    allowed_origins?: string[];
    logging: { level: LogLevel };
}

interface PortalDefaults {
    port: number;
    auth_mode: AuthMode;
    logging: { level: LogLevel };
}

export async function loadPortalConfig(): Promise<PortalConfig> {
    // Use a runtime fetch via dynamic import so this stub is small and the
    // full loader in SPEC-013-2-03 can replace this in one swap.
    const mod = (await import("../../config/portal-defaults.json", {
        with: { type: "json" },
    })) as { default: PortalDefaults };
    return mod.default as PortalConfig;
}

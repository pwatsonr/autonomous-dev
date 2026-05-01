// SPEC-013-2-03 §Task 3 — Bind hostname resolution + binding validation.
//
// The security boundary that prevents accidental exposure of the
// development server. localhost mode is hard-coded to 127.0.0.1; tailscale
// mode reads the IPv4 address of `tailscale0`; oauth mode requires the
// extension hook from oauth-extension.ts to be registered before startup.
//
// Validation runs BEFORE the server attempts to bind, so any failure
// (disallowed bind_host, missing tailscale0, unregistered OAuth extension,
// privileged port without root, port already in use) surfaces as a
// `startup_failed` log line and exits 1 instead of a partial bind.

import { networkInterfaces } from "node:os";
import { serve } from "bun";

import { PortalError } from "../middleware/error-handler";
import { isOAuthExtensionRegistered } from "./oauth-extension";
import type { PortalConfig } from "./config";

export function resolveBindHostname(config: PortalConfig): string {
    if (config.auth_mode === "localhost") return "127.0.0.1";
    if (config.auth_mode === "tailscale") {
        const addr = resolveTailscaleAddress();
        if (addr === "") {
            // Defensive: validateBindingConfig() should have caught this
            // already. Throw rather than bind to a wildcard by accident.
            throw new PortalError(
                "TAILSCALE_NOT_FOUND",
                "auth_mode=tailscale but no tailscale0 interface was found",
                500,
            );
        }
        return addr;
    }
    if (config.auth_mode === "oauth") {
        return config.bind_host ?? "0.0.0.0";
    }
    // TS exhaustiveness fallback; only reachable on schema bypass.
    throw new PortalError(
        "INVALID_AUTH_MODE",
        `Unknown auth_mode: ${String(config.auth_mode)}`,
        500,
    );
}

export async function validateBindingConfig(
    config: PortalConfig,
): Promise<void> {
    // 1. Localhost mode forbids any non-loopback bind_host.
    if (
        config.auth_mode === "localhost" &&
        config.bind_host !== null &&
        config.bind_host !== undefined &&
        config.bind_host !== "127.0.0.1"
    ) {
        throw new PortalError(
            "BIND_HOST_DISALLOWED",
            `bind_host '${config.bind_host}' is not permitted in auth_mode=localhost. ` +
                "Use auth_mode=tailscale or auth_mode=oauth for non-loopback binds.",
            500,
        );
    }

    // 2. Tailscale mode requires a tailscale0 interface on this host.
    if (config.auth_mode === "tailscale") {
        const tsAddr = resolveTailscaleAddress();
        if (tsAddr === "") {
            throw new PortalError(
                "TAILSCALE_NOT_FOUND",
                "auth_mode=tailscale but no tailscale0 interface was found. " +
                    "Install Tailscale or change auth_mode.",
                500,
            );
        }
    }

    // 3. OAuth mode requires the extension to be registered.
    if (config.auth_mode === "oauth") {
        if (!isOAuthExtensionRegistered()) {
            throw new PortalError(
                "OAUTH_NOT_CONFIGURED",
                "auth_mode=oauth requires the OAuth+PKCE extension (TDD-014) " +
                    "to be registered before startup.",
                500,
            );
        }
    }

    // 4. Privileged-port check (Unix only).
    const getuid = (process as NodeJS.Process & { getuid?: () => number })
        .getuid;
    if (config.port < 1024 && (getuid?.() ?? 0) !== 0) {
        throw new PortalError(
            "INSUFFICIENT_PRIVILEGES",
            `Port ${String(config.port)} requires root privileges. Use a port >= 1024.`,
            500,
        );
    }

    // 5. Port-availability probe.
    await checkPortAvailability(config.port, resolveBindHostname(config));
}

function resolveTailscaleAddress(): string {
    const ifaces = networkInterfaces();
    const ts = ifaces["tailscale0"];
    if (!ts) return "";
    const v4 = ts.find((i) => i.family === "IPv4" && !i.internal);
    return v4?.address ?? "";
}

export async function checkPortAvailability(
    port: number,
    hostname: string,
): Promise<void> {
    let probe: ReturnType<typeof serve> | null = null;
    try {
        probe = serve({
            port,
            hostname,
            fetch: () => new Response(),
        });
    } catch (err) {
        const e = err as { code?: string; message?: string };
        if (e.code === "EADDRINUSE") {
            throw new PortalError(
                "PORT_IN_USE",
                `Port ${String(port)} on ${hostname} is already in use.`,
                500,
                { port, hostname },
            );
        }
        throw err;
    } finally {
        if (probe !== null) {
            try {
                probe.stop(true);
            } catch {
                // best-effort
            }
        }
    }
}

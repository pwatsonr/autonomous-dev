// SPEC-014-1-02 §Tasks 2.2, 2.3 — Loopback detection + binding enforcer.
//
// Two responsibilities, intentionally co-located:
//   1. isLoopbackIp(ip) — strict loopback predicate; only 127.0.0.1, ::1,
//      and ::ffff:127.0.0.1 are treated as loopback. The full 127.0.0.0/8
//      range is NOT accepted (some kernel/container configs reach beyond
//      the host's loopback intent).
//   2. enforceBinding(config) — startup gate that refuses to bring the
//      server up on a non-loopback address when auth_mode='localhost'.
//      Also rejects trusted_reverse_proxy=true in localhost mode (closes
//      the X-Forwarded-For loophole).
//
// SPEC-014-1-03 extends enforceBinding with the tailscale path; this
// module owns the localhost branch and the shared loopback helper.

import type { PortalConfig } from "../lib/config";
import { SecurityError } from "./types";

/**
 * Strict IPv4/IPv6 loopback predicate. Returns false for any address
 * outside the exact loopback constants — including the rest of the
 * `127.0.0.0/8` range.
 */
export function isLoopbackIp(ip: string): boolean {
    if (typeof ip !== "string" || ip.length === 0) return false;
    if (ip === "127.0.0.1") return true;
    if (ip === "::1") return true;
    if (ip === "::ffff:127.0.0.1") return true;
    return false;
}

/** Hostnames refused outright in localhost mode. */
export const FORBIDDEN_HOSTS_FOR_LOCALHOST_MODE: readonly string[] = [
    "0.0.0.0",
    "::",
    "localhost",
];

/**
 * SPEC-014-1-02 §Task 2.3 — Network binding gate.
 *
 * For `auth_mode='localhost'`:
 *   - Refuses 0.0.0.0, ::, and the literal hostname 'localhost' with
 *     LOCALHOST_FORBIDDEN_BIND.
 *   - Refuses any non-loopback IP with LOCALHOST_REQUIRES_LOOPBACK.
 *   - Refuses trusted_reverse_proxy=true (incompatible with the trust
 *     model) with LOCALHOST_REJECTS_PROXY.
 *
 * Other auth modes are no-ops here — their gates live in their own
 * modules (SPEC-014-1-03 for tailscale, SPEC-014-1-01 §validateAuthConfig
 * for OAuth).
 *
 * Intentionally redundant with validateAuthConfig: if a future refactor
 * weakens the validator, this enforcer still blocks the bind.
 */
export function enforceBinding(config: PortalConfig): void {
    if (config.auth_mode !== "localhost") return;

    const bindHost = config.bind_host;

    if (bindHost !== null && bindHost !== undefined) {
        if (FORBIDDEN_HOSTS_FOR_LOCALHOST_MODE.includes(bindHost)) {
            throw new SecurityError(
                "LOCALHOST_FORBIDDEN_BIND",
                `auth_mode='localhost' refuses to bind to '${bindHost}'. ` +
                    `Use bind_host='127.0.0.1' (or null), or switch to ` +
                    `auth_mode='tailscale' / 'oauth-pkce' for network exposure.`,
            );
        }
        if (bindHost !== "127.0.0.1") {
            throw new SecurityError(
                "LOCALHOST_REQUIRES_LOOPBACK",
                `auth_mode='localhost' requires bind_host='127.0.0.1' ` +
                    `(got '${bindHost}'). Refusing to start to avoid ` +
                    `accidental exposure.`,
            );
        }
    }

    if (config.trusted_reverse_proxy === true) {
        throw new SecurityError(
            "LOCALHOST_REJECTS_PROXY",
            `auth_mode='localhost' is incompatible with ` +
                `trusted_reverse_proxy=true. A reverse proxy implies network ` +
                `exposure; switch to auth_mode='tailscale' or 'oauth-pkce'.`,
        );
    }
}

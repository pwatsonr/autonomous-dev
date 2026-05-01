// SPEC-014-1-02 §Task 2.1 — LocalhostAuthProvider.
//
// Grants access to all requests originating from the loopback interface
// and denies everything else. The provider's decision is a pure function
// of `(request, peerIp)` — it MUST NOT consult HTTP headers itself,
// because extractPeerIp (SPEC-014-1-01) is the authoritative source and
// already implements the X-Forwarded-For trust gate.
//
// Together with enforceBinding() (network-binding.ts) this layer guards
// against:
//   - Misconfiguration: bind_host=0.0.0.0 with auth_mode=localhost
//   - Header spoofing: X-Forwarded-For: 127.0.0.1 from a remote peer

import type { PortalConfig } from "../lib/config";
import { BaseAuthProvider, defaultAuthLogger } from "./base-auth";
import type { AuthLogger } from "./base-auth";
import { isLoopbackIp } from "./network-binding";
import { SecurityError } from "./types";
import type { AuthDecision, AuthMode } from "./types";

export class LocalhostAuthProvider extends BaseAuthProvider {
    readonly mode: AuthMode = "localhost";
    private readonly config: PortalConfig;
    private readonly logger: AuthLogger;

    constructor(config: PortalConfig, logger: AuthLogger = defaultAuthLogger()) {
        super();
        this.config = config;
        this.logger = logger;
    }

    async init(): Promise<void> {
        // bind_host=null is the recommended default (resolveBindHostname
        // substitutes 127.0.0.1). Any explicit non-loopback override is
        // refused — defense-in-depth with validateAuthConfig.
        const bind = this.config.bind_host;
        if (bind !== null && bind !== undefined && bind !== "127.0.0.1") {
            throw new SecurityError(
                "LOCALHOST_REQUIRES_LOOPBACK",
                `auth_mode='localhost' requires bind_host='127.0.0.1' ` +
                    `(got '${bind}')`,
            );
        }
    }

    async evaluate(_request: Request, peerIp: string): Promise<AuthDecision> {
        if (!isLoopbackIp(peerIp)) {
            this.logger.warn("localhost.auth.rejected_non_loopback", {
                peer_ip: peerIp,
            });
            return this.deny(
                403,
                "NON_LOOPBACK",
                "Localhost mode requires loopback origin",
            );
        }
        return this.allow("localhost", "Local Operator", { peer_ip: peerIp });
    }
}

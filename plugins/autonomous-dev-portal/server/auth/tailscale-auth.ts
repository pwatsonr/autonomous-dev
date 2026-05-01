// SPEC-014-1-03 §Task 3.3 — TailscaleAuthProvider.
//
// Validates that the request's peer IP falls within the Tailscale CGNAT
// (or ULA) range. For mutating methods, performs an additional
// `tailscale whois` lookup and uses its authoritative identity instead of
// any client-supplied `Tailscale-User-Login` header — defeats forged-
// header attacks from a compromised tailnet member.
//
// Read-only methods trust the header AFTER the peer-IP CIDR check passes
// (TDD-014 §22.1 threat model: in-tailnet peers are tailscaled-authenticated).

import type { PortalConfig } from "../lib/config";
import { BaseAuthProvider, defaultAuthLogger } from "./base-auth";
import type { AuthLogger } from "./base-auth";
import { ipInAnyCIDR, parseCIDR } from "./cidr-utils";
import type { CIDRRange } from "./cidr-utils";
import type { TailscaleClient } from "./tailscale-client";
import type { AuthDecision, AuthMode } from "./types";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const HEADER_LOGIN = "tailscale-user-login";
const HEADER_DISPLAY_NAME = "tailscale-user-name";

export interface TailscaleAuthOptions {
    config: PortalConfig;
    client: TailscaleClient;
    logger?: AuthLogger;
}

export class TailscaleAuthProvider extends BaseAuthProvider {
    readonly mode: AuthMode = "tailscale";
    private readonly config: PortalConfig;
    private readonly client: TailscaleClient;
    private readonly logger: AuthLogger;
    private interfaceIp: string | null = null;
    private cidrs: CIDRRange[] = [];

    constructor(opts: TailscaleAuthOptions) {
        super();
        this.config = opts.config;
        this.client = opts.client;
        this.logger = opts.logger ?? defaultAuthLogger();
    }

    async init(): Promise<void> {
        await this.client.ensureAvailable();
        this.interfaceIp = await this.client.getInterfaceIp();
        const raw = await this.client.getTailnetCIDRs();
        this.cidrs = raw.map((c) => parseCIDR(c));
        this.logger.info("tailscale.auth.initialized", {
            interface_ip: this.interfaceIp,
            cidrs: raw,
        });
    }

    /** Test/diagnostic accessor. Not part of the AuthProvider contract. */
    getInterfaceIp(): string | null {
        return this.interfaceIp;
    }

    async evaluate(request: Request, peerIp: string): Promise<AuthDecision> {
        if (!ipInAnyCIDR(peerIp, this.cidrs)) {
            this.logger.warn("tailscale.auth.peer_not_in_tailnet", {
                peer_ip: peerIp,
            });
            return this.deny(
                403,
                "NOT_IN_TAILNET",
                "Peer IP is not a member of the tailnet",
            );
        }

        const isMutating = !READ_METHODS.has(request.method.toUpperCase());
        const requireWhois =
            this.config.tailscale?.require_whois_for_writes ?? true;

        let login: string | null = null;
        let displayName: string | null = null;
        let whoisVerified = false;

        if (isMutating && requireWhois) {
            // Whois is the AUTHORITATIVE identity for mutating ops; we
            // must NOT consult the client-supplied headers here.
            const result = await this.client.whois(peerIp);
            if (result === null) {
                this.logger.warn("tailscale.auth.whois_failed", {
                    peer_ip: peerIp,
                });
                return this.deny(
                    403,
                    "WHOIS_FAILED",
                    "Tailscale whois did not return an identity for this peer",
                );
            }
            login = result.login;
            displayName = result.display_name;
            whoisVerified = true;
        } else {
            const headerLogin = request.headers.get(HEADER_LOGIN);
            const headerName = request.headers.get(HEADER_DISPLAY_NAME);
            if (typeof headerLogin === "string" && headerLogin.length > 0) {
                login = headerLogin;
                displayName =
                    typeof headerName === "string" && headerName.length > 0
                        ? headerName
                        : headerLogin;
            }
        }

        const sourceUserId = login ?? `tailnet-peer:${peerIp}`;
        const display = displayName ?? sourceUserId;
        return this.allow(sourceUserId, display, {
            peer_ip: peerIp,
            whois_verified: whoisVerified,
        });
    }
}

/**
 * Shared firewall types (SPEC-024-3-01).
 *
 * Defines the platform-agnostic surface used by both the Linux nftables
 * backend (SPEC-024-3-01) and the macOS pfctl backend (SPEC-024-3-02), as
 * well as the shared DNS refresh loop (SPEC-024-3-01) and the cloud-backend
 * spawn integration (SPEC-024-3-02).
 *
 * @module intake/firewall/types
 */

/**
 * One entry from a plugin manifest's `egress_allowlist[]`. Wildcard FQDNs
 * (leading `*.`) MUST be expanded by the spawner before being handed to a
 * firewall backend; backends that receive a wildcard FQDN log a WARN and
 * skip it.
 */
export interface AllowlistEntry {
  fqdn: string;
  port: number;
  protocol: 'tcp' | 'udp';
}

/**
 * One concrete IP rule produced by the DNS refresh loop. Backends translate
 * these into platform-native rules (nftables `ip daddr ... accept` / pf
 * `pass out quick proto ... to <ip> port ...`).
 *
 * `family: 'inet'` means IPv4; `'inet6'` means IPv6. `lastSeenMs` is the
 * wall-clock millisecond when the FQDN was last resolved to this IP — the
 * refresh loop expires rules whose `lastSeenMs` is older than 1 hour.
 */
export interface ResolvedRule {
  fqdn: string;
  ip: string;
  family: 'inet' | 'inet6';
  port: number;
  protocol: 'tcp' | 'udp';
  lastSeenMs: number;
}

/**
 * Platform-agnostic firewall backend contract. The Linux backend keys on
 * PID; the macOS backend keys on the same numeric handle but treats it as a
 * UID internally (per SPEC-024-3-02 §"PID/UID confusion").
 */
export interface FirewallBackend {
  readonly platform: 'linux' | 'darwin' | 'unsupported';
  init(): Promise<void>;
  applyRulesForPid(pid: number, allowlist: AllowlistEntry[]): Promise<void>;
  replaceRulesForPid(pid: number, rules: ResolvedRule[]): Promise<void>;
  removeRulesForPid(pid: number): Promise<void>;
  listActiveAllowlists(): Map<number, AllowlistEntry[]>;
}

/**
 * Thrown by a firewall backend when the host platform cannot apply rules
 * (e.g. nftables missing, `pf` not enabled, missing CAP_NET_ADMIN). The
 * spawner translates this into either a refusal (default) or a WARN log
 * (when `extensions.allow_unfirewalled_backends: true`).
 */
export class FirewallUnavailableError extends Error {
  readonly code = 'FIREWALL_UNAVAILABLE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'FirewallUnavailableError';
  }
}

/**
 * macOS pfctl firewall backend (SPEC-024-3-02).
 *
 * macOS `pf` cannot match per-PID, so this backend filters per-UID. The
 * spawn helper assigns each cloud-backend child process a unique
 * effective UID (see SPEC-024-3-02 §"Session-spawner integration"); the
 * `applyRulesForPid` parameter is treated as a UID throughout — the
 * `FirewallBackend` interface is preserved so callers stay
 * platform-agnostic.
 *
 * @module intake/firewall/pfctl
 */

import { runPfctl } from './pfctl-cli';
import { defaultRefresh, DnsRefreshLoop } from './dns-refresh';
import {
  type AllowlistEntry,
  type FirewallBackend,
  FirewallUnavailableError,
  type ResolvedRule,
} from './types';

/** Top-level anchor namespace; per-UID anchors live under it. */
export const ANCHOR_ROOT = 'autonomous-dev-egress';

/** Pluggable pfctl runner — tests mock this entirely. */
export type PfctlRunner = typeof runPfctl;

/** Constructor deps. */
export interface PfctlBackendDeps {
  pfctl?: PfctlRunner;
  refresh?: DnsRefreshLoop;
}

export class PfctlBackend implements FirewallBackend {
  readonly platform = 'darwin' as const;
  private readonly pfctl: PfctlRunner;
  private readonly refresh: DnsRefreshLoop;
  private initialised = false;
  private readonly active: Map<number, AllowlistEntry[]> = new Map();

  constructor(deps: PfctlBackendDeps = {}) {
    this.pfctl = deps.pfctl ?? runPfctl;
    this.refresh = deps.refresh ?? defaultRefresh;
  }

  async init(): Promise<void> {
    if (this.initialised) return;
    const probe = await this.pfctl(['-a', ANCHOR_ROOT, '-s', 'rules']);
    if (probe.exitCode === 0) {
      this.initialised = true;
      return;
    }
    if (/pf not enabled/i.test(probe.stderr)) {
      throw new FirewallUnavailableError(
        `pfctl: pf not enabled. Run 'sudo pfctl -e' or set extensions.allow_unfirewalled_backends: true. stderr=${probe.stderr.trim()}`,
      );
    }
    throw new FirewallUnavailableError(
      `pfctl: probe failed exit=${probe.exitCode} stderr=${probe.stderr.trim()}`,
    );
  }

  /**
   * Apply rules for the given UID (named `pid` for interface uniformity;
   * macOS pf is per-UID).
   */
  async applyRulesForPid(uid: number, allowlist: AllowlistEntry[]): Promise<void> {
    if (!this.initialised) await this.init();
    this.active.set(uid, allowlist);
    this.refresh.register(uid, allowlist, this);
    const initialRules = await this.refresh.resolveOnce(allowlist);
    await this.replaceRulesForPid(uid, initialRules);
  }

  async replaceRulesForPid(uid: number, rules: ResolvedRule[]): Promise<void> {
    const lines: string[] = [];
    for (const r of rules) {
      lines.push(
        `pass out quick proto ${r.protocol} from any to ${r.ip} port ${r.port} user ${uid}`,
      );
    }
    lines.push(`block return out quick from any to any user ${uid}`);
    lines.push('');
    const anchor = `${ANCHOR_ROOT}/uid-${uid}`;
    const out = await this.pfctl(['-a', anchor, '-f', '-'], lines.join('\n'));
    if (out.exitCode !== 0) {
      throw new FirewallUnavailableError(
        `pfctl: replaceRulesForPid(uid=${uid}) failed exit=${out.exitCode} stderr=${out.stderr.trim()}`,
      );
    }
  }

  async removeRulesForPid(uid: number): Promise<void> {
    const anchor = `${ANCHOR_ROOT}/uid-${uid}`;
    await this.pfctl(['-a', anchor, '-F', 'all']);
    this.active.delete(uid);
    this.refresh.unregister(uid);
  }

  listActiveAllowlists(): Map<number, AllowlistEntry[]> {
    return new Map(this.active);
  }
}

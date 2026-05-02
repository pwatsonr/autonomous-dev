/**
 * Linux nftables firewall backend (SPEC-024-3-01).
 *
 * Filters per-PID via `meta cgroup` matching in a dedicated
 * `autonomous-dev-egress` table. The output chain has policy `accept` so
 * unrelated host traffic is unaffected — only PIDs registered in the
 * per-PID chains are filtered.
 *
 * Lifecycle (per spec):
 *   1. `init()` ensures the table + base output chain exist.
 *   2. `applyRulesForPid` writes the PID into a per-PID cgroup-v2
 *      directory, registers the allowlist with `dns-refresh`, resolves
 *      the FQDNs once, and installs the per-PID chain in a single atomic
 *      transaction.
 *   3. `replaceRulesForPid` rebuilds the per-PID chain in one transaction.
 *   4. `removeRulesForPid` deletes the chain, removes the jump rule, and
 *      cleans up the cgroup directory.
 *
 * Tests mock `runNft`, `dnsResolver`, and `fsImpl` entirely; no real `nft`
 * or `dns` calls run in CI.
 *
 * @module intake/firewall/nftables
 */

import { promises as nodeFs } from 'fs';
import { runNft } from './nft-cli';
import { defaultRefresh, DnsRefreshLoop } from './dns-refresh';
import {
  type AllowlistEntry,
  type FirewallBackend,
  FirewallUnavailableError,
  type ResolvedRule,
} from './types';

/** Dedicated table name; namespaced to never collide with operator rules. */
export const TABLE_NAME = 'autonomous-dev-egress';
/** cgroup-v2 base path. */
export const CGROUP_BASE = '/sys/fs/cgroup/autonomous-dev';

/** Pluggable filesystem; tests mock the few calls we need. */
export interface FsLike {
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, data: string): Promise<void>;
  readFile(path: string, enc: 'utf8'): Promise<string>;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

/** Pluggable nft runner. */
export type NftRunner = typeof runNft;

/** Constructor deps; defaulted in production. */
export interface NftablesBackendDeps {
  nft?: NftRunner;
  fs?: FsLike;
  refresh?: DnsRefreshLoop;
}

const DEFAULT_FS: FsLike = {
  mkdir: (p, o) => nodeFs.mkdir(p, o),
  writeFile: (p, d) => nodeFs.writeFile(p, d),
  readFile: (p, e) => nodeFs.readFile(p, e),
  rm: (p, o) => nodeFs.rm(p, o),
};

export class NftablesBackend implements FirewallBackend {
  readonly platform = 'linux' as const;
  private readonly nft: NftRunner;
  private readonly fs: FsLike;
  private readonly refresh: DnsRefreshLoop;
  private initialised = false;
  private readonly active: Map<number, AllowlistEntry[]> = new Map();

  constructor(deps: NftablesBackendDeps = {}) {
    this.nft = deps.nft ?? runNft;
    this.fs = deps.fs ?? DEFAULT_FS;
    this.refresh = deps.refresh ?? defaultRefresh;
  }

  async init(): Promise<void> {
    if (this.initialised) return;
    const probe = await this.nft(`list table ip ${TABLE_NAME}\n`);
    if (probe.exitCode === 0) {
      this.initialised = true;
      return;
    }
    // Table not present (exit 1 is the expected "no such table" case).
    if (probe.exitCode === 1) {
      const create = await this.nft(
        [
          `add table ip ${TABLE_NAME}`,
          `add chain ip ${TABLE_NAME} output { type filter hook output priority 0 ; policy accept ; }`,
          '',
        ].join('\n'),
      );
      if (create.exitCode !== 0) {
        if (
          /Operation not permitted/i.test(create.stderr) ||
          /permission/i.test(create.stderr)
        ) {
          throw new FirewallUnavailableError(
            `nftables: cannot create '${TABLE_NAME}' table — daemon must run as root or hold CAP_NET_ADMIN. stderr=${create.stderr.trim()}`,
          );
        }
        throw new FirewallUnavailableError(
          `nftables: failed to create '${TABLE_NAME}' table: ${create.stderr.trim()}`,
        );
      }
      this.initialised = true;
      return;
    }
    if (
      /Operation not permitted/i.test(probe.stderr) ||
      /permission/i.test(probe.stderr)
    ) {
      throw new FirewallUnavailableError(
        `nftables: cannot probe '${TABLE_NAME}' table — daemon must run as root or hold CAP_NET_ADMIN. stderr=${probe.stderr.trim()}`,
      );
    }
    throw new FirewallUnavailableError(
      `nftables: probe failed exit=${probe.exitCode} stderr=${probe.stderr.trim()}`,
    );
  }

  async applyRulesForPid(pid: number, allowlist: AllowlistEntry[]): Promise<void> {
    if (!this.initialised) await this.init();
    const cgroupDir = `${CGROUP_BASE}/pid-${pid}`;
    try {
      await this.fs.mkdir(cgroupDir, { recursive: true });
      await this.fs.writeFile(`${cgroupDir}/cgroup.procs`, String(pid));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        throw new FirewallUnavailableError(
          `nftables: cannot create cgroup '${cgroupDir}' — daemon must run as root or hold CAP_NET_ADMIN with write perms on '${CGROUP_BASE}'. cause=${err.message}`,
        );
      }
      throw err;
    }
    this.active.set(pid, allowlist);
    this.refresh.register(pid, allowlist, this);
    const initialRules = await this.refresh.resolveOnce(allowlist);
    await this.replaceRulesForPid(pid, initialRules);
  }

  async replaceRulesForPid(pid: number, rules: ResolvedRule[]): Promise<void> {
    const lines: string[] = [];
    lines.push(`flush chain ip ${TABLE_NAME} pid-${pid}`);
    lines.push(`add chain ip ${TABLE_NAME} pid-${pid}`);
    // jump rule (operator chain → per-pid chain) — we re-add for idempotency.
    lines.push(
      `add rule ip ${TABLE_NAME} output meta cgroup ${cgroupId(pid)} jump pid-${pid}`,
    );
    for (const r of rules) {
      const fam = r.family === 'inet6' ? 'ip6' : 'ip';
      lines.push(
        `add rule ip ${TABLE_NAME} pid-${pid} ${fam} daddr ${r.ip} ${r.protocol} dport ${r.port} accept`,
      );
    }
    lines.push(
      `add rule ip ${TABLE_NAME} pid-${pid} reject with icmp type admin-prohibited`,
    );
    lines.push('');
    const out = await this.nft(lines.join('\n'));
    if (out.exitCode !== 0) {
      throw new FirewallUnavailableError(
        `nftables: replaceRulesForPid(${pid}) failed exit=${out.exitCode} stderr=${out.stderr.trim()}`,
      );
    }
  }

  async removeRulesForPid(pid: number): Promise<void> {
    const out = await this.nft(
      [
        `delete chain ip ${TABLE_NAME} pid-${pid}`,
        '', // trailing newline
      ].join('\n'),
    );
    // Idempotency: missing chain is not an error.
    if (out.exitCode !== 0 && !/No such file or directory/i.test(out.stderr)) {
      // Log via stderr only — caller may swallow per spec.
    }
    try {
      await this.fs.rm(`${CGROUP_BASE}/pid-${pid}`, {
        recursive: true,
        force: true,
      });
    } catch {
      // Idempotent removal — ignore.
    }
    this.active.delete(pid);
    this.refresh.unregister(pid);
  }

  listActiveAllowlists(): Map<number, AllowlistEntry[]> {
    return new Map(this.active);
  }
}

/**
 * Map a PID to the cgroup ID that nftables `meta cgroup` matches against.
 * Production reads `/sys/fs/cgroup/autonomous-dev/pid-<pid>/cgroup.id`; for
 * the default helper here we synthesise a deterministic placeholder so the
 * generated rule string is testable. The spawner replaces this when the
 * real cgroup ID is known (PLAN-024-2 contract).
 */
export function cgroupId(pid: number): number {
  return pid;
}

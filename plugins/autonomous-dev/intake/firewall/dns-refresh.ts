/**
 * Shared DNS refresh loop (SPEC-024-3-01).
 *
 * Resolves every active allowlist's FQDNs every 5 minutes; merges new IPs
 * into the per-key (PID on Linux, UID on macOS) rule set; expires rules
 * whose `lastSeenMs` is older than 1 hour. When any key's rule set changes
 * during a refresh, the registered backend's `replaceRulesForPid` is
 * called with the post-refresh `ResolvedRule[]`.
 *
 * Single-instance per process. Tests inject a clock + DNS resolver and
 * advance both manually.
 *
 * @module intake/firewall/dns-refresh
 */

import * as dnsPromises from 'dns/promises';
import type {
  AllowlistEntry,
  FirewallBackend,
  ResolvedRule,
} from './types';

/** Refresh cadence per TDD-024 §8 — 5 minutes. */
export const REFRESH_INTERVAL_MS = 5 * 60_000;
/** Stale-rule TTL per TDD-024 §8 — 1 hour. */
export const STALE_TTL_MS = 60 * 60_000;

/** Internal registration record. */
interface Registration {
  allowlist: AllowlistEntry[];
  backend: FirewallBackend;
  /** key → fqdn → ip → ResolvedRule (latest snapshot). */
  rules: Map<string, Map<string, ResolvedRule>>;
}

/** Pluggable DNS resolver — swapped in tests. */
export interface DnsResolver {
  resolve4(fqdn: string): Promise<string[]>;
  resolve6(fqdn: string): Promise<string[]>;
}

/** Pluggable clock — swapped in tests. */
export type Clock = () => number;

/** Pluggable timer factory — swapped in tests. */
export interface TimerFactory {
  setInterval(handler: () => void, ms: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout): void;
}

/**
 * Logger shape the refresh loop uses. Defaults to `console.warn` for the
 * single warn path (failed FQDN resolution); production callers may wire
 * a structured logger.
 */
export interface DnsRefreshLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Refresh-loop dependencies; defaulted in production, injected in tests. */
export interface DnsRefreshDeps {
  resolver?: DnsResolver;
  clock?: Clock;
  timers?: TimerFactory;
  logger?: DnsRefreshLogger;
}

/**
 * Singleton-ish refresh loop. Tests instantiate fresh instances; production
 * code uses the module-level `defaultRefresh` exported below.
 */
export class DnsRefreshLoop {
  private readonly registrations: Map<number, Registration> = new Map();
  private intervalHandle: NodeJS.Timeout | null = null;
  private readonly resolver: DnsResolver;
  private readonly clock: Clock;
  private readonly timers: TimerFactory;
  private readonly logger: DnsRefreshLogger;

  constructor(deps: DnsRefreshDeps = {}) {
    this.resolver = deps.resolver ?? {
      resolve4: (fqdn) => dnsPromises.resolve4(fqdn),
      resolve6: (fqdn) => dnsPromises.resolve6(fqdn),
    };
    this.clock = deps.clock ?? Date.now;
    this.timers = deps.timers ?? {
      setInterval: (h, ms) => setInterval(h, ms),
      clearInterval: (handle) => clearInterval(handle),
    };
    this.logger = deps.logger ?? {
      warn: (msg, fields) =>
        // eslint-disable-next-line no-console
        console.warn(msg, fields ?? {}),
    };
  }

  /** Register a key (PID or UID) for periodic refresh. */
  register(key: number, allowlist: AllowlistEntry[], backend: FirewallBackend): void {
    this.registrations.set(key, {
      allowlist,
      backend,
      rules: new Map(),
    });
    if (this.intervalHandle === null) {
      this.intervalHandle = this.timers.setInterval(() => {
        void this.refresh();
      }, REFRESH_INTERVAL_MS);
    }
  }

  /** Remove a key; the timer is cleared when no keys remain. */
  unregister(key: number): void {
    this.registrations.delete(key);
    if (this.registrations.size === 0 && this.intervalHandle !== null) {
      this.timers.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** True iff the timer is currently scheduled. Test helper. */
  isRunning(): boolean {
    return this.intervalHandle !== null;
  }

  /** Snapshot of current rules for a key. Test helper. */
  rulesFor(key: number): ResolvedRule[] {
    const reg = this.registrations.get(key);
    if (!reg) return [];
    const out: ResolvedRule[] = [];
    for (const fqdnMap of reg.rules.values()) {
      for (const r of fqdnMap.values()) out.push(r);
    }
    return out;
  }

  /**
   * Resolve every entry in `allowlist` to `ResolvedRule[]`. Wildcard FQDNs
   * (leading `*.`) are skipped with a WARN — they should have been
   * expanded by the caller. Failed resolutions log a WARN and are skipped
   * but do not abort the whole resolution.
   */
  async resolveOnce(allowlist: AllowlistEntry[]): Promise<ResolvedRule[]> {
    const now = this.clock();
    const rules: ResolvedRule[] = [];
    for (const entry of allowlist) {
      if (entry.fqdn.startsWith('*.')) {
        this.logger.warn('skipping wildcard FQDN; spawner must expand', {
          fqdn: entry.fqdn,
        });
        continue;
      }
      let v4: string[] = [];
      let v6: string[] = [];
      try {
        v4 = await this.resolver.resolve4(entry.fqdn);
      } catch (e) {
        this.logger.warn('resolve4 failed', {
          fqdn: entry.fqdn,
          error: (e as Error).message,
        });
      }
      try {
        v6 = await this.resolver.resolve6(entry.fqdn);
      } catch (e) {
        // IPv6 absence is common; debug-level in production but WARN here
        // keeps the path simple.
        this.logger.warn('resolve6 failed', {
          fqdn: entry.fqdn,
          error: (e as Error).message,
        });
      }
      for (const ip of v4) {
        rules.push({
          fqdn: entry.fqdn,
          ip,
          family: 'inet',
          port: entry.port,
          protocol: entry.protocol,
          lastSeenMs: now,
        });
      }
      for (const ip of v6) {
        rules.push({
          fqdn: entry.fqdn,
          ip,
          family: 'inet6',
          port: entry.port,
          protocol: entry.protocol,
          lastSeenMs: now,
        });
      }
    }
    return rules;
  }

  /**
   * Re-resolve every registered allowlist; merge new IPs, expire stale
   * IPs, and call `backend.replaceRulesForPid` for any key whose rule
   * set changed.
   */
  async refresh(): Promise<void> {
    const now = this.clock();
    for (const [key, reg] of this.registrations) {
      const before = this.snapshotIps(reg);
      // Resolve fresh and merge into reg.rules.
      for (const entry of reg.allowlist) {
        if (entry.fqdn.startsWith('*.')) {
          this.logger.warn('skipping wildcard FQDN during refresh', {
            fqdn: entry.fqdn,
          });
          continue;
        }
        let resolved4: string[] = [];
        let resolved6: string[] = [];
        let resolveOk = false;
        try {
          resolved4 = await this.resolver.resolve4(entry.fqdn);
          resolveOk = true;
        } catch (e) {
          this.logger.warn('resolve4 failed during refresh', {
            fqdn: entry.fqdn,
            error: (e as Error).message,
          });
        }
        try {
          resolved6 = await this.resolver.resolve6(entry.fqdn);
          resolveOk = true;
        } catch {
          // Ignore — same WARN already issued in initial resolve path.
        }
        if (!resolveOk) continue; // keep existing rules for this fqdn
        const fqdnMap = reg.rules.get(entry.fqdn) ?? new Map<string, ResolvedRule>();
        for (const ip of resolved4) {
          fqdnMap.set(ip, {
            fqdn: entry.fqdn,
            ip,
            family: 'inet',
            port: entry.port,
            protocol: entry.protocol,
            lastSeenMs: now,
          });
        }
        for (const ip of resolved6) {
          fqdnMap.set(ip, {
            fqdn: entry.fqdn,
            ip,
            family: 'inet6',
            port: entry.port,
            protocol: entry.protocol,
            lastSeenMs: now,
          });
        }
        reg.rules.set(entry.fqdn, fqdnMap);
      }
      // Evict stale entries.
      for (const [fqdn, fqdnMap] of reg.rules) {
        for (const [ip, rule] of fqdnMap) {
          if (rule.lastSeenMs < now - STALE_TTL_MS) {
            fqdnMap.delete(ip);
          }
        }
        if (fqdnMap.size === 0) reg.rules.delete(fqdn);
      }
      const after = this.snapshotIps(reg);
      if (!setsEqual(before, after)) {
        const all: ResolvedRule[] = [];
        for (const fqdnMap of reg.rules.values()) {
          for (const r of fqdnMap.values()) all.push(r);
        }
        await reg.backend.replaceRulesForPid(key, all);
      }
    }
  }

  private snapshotIps(reg: Registration): Set<string> {
    const out = new Set<string>();
    for (const [fqdn, fqdnMap] of reg.rules) {
      for (const ip of fqdnMap.keys()) out.add(`${fqdn}|${ip}`);
    }
    return out;
  }
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Module-level default refresh loop used by production backends. */
export const defaultRefresh = new DnsRefreshLoop();

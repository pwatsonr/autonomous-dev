/**
 * Firewall module facade (SPEC-024-3-01 / SPEC-024-3-02).
 *
 * Exports the platform-agnostic types and a `selectBackend()` factory the
 * spawner uses to pick the correct implementation at runtime.
 *
 * @module intake/firewall
 */

import { NftablesBackend } from './nftables';
import { PfctlBackend } from './pfctl';
import {
  type AllowlistEntry,
  type FirewallBackend,
  FirewallUnavailableError,
  type ResolvedRule,
} from './types';

export {
  AllowlistEntry,
  FirewallBackend,
  FirewallUnavailableError,
  ResolvedRule,
};
export { NftablesBackend } from './nftables';
export { PfctlBackend } from './pfctl';
export {
  DnsRefreshLoop,
  defaultRefresh,
  REFRESH_INTERVAL_MS,
  STALE_TTL_MS,
} from './dns-refresh';

/**
 * Stub backend returned on unsupported platforms (Windows). Every method
 * throws `FirewallUnavailableError` so the spawner reliably refuses to
 * launch unless `extensions.allow_unfirewalled_backends: true`.
 */
export class UnsupportedBackend implements FirewallBackend {
  readonly platform = 'unsupported' as const;
  async init(): Promise<void> {
    throw new FirewallUnavailableError(
      `firewall: platform '${process.platform}' is not supported; cloud backends require Linux or macOS`,
    );
  }
  async applyRulesForPid(): Promise<void> {
    throw new FirewallUnavailableError('firewall unavailable on this platform');
  }
  async replaceRulesForPid(): Promise<void> {
    throw new FirewallUnavailableError('firewall unavailable on this platform');
  }
  async removeRulesForPid(): Promise<void> {
    throw new FirewallUnavailableError('firewall unavailable on this platform');
  }
  listActiveAllowlists(): Map<number, AllowlistEntry[]> {
    return new Map();
  }
}

/**
 * Pick a firewall backend for the current platform. Tests inject overrides
 * directly; production callers use the no-arg form.
 */
export function selectBackend(platform: NodeJS.Platform = process.platform): FirewallBackend {
  if (platform === 'linux') return new NftablesBackend();
  if (platform === 'darwin') return new PfctlBackend();
  return new UnsupportedBackend();
}

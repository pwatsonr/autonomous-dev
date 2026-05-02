/**
 * macOS pfctl firewall backend — STUB (replaced by SPEC-024-3-02).
 *
 * SPEC-024-3-01 left this as a stub so `selectBackend()` can compile;
 * SPEC-024-3-02 fills in the real implementation. Until then every method
 * throws `FirewallUnavailableError`.
 *
 * @module intake/firewall/pfctl
 */

import {
  type AllowlistEntry,
  type FirewallBackend,
  FirewallUnavailableError,
  type ResolvedRule,
} from './types';

export class PfctlBackend implements FirewallBackend {
  readonly platform = 'darwin' as const;
  async init(): Promise<void> {
    throw new FirewallUnavailableError('pfctl backend not yet implemented (SPEC-024-3-02)');
  }
  async applyRulesForPid(_pid: number, _allowlist: AllowlistEntry[]): Promise<void> {
    throw new FirewallUnavailableError('pfctl backend not yet implemented (SPEC-024-3-02)');
  }
  async replaceRulesForPid(_pid: number, _rules: ResolvedRule[]): Promise<void> {
    throw new FirewallUnavailableError('pfctl backend not yet implemented (SPEC-024-3-02)');
  }
  async removeRulesForPid(_pid: number): Promise<void> {
    throw new FirewallUnavailableError('pfctl backend not yet implemented (SPEC-024-3-02)');
  }
  listActiveAllowlists(): Map<number, AllowlistEntry[]> {
    return new Map();
  }
}

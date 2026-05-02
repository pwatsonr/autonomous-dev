/**
 * Expand wildcard FQDNs in a manifest's `egress_allowlist` against a
 * resolved cloud region (SPEC-024-3-02).
 *
 * `*.amazonaws.com` style is rejected by the manifest schema; only a
 * leading `*.` (single label) is allowed, e.g. `ecs.*.amazonaws.com`.
 *
 * Per the spec the leading-`*.` is replaced with `<region>.` — the
 * regex `^*.` lives on the leftmost label which the schema validates is
 * always the cloud's "service" segment. If `region` is empty/undefined
 * and any entry contains a wildcard, this throws — silent fall-through
 * would leave a literal `*` in the firewall rule and break DNS resolution.
 *
 * @module intake/sessions/wildcard-expander
 */

import type { AllowlistEntry } from '../firewall/types';

export function expandWildcards(
  entries: AllowlistEntry[],
  region: string | undefined | null,
): AllowlistEntry[] {
  return entries.map((e) => {
    if (!e.fqdn.startsWith('*.')) return { ...e };
    if (!region || region.length === 0) {
      throw new Error(`region required to expand wildcard FQDN: ${e.fqdn}`);
    }
    return { ...e, fqdn: e.fqdn.replace(/^\*\./, `${region}.`) };
  });
}

/**
 * Tiny semver-compat helper used by chain orphan-consumer validation
 * (SPEC-022-1-01) and the dependency graph (SPEC-022-1-03).
 *
 * Producers always declare an exact MAJOR.MINOR (or MAJOR.MINOR.PATCH);
 * consumers may declare an optional leading `^` to accept any same-major
 * producer with minor ≥ the declared minor. Patch versions are ignored.
 *
 * This is deliberately narrower than the full `semver` package:
 *   - No `>=` / `<` / `||` ranges.
 *   - No prerelease / build-metadata handling.
 *   - Same-MAJOR.MINOR or caret-same-major-min-minor only.
 *
 * @module intake/hooks/semver-compat
 */

/**
 * True iff `producer` (e.g. '1.0' or '1.2.3') satisfies `consumerRange`
 * (e.g. '^1.0' or '1.0'). Caret means "same major, minor ≥ declared".
 *
 * Examples:
 *   satisfiesRange('1.0', '^1.0')   // true
 *   satisfiesRange('1.5', '^1.0')   // true
 *   satisfiesRange('2.0', '^1.0')   // false
 *   satisfiesRange('1.0', '1.0')    // true (exact)
 *   satisfiesRange('1.1', '1.0')    // false (exact)
 */
export function satisfiesRange(producer: string, consumerRange: string): boolean {
  const caret = consumerRange.startsWith('^');
  const range = caret ? consumerRange.slice(1) : consumerRange;
  const [pMajRaw, pMinRaw] = producer.split('.');
  const [rMajRaw, rMinRaw] = range.split('.');
  const pMaj = Number(pMajRaw);
  const pMin = Number(pMinRaw);
  const rMaj = Number(rMajRaw);
  const rMin = Number(rMinRaw);
  if (!Number.isFinite(pMaj) || !Number.isFinite(pMin)) return false;
  if (!Number.isFinite(rMaj) || !Number.isFinite(rMin)) return false;
  if (caret) return pMaj === rMaj && pMin >= rMin;
  return pMaj === rMaj && pMin === rMin;
}

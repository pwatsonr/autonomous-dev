/**
 * Pure scope helpers (ONBOARD Phase 0 — #584).
 *
 * Operate on `ArtifactScope` strings (not agent objects) so they can be shared
 * by the agent registry and the validator without coupling ownership to
 * agent-factory types. See docs/tdd/ONBOARD-phase0-ownership-scope.md (§4.3).
 */

import type { ArtifactScope, ScopeContext } from './types';

/** The composite registry key for an artifact: `${scope}::${name}`. */
export function scopeKeyOf(scope: ArtifactScope, name: string): string {
  return `${scope}::${name}`;
}

/**
 * Specificity ranking used for most-specific-wins resolution
 * (repo > project > global). A malformed/unknown scope ranks 0 and is never
 * preferred.
 */
export function scopeSpecificity(scope: ArtifactScope): number {
  if (scope === 'global') return 1;
  if (scope.startsWith('project:')) return 2;
  if (scope.startsWith('repo:')) return 3;
  return 0;
}

/**
 * Whether an artifact scope is eligible for a given request scope context.
 * `global` is always eligible; a project/repo scope is eligible only when it
 * matches the context's projectId/repoId. An empty/undefined context makes
 * only `global` eligible (back-compat).
 */
export function scopeEligible(scope: ArtifactScope, ctx?: ScopeContext): boolean {
  if (scope === 'global') return true;
  if (!ctx) return false;
  if (scope.startsWith('repo:')) {
    return ctx.repoId !== undefined && scope === `repo:${ctx.repoId}`;
  }
  if (scope.startsWith('project:')) {
    return ctx.projectId !== undefined && scope === `project:${ctx.projectId}`;
  }
  return false;
}

/**
 * Pick the most-specific eligible item for a scope context, given items that
 * each carry an `ArtifactScope` (extracted via `scopeOf`). Returns undefined if
 * none is eligible. Precedence (repo > project > global) is independent of any
 * `managed` flag on the items — managed governs lifecycle eligibility, not
 * resolution (OQ-3). This is the pure core of the registry's scope resolution.
 */
export function mostSpecificEligible<T>(
  items: T[],
  scopeOf: (item: T) => ArtifactScope,
  ctx?: ScopeContext,
): T | undefined {
  let best: T | undefined;
  let bestRank = -1;
  for (const item of items) {
    const scope = scopeOf(item);
    if (!scopeEligible(scope, ctx)) continue;
    const rank = scopeSpecificity(scope);
    if (rank > bestRank) {
      best = item;
      bestRank = rank;
    }
  }
  return best;
}

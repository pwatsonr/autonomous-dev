/**
 * ONBOARD Phase 4 (#596) — resolve a scoped-trigger `scope-id` against P0
 * ownership (FR-C).
 *
 * This verifies the scope EXISTS and maps it to its concrete target repo(s).
 * It does NOT decide who may trigger it (that is the scope-authz step) and it
 * does NOT pick which repo a project-scoped task runs against (that is the
 * handler's concern, informed by `repoIds`). Pure — takes an already-loaded
 * `Ownership` (the handler loads it via `readOwnership`, which is mockable).
 *
 * @module intake/triggers/scope_resolution
 */

import type { ArtifactScope, Ownership } from '../../src/ownership/types';

import type { ScopeType } from './scoped_command';

export type ResolvedScope =
  | {
      found: true;
      /** Canonical scope tag, e.g. `repo:acme/orders` or `project:payments`. */
      scope: ArtifactScope;
      scopeType: ScopeType;
      scopeId: string;
      /** The owning project: a repo's project (may be null = standalone), or the project itself. */
      projectId: string | null;
      /** Concrete repos the triggered task can target (repo scope → [the repo]; project scope → its members). */
      repoIds: string[];
    }
  | { found: false; reason: 'unknown-repo' | 'unknown-project' };

/**
 * Resolve `scopeId` of `scopeType` against `ownership`. Returns `found:false`
 * with a typed reason when the scope is not in the ownership tree.
 */
export function resolveScope(
  ownership: Ownership,
  scopeType: ScopeType,
  scopeId: string,
): ResolvedScope {
  if (scopeType === 'repo') {
    const repo = ownership.repos.find((r) => r.id === scopeId);
    if (repo === undefined) return { found: false, reason: 'unknown-repo' };
    return {
      found: true,
      scope: `repo:${scopeId}`,
      scopeType,
      scopeId,
      projectId: repo.projectId,
      repoIds: [scopeId],
    };
  }

  // scopeType === 'project'
  const project = ownership.projects.find((p) => p.id === scopeId);
  if (project === undefined) return { found: false, reason: 'unknown-project' };
  const repoIds = ownership.repos
    .filter((r) => r.projectId === scopeId)
    .map((r) => r.id);
  return {
    found: true,
    scope: `project:${scopeId}`,
    scopeType,
    scopeId,
    projectId: scopeId,
    repoIds,
  };
}

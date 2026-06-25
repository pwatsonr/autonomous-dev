/**
 * ONBOARD Phase 4 (#596) — scope-aware authorization for triggers (FR-C).
 *
 * This REUSES the existing intake `AuthzEngine` repo-scoped role resolution
 * rather than inventing a parallel permission model. The caller injects an
 * `authorize(userId, targetRepo)` that wraps
 * `AuthzEngine.authorize(userId, 'trigger', { targetRepo }, channel).granted`
 * — which already honors per-repo `repo_permissions` overrides and
 * default-denies unknown users / insufficient roles. This module only
 * COMPOSES that per-repo decision across a resolved scope:
 *   - repo scope    → authorized iff authorized for that repo.
 *   - project scope → authorized iff authorized for EVERY member repo (a
 *                     project trigger touches the whole project).
 *
 * It is NOT the enrollment gate `mayAutoImproveScope` — that governs proactive
 * work; a chat trigger is operator-requested work. Default-deny throughout.
 *
 * @module intake/triggers/scope_authz
 */

import type { ResolvedScope } from './scope_resolution';

/** A per-repo authorization decision (injected; wraps the real AuthzEngine). */
export type RepoAuthorizeFn = (userId: string, targetRepo: string) => boolean;

export interface ScopeAuthzResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether `userId` may trigger the (already resolved) scope, by
 * composing the injected per-repo `authorize` decision.
 */
export function canTriggerScope(
  resolved: Extract<ResolvedScope, { found: true }>,
  userId: string,
  authorize: RepoAuthorizeFn,
): ScopeAuthzResult {
  if (resolved.scopeType === 'repo') {
    return authorize(userId, resolved.scopeId)
      ? { allowed: true }
      : { allowed: false, reason: `not authorized for repo ${resolved.scopeId}` };
  }

  // project scope: must be authorized for every member repo (default-deny on
  // an empty project — there is nothing to authorize against).
  if (resolved.repoIds.length === 0) {
    return { allowed: false, reason: `project ${resolved.scopeId} has no repos to act on` };
  }
  const denied = resolved.repoIds.filter((repoId) => !authorize(userId, repoId));
  if (denied.length > 0) {
    return {
      allowed: false,
      reason: `not authorized for ${denied.length} repo(s) in project ${resolved.scopeId}`,
    };
  }
  return { allowed: true };
}

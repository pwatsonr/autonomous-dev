/**
 * Pure scope helpers for the memory hierarchy (ONBOARD Phase 1 — #587).
 * No IO — shared by the store and tests. Mirrors ownership/scope.ts.
 */

import type { MemoryScope, MemoryContext } from './types';

/**
 * The scopes that apply to a context, **general→specific** (global first).
 * global is always included; org/project/repo are added when present.
 */
export function scopesForContext(ctx: MemoryContext): MemoryScope[] {
  const scopes: MemoryScope[] = ['global'];
  if (ctx.orgId) scopes.push(`org:${ctx.orgId}`);
  if (ctx.projectId) scopes.push(`project:${ctx.projectId}`);
  if (ctx.repoId) scopes.push(`repo:${ctx.repoId}`);
  return scopes;
}

/** Relative directory for a scope under the memory root (e.g. `repo:acme/api` → `repo/acme/api`). */
export function scopeDir(scope: MemoryScope): string {
  if (scope === 'global') return 'global';
  const idx = scope.indexOf(':');
  const kind = scope.slice(0, idx);
  const id = scope.slice(idx + 1);
  return `${kind}/${id}`;
}

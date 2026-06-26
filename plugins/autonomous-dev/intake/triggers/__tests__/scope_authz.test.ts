/**
 * Unit tests for scope-aware trigger authorization (ONBOARD Phase 4, #596).
 *
 * @module intake/triggers/scope_authz.test
 */

import { canTriggerScope } from '../scope_authz';
import type { ResolvedScope } from '../scope_resolution';

type Found = Extract<ResolvedScope, { found: true }>;

const repoScope: Found = {
  found: true,
  scope: 'repo:acme/orders',
  scopeType: 'repo',
  scopeId: 'acme/orders',
  projectId: 'payments',
  repoIds: ['acme/orders'],
};

const projectScope: Found = {
  found: true,
  scope: 'project:payments',
  scopeType: 'project',
  scopeId: 'payments',
  projectId: 'payments',
  repoIds: ['acme/orders', 'acme/billing'],
};

describe('canTriggerScope', () => {
  it('allows a repo trigger when authorized for that repo', () => {
    const r = canTriggerScope(repoScope, 'u1', () => true);
    expect(r.allowed).toBe(true);
  });

  it('denies a repo trigger when not authorized (default-deny)', () => {
    const r = canTriggerScope(repoScope, 'u1', () => false);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('acme/orders');
  });

  it('allows a project trigger only when authorized for EVERY member repo', () => {
    const r = canTriggerScope(projectScope, 'u1', () => true);
    expect(r.allowed).toBe(true);
  });

  it('denies a project trigger when not authorized for one member repo', () => {
    const r = canTriggerScope(projectScope, 'u1', (_u, repo) => repo !== 'acme/billing');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('payments');
  });

  it('denies a project trigger when the project has no repos', () => {
    const empty: Found = { ...projectScope, scopeId: 'empty', scope: 'project:empty', repoIds: [] };
    const r = canTriggerScope(empty, 'u1', () => true);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('no repos');
  });

  it('passes the right repo ids to the injected authorize fn', () => {
    const seen: string[] = [];
    canTriggerScope(projectScope, 'u7', (_u, repo) => {
      seen.push(repo);
      return true;
    });
    expect(seen.sort()).toEqual(['acme/billing', 'acme/orders']);
  });
});

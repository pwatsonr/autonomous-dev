/**
 * Unit tests for scoped-trigger scope resolution (ONBOARD Phase 4, #596).
 *
 * @module intake/triggers/scope_resolution.test
 */

import type { Ownership } from '../../../src/ownership/types';
import { resolveScope } from '../scope_resolution';

const OWN: Ownership = {
  org: 'acme',
  projects: [
    { id: 'payments', name: 'Payments', tags: {} },
    { id: 'web', name: 'Web', tags: {} },
    { id: 'empty', name: 'Empty', tags: {} },
  ],
  repos: [
    { id: 'acme/orders', projectId: 'payments', tags: {} },
    { id: 'acme/billing', projectId: 'payments', tags: {} },
    { id: 'acme/site', projectId: 'web', tags: {} },
    { id: 'acme/standalone', projectId: null, tags: {} },
  ],
};

describe('resolveScope', () => {
  it('resolves a known repo scope to itself + its project', () => {
    const r = resolveScope(OWN, 'repo', 'acme/orders');
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.scope).toBe('repo:acme/orders');
      expect(r.projectId).toBe('payments');
      expect(r.repoIds).toEqual(['acme/orders']);
    }
  });

  it('resolves a standalone repo (projectId null)', () => {
    const r = resolveScope(OWN, 'repo', 'acme/standalone');
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.projectId).toBeNull();
      expect(r.repoIds).toEqual(['acme/standalone']);
    }
  });

  it('rejects an unknown repo', () => {
    const r = resolveScope(OWN, 'repo', 'acme/ghost');
    expect(r.found).toBe(false);
    if (!r.found) expect(r.reason).toBe('unknown-repo');
  });

  it('resolves a known project to its member repos', () => {
    const r = resolveScope(OWN, 'project', 'payments');
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.scope).toBe('project:payments');
      expect(r.projectId).toBe('payments');
      expect(r.repoIds.sort()).toEqual(['acme/billing', 'acme/orders']);
    }
  });

  it('resolves a project with no repos to an empty repo list', () => {
    const r = resolveScope(OWN, 'project', 'empty');
    expect(r.found).toBe(true);
    if (r.found) expect(r.repoIds).toEqual([]);
  });

  it('rejects an unknown project', () => {
    const r = resolveScope(OWN, 'project', 'nope');
    expect(r.found).toBe(false);
    if (!r.found) expect(r.reason).toBe('unknown-project');
  });

  it('matches case-insensitively and returns the canonical stored id', () => {
    const r = resolveScope(OWN, 'repo', 'ACME/Orders');
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.scopeId).toBe('acme/orders');
      expect(r.scope).toBe('repo:acme/orders');
      expect(r.repoIds).toEqual(['acme/orders']);
    }
  });
});

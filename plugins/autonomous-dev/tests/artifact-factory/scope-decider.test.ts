import { decideScopes } from '../../src/artifact-factory/scope-decider';
import type { Ownership } from '../../src/ownership/types';
import type { Opportunity } from '../../src/artifact-factory/detectors';

/**
 * Unit tests for the scope-decision heuristic (ONBOARD Phase 2, #590, P2.3).
 * Pure — repo→project via Ownership membership; propose-don't-apply.
 */

function own(repos: Record<string, string | null>): Ownership {
  return {
    org: 'acme',
    projects: [
      { id: 'payments', name: 'Payments', tags: {} },
      { id: 'web', name: 'Web', tags: {} },
    ],
    repos: Object.entries(repos).map(([id, projectId]) => ({ id, projectId, tags: {} })),
  };
}

function opp(name: string, repoId: string): Opportunity {
  return { id: `skill:${name}:${repoId}`, kind: 'skill', repoId, suggestedName: name, title: name, evidence: 'ev' };
}

function test_single_repo_repo_scope(): void {
  const o = own({ 'acme/orders': 'payments' });
  const props = decideScopes([opp('vault-access', 'acme/orders')], o);
  assert(props.length === 1, 'one proposal');
  assert(props[0].scope === 'repo:acme/orders', `repo scope, got ${props[0].scope}`);
  assert(props[0].confidence >= 0.85, 'high confidence for single repo');
  console.log('PASS: test_single_repo_repo_scope');
}

function test_three_in_project_project_scope(): void {
  const o = own({ 'acme/orders': 'payments', 'acme/billing': 'payments', 'acme/ledger': 'payments' });
  const props = decideScopes(
    [opp('vault-access', 'acme/orders'), opp('vault-access', 'acme/billing'), opp('vault-access', 'acme/ledger')],
    o,
  );
  assert(props.length === 1 && props[0].scope === 'project:payments', `project scope, got ${props[0].scope}`);
  assert(props[0].confidence >= 0.8, 'high confidence at ≥K');
  assert(props[0].repoIds.length === 3, 'all three members');
  console.log('PASS: test_three_in_project_project_scope');
}

function test_two_in_project_below_k(): void {
  const o = own({ 'acme/orders': 'payments', 'acme/billing': 'payments' });
  const props = decideScopes([opp('vault-access', 'acme/orders'), opp('vault-access', 'acme/billing')], o);
  assert(props[0].scope === 'project:payments', 'still project scope');
  assert(props[0].confidence < 0.7, 'lower confidence below K=3');
  assert(props[0].rationale.includes('below K'), 'rationale notes below-K');
  console.log('PASS: test_two_in_project_below_k');
}

function test_across_projects_global(): void {
  const o = own({ 'acme/orders': 'payments', 'acme/site': 'web' });
  const props = decideScopes([opp('vault-access', 'acme/orders'), opp('vault-access', 'acme/site')], o);
  assert(props[0].scope === 'global', `global across projects, got ${props[0].scope}`);
  console.log('PASS: test_across_projects_global');
}

function test_standalone_repos_global(): void {
  const o = own({ 'acme/a': null, 'acme/b': null });
  const props = decideScopes([opp('vault-access', 'acme/a'), opp('vault-access', 'acme/b')], o);
  assert(props[0].scope === 'global', 'standalone recurrence → global');
  console.log('PASS: test_standalone_repos_global');
}

function test_grouping_and_normalization(): void {
  const o = own({ 'acme/orders': 'payments' });
  const props = decideScopes(
    [opp('vault-access', 'acme/orders'), opp('run-tests', 'acme/orders'), opp('Vault-Access', 'acme/orders')],
    o,
  );
  // 'vault-access' + 'Vault-Access' aggregate (normalized); run-tests separate → 2 proposals
  assert(props.length === 2, `two distinct signals, got ${props.length}`);
  const vault = props.find((p) => p.suggestedName === 'vault-access');
  assert(!!vault, 'normalized vault group exists');
  console.log('PASS: test_grouping_and_normalization');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('artifact-factory/scope-decider', () => {
  it('test_single_repo_repo_scope', test_single_repo_repo_scope);
  it('test_three_in_project_project_scope', test_three_in_project_project_scope);
  it('test_two_in_project_below_k', test_two_in_project_below_k);
  it('test_across_projects_global', test_across_projects_global);
  it('test_standalone_repos_global', test_standalone_repos_global);
  it('test_grouping_and_normalization', test_grouping_and_normalization);
});

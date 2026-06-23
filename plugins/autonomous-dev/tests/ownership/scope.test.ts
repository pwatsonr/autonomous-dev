import {
  scopeKeyOf,
  scopeSpecificity,
  scopeEligible,
  mostSpecificEligible,
} from '../../src/ownership/scope';
import type { ArtifactScope } from '../../src/ownership/types';

/**
 * Unit tests for the pure scope-resolution core (ONBOARD Phase 0, #584).
 * This is the decision logic behind the registry's multi-scope resolution
 * (AC3: repo > project > global, with override, independent of `managed`).
 */

function test_scope_key(): void {
  assert(scopeKeyOf('global', 'code-executor') === 'global::code-executor', 'global key');
  assert(scopeKeyOf('repo:acme/api', 'x') === 'repo:acme/api::x', 'repo key');
  console.log('PASS: test_scope_key');
}

function test_specificity_ordering(): void {
  assert(scopeSpecificity('repo:acme/api') === 3, 'repo=3');
  assert(scopeSpecificity('project:payments') === 2, 'project=2');
  assert(scopeSpecificity('global') === 1, 'global=1');
  assert(scopeSpecificity('garbage' as ArtifactScope) === 0, 'malformed=0');
  assert(
    scopeSpecificity('repo:x') > scopeSpecificity('project:x') &&
      scopeSpecificity('project:x') > scopeSpecificity('global'),
    'repo > project > global',
  );
  console.log('PASS: test_specificity_ordering');
}

function test_eligibility(): void {
  // global is always eligible
  assert(scopeEligible('global') === true, 'global eligible w/o ctx');
  assert(scopeEligible('global', { repoId: 'r' }) === true, 'global eligible w/ ctx');
  // no ctx => only global
  assert(scopeEligible('repo:r', undefined) === false, 'repo not eligible w/o ctx');
  assert(scopeEligible('project:p', undefined) === false, 'project not eligible w/o ctx');
  // repo scope matches only its repoId
  assert(scopeEligible('repo:acme/api', { repoId: 'acme/api' }) === true, 'repo match');
  assert(scopeEligible('repo:acme/api', { repoId: 'acme/web' }) === false, 'repo mismatch');
  // project scope matches only its projectId
  assert(
    scopeEligible('project:payments', { repoId: 'acme/api', projectId: 'payments' }) === true,
    'project match',
  );
  assert(scopeEligible('project:payments', { projectId: 'identity' }) === false, 'project mismatch');
  // malformed scope is never eligible
  assert(scopeEligible('garbage' as ArtifactScope, { repoId: 'r' }) === false, 'malformed inert');
  console.log('PASS: test_eligibility');
}

interface Item {
  scope: ArtifactScope;
  managed?: boolean;
  tag: string;
}
const sc = (i: Item) => i.scope;

function test_resolution_override_and_precedence(): void {
  const glob: Item = { scope: 'global', tag: 'G' };
  const proj: Item = { scope: 'project:payments', tag: 'P' };
  const repo: Item = { scope: 'repo:acme/api', tag: 'R' };
  const items = [glob, proj, repo];

  // repo target in project payments -> repo wins (most specific)
  let r = mostSpecificEligible(items, sc, { repoId: 'acme/api', projectId: 'payments' });
  assert(r?.tag === 'R', `repo should win, got ${r?.tag}`);

  // a repo in payments but NOT the repo-scoped one -> project wins
  r = mostSpecificEligible([glob, proj], sc, { repoId: 'acme/web', projectId: 'payments' });
  assert(r?.tag === 'P', `project should win, got ${r?.tag}`);

  // no ctx (or a repo with no project membership) -> global only
  r = mostSpecificEligible(items, sc, {});
  assert(r?.tag === 'G', `global should win with empty ctx, got ${r?.tag}`);
  r = mostSpecificEligible(items, sc, undefined);
  assert(r?.tag === 'G', `global should win with no ctx, got ${r?.tag}`);

  // none eligible -> undefined (only repo-scoped item, wrong repo)
  r = mostSpecificEligible([repo], sc, { repoId: 'other/repo' });
  assert(r === undefined, 'no eligible -> undefined');
  console.log('PASS: test_resolution_override_and_precedence');
}

function test_precedence_independent_of_managed(): void {
  // A user-authoritative (managed:false) repo agent still overrides a
  // managed:true global agent of the same name (OQ-3).
  const globalManaged: Item = { scope: 'global', managed: true, tag: 'G' };
  const repoAuthoritative: Item = { scope: 'repo:acme/api', managed: false, tag: 'R' };
  const r = mostSpecificEligible([globalManaged, repoAuthoritative], sc, { repoId: 'acme/api' });
  assert(r?.tag === 'R', `repo authoritative should win regardless of managed, got ${r?.tag}`);
  assert(r?.managed === false, 'winner is the managed:false repo agent');
  console.log('PASS: test_precedence_independent_of_managed');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('ownership/scope', () => {
  it('test_scope_key', test_scope_key);
  it('test_specificity_ordering', test_specificity_ordering);
  it('test_eligibility', test_eligibility);
  it('test_resolution_override_and_precedence', test_resolution_override_and_precedence);
  it('test_precedence_independent_of_managed', test_precedence_independent_of_managed);
});

import { inferProjects, namePrefixOf } from '../../src/ingest/inference';
import type { RepoSignals } from '../../src/ingest/inference';

/**
 * Unit tests for project inference (ONBOARD Phase 1, #587, AC2).
 * Pure — inferProjects has no IO and never writes ownership (propose-don't-apply).
 */

function test_name_prefix_of(): void {
  assert(namePrefixOf('acme/payments-api') === 'payments', 'prefix from owner/name');
  assert(namePrefixOf('foo_bar') === 'foo', 'underscore separator');
  assert(namePrefixOf('acme/api') === undefined, 'no separator => undefined');
  console.log('PASS: test_name_prefix_of');
}

function test_infer_by_shared_owner(): void {
  const repos: RepoSignals[] = [
    { repoId: 'acme/orders', owners: ['@acme/payments'], deps: [] },
    { repoId: 'acme/billing', owners: ['@acme/payments'], deps: [] },
  ];
  const props = inferProjects(repos);
  assert(props.length === 1, 'one proposal');
  assert(props[0].repoIds.join(',') === 'acme/billing,acme/orders', 'both grouped (sorted)');
  assert(props[0].rationale.includes('@acme/payments'), 'rationale cites the owner');
  assert(props[0].confidence >= 0.7, `confidence raised by the strong signal, got ${props[0].confidence}`);
  console.log('PASS: test_infer_by_shared_owner');
}

function test_infer_by_name_prefix(): void {
  const repos: RepoSignals[] = [
    { repoId: 'acme/payments-api', owners: [], deps: [] },
    { repoId: 'acme/payments-web', owners: [], deps: [] },
  ];
  const props = inferProjects(repos);
  assert(props.length === 1 && props[0].id === 'payments', 'grouped by prefix, id=payments');
  assert(props[0].rationale.includes('payments'), 'rationale cites the prefix');
  console.log('PASS: test_infer_by_name_prefix');
}

function test_unrelated_no_proposal(): void {
  const repos: RepoSignals[] = [
    { repoId: 'acme/alpha', owners: ['@team/a'], deps: ['x'] },
    { repoId: 'acme/beta', owners: ['@team/b'], deps: ['y'] },
  ];
  assert(inferProjects(repos).length === 0, 'unrelated repos => no proposal (lone repos)');
  console.log('PASS: test_unrelated_no_proposal');
}

function test_transitive_grouping(): void {
  // a~b via shared owner; b~c via shared prefix => a,b,c are one project (union-find)
  const repos: RepoSignals[] = [
    { repoId: 'o/a', owners: ['@t/x'], deps: [] },
    { repoId: 'o/b', owners: ['@t/x'], deps: [], namePrefix: 'shared' },
    { repoId: 'o/c', owners: [], deps: [], namePrefix: 'shared' },
  ];
  const props = inferProjects(repos);
  assert(props.length === 1, 'one transitive group');
  assert(props[0].repoIds.length === 3, 'all three grouped transitively');
  console.log('PASS: test_transitive_grouping');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('ingest/inference (project inference)', () => {
  it('test_name_prefix_of', test_name_prefix_of);
  it('test_infer_by_shared_owner', test_infer_by_shared_owner);
  it('test_infer_by_name_prefix', test_infer_by_name_prefix);
  it('test_unrelated_no_proposal', test_unrelated_no_proposal);
  it('test_transitive_grouping', test_transitive_grouping);
});

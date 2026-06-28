import {
  inferProjects,
  namePrefixOf,
  parseOwners,
  signalsFromMemory,
  findAmbiguousMemberships,
} from '../../src/ingest/inference';
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

function test_parse_owners(): void {
  const codeowners = '# comment\n*       @acme/payments @alice\n/docs   @acme/Docs-Team\n';
  const owners = parseOwners(codeowners);
  assert(owners.includes('@acme/payments'), 'team token');
  assert(owners.includes('@alice'), 'user token');
  assert(owners.includes('@acme/docs-team'), 'lowercased team');
  assert(owners.length === 3 && owners[0] === '@acme/docs-team', 'deduped + sorted');
  assert(parseOwners('no owners here').length === 0, 'no false positives on plain text');
  // email-form owners (GitHub CODEOWNERS supports them) must NOT yield a bogus @domain owner
  const withEmail = parseOwners('* alice@acme.com bob@acme.com @real/team');
  assert(withEmail.join(',') === '@real/team', `emails ignored, only real handles: got ${withEmail.join(',')}`);
  // commented-out owners are stripped
  assert(parseOwners('# was @old-team\n* @new-team').join(',') === '@new-team', 'comment owners stripped');
  console.log('PASS: test_parse_owners');
}

function test_signals_from_memory(): void {
  const docs = [
    { topic: 'overview', content: '# Overview' },
    { topic: 'ownership', content: '* @acme/payments\n' },
  ];
  const s = signalsFromMemory('acme/orders', docs);
  assert(s.repoId === 'acme/orders', 'repoId carried');
  assert(s.owners.join(',') === '@acme/payments', 'owners parsed from ownership doc');
  assert(s.deps.length === 0, 'deps empty (weak signal, future enrichment)');
  // a repo with no ownership doc => no owners, still a valid signal
  assert(signalsFromMemory('acme/lonely', []).owners.length === 0, 'missing ownership doc => no owners');
  console.log('PASS: test_signals_from_memory');
}

function test_infer_from_memory_end_to_end(): void {
  // signalsFromMemory + inferProjects compose: two repos sharing an owner group.
  const mem: Record<string, { topic: string; content: string }[]> = {
    'acme/orders': [{ topic: 'ownership', content: '* @acme/payments' }],
    'acme/billing': [{ topic: 'ownership', content: '* @acme/payments' }],
    'acme/website': [{ topic: 'ownership', content: '* @acme/web' }],
  };
  const signals = Object.keys(mem).map((id) => signalsFromMemory(id, mem[id]));
  const props = inferProjects(signals);
  assert(props.length === 1, 'one proposal (orders+billing); website is lone');
  assert(props[0].repoIds.join(',') === 'acme/billing,acme/orders', 'grouped the shared-owner pair');
  console.log('PASS: test_infer_from_memory_end_to_end');
}

function test_ambiguity_detects_bridge_repo(): void {
  // o/c shares owner @team/pay with o/a AND name prefix "web" with o/web-ui —
  // two DIFFERENT candidate projects => o/c is ambiguous; the others are not.
  const repos: RepoSignals[] = [
    { repoId: 'o/a', owners: ['@team/pay'], deps: [] },
    { repoId: 'o/c', owners: ['@team/pay'], deps: [], namePrefix: 'web' },
    { repoId: 'o/web-ui', owners: [], deps: [], namePrefix: 'web' },
  ];
  const amb = findAmbiguousMemberships(repos);
  assert(amb.length === 1 && amb[0].repoId === 'o/c', 'only the bridge repo is ambiguous');
  assert(amb[0].candidateProjectIds.join(',') === 'team-pay,web', `2 sorted candidate ids, got ${amb[0].candidateProjectIds.join(',')}`);
  console.log('PASS: test_ambiguity_detects_bridge_repo');
}

function test_ambiguity_none_when_single_project(): void {
  // a clean single-owner project and a clean single-prefix project => no ambiguity.
  const repos: RepoSignals[] = [
    { repoId: 'acme/orders', owners: ['@acme/payments'], deps: [] },
    { repoId: 'acme/billing', owners: ['@acme/payments'], deps: [] },
    { repoId: 'acme/payments-api', owners: [], deps: [] },
    { repoId: 'acme/payments-web', owners: [], deps: [] },
  ];
  assert(findAmbiguousMemberships(repos).length === 0, 'unambiguous repos produce no questions');
  console.log('PASS: test_ambiguity_none_when_single_project');
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
  it('test_parse_owners', test_parse_owners);
  it('test_signals_from_memory', test_signals_from_memory);
  it('test_infer_from_memory_end_to_end', test_infer_from_memory_end_to_end);
  it('test_ambiguity_detects_bridge_repo', test_ambiguity_detects_bridge_repo);
  it('test_ambiguity_none_when_single_project', test_ambiguity_none_when_single_project);
});

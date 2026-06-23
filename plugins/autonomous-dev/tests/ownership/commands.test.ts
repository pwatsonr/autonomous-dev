import {
  addProject,
  assignRepo,
  tagRepo,
  listProjects,
  listRepos,
  parseTags,
} from '../../src/ownership/commands';
import { readOwnership, writeOwnership, manifestPath } from '../../src/ownership/store';
import type { OwnershipStoreIO } from '../../src/ownership/store';
import type { Ownership } from '../../src/ownership/types';

/**
 * Unit tests for ownership CLI command logic + manifest store (ONBOARD #584).
 * Pure command logic + an injected fake IO — never touches real operator state.
 */

const EMPTY: Ownership = { org: null, projects: [], repos: [] };

function fakeIO(initialFiles: Record<string, string> = {}): OwnershipStoreIO & {
  files: Record<string, string>;
} {
  const files: Record<string, string> = { ...initialFiles };
  return {
    files,
    homedir: () => '/home/test',
    readFile: (p: string) => files[p],
    writeFile: (p: string, data: string) => {
      files[p] = data;
    },
  };
}

// --- parseTags ---
function test_parse_tags(): void {
  const t = parseTags(['team=payments', 'domain=checkout']);
  assert(t.team === 'payments' && t.domain === 'checkout', 'parsed tags');
  let threw = false;
  try {
    parseTags(['bad']);
  } catch {
    threw = true;
  }
  assert(threw, 'malformed tag rejected');
  console.log('PASS: test_parse_tags');
}

// --- addProject ---
function test_add_project(): void {
  const r = addProject(EMPTY, { id: 'payments', name: 'Payments', tags: ['team=pay'] });
  assert(r.ownership.projects.length === 1, 'one project');
  assert(r.ownership.projects[0].id === 'payments', 'id set');
  assert(r.ownership.projects[0].name === 'Payments', 'name set');
  assert(r.ownership.projects[0].tags.team === 'pay', 'tag set');

  // invalid id rejected
  let threw = false;
  try {
    addProject(EMPTY, { id: 'Bad Id' });
  } catch {
    threw = true;
  }
  assert(threw, 'invalid id rejected');

  // duplicate rejected
  threw = false;
  try {
    addProject(r.ownership, { id: 'payments' });
  } catch {
    threw = true;
  }
  assert(threw, 'duplicate id rejected');

  // name defaults to id
  const r2 = addProject(EMPTY, { id: 'identity' });
  assert(r2.ownership.projects[0].name === 'identity', 'name defaults to id');
  console.log('PASS: test_add_project');
}

// --- assignRepo (AC1) ---
function test_assign_repo(): void {
  const withProject = addProject(EMPTY, { id: 'payments' }).ownership;

  // assign to unknown project rejected
  let threw = false;
  try {
    assignRepo(withProject, { repoId: 'acme/api', projectId: 'ghost' });
  } catch {
    threw = true;
  }
  assert(threw, 'assign to unknown project rejected');

  // assign creates the repo entry
  const r = assignRepo(withProject, { repoId: 'acme/api', projectId: 'payments', path: '/work/api' });
  assert(r.ownership.repos.length === 1, 'repo created');
  assert(r.ownership.repos[0].projectId === 'payments', 'membership set');
  assert(r.ownership.repos[0].path === '/work/api', 'path set');

  // re-assign updates membership, not duplicate
  const withProj2 = addProject(r.ownership, { id: 'identity' }).ownership;
  const r2 = assignRepo(withProj2, { repoId: 'acme/api', projectId: 'identity' });
  assert(r2.ownership.repos.length === 1, 'no duplicate repo');
  assert(r2.ownership.repos[0].projectId === 'identity', 'membership updated');
  assert(r2.ownership.repos[0].path === '/work/api', 'path preserved on reassign');
  console.log('PASS: test_assign_repo');
}

// --- tagRepo (AC4 — arbitrary vocabulary) ---
function test_tag_repo(): void {
  let own = addProject(EMPTY, { id: 'p' }).ownership;
  own = assignRepo(own, { repoId: 'r', projectId: 'p' }).ownership;

  const r = tagRepo(own, { repoId: 'r', set: ['team=core', 'business-unit=fintech'] });
  assert(r.ownership.repos[0].tags.team === 'core', 'team tag');
  assert(r.ownership.repos[0].tags['business-unit'] === 'fintech', 'arbitrary tag key allowed');

  // tagging unknown repo rejected
  let threw = false;
  try {
    tagRepo(own, { repoId: 'nope', set: ['x=y'] });
  } catch {
    threw = true;
  }
  assert(threw, 'tag unknown repo rejected');
  console.log('PASS: test_tag_repo');
}

// --- list formatting ---
function test_list(): void {
  let own = addProject(EMPTY, { id: 'payments', name: 'Pay', tags: ['team=pay'] }).ownership;
  own = assignRepo(own, { repoId: 'acme/api', projectId: 'payments' }).ownership;
  const pl = listProjects(own);
  assert(pl.includes('payments') && pl.includes('acme/api'), 'project list shows repo');
  assert(listProjects(EMPTY) === '(no projects)', 'empty project list');
  const rl = listRepos(own, 'payments');
  assert(rl.includes('acme/api'), 'repo list filtered by project');
  console.log('PASS: test_list');
}

// --- store round-trip preserves other manifest keys ---
function test_store_roundtrip_preserves_keys(): void {
  const io = fakeIO();
  const p = manifestPath(io);
  io.files[p] = JSON.stringify({
    repositories: { allowlist: ['/x'] },
    trust: { system_default_level: 1 },
    ownership: { org: 'acme', projects: [], repos: [] },
  });

  let own = readOwnership(io);
  assert(own.org === 'acme', 'reads existing ownership');

  own = addProject(own, { id: 'payments' }).ownership;
  own = assignRepo(own, { repoId: 'acme/api', projectId: 'payments' }).ownership;
  writeOwnership(own, io);

  // other keys preserved
  const manifest = JSON.parse(io.files[p]);
  assert(manifest.repositories.allowlist[0] === '/x', 'allowlist preserved');
  assert(manifest.trust.system_default_level === 1, 'trust preserved');
  assert(manifest.ownership.projects[0].id === 'payments', 'ownership written');

  // re-read reflects the write
  const reread = readOwnership(io);
  assert(reread.repos[0].projectId === 'payments', 'round-trip membership');
  console.log('PASS: test_store_roundtrip_preserves_keys');
}

// --- store handles missing manifest ---
function test_store_missing_manifest(): void {
  const io = fakeIO();
  const own = readOwnership(io);
  assert(own.projects.length === 0 && own.org === null, 'missing manifest -> empty ownership');
  writeOwnership(addProject(own, { id: 'x' }).ownership, io);
  assert(io.files[manifestPath(io)] !== undefined, 'manifest created on write');
  console.log('PASS: test_store_missing_manifest');
}

// F6/F8 hardening — input validation (ONBOARD #584 review round 1)
function test_command_input_hardening(): void {
  // empty tag key after trim rejected
  let threw = false;
  try {
    parseTags(['  =v']);
  } catch {
    threw = true;
  }
  assert(threw, 'empty tag key rejected');
  // prototype-pollution tag keys rejected
  for (const k of ['__proto__', 'constructor', 'prototype']) {
    threw = false;
    try {
      parseTags([`${k}=x`]);
    } catch {
      threw = true;
    }
    assert(threw, `unsafe tag key ${k} rejected`);
  }
  // invalid repoId rejected by assignRepo
  const own = addProject(EMPTY, { id: 'p' }).ownership;
  for (const bad of ['Up/Case', 'has space', 'a::b', '']) {
    threw = false;
    try {
      assignRepo(own, { repoId: bad, projectId: 'p' });
    } catch {
      threw = true;
    }
    assert(threw, `invalid repoId "${bad}" rejected`);
  }
  // valid repoId (owner/name with dots/underscores) accepted
  const r = assignRepo(own, { repoId: 'acme/api_v2.1', projectId: 'p' });
  assert(r.ownership.repos[0].id === 'acme/api_v2.1', 'valid repoId accepted');
  console.log('PASS: test_command_input_hardening');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('ownership/commands + store', () => {
  it('test_parse_tags', test_parse_tags);
  it('test_add_project', test_add_project);
  it('test_assign_repo', test_assign_repo);
  it('test_tag_repo', test_tag_repo);
  it('test_list', test_list);
  it('test_store_roundtrip_preserves_keys', test_store_roundtrip_preserves_keys);
  it('test_store_missing_manifest', test_store_missing_manifest);
  it('test_command_input_hardening', test_command_input_hardening);
});

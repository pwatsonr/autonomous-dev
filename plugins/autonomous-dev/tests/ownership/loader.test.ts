import {
  loadOwnershipConfig,
  projectForRepo,
  scopeContextForRepo,
  repoIdForPath,
} from '../../src/ownership/loader';

/**
 * Unit tests for the ownership config loader (ONBOARD Phase 0, #584).
 * Pure over injected raw config — never touches live operator state (NFR-4).
 */

function sampleRaw(): Record<string, unknown> {
  return {
    org: 'acme',
    projects: [
      { id: 'payments', name: 'Payments Platform', tags: { team: 'pay', domain: 'checkout' } },
      { id: 'identity', name: 'Identity' },
    ],
    repos: [
      { id: 'acme/api', path: '/work/api', remote: 'github.com/acme/api', projectId: 'payments', tags: { tier: 'critical' } },
      { id: 'acme/web', path: '/work/web', projectId: 'identity', tags: {} },
      { id: 'acme/tools', projectId: null },
    ],
  };
}

// O1 — absent/invalid input -> empty tree (back-compat)
function test_default_when_absent(): void {
  for (const input of [undefined, null, 42, 'nope', []]) {
    const o = loadOwnershipConfig(input as unknown);
    assert(o.org === null, `org should be null for ${JSON.stringify(input)}`);
    assert(o.projects.length === 0, 'projects should be empty');
    assert(o.repos.length === 0, 'repos should be empty');
  }
  console.log('PASS: test_default_when_absent');
}

// O2 — valid tree round-trips; project/scope resolution correct
function test_valid_tree_and_resolution(): void {
  const o = loadOwnershipConfig(sampleRaw());
  assert(o.org === 'acme', `org mismatch: ${o.org}`);
  assert(o.projects.length === 2, `projects len: ${o.projects.length}`);
  assert(o.repos.length === 3, `repos len: ${o.repos.length}`);
  // project name falls back to id when missing
  assert(o.projects[1].name === 'Identity', 'identity name');

  assert(projectForRepo(o, 'acme/api') === 'payments', 'api -> payments');
  assert(projectForRepo(o, 'acme/tools') === null, 'tools standalone');
  assert(projectForRepo(o, 'unknown/repo') === null, 'unknown repo -> null');

  const ctxApi = scopeContextForRepo(o, 'acme/api');
  assert(ctxApi.repoId === 'acme/api' && ctxApi.projectId === 'payments', 'api scope ctx');
  const ctxTools = scopeContextForRepo(o, 'acme/tools');
  assert(ctxTools.repoId === 'acme/tools' && ctxTools.projectId === undefined, 'tools scope ctx');
  console.log('PASS: test_valid_tree_and_resolution');
}

// O3 — dangling projectId is dropped to standalone (null)
function test_dangling_project_membership_dropped(): void {
  const raw = {
    projects: [{ id: 'real', name: 'Real' }],
    repos: [{ id: 'r1', projectId: 'ghost' }, { id: 'r2', projectId: 'real' }],
  };
  const o = loadOwnershipConfig(raw);
  assert(projectForRepo(o, 'r1') === null, 'ghost membership dropped to null');
  assert(projectForRepo(o, 'r2') === 'real', 'valid membership kept');
  console.log('PASS: test_dangling_project_membership_dropped');
}

// O4 — reverse path lookup
function test_repo_id_for_path(): void {
  const o = loadOwnershipConfig(sampleRaw());
  assert(repoIdForPath(o, '/work/api') === 'acme/api', 'path -> api');
  assert(repoIdForPath(o, '/work/web') === 'acme/web', 'path -> web');
  assert(repoIdForPath(o, '/work/nope') === undefined, 'unknown path -> undefined');
  console.log('PASS: test_repo_id_for_path');
}

// O5 — flexible grouping tags: arbitrary keys preserved, vocabulary not constrained (AC4)
function test_flexible_tags_preserved(): void {
  const raw = {
    projects: [{ id: 'p', name: 'P', tags: { team: 'a', domain: 'b', 'product-line': 'c', 'business-unit': 'd' } }],
    repos: [{ id: 'r', projectId: 'p', tags: { 'arbitrary-key': 'v', numeric: 7 } }],
  };
  const o = loadOwnershipConfig(raw);
  const t = o.projects[0].tags;
  assert(t.team === 'a' && t.domain === 'b' && t['product-line'] === 'c' && t['business-unit'] === 'd', 'all project tag keys preserved');
  assert(o.repos[0].tags['arbitrary-key'] === 'v', 'arbitrary repo tag key preserved');
  assert(o.repos[0].tags.numeric === '7', 'non-string tag value coerced to string');
  console.log('PASS: test_flexible_tags_preserved');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('ownership/loader', () => {
  it('test_default_when_absent', test_default_when_absent);
  it('test_valid_tree_and_resolution', test_valid_tree_and_resolution);
  it('test_dangling_project_membership_dropped', test_dangling_project_membership_dropped);
  it('test_repo_id_for_path', test_repo_id_for_path);
  it('test_flexible_tags_preserved', test_flexible_tags_preserved);
});

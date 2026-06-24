import {
  upsertProposal,
  getProposal,
  listProposals,
  setStatus,
  proposalId,
  loadProposals,
  proposalsPath,
} from '../../src/artifact-factory/proposal-store';
import type { ArtifactProposal, ArtifactStoreIO } from '../../src/artifact-factory/proposal-store';
import type { GeneratedArtifact } from '../../src/artifact-factory/types';

/**
 * Unit tests for the artifact proposal store (ONBOARD Phase 2, #590, P2.6).
 * JSON store + injected IO/clock — deterministic, no real disk.
 */

function fakeIO(): ArtifactStoreIO & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  let t = 0;
  return {
    files,
    homedir: () => '/home/test',
    readFile: (p) => files[p],
    writeFile: (p, d) => {
      files[p] = d;
    },
    now: () => `t${t++}`,
  };
}

const ARTIFACT: GeneratedArtifact = {
  kind: 'skill',
  name: 'vault-access',
  scope: 'repo:acme/api',
  description: 'Access the repo vault.',
  managed: true,
  allowedTools: ['Read', 'Glob', 'Grep'],
  body: '# Vault',
};

function proposal(status: ArtifactProposal['status']): ArtifactProposal {
  return {
    id: proposalId('skill', 'repo:acme/api', 'vault-access'),
    kind: 'skill',
    name: 'vault-access',
    scope: 'repo:acme/api',
    status,
    artifact: ARTIFACT,
    evidence: ['acme/api: vault'],
    rationale: 'single repo',
    confidence: 0.9,
    createdAt: 't0',
    history: [],
  };
}

function test_upsert_get_list(): void {
  const io = fakeIO();
  upsertProposal(proposal('pending_meta_review'), io);
  const got = getProposal('skill::repo:acme/api::vault-access', io);
  assert(!!got && got.status === 'pending_meta_review', 'get after upsert');

  // idempotent replace by id
  upsertProposal(proposal('meta_approved'), io);
  const all = listProposals(io);
  assert(all.length === 1, 'replace by id, not duplicate');
  assert(all[0].status === 'meta_approved', 'status replaced');

  assert(listProposals(io, { status: 'meta_approved' }).length === 1, 'filter by status');
  assert(listProposals(io, { status: 'promoted' }).length === 0, 'filter excludes other status');
  console.log('PASS: test_upsert_get_list');
}

function test_set_status_history(): void {
  const io = fakeIO();
  upsertProposal(proposal('meta_approved'), io);
  const id = 'skill::repo:acme/api::vault-access';
  const p = setStatus(id, 'promoted', 'promoted', io, 'wrote file');
  assert(p.status === 'promoted', 'status transitioned');
  assert(p.history.length === 1 && p.history[0].event === 'promoted', 'history appended');
  assert(p.history[0].detail === 'wrote file', 'history detail');
  assert(typeof p.history[0].at === 'string', 'history timestamped via io.now()');

  let threw = false;
  try {
    setStatus('nope', 'rejected', 'x', io);
  } catch {
    threw = true;
  }
  assert(threw, 'setStatus unknown id throws');
  console.log('PASS: test_set_status_history');
}

// M2: a corrupt store is PRESERVED, not silently wiped
function test_corrupt_preserve(): void {
  const io = fakeIO();
  io.files[proposalsPath(io)] = '{ this is : not json';
  const ps = loadProposals(io);
  assert(ps.length === 0, 'corrupt store loads as empty');
  const corruptKey = Object.keys(io.files).find((k) => k.includes('.corrupt-'));
  assert(!!corruptKey && io.files[corruptKey].includes('not json'), 'corrupt content preserved to a .corrupt- file');
  console.log('PASS: test_corrupt_preserve');
}

// F7: illegal status transitions are rejected
function test_illegal_transition(): void {
  const io = fakeIO();
  upsertProposal(proposal('meta_rejected'), io);
  const id = 'skill::repo:acme/api::vault-access';
  let threw = false;
  try {
    setStatus(id, 'promoted', 'x', io);
  } catch {
    threw = true;
  }
  assert(threw, 'meta_rejected → promoted is illegal');
  assert(setStatus(id, 'rejected', 'x', io).status === 'rejected', 'meta_rejected → rejected allowed');
  console.log('PASS: test_illegal_transition');
}

// B5: prior history is preserved on re-upsert (append-only audit)
function test_history_merge(): void {
  const io = fakeIO();
  const p1 = proposal('meta_rejected');
  p1.history = [{ at: 't0', event: 'generated' }];
  upsertProposal(p1, io);
  const p2 = proposal('meta_approved');
  p2.history = [{ at: 't1', event: 'regenerated' }];
  upsertProposal(p2, io);
  const got = getProposal('skill::repo:acme/api::vault-access', io)!;
  assert(got.history.length === 2, 'prior history preserved on re-upsert');
  assert(got.status === 'meta_approved', 'status updated on re-upsert');
  console.log('PASS: test_history_merge');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('artifact-factory/proposal-store', () => {
  it('test_upsert_get_list', test_upsert_get_list);
  it('test_set_status_history', test_set_status_history);
  it('test_corrupt_preserve', test_corrupt_preserve);
  it('test_illegal_transition', test_illegal_transition);
  it('test_history_merge', test_history_merge);
});

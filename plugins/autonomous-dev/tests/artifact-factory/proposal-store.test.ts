import {
  upsertProposal,
  getProposal,
  listProposals,
  setStatus,
  proposalId,
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

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('artifact-factory/proposal-store', () => {
  it('test_upsert_get_list', test_upsert_get_list);
  it('test_set_status_history', test_set_status_history);
});

import {
  proposeArtifacts,
  promoteProposal,
  rejectProposal,
  artifactPath,
  artifactScopeDir,
} from '../../src/artifact-factory/orchestrator';
import { proposalId, upsertProposal, getProposal } from '../../src/artifact-factory/proposal-store';
import type { ArtifactStoreIO } from '../../src/artifact-factory/proposal-store';
import { writeMemoryDoc } from '../../src/memory/store';
import type { MemoryStoreIO } from '../../src/memory/store';
import type { ArtifactRuntime } from '../../src/artifact-factory/runtime';
import type { OpportunityDetector } from '../../src/artifact-factory/detectors';
import type { Ownership } from '../../src/ownership/types';

/**
 * End-to-end pipeline tests (ONBOARD Phase 2, #590, P2.6): detect → scope →
 * generate → constraints → meta-review → park → promote. Fake runtime + IO.
 */

const OWN: Ownership = {
  org: 'acme',
  projects: [],
  repos: [{ id: 'acme/api', projectId: null, tags: {} }],
};

const CLEAN_SKILL = [
  '---',
  'name: model-name',
  'description: Access the repo vault configuration.',
  'kind: skill',
  'scope: global',
  'managed: true',
  'allowed-tools: [Read]',
  '---',
  '# Vault',
  'Look up the vault address in the repo config.',
].join('\n');

const SECRET_SKILL = [
  '---',
  'name: model-name',
  'description: Access the repo vault.',
  'scope: global',
  'managed: true',
  'allowed-tools: [Read]',
  '---',
  '# Vault',
  'Use password = hunter2hunter2 to authenticate.',
].join('\n');

function fakeRuntime(skillMd: string, verdict = '{"verdict":"approve","findings":[]}'): ArtifactRuntime {
  return {
    async generate(prompt) {
      // the meta-review prompt ends with this marker; everything else is a generation call
      return prompt.includes('Emit ONLY a JSON object') ? verdict : skillMd;
    },
  };
}

function fakeMemoryIO(): MemoryStoreIO & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    homedir: () => '/home/test',
    readFile: (p) => files[p],
    writeFile: (p, d) => {
      files[p] = d;
    },
    listDir: (dir) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const p of Object.keys(files)) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          if (rest.length > 0 && !rest.includes('/')) names.add(rest);
        }
      }
      return [...names];
    },
  };
}

function fakeStoreIO(): ArtifactStoreIO & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    homedir: () => '/home/test',
    readFile: (p) => files[p],
    writeFile: (p, d) => {
      files[p] = d;
    },
    now: () => '2026-06-24T00:00:00Z',
  };
}

function memWithVault(): MemoryStoreIO & { files: Record<string, string> } {
  const io = fakeMemoryIO();
  writeMemoryDoc('repo:acme/api', 'dependencies', '# Deps\n\n- node-vault\n', io);
  return io;
}

const VAULT_ID = proposalId('skill', 'repo:acme/api', 'vault-access');

async function test_propose_meta_approved(): Promise<void> {
  const storeIO = fakeStoreIO();
  const res = await proposeArtifacts({
    repoIds: ['acme/api'],
    ownership: OWN,
    runtime: fakeRuntime(CLEAN_SKILL),
    memIO: memWithVault(),
    storeIO,
  });
  assert(res.proposals.length === 1, `one proposal, got ${res.proposals.length}`);
  const p = res.proposals[0];
  assert(p.status === 'meta_approved', `meta_approved, got ${p.status}`);
  assert(p.scope === 'repo:acme/api', 'repo scope');
  assert(p.artifact.allowedTools.join(',') === 'Read,Glob,Grep', 'forced read-only tools');
  assert(p.id === VAULT_ID, 'stable id');
  console.log('PASS: test_propose_meta_approved');
}

async function test_constraint_rejects_secret(): Promise<void> {
  const storeIO = fakeStoreIO();
  const res = await proposeArtifacts({
    repoIds: ['acme/api'],
    ownership: OWN,
    runtime: fakeRuntime(SECRET_SKILL),
    memIO: memWithVault(),
    storeIO,
  });
  const p = res.proposals[0];
  assert(p.status === 'meta_rejected', 'secret body → meta_rejected by the constraints gate');
  assert((p.constraintViolations ?? []).some((v) => v.rule.startsWith('secret:')), 'records the secret violation');
  console.log('PASS: test_constraint_rejects_secret');
}

async function test_review_rejects(): Promise<void> {
  const storeIO = fakeStoreIO();
  const res = await proposeArtifacts({
    repoIds: ['acme/api'],
    ownership: OWN,
    runtime: fakeRuntime(CLEAN_SKILL, '{"verdict":"block","findings":[{"severity":"blocking","message":"nope"}]}'),
    memIO: memWithVault(),
    storeIO,
  });
  assert(res.proposals[0].status === 'meta_rejected', 'meta-review block → meta_rejected');
  console.log('PASS: test_review_rejects');
}

async function test_promote_writes_scoped_store(): Promise<void> {
  const storeIO = fakeStoreIO();
  await proposeArtifacts({ repoIds: ['acme/api'], ownership: OWN, runtime: fakeRuntime(CLEAN_SKILL), memIO: memWithVault(), storeIO });

  const { path: target, proposal } = promoteProposal(VAULT_ID, { ownership: OWN, storeIO });
  assert(proposal.status === 'promoted', 'status promoted');
  assert(target === '/home/test/.autonomous-dev/artifacts/repo/acme/api/skills/vault-access.md', `scoped path, got ${target}`);
  assert((storeIO.files[target] ?? '').includes('name: vault-access'), 'skill written to scoped store');
  // not promotable twice
  let threw = false;
  try {
    promoteProposal(VAULT_ID, { ownership: OWN, storeIO });
  } catch {
    threw = true;
  }
  assert(threw, 'cannot re-promote a promoted proposal');
  console.log('PASS: test_promote_writes_scoped_store');
}

async function test_promote_requires_meta_approved(): Promise<void> {
  const storeIO = fakeStoreIO();
  await proposeArtifacts({
    repoIds: ['acme/api'],
    ownership: OWN,
    runtime: fakeRuntime(CLEAN_SKILL, '{"verdict":"block","findings":[{"severity":"blocking","message":"x"}]}'),
    memIO: memWithVault(),
    storeIO,
  });
  let threw = false;
  try {
    promoteProposal(VAULT_ID, { ownership: OWN, storeIO });
  } catch {
    threw = true;
  }
  assert(threw, 'meta_rejected is not promotable');
  console.log('PASS: test_promote_requires_meta_approved');
}

async function test_tool_override_on_promote(): Promise<void> {
  const storeIO = fakeStoreIO();
  await proposeArtifacts({ repoIds: ['acme/api'], ownership: OWN, runtime: fakeRuntime(CLEAN_SKILL), memIO: memWithVault(), storeIO });
  const { path: target } = promoteProposal(VAULT_ID, { ownership: OWN, storeIO, toolOverride: ['Bash'] });
  const written = storeIO.files[target] ?? '';
  assert(written.includes('Bash'), 'operator-authorized Bash written into the promoted skill');
  // B5 regression guard: history must NOT be doubled — prior (generated+meta_approved) + promoted = 3.
  const after = getProposal(VAULT_ID, storeIO)!;
  assert(after.history.length === 3, `history not doubled, got ${after.history.length}`);
  assert(after.toolOverride?.join(',') === 'Bash', 'tool override recorded');
  console.log('PASS: test_tool_override_on_promote');
}

async function test_reject(): Promise<void> {
  const storeIO = fakeStoreIO();
  await proposeArtifacts({ repoIds: ['acme/api'], ownership: OWN, runtime: fakeRuntime(CLEAN_SKILL), memIO: memWithVault(), storeIO });
  const p = rejectProposal(VAULT_ID, storeIO);
  assert(p.status === 'rejected', 'operator reject → rejected');
  console.log('PASS: test_reject');
}

async function test_promote_requires_verdict(): Promise<void> {
  // forged: status meta_approved but the meta-review verdict is rejected → must NOT promote (SEC-004/009)
  const storeIO = fakeStoreIO();
  upsertProposal(
    {
      id: VAULT_ID,
      kind: 'skill',
      name: 'vault-access',
      scope: 'repo:acme/api',
      status: 'meta_approved',
      artifact: { kind: 'skill', name: 'vault-access', scope: 'repo:acme/api', description: 'd', managed: true, allowedTools: ['Read'], body: '# ok' },
      evidence: [],
      rationale: '',
      confidence: 0.9,
      metaReview: { verdict: 'rejected', findings: [] },
      createdAt: 't',
      history: [],
    },
    storeIO,
  );
  let threw = false;
  try {
    promoteProposal(VAULT_ID, { ownership: OWN, storeIO });
  } catch {
    threw = true;
  }
  assert(threw, 'forged meta_approved + rejected verdict is not promotable');
  console.log('PASS: test_promote_requires_verdict');
}

async function test_detection_errors_surfaced(): Promise<void> {
  const boom: OpportunityDetector = {
    name: 'boom',
    detect() {
      throw new Error('detector failure');
    },
  };
  const res = await proposeArtifacts({
    repoIds: ['acme/api'],
    ownership: OWN,
    runtime: fakeRuntime(CLEAN_SKILL),
    memIO: memWithVault(),
    storeIO: fakeStoreIO(),
    detectors: [boom],
  });
  assert(res.detectionErrors.length === 1 && res.detectionErrors[0].detector === 'boom', 'detector error surfaced (FR-A4)');
  console.log('PASS: test_detection_errors_surfaced');
}

async function test_multi_repo_grounding(): Promise<void> {
  // two repos in one project, both vault → project proposal; generation must see BOTH memories (B4)
  const own: Ownership = {
    org: 'acme',
    projects: [{ id: 'pay', name: 'Pay', tags: {} }],
    repos: [
      { id: 'acme/a', projectId: 'pay', tags: {} },
      { id: 'acme/b', projectId: 'pay', tags: {} },
    ],
  };
  const memIO = fakeMemoryIO();
  writeMemoryDoc('repo:acme/a', 'dependencies', '# Deps\n- node-vault\nMARKER_A', memIO);
  writeMemoryDoc('repo:acme/b', 'dependencies', '# Deps\n- node-vault\nMARKER_B', memIO);
  let capturedGen = '';
  const capturing: ArtifactRuntime = {
    async generate(prompt) {
      if (prompt.includes('Emit ONLY a JSON object')) return '{"verdict":"approve","findings":[]}';
      capturedGen = prompt;
      return CLEAN_SKILL;
    },
  };
  const res = await proposeArtifacts({ repoIds: ['acme/a', 'acme/b'], ownership: own, runtime: capturing, memIO, storeIO: fakeStoreIO(), k: 2 });
  assert(res.proposals.some((p) => p.scope === 'project:pay'), 'aggregated to project scope');
  assert(capturedGen.includes('MARKER_A') && capturedGen.includes('MARKER_B'), 'generation grounded in BOTH repos memory');
  console.log('PASS: test_multi_repo_grounding');
}

function test_scope_dir(): void {
  assert(artifactScopeDir('global') === 'global', 'global dir');
  assert(artifactScopeDir('project:payments') === 'project/payments', 'project dir');
  assert(artifactScopeDir('repo:acme/api') === 'repo/acme/api', 'repo dir');
  const io = fakeStoreIO();
  assert(artifactPath(io, 'global', 'x').endsWith('/artifacts/global/skills/x.md'), 'global path');
  console.log('PASS: test_scope_dir');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('artifact-factory/orchestrator', () => {
  it('test_propose_meta_approved', test_propose_meta_approved);
  it('test_constraint_rejects_secret', test_constraint_rejects_secret);
  it('test_review_rejects', test_review_rejects);
  it('test_promote_writes_scoped_store', test_promote_writes_scoped_store);
  it('test_promote_requires_meta_approved', test_promote_requires_meta_approved);
  it('test_tool_override_on_promote', test_tool_override_on_promote);
  it('test_reject', test_reject);
  it('test_promote_requires_verdict', test_promote_requires_verdict);
  it('test_detection_errors_surfaced', test_detection_errors_surfaced);
  it('test_multi_repo_grounding', test_multi_repo_grounding);
  it('test_scope_dir', test_scope_dir);
});

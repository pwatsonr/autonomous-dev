/**
 * Unit tests for the approval-gate / pause-resume flow shipped by
 * SPEC-022-2-03. Exercises:
 *
 *   - Pause: a producer with `requires_approval: true` halts the chain,
 *     downstream plugins are NOT invoked, the executor returns
 *     `outcome: 'paused'` with the persisted state.
 *   - State file: written via two-phase commit at
 *     `<requestRoot>/.autonomous-dev/chains/<chain-id>.state.json` with
 *     mode 0600 and no `.tmp.*` siblings.
 *   - Escalation: `chain-approval-pending` event is emitted exactly once.
 *   - Resume: without an `.approved.json` marker → `ChainNotApprovedError`
 *     and the state file is preserved. With the marker → the remaining
 *     plugins run and the state file is removed.
 *   - Daemon restart: `recoverPending` finds the persisted state and
 *     re-emits the escalation; subsequent approval + resume succeeds.
 *   - Without a `stateStore` injection the gate is a no-op (back-compat).
 *
 * @module tests/chains/test-approval-gate
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  ChainExecutor,
  type ChainHookInvoker,
} from '../../intake/chains/executor';
import { ArtifactRegistry } from '../../intake/chains/artifact-registry';
import { recoverPending, StateStore } from '../../intake/chains/state-store';
import {
  ChainNotApprovedError,
  ChainStateMissingError,
} from '../../intake/chains/errors';
import {
  buildGraphFrom,
  buildManifest,
  cleanupTempDir,
  createTempRequestDir,
  loadArtifactSchemas,
  loadCodePatchesExample,
  loadSecurityFindingsExample,
} from '../helpers/chain-fixtures';
import type {
  ChainEscalationEvent,
  ChainPausedState,
  EscalationRouter,
} from '../../intake/chains/types';
import type { HookManifest } from '../../intake/hooks/types';

interface RecordingRouter extends EscalationRouter {
  events: ChainEscalationEvent[];
}

function makeRouter(): RecordingRouter {
  const events: ChainEscalationEvent[] = [];
  return {
    events,
    notify(ev: ChainEscalationEvent): void {
      events.push(ev);
    },
  };
}

/**
 * Three-plugin chain shaped like the standards-to-fix flow:
 *   producer → fixer (requires_approval) → downstream
 * The downstream consumer needs `code-patches` so the chain genuinely
 * pauses on the middle plugin's output.
 */
function approvalGateManifests(): HookManifest[] {
  return [
    buildManifest({
      id: 'security-reviewer',
      produces: [
        { artifact_type: 'security-findings', schema_version: '1.0', format: 'json' },
      ],
    }),
    buildManifest({
      id: 'code-fixer',
      consumes: [
        { artifact_type: 'security-findings', schema_version: '^1.0' },
      ],
      produces: [
        {
          artifact_type: 'code-patches',
          schema_version: '1.0',
          format: 'json',
          requires_approval: true,
        },
      ],
    }),
    buildManifest({
      id: 'downstream-consumer',
      consumes: [
        { artifact_type: 'code-patches', schema_version: '^1.0' },
      ],
    }),
  ];
}

describe('SPEC-022-2-03: approval-gate pause behavior', () => {
  let tempRoot: string;
  let registry: ArtifactRegistry;
  let securityExample: unknown;
  let patchesExample: unknown;

  beforeEach(async () => {
    tempRoot = await createTempRequestDir();
    registry = await loadArtifactSchemas();
    securityExample = await loadSecurityFindingsExample();
    patchesExample = await loadCodePatchesExample();
    ChainExecutor.__resetActiveChainsForTest();
  });

  afterEach(async () => {
    ChainExecutor.__resetActiveChainsForTest();
    await cleanupTempDir(tempRoot);
  });

  it('halts on a requires_approval producer and writes a state file', async () => {
    const manifests = approvalGateManifests();
    const graph = buildGraphFrom(manifests);
    const downstreamCalls: string[] = [];
    const invoker: ChainHookInvoker = async (pid) => {
      downstreamCalls.push(pid);
      if (pid === 'code-fixer') {
        return [
          { artifactType: 'code-patches', scanId: 'patches-1', payload: patchesExample },
        ];
      }
      return [];
    };
    const router = makeRouter();
    const stateStore = new StateStore();
    const exec = new ChainExecutor(
      graph,
      registry,
      (id) => manifests.find((m) => m.id === id),
      invoker,
      undefined,
      { stateStore, escalationRouter: router, chainId: 'pause-1' },
    );

    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-PAUSE' },
      { artifactType: 'security-findings', scanId: 's-1', payload: securityExample },
    );

    expect(result.outcome).toBe('paused');
    expect(result.ok).toBe(true);
    expect(result.pausedState).toBeDefined();
    expect(result.pausedState!.paused_at_plugin).toBe('code-fixer');
    expect(result.pausedState!.paused_at_artifact).toBe('patches-1');
    expect(result.pausedState!.paused_at_artifact_type).toBe('code-patches');
    expect(result.pausedState!.remaining_order).toEqual(['downstream-consumer']);
    expect(result.pausedState!.triggering_plugin).toBe('security-reviewer');
    expect(result.pausedState!.request_id).toBe('REQ-PAUSE');

    // Downstream consumer was NOT invoked.
    expect(downstreamCalls).toEqual(['code-fixer']);

    // State file present, mode 0600, JSON parses to the same shape.
    const statePath = StateStore.statePathFor(tempRoot, 'pause-1');
    const stat = await fs.stat(statePath);
    expect(stat.isFile()).toBe(true);
    // Mode bits — mask off the file-type to be portable.
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).toBe(0o600);

    const persisted = JSON.parse(await fs.readFile(statePath, 'utf-8')) as ChainPausedState;
    expect(persisted.chain_id).toBe('pause-1');
    expect(persisted.paused_at_artifact).toBe('patches-1');

    // No leftover .tmp.* files in the chains directory.
    const chainsDir = path.dirname(statePath);
    const ents = await fs.readdir(chainsDir);
    expect(ents.filter((e) => e.includes('.tmp.'))).toEqual([]);

    // Exactly one escalation, with the canonical fields.
    expect(router.events).toHaveLength(1);
    expect(router.events[0]).toMatchObject({
      kind: 'chain-approval-pending',
      chain_id: 'pause-1',
      artifact_id: 'patches-1',
      artifact_type: 'code-patches',
      request_id: 'REQ-PAUSE',
    });
    expect(typeof router.events[0].paused_since).toBe('string');
  });

  it('without a stateStore the gate is a no-op (back-compat)', async () => {
    const manifests = approvalGateManifests();
    const graph = buildGraphFrom(manifests);
    const calls: string[] = [];
    const invoker: ChainHookInvoker = async (pid) => {
      calls.push(pid);
      if (pid === 'code-fixer') {
        return [
          { artifactType: 'code-patches', scanId: 's2', payload: patchesExample },
        ];
      }
      return [];
    };
    // No stateStore option → executor proceeds past the gate.
    const exec = new ChainExecutor(
      graph,
      registry,
      (id) => manifests.find((m) => m.id === id),
      invoker,
    );
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-NO-STORE' },
      { artifactType: 'security-findings', scanId: 's-2', payload: securityExample },
    );
    expect(result.outcome).not.toBe('paused');
    // Downstream consumer was invoked.
    expect(calls).toContain('downstream-consumer');
  });
});

describe('SPEC-022-2-03: resume() entry point', () => {
  let tempRoot: string;
  let registry: ArtifactRegistry;
  let securityExample: unknown;
  let patchesExample: unknown;

  beforeEach(async () => {
    tempRoot = await createTempRequestDir();
    registry = await loadArtifactSchemas();
    securityExample = await loadSecurityFindingsExample();
    patchesExample = await loadCodePatchesExample();
    ChainExecutor.__resetActiveChainsForTest();
  });

  afterEach(async () => {
    ChainExecutor.__resetActiveChainsForTest();
    await cleanupTempDir(tempRoot);
  });

  async function pauseChain(): Promise<{
    exec: ChainExecutor;
    stateStore: StateStore;
    chainId: string;
  }> {
    const manifests = approvalGateManifests();
    const graph = buildGraphFrom(manifests);
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') {
        return [
          { artifactType: 'code-patches', scanId: 'patches-resume', payload: patchesExample },
        ];
      }
      return [];
    };
    const stateStore = new StateStore();
    const exec = new ChainExecutor(
      graph,
      registry,
      (id) => manifests.find((m) => m.id === id),
      invoker,
      undefined,
      { stateStore, escalationRouter: makeRouter(), chainId: 'resume-1' },
    );
    const initial = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-RESUME' },
      { artifactType: 'security-findings', scanId: 's-r', payload: securityExample },
    );
    expect(initial.outcome).toBe('paused');
    return { exec, stateStore, chainId: 'resume-1' };
  }

  it('throws ChainNotApprovedError when no marker exists; state file preserved', async () => {
    const { exec, chainId } = await pauseChain();
    const statePath = StateStore.statePathFor(tempRoot, chainId);
    await expect(exec.resume(chainId, tempRoot)).rejects.toBeInstanceOf(
      ChainNotApprovedError,
    );
    // State file still present.
    const stat = await fs.stat(statePath);
    expect(stat.isFile()).toBe(true);
  });

  it('throws ChainStateMissingError when no state file exists', async () => {
    const stateStore = new StateStore();
    const exec = new ChainExecutor(
      buildGraphFrom(approvalGateManifests()),
      registry,
      () => undefined,
      async () => [],
      undefined,
      { stateStore },
    );
    await expect(exec.resume('does-not-exist', tempRoot)).rejects.toBeInstanceOf(
      ChainStateMissingError,
    );
  });

  it('throws ChainStateMissingError when stateStore is not configured', async () => {
    const exec = new ChainExecutor(
      buildGraphFrom(approvalGateManifests()),
      registry,
      () => undefined,
      async () => [],
    );
    await expect(exec.resume('any', tempRoot)).rejects.toBeInstanceOf(
      ChainStateMissingError,
    );
  });

  it('runs remaining plugins when an approval marker exists and removes the state file', async () => {
    const { exec, stateStore, chainId } = await pauseChain();

    // Write the approval marker beside the persisted patches artifact.
    const markerPath = StateStore.approvalMarkerPathFor(
      tempRoot,
      'code-patches',
      'patches-resume',
    );
    await stateStore.writeApprovalMarker(markerPath, {
      chain_id: chainId,
      artifact_id: 'patches-resume',
      approved_by: 'tester',
      approved_timestamp_iso: new Date().toISOString(),
    });

    const result = await exec.resume(chainId, tempRoot);
    expect(result.outcome).toBe('success');
    expect(result.steps.map((s) => s.pluginId)).toEqual(['downstream-consumer']);
    expect(result.steps[0].status).toBe('ok');

    // State file removed on successful resume.
    const statePath = StateStore.statePathFor(tempRoot, chainId);
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resume marks failure when a prior artifact was removed', async () => {
    const { exec, stateStore, chainId } = await pauseChain();
    // Write approval marker.
    const markerPath = StateStore.approvalMarkerPathFor(
      tempRoot,
      'code-patches',
      'patches-resume',
    );
    await stateStore.writeApprovalMarker(markerPath, {
      chain_id: chainId,
      artifact_id: 'patches-resume',
      approved_by: 'tester',
      approved_timestamp_iso: new Date().toISOString(),
    });

    // Wipe the persisted security-findings artifact so resume cannot
    // rebuild the producedIndex.
    const findingsPath = path.join(
      tempRoot,
      '.autonomous-dev',
      'artifacts',
      'security-findings',
      's-r.json',
    );
    await fs.unlink(findingsPath);

    const result = await exec.resume(chainId, tempRoot);
    expect(result.outcome).toBe('failed');
    expect(result.ok).toBe(false);
  });
});

describe('SPEC-022-2-03: recoverPending', () => {
  let tempRoot: string;
  let registry: ArtifactRegistry;
  let securityExample: unknown;
  let patchesExample: unknown;

  beforeEach(async () => {
    tempRoot = await createTempRequestDir();
    registry = await loadArtifactSchemas();
    securityExample = await loadSecurityFindingsExample();
    patchesExample = await loadCodePatchesExample();
    ChainExecutor.__resetActiveChainsForTest();
  });

  afterEach(async () => {
    ChainExecutor.__resetActiveChainsForTest();
    await cleanupTempDir(tempRoot);
  });

  it('returns 0 when no chains directory exists', async () => {
    const router = makeRouter();
    const recovered = await recoverPending(tempRoot, router);
    expect(recovered).toBe(0);
    expect(router.events).toHaveLength(0);
  });

  it('re-emits one chain-approval-pending event per state file (idempotent across instances)', async () => {
    // Build & pause a chain via one executor instance.
    const manifests = approvalGateManifests();
    const graph = buildGraphFrom(manifests);
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') {
        return [
          { artifactType: 'code-patches', scanId: 'patches-recovery', payload: patchesExample },
        ];
      }
      return [];
    };
    const stateStore = new StateStore();
    const firstRouter = makeRouter();
    const e1 = new ChainExecutor(
      graph,
      registry,
      (id) => manifests.find((m) => m.id === id),
      invoker,
      undefined,
      { stateStore, escalationRouter: firstRouter, chainId: 'recovery-1' },
    );
    await e1.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-RECOVER' },
      { artifactType: 'security-findings', scanId: 's-rec', payload: securityExample },
    );
    expect(firstRouter.events).toHaveLength(1);

    // Simulate daemon restart: build a brand-new router and call
    // recoverPending against the same temp root.
    const restartRouter = makeRouter();
    const recovered = await recoverPending(tempRoot, restartRouter);
    expect(recovered).toBe(1);
    expect(restartRouter.events).toHaveLength(1);
    expect(restartRouter.events[0]).toMatchObject({
      kind: 'chain-approval-pending',
      chain_id: 'recovery-1',
      artifact_id: 'patches-recovery',
      artifact_type: 'code-patches',
      request_id: 'REQ-RECOVER',
    });

    // Approve and resume via a brand-new executor (full restart).
    const markerPath = StateStore.approvalMarkerPathFor(
      tempRoot,
      'code-patches',
      'patches-recovery',
    );
    await stateStore.writeApprovalMarker(markerPath, {
      chain_id: 'recovery-1',
      artifact_id: 'patches-recovery',
      approved_by: 'tester-after-restart',
      approved_timestamp_iso: new Date().toISOString(),
    });
    const e2 = new ChainExecutor(
      buildGraphFrom(manifests),
      registry,
      (id) => manifests.find((m) => m.id === id),
      invoker,
      undefined,
      { stateStore, chainId: 'recovery-1' },
    );
    const result = await e2.resume('recovery-1', tempRoot);
    expect(result.outcome).toBe('success');
    const statePath = StateStore.statePathFor(tempRoot, 'recovery-1');
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips non-state-json entries and returns the correct count', async () => {
    const stateDir = path.join(tempRoot, '.autonomous-dev', 'chains');
    await fs.mkdir(stateDir, { recursive: true });
    // Garbage file that should be ignored.
    await fs.writeFile(path.join(stateDir, 'README.md'), 'not a state file');
    // Two valid state files.
    const store = new StateStore();
    for (const id of ['recA', 'recB']) {
      const sp = StateStore.statePathFor(tempRoot, id);
      const s: ChainPausedState = {
        chain_id: id,
        paused_at_plugin: 'p',
        paused_at_artifact: 'a',
        paused_at_artifact_type: 't',
        triggering_plugin: 'p0',
        remaining_order: [],
        artifacts_so_far: [],
        request_id: 'r',
        request_root: tempRoot,
        paused_timestamp_iso: '2026-05-02T00:00:00.000Z',
      };
      await store.writeState(sp, s);
    }
    const router = makeRouter();
    const recovered = await recoverPending(tempRoot, router, store);
    expect(recovered).toBe(2);
    expect(router.events.map((e) => e.chain_id).sort()).toEqual(['recA', 'recB']);
  });
});

describe('SPEC-022-2-03: StateStore primitives', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await createTempRequestDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempRoot);
  });

  it('rejects path computation for invalid chain ids', () => {
    expect(() =>
      StateStore.statePathFor(tempRoot, '../etc/passwd'),
    ).toThrow(/invalid chainId/);
    expect(() =>
      StateStore.statePathFor(tempRoot, 'with/slash'),
    ).toThrow(/invalid chainId/);
  });

  it('writeState then readState round-trips and chmod 0600 holds', async () => {
    const store = new StateStore();
    const target = StateStore.statePathFor(tempRoot, 'rt-1');
    const state: ChainPausedState = {
      chain_id: 'rt-1',
      paused_at_plugin: 'p',
      paused_at_artifact: 'a',
      paused_at_artifact_type: 't',
      triggering_plugin: 'p0',
      remaining_order: ['x', 'y'],
      artifacts_so_far: [{ artifact_type: 't', scan_id: 'a' }],
      request_id: 'req',
      request_root: tempRoot,
      paused_timestamp_iso: '2026-05-02T00:00:00.000Z',
    };
    await store.writeState(target, state);
    const stat = await fs.stat(target);
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).toBe(0o600);
    const readBack = await store.readState(target);
    expect(readBack).toEqual(state);
  });

  it('readState returns null on ENOENT', async () => {
    const store = new StateStore();
    const result = await store.readState(path.join(tempRoot, 'missing.state.json'));
    expect(result).toBeNull();
  });

  it('deleteState is idempotent', async () => {
    const store = new StateStore();
    const target = StateStore.statePathFor(tempRoot, 'idem-1');
    await store.deleteState(target); // never existed
    // Now create + delete + delete again
    await store.writeState(target, {
      chain_id: 'idem-1',
      paused_at_plugin: 'p',
      paused_at_artifact: 'a',
      paused_at_artifact_type: 't',
      triggering_plugin: 'p',
      remaining_order: [],
      artifacts_so_far: [],
      request_id: 'r',
      request_root: tempRoot,
      paused_timestamp_iso: '2026-05-02T00:00:00.000Z',
    });
    await store.deleteState(target);
    await expect(store.deleteState(target)).resolves.toBeUndefined();
  });

  it('approval and rejection markers round-trip with the right shape', async () => {
    const store = new StateStore();
    const approvedPath = StateStore.approvalMarkerPathFor(tempRoot, 'code-patches', 'sc-1');
    const rejectedPath = StateStore.rejectionMarkerPathFor(tempRoot, 'code-patches', 'sc-2');
    await store.writeApprovalMarker(approvedPath, {
      chain_id: 'c1',
      artifact_id: 'sc-1',
      approved_by: 'alice',
      approved_timestamp_iso: '2026-05-02T00:00:00.000Z',
      notes: 'looks good',
    });
    await store.writeRejectionMarker(rejectedPath, {
      chain_id: 'c2',
      artifact_id: 'sc-2',
      rejected_by: 'bob',
      rejected_timestamp_iso: '2026-05-02T00:00:00.000Z',
      reason: 'too risky',
    });
    expect(await store.readApprovalMarker(approvedPath)).toEqual({
      chain_id: 'c1',
      artifact_id: 'sc-1',
      approved_by: 'alice',
      approved_timestamp_iso: '2026-05-02T00:00:00.000Z',
      notes: 'looks good',
    });
    expect(await store.readRejectionMarker(rejectedPath)).toMatchObject({
      reason: 'too risky',
    });
    expect(await store.readApprovalMarker(path.join(tempRoot, 'nope'))).toBeNull();
    expect(await store.readRejectionMarker(path.join(tempRoot, 'nope'))).toBeNull();
  });

  it('fileExists returns true for a regular file and false for a directory or missing path', async () => {
    const store = new StateStore();
    const target = path.join(tempRoot, 'real.txt');
    await fs.writeFile(target, 'hi');
    expect(await store.fileExists(target)).toBe(true);
    expect(await store.fileExists(tempRoot)).toBe(false);
    expect(await store.fileExists(path.join(tempRoot, 'nope.txt'))).toBe(false);
  });
});

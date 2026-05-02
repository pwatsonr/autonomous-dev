/**
 * Unit tests for `autonomous-dev chains approve|reject` (SPEC-022-2-04).
 *
 * Covers:
 *   - approve: writes the marker, calls executor.resume, prints outcome.
 *   - approve: surfaces "no paused chain" / locator failure / auth failure.
 *   - reject: writes marker, deletes state file, prints summary.
 *   - reject: requires --reason; rejects empty / whitespace.
 *   - reject: surfaces auth failure / missing chain.
 *   - Fire-and-forget: no commands throw; exit code is the runner return.
 *
 * @module tests/cli/test-chains-approve-reject
 */

import { Writable } from 'node:stream';

import {
  runChainsApprove,
  type ChainsApproveDeps,
} from '../../intake/cli/chains_approve_command';
import {
  runChainsReject,
  type ChainsRejectDeps,
} from '../../intake/cli/chains_reject_command';
import type {
  ApprovalMarker,
  ChainPausedState,
  RejectionMarker,
} from '../../intake/chains/types';
import { StateStore } from '../../intake/chains/state-store';
import type { ChainExecutor } from '../../intake/chains/executor';

class CapturingStream extends Writable {
  chunks: string[] = [];
  _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    cb();
  }
  text(): string {
    return this.chunks.join('');
  }
}

function makePausedState(overrides: Partial<ChainPausedState> = {}): ChainPausedState {
  return {
    chain_id: 'chain-A',
    paused_at_plugin: 'code-fixer',
    paused_at_artifact: 'patches-1',
    paused_at_artifact_type: 'code-patches',
    triggering_plugin: 'security-reviewer',
    remaining_order: ['audit-logger'],
    artifacts_so_far: [
      { artifact_type: 'security-findings', scan_id: 'sf-1' },
      { artifact_type: 'code-patches', scan_id: 'patches-1' },
    ],
    request_id: 'REQ-1',
    request_root: '/tmp/req-1',
    paused_timestamp_iso: '2026-05-02T12:00:00.000Z',
    ...overrides,
  };
}

interface MockStore {
  written: { path: string; marker: ApprovalMarker | RejectionMarker }[];
  deleted: string[];
  writeApprovalMarker: jest.Mock;
  writeRejectionMarker: jest.Mock;
  deleteState: jest.Mock;
}

function makeMockStateStore(): MockStore {
  const written: MockStore['written'] = [];
  const deleted: string[] = [];
  return {
    written,
    deleted,
    writeApprovalMarker: jest.fn(async (path: string, marker: ApprovalMarker) => {
      written.push({ path, marker });
    }),
    writeRejectionMarker: jest.fn(async (path: string, marker: RejectionMarker) => {
      written.push({ path, marker });
    }),
    deleteState: jest.fn(async (path: string) => {
      deleted.push(path);
    }),
  };
}

describe('SPEC-022-2-04: chains approve', () => {
  it('writes the approval marker, calls executor.resume, and prints outcome=success', async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const store = makeMockStateStore();
    const executor = {
      resume: jest.fn(async () => ({
        triggeringPluginId: 'security-reviewer',
        steps: [],
        ok: true,
        outcome: 'success' as const,
      })),
    } as unknown as ChainExecutor;
    const state = makePausedState();
    const deps: ChainsApproveDeps = {
      stdout,
      stderr,
      executor,
      stateStore: store as unknown as StateStore,
      locateChainStateByArtifact: async () => state,
      requireAdminAuth: async () => {},
      approvedByResolver: () => 'tester',
      now: () => new Date('2026-05-02T12:00:00.000Z'),
    };

    const code = await runChainsApprove({ artifactId: 'patches-1' }, deps);
    expect(code).toBe(0);
    expect(stderr.text()).toBe('');
    expect(stdout.text()).toMatch(/Chain chain-A resumed: outcome=success/);
    expect(store.written).toHaveLength(1);
    const m = store.written[0].marker as ApprovalMarker;
    expect(m.chain_id).toBe('chain-A');
    expect(m.artifact_id).toBe('patches-1');
    expect(m.approved_by).toBe('tester');
    expect(m.approved_timestamp_iso).toBe('2026-05-02T12:00:00.000Z');
    expect(executor.resume).toHaveBeenCalledWith('chain-A', '/tmp/req-1');
  });

  it('records optional --notes on the approval marker', async () => {
    const store = makeMockStateStore();
    const deps: ChainsApproveDeps = {
      stdout: new CapturingStream(),
      stderr: new CapturingStream(),
      executor: {
        resume: jest.fn(async () => ({
          triggeringPluginId: 't',
          steps: [],
          ok: true,
          outcome: 'success' as const,
        })),
      } as unknown as ChainExecutor,
      stateStore: store as unknown as StateStore,
      locateChainStateByArtifact: async () => makePausedState(),
      requireAdminAuth: async () => {},
      approvedByResolver: () => 'tester',
      now: () => new Date(),
    };
    const code = await runChainsApprove(
      { artifactId: 'patches-1', notes: 'looks good' },
      deps,
    );
    expect(code).toBe(0);
    expect((store.written[0].marker as ApprovalMarker).notes).toBe('looks good');
  });

  it('exits non-zero with a clear message when no paused chain matches', async () => {
    const stderr = new CapturingStream();
    const deps: ChainsApproveDeps = {
      stdout: new CapturingStream(),
      stderr,
      executor: { resume: jest.fn() } as unknown as ChainExecutor,
      stateStore: makeMockStateStore() as unknown as StateStore,
      locateChainStateByArtifact: async () => null,
      requireAdminAuth: async () => {},
    };
    const code = await runChainsApprove({ artifactId: 'VIO-NONEXISTENT' }, deps);
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/No paused chain found for artifact VIO-NONEXISTENT/);
  });

  it('exits non-zero when admin auth fails (delegated)', async () => {
    const stderr = new CapturingStream();
    const deps: ChainsApproveDeps = {
      stdout: new CapturingStream(),
      stderr,
      executor: { resume: jest.fn() } as unknown as ChainExecutor,
      stateStore: makeMockStateStore() as unknown as StateStore,
      locateChainStateByArtifact: async () => makePausedState(),
      requireAdminAuth: async () => {
        throw new Error('not an admin');
      },
    };
    const code = await runChainsApprove({ artifactId: 'patches-1' }, deps);
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/auth failed: not an admin/);
  });

  it('exits non-zero when locating chain state throws', async () => {
    const stderr = new CapturingStream();
    const deps: ChainsApproveDeps = {
      stdout: new CapturingStream(),
      stderr,
      executor: { resume: jest.fn() } as unknown as ChainExecutor,
      stateStore: makeMockStateStore() as unknown as StateStore,
      locateChainStateByArtifact: async () => {
        throw new Error('disk on fire');
      },
      requireAdminAuth: async () => {},
    };
    const code = await runChainsApprove({ artifactId: 'p' }, deps);
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/failed to locate chain state: disk on fire/);
  });

  it('exits non-zero when writing the marker fails (returns code, never throws)', async () => {
    const stderr = new CapturingStream();
    const store = makeMockStateStore();
    store.writeApprovalMarker.mockRejectedValue(new Error('EACCES'));
    const deps: ChainsApproveDeps = {
      stdout: new CapturingStream(),
      stderr,
      executor: { resume: jest.fn() } as unknown as ChainExecutor,
      stateStore: store as unknown as StateStore,
      locateChainStateByArtifact: async () => makePausedState(),
      requireAdminAuth: async () => {},
    };
    const code = await runChainsApprove({ artifactId: 'p' }, deps);
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/failed to write approval marker: EACCES/);
  });

  it('exits non-zero when executor.resume throws', async () => {
    const stderr = new CapturingStream();
    const deps: ChainsApproveDeps = {
      stdout: new CapturingStream(),
      stderr,
      executor: {
        resume: jest.fn(async () => {
          throw new Error('chain not approved');
        }),
      } as unknown as ChainExecutor,
      stateStore: makeMockStateStore() as unknown as StateStore,
      locateChainStateByArtifact: async () => makePausedState(),
      requireAdminAuth: async () => {},
    };
    const code = await runChainsApprove({ artifactId: 'p' }, deps);
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/resume failed: chain not approved/);
  });

  it('falls back to $USER when no approvedByResolver is provided', async () => {
    const store = makeMockStateStore();
    const prev = process.env.USER;
    process.env.USER = 'env-user';
    try {
      const deps: ChainsApproveDeps = {
        stdout: new CapturingStream(),
        stderr: new CapturingStream(),
        executor: {
          resume: jest.fn(async () => ({
            triggeringPluginId: 't',
            steps: [],
            ok: true,
            outcome: 'success' as const,
          })),
        } as unknown as ChainExecutor,
        stateStore: store as unknown as StateStore,
        locateChainStateByArtifact: async () => makePausedState(),
        requireAdminAuth: async () => {},
      };
      await runChainsApprove({ artifactId: 'p' }, deps);
      expect((store.written[0].marker as ApprovalMarker).approved_by).toBe('env-user');
    } finally {
      if (prev === undefined) delete process.env.USER;
      else process.env.USER = prev;
    }
  });
});

describe('SPEC-022-2-04: chains reject', () => {
  it('writes rejection marker, deletes state file, prints summary', async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const store = makeMockStateStore();
    const state = makePausedState();
    const deps: ChainsRejectDeps = {
      stdout,
      stderr,
      stateStore: store as unknown as StateStore,
      locateChainStateByArtifact: async () => state,
      requireAdminAuth: async () => {},
      rejectedByResolver: () => 'tester',
      now: () => new Date('2026-05-02T12:00:00.000Z'),
    };
    const code = await runChainsReject(
      { artifactId: 'patches-1', reason: 'patches too risky' },
      deps,
    );
    expect(code).toBe(0);
    expect(stderr.text()).toBe('');
    expect(stdout.text()).toMatch(/Chain chain-A rejected: reason="patches too risky"/);
    const m = store.written[0].marker as RejectionMarker;
    expect(m.chain_id).toBe('chain-A');
    expect(m.artifact_id).toBe('patches-1');
    expect(m.rejected_by).toBe('tester');
    expect(m.reason).toBe('patches too risky');
    expect(store.deleted).toHaveLength(1);
    expect(store.deleted[0]).toContain('chain-A.state.json');
  });

  it('exits non-zero when --reason is missing', async () => {
    const stderr = new CapturingStream();
    const deps: ChainsRejectDeps = {
      stdout: new CapturingStream(),
      stderr,
      stateStore: makeMockStateStore() as unknown as StateStore,
      locateChainStateByArtifact: async () => makePausedState(),
      requireAdminAuth: async () => {},
    };
    const code = await runChainsReject({ artifactId: 'p', reason: '' }, deps);
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/--reason is required for chains reject/);
  });

  it('exits non-zero when --reason is whitespace-only', async () => {
    const stderr = new CapturingStream();
    const deps: ChainsRejectDeps = {
      stdout: new CapturingStream(),
      stderr,
      stateStore: makeMockStateStore() as unknown as StateStore,
      locateChainStateByArtifact: async () => makePausedState(),
      requireAdminAuth: async () => {},
    };
    const code = await runChainsReject({ artifactId: 'p', reason: '   \t\n' }, deps);
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/--reason is required/);
  });

  it('exits non-zero when admin auth fails', async () => {
    const stderr = new CapturingStream();
    const deps: ChainsRejectDeps = {
      stdout: new CapturingStream(),
      stderr,
      stateStore: makeMockStateStore() as unknown as StateStore,
      locateChainStateByArtifact: async () => makePausedState(),
      requireAdminAuth: async () => {
        throw new Error('not an admin');
      },
    };
    const code = await runChainsReject(
      { artifactId: 'p', reason: 'nope' },
      deps,
    );
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/auth failed: not an admin/);
  });

  it('exits non-zero when no paused chain matches', async () => {
    const stderr = new CapturingStream();
    const deps: ChainsRejectDeps = {
      stdout: new CapturingStream(),
      stderr,
      stateStore: makeMockStateStore() as unknown as StateStore,
      locateChainStateByArtifact: async () => null,
      requireAdminAuth: async () => {},
    };
    const code = await runChainsReject(
      { artifactId: 'GONE', reason: 'because' },
      deps,
    );
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/No paused chain found for artifact GONE/);
  });

  it('exits non-zero when writeRejectionMarker throws', async () => {
    const stderr = new CapturingStream();
    const store = makeMockStateStore();
    store.writeRejectionMarker.mockRejectedValue(new Error('EACCES'));
    const deps: ChainsRejectDeps = {
      stdout: new CapturingStream(),
      stderr,
      stateStore: store as unknown as StateStore,
      locateChainStateByArtifact: async () => makePausedState(),
      requireAdminAuth: async () => {},
    };
    const code = await runChainsReject(
      { artifactId: 'p', reason: 'nope' },
      deps,
    );
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/failed to write rejection marker: EACCES/);
    expect(store.deleted).toHaveLength(0);
  });

  it('exits non-zero when deleteState throws (marker already written)', async () => {
    const stderr = new CapturingStream();
    const store = makeMockStateStore();
    store.deleteState.mockRejectedValue(new Error('EBUSY'));
    const deps: ChainsRejectDeps = {
      stdout: new CapturingStream(),
      stderr,
      stateStore: store as unknown as StateStore,
      locateChainStateByArtifact: async () => makePausedState(),
      requireAdminAuth: async () => {},
    };
    const code = await runChainsReject(
      { artifactId: 'p', reason: 'nope' },
      deps,
    );
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/failed to delete chain state: EBUSY/);
  });

  it('exits non-zero when locating chain state throws', async () => {
    const stderr = new CapturingStream();
    const deps: ChainsRejectDeps = {
      stdout: new CapturingStream(),
      stderr,
      stateStore: makeMockStateStore() as unknown as StateStore,
      locateChainStateByArtifact: async () => {
        throw new Error('disk on fire');
      },
      requireAdminAuth: async () => {},
    };
    const code = await runChainsReject(
      { artifactId: 'p', reason: 'nope' },
      deps,
    );
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/failed to locate chain state: disk on fire/);
  });
});

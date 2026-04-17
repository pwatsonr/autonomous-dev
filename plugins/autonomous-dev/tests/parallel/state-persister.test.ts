/**
 * Tests for StatePersister — SPEC-006-1-3: State Persistence and Orphan Cleanup
 *
 * Covers:
 *   - saveState / loadState roundtrip (atomic write, schema validation)
 *   - loadState error handling (StateNotFoundError, CorruptStateError, UnsupportedStateVersionError)
 *   - listInFlightRequests (active filtering, .tmp skipping, corrupt file skipping)
 *   - archiveState (moves to archive dir with timestamp suffix)
 *   - deleteState (removes state file, idempotent on missing)
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import {
  StatePersister,
  StateNotFoundError,
  CorruptStateError,
  UnsupportedStateVersionError,
} from '../../src/parallel/state-persister';
import { PersistedExecutionState, ExecutionPhase } from '../../src/parallel/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let stateDir: string;
let archiveDir: string;
let persister: StatePersister;

function createTestState(
  requestId: string,
  overrides: Partial<PersistedExecutionState> = {},
): PersistedExecutionState {
  return {
    version: 1,
    requestId,
    baseBranch: 'main',
    integrationBranch: `auto/${requestId}/integration`,
    phase: 'fan-out' as ExecutionPhase,
    worktrees: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'state-persister-test-'));
  stateDir = path.join(tmpDir, 'state');
  archiveDir = path.join(tmpDir, 'archive');
  persister = new StatePersister(stateDir, archiveDir);
  await persister.init();
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// saveState / loadState roundtrip
// ---------------------------------------------------------------------------

describe('saveState / loadState roundtrip', () => {
  it('roundtrips a valid state', async () => {
    const state = createTestState('req-001');
    await persister.saveState(state);
    const loaded = await persister.loadState('req-001');
    expect(loaded.requestId).toBe('req-001');
    expect(loaded.version).toBe(1);
  });

  it('atomic write: .tmp removed after successful save', async () => {
    await persister.saveState(createTestState('req-001'));
    expect(fs.existsSync(path.join(stateDir, 'req-001.json.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'req-001.json'))).toBe(true);
  });

  it('preserves old state if write is interrupted', async () => {
    // Save initial state
    await persister.saveState(createTestState('req-001', { phase: 'fan-out' }));

    // Simulate interrupted write: create .tmp but don't rename
    fs.writeFileSync(path.join(stateDir, 'req-001.json.tmp'), 'corrupt');

    // Load should return original state (the .json file is untouched)
    const loaded = await persister.loadState('req-001');
    expect(loaded.phase).toBe('fan-out');
  });

  it('updates the updatedAt timestamp on save', async () => {
    const state = createTestState('req-001');
    const beforeSave = state.updatedAt;
    // Small delay to ensure timestamp differs
    await new Promise((resolve) => setTimeout(resolve, 10));
    await persister.saveState(state);
    const loaded = await persister.loadState('req-001');
    expect(loaded.updatedAt).not.toBe(beforeSave);
  });

  it('preserves all fields on roundtrip', async () => {
    const state = createTestState('req-002', {
      baseBranch: 'develop',
      phase: 'merging',
      worktrees: {
        'track-a': {
          requestId: 'req-002',
          trackName: 'track-a',
          worktreePath: '/tmp/wt/req-002/track-a',
          branchName: 'auto/req-002/track-a',
          integrationBranch: 'auto/req-002/integration',
          createdAt: '2026-04-08T10:00:00Z',
          status: 'active',
        },
      },
    });
    await persister.saveState(state);
    const loaded = await persister.loadState('req-002');
    expect(loaded.baseBranch).toBe('develop');
    expect(loaded.phase).toBe('merging');
    expect(loaded.worktrees['track-a'].trackName).toBe('track-a');
    expect(loaded.worktrees['track-a'].status).toBe('active');
  });

  it('overwrites existing state', async () => {
    await persister.saveState(createTestState('req-001', { phase: 'fan-out' }));
    await persister.saveState(createTestState('req-001', { phase: 'merging' }));
    const loaded = await persister.loadState('req-001');
    expect(loaded.phase).toBe('merging');
  });
});

// ---------------------------------------------------------------------------
// loadState error handling
// ---------------------------------------------------------------------------

describe('loadState error handling', () => {
  it('throws StateNotFoundError for missing file', async () => {
    await expect(persister.loadState('nonexistent')).rejects.toThrow(StateNotFoundError);
  });

  it('throws CorruptStateError for invalid JSON', async () => {
    fs.writeFileSync(path.join(stateDir, 'bad.json'), '{truncated');
    await expect(persister.loadState('bad')).rejects.toThrow(CorruptStateError);
  });

  it('throws CorruptStateError for empty file', async () => {
    fs.writeFileSync(path.join(stateDir, 'empty.json'), '');
    await expect(persister.loadState('empty')).rejects.toThrow(CorruptStateError);
  });

  it('throws UnsupportedStateVersionError for version != 1', async () => {
    fs.writeFileSync(
      path.join(stateDir, 'v2.json'),
      JSON.stringify({ version: 2 }),
    );
    await expect(persister.loadState('v2')).rejects.toThrow(
      UnsupportedStateVersionError,
    );
  });

  it('throws UnsupportedStateVersionError for missing version', async () => {
    fs.writeFileSync(
      path.join(stateDir, 'no-version.json'),
      JSON.stringify({ requestId: 'no-version' }),
    );
    await expect(persister.loadState('no-version')).rejects.toThrow(
      UnsupportedStateVersionError,
    );
  });

  it('StateNotFoundError includes requestId', async () => {
    try {
      await persister.loadState('missing-req');
      fail('Expected StateNotFoundError');
    } catch (err) {
      expect(err).toBeInstanceOf(StateNotFoundError);
      expect((err as StateNotFoundError).requestId).toBe('missing-req');
    }
  });

  it('CorruptStateError includes requestId and filePath', async () => {
    fs.writeFileSync(path.join(stateDir, 'corrupt.json'), 'not json');
    try {
      await persister.loadState('corrupt');
      fail('Expected CorruptStateError');
    } catch (err) {
      expect(err).toBeInstanceOf(CorruptStateError);
      expect((err as CorruptStateError).requestId).toBe('corrupt');
      expect((err as CorruptStateError).filePath).toContain('corrupt.json');
    }
  });

  it('UnsupportedStateVersionError includes version', async () => {
    fs.writeFileSync(
      path.join(stateDir, 'v99.json'),
      JSON.stringify({ version: 99 }),
    );
    try {
      await persister.loadState('v99');
      fail('Expected UnsupportedStateVersionError');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedStateVersionError);
      expect((err as UnsupportedStateVersionError).version).toBe(99);
    }
  });
});

// ---------------------------------------------------------------------------
// listInFlightRequests
// ---------------------------------------------------------------------------

describe('listInFlightRequests', () => {
  it('returns only active requests', async () => {
    await persister.saveState(createTestState('req-001', { phase: 'fan-out' }));
    await persister.saveState(createTestState('req-002', { phase: 'complete' }));
    await persister.saveState(createTestState('req-003', { phase: 'merging' }));
    const inFlight = await persister.listInFlightRequests();
    expect(inFlight).toContain('req-001');
    expect(inFlight).toContain('req-003');
    expect(inFlight).not.toContain('req-002');
  });

  it('excludes failed requests', async () => {
    await persister.saveState(createTestState('req-004', { phase: 'failed' }));
    const inFlight = await persister.listInFlightRequests();
    expect(inFlight).not.toContain('req-004');
  });

  it('skips .tmp files', async () => {
    fs.writeFileSync(path.join(stateDir, 'req-tmp.json.tmp'), '{}');
    const inFlight = await persister.listInFlightRequests();
    expect(inFlight).not.toContain('req-tmp');
  });

  it('skips corrupt state files', async () => {
    fs.writeFileSync(path.join(stateDir, 'corrupt.json'), 'not json');
    const inFlight = await persister.listInFlightRequests();
    expect(inFlight).not.toContain('corrupt');
  });

  it('returns empty array when state dir is empty', async () => {
    const inFlight = await persister.listInFlightRequests();
    expect(inFlight).toEqual([]);
  });

  it('returns empty array when state dir does not exist', async () => {
    const emptyPersister = new StatePersister(
      path.join(tmpDir, 'nonexistent'),
      archiveDir,
    );
    const inFlight = await emptyPersister.listInFlightRequests();
    expect(inFlight).toEqual([]);
  });

  it('includes all non-terminal phases', async () => {
    const activePhases: ExecutionPhase[] = [
      'initializing',
      'fan-out',
      'merging',
      'testing',
      'revising',
      'escalated',
    ];
    for (let i = 0; i < activePhases.length; i++) {
      await persister.saveState(
        createTestState(`req-active-${i}`, { phase: activePhases[i] }),
      );
    }
    const inFlight = await persister.listInFlightRequests();
    expect(inFlight.length).toBe(activePhases.length);
  });
});

// ---------------------------------------------------------------------------
// archiveState
// ---------------------------------------------------------------------------

describe('archiveState', () => {
  it('moves state to archive dir', async () => {
    await persister.saveState(createTestState('req-001'));
    await persister.archiveState('req-001');
    expect(fs.existsSync(path.join(stateDir, 'req-001.json'))).toBe(false);
    const archived = fs.readdirSync(archiveDir);
    expect(archived.some((f) => f.startsWith('req-001-'))).toBe(true);
  });

  it('archived file contains the original state data', async () => {
    const state = createTestState('req-002', { phase: 'merging' });
    await persister.saveState(state);
    await persister.archiveState('req-002');
    const archived = fs.readdirSync(archiveDir);
    const archivedFile = archived.find((f) => f.startsWith('req-002-'));
    expect(archivedFile).toBeDefined();
    const content = JSON.parse(
      fs.readFileSync(path.join(archiveDir, archivedFile!), 'utf-8'),
    );
    expect(content.requestId).toBe('req-002');
    expect(content.phase).toBe('merging');
  });

  it('creates archive dir if it does not exist', async () => {
    // Remove archive dir
    await fsp.rm(archiveDir, { recursive: true, force: true });
    await persister.saveState(createTestState('req-001'));
    await persister.archiveState('req-001');
    expect(fs.existsSync(archiveDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deleteState
// ---------------------------------------------------------------------------

describe('deleteState', () => {
  it('removes the state file', async () => {
    await persister.saveState(createTestState('req-001'));
    expect(fs.existsSync(path.join(stateDir, 'req-001.json'))).toBe(true);
    await persister.deleteState('req-001');
    expect(fs.existsSync(path.join(stateDir, 'req-001.json'))).toBe(false);
  });

  it('is idempotent on missing file', async () => {
    await expect(persister.deleteState('nonexistent')).resolves.not.toThrow();
  });

  it('deleted state is no longer loadable', async () => {
    await persister.saveState(createTestState('req-001'));
    await persister.deleteState('req-001');
    await expect(persister.loadState('req-001')).rejects.toThrow(StateNotFoundError);
  });
});

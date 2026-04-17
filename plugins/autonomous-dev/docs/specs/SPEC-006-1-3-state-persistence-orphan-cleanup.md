# SPEC-006-1-3: State Persistence and Orphan Cleanup

## Metadata
- **Parent Plan**: PLAN-006-1
- **Tasks Covered**: Task 6, Task 7, Task 8
- **Estimated effort**: 13 hours

## Description

Implement the `StatePersister` that writes execution state atomically to disk using write-to-temp-then-rename, with crash recovery detection on startup. Also implement the orphaned worktree cleanup that reconciles `git worktree list` output against persisted state on startup, removing stale worktrees and branches from previous crashed runs. Includes comprehensive tests for both components.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/parallel/state-persister.ts` | **Create** | Atomic state I/O, listing in-flight requests, archival |
| `src/parallel/worktree-manager.ts` | **Modify** | Add `cleanupOrphanedWorktrees()` startup routine |
| `tests/parallel/state-persister.test.ts` | **Create** | Unit/integration tests for state persistence |
| `tests/parallel/worktree-manager.test.ts` | **Modify** | Add orphan cleanup tests |

## Implementation Details

### 1. StatePersister

```typescript
export class StatePersister {
  constructor(
    private stateDir: string,  // e.g. "{repoRoot}/.autonomous-dev/state"
    private archiveDir: string // e.g. "{repoRoot}/.autonomous-dev/archive"
  ) {}

  async saveState(state: PersistedExecutionState): Promise<void>;
  async loadState(requestId: string): Promise<PersistedExecutionState>;
  async listInFlightRequests(): Promise<string[]>;
  async archiveState(requestId: string): Promise<void>;
  async deleteState(requestId: string): Promise<void>;
}
```

**Atomic write procedure (`saveState`)**:

```typescript
async saveState(state: PersistedExecutionState): Promise<void> {
  state.updatedAt = new Date().toISOString();

  const filePath = path.join(this.stateDir, `${state.requestId}.json`);
  const tmpPath  = `${filePath}.tmp`;

  // 1. Serialize to JSON with 2-space indent for debuggability
  const json = JSON.stringify(state, null, 2);

  // 2. Write to temp file
  await fs.writeFile(tmpPath, json, 'utf-8');

  // 3. Atomic rename (POSIX guarantees atomicity for rename on same filesystem)
  await fs.rename(tmpPath, filePath);
}
```

**Load with validation (`loadState`)**:

```typescript
async loadState(requestId: string): Promise<PersistedExecutionState> {
  const filePath = path.join(this.stateDir, `${requestId}.json`);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new StateNotFoundError(requestId);
    throw err;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt file -- log and throw
    logger.error(`Corrupt state file for ${requestId}: ${filePath}`);
    throw new CorruptStateError(requestId, filePath);
  }

  // Schema version check
  if (parsed.version !== 1) {
    throw new UnsupportedStateVersionError(requestId, parsed.version);
  }

  return parsed as PersistedExecutionState;
}
```

**List in-flight requests**:

```typescript
async listInFlightRequests(): Promise<string[]> {
  const files = await fs.readdir(this.stateDir);
  const inFlight: string[] = [];

  for (const file of files) {
    if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
    try {
      const state = await this.loadState(file.replace('.json', ''));
      if (state.phase !== 'complete' && state.phase !== 'failed') {
        inFlight.push(state.requestId);
      }
    } catch {
      // Skip corrupt files -- they'll be handled by crash recovery
    }
  }
  return inFlight;
}
```

**Archive**:

```typescript
async archiveState(requestId: string): Promise<void> {
  const src = path.join(this.stateDir, `${requestId}.json`);
  const dst = path.join(this.archiveDir, `${requestId}-${Date.now()}.json`);
  await fs.mkdir(this.archiveDir, { recursive: true });
  await fs.rename(src, dst);
}
```

### 2. Orphan cleanup on startup

Add to `WorktreeManager`:

```typescript
async cleanupOrphanedWorktrees(persister: StatePersister): Promise<CleanupReport> {
  const report: CleanupReport = { removedWorktrees: [], removedBranches: [], errors: [] };

  // 1. Get all git-registered worktrees under our root
  const gitWorktrees = await this.parseGitWorktreeList();

  // 2. Get all in-flight request IDs
  const inFlightIds = new Set(await persister.listInFlightRequests());

  // 3. For each worktree under worktreeRoot:
  for (const wt of gitWorktrees) {
    if (!wt.path.startsWith(this.resolvedWorktreeRoot)) continue; // skip non-managed

    const { requestId, trackName } = this.parseWorktreePath(wt.path);
    if (!requestId) continue; // not our naming convention

    if (!inFlightIds.has(requestId)) {
      // Orphaned: no active state file
      logger.info(`Removing orphaned worktree: ${wt.path} (branch: ${wt.branch})`);
      try {
        await this.removeWorktree(requestId, trackName, true /* force */);
        report.removedWorktrees.push(wt.path);
      } catch (err) {
        report.errors.push({ path: wt.path, error: String(err) });
      }
    }
  }

  // 4. Clean stale auto/* branches with no corresponding state
  const autoBranches = await this.listAutoBranches();
  for (const branch of autoBranches) {
    const reqId = this.extractRequestIdFromBranch(branch);
    if (reqId && !inFlightIds.has(reqId)) {
      logger.info(`Removing stale branch: ${branch}`);
      await this.exec(`git branch -D ${branch}`);
      report.removedBranches.push(branch);
    }
  }

  // 5. Final prune
  await this.exec('git worktree prune');

  return report;
}
```

**Helper: parse `git worktree list --porcelain`**:
```bash
git worktree list --porcelain
```
Output format:
```
worktree /path/to/main
HEAD abc123
branch refs/heads/main

worktree /path/to/.worktrees/req-001/track-a
HEAD def456
branch refs/heads/auto/req-001/track-a
```

Parse into `{ path: string, head: string, branch: string }[]`.

**Helper: list `auto/*` branches**:
```bash
git branch --list 'auto/*' --format='%(refname:short)'
```

### 3. .gitignore management

On first initialization, ensure the repo's `.gitignore` includes:

```
.worktrees/
.autonomous-dev/state/
.autonomous-dev/archive/
```

Only append if lines are not already present. Never remove existing entries.

## Acceptance Criteria

1. `saveState` writes to `.json.tmp` then renames; no partial files remain on success.
2. `loadState` returns the exact state that was saved (roundtrip identity).
3. `loadState` throws `CorruptStateError` on truncated/invalid JSON.
4. `loadState` throws `UnsupportedStateVersionError` when `version !== 1`.
5. `loadState` throws `StateNotFoundError` when file does not exist.
6. `listInFlightRequests` returns only requests where `phase` is not `complete` or `failed`.
7. `listInFlightRequests` skips `.tmp` files and corrupt state files.
8. `archiveState` moves the file to the archive directory with a timestamp suffix.
9. `cleanupOrphanedWorktrees` removes worktrees under `worktreeRoot` that have no in-flight state.
10. `cleanupOrphanedWorktrees` removes `auto/*` branches with no corresponding state file.
11. `cleanupOrphanedWorktrees` does not touch worktrees outside `worktreeRoot` or non-`auto/` branches.
12. `cleanupOrphanedWorktrees` runs `git worktree prune` at the end.
13. All cleanup actions are logged with the worktree path and branch name.
14. `.gitignore` is updated on initialization without duplicating entries.

## Test Cases

```
// state-persister.test.ts

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
});

describe('loadState error handling', () => {
  it('throws StateNotFoundError for missing file', async () => {
    await expect(persister.loadState('nonexistent')).rejects.toThrow(StateNotFoundError);
  });

  it('throws CorruptStateError for invalid JSON', async () => {
    fs.writeFileSync(path.join(stateDir, 'bad.json'), '{truncated');
    await expect(persister.loadState('bad')).rejects.toThrow(CorruptStateError);
  });

  it('throws UnsupportedStateVersionError for version != 1', async () => {
    fs.writeFileSync(path.join(stateDir, 'v2.json'), JSON.stringify({ version: 2 }));
    await expect(persister.loadState('v2')).rejects.toThrow(UnsupportedStateVersionError);
  });
});

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

  it('skips .tmp files', async () => {
    fs.writeFileSync(path.join(stateDir, 'req-tmp.json.tmp'), '{}');
    const inFlight = await persister.listInFlightRequests();
    expect(inFlight).not.toContain('req-tmp');
  });
});

describe('archiveState', () => {
  it('moves state to archive dir', async () => {
    await persister.saveState(createTestState('req-001'));
    await persister.archiveState('req-001');
    expect(fs.existsSync(path.join(stateDir, 'req-001.json'))).toBe(false);
    const archived = fs.readdirSync(archiveDir);
    expect(archived.some(f => f.startsWith('req-001-'))).toBe(true);
  });
});

// worktree-manager.test.ts (orphan cleanup section)

describe('cleanupOrphanedWorktrees', () => {
  it('removes worktrees with no state file', async () => {
    // Create a worktree, then delete its state file
    await wm.createIntegrationBranch('req-orphan', 'main');
    await wm.createTrackWorktree('req-orphan', 'track-a');
    await persister.deleteState('req-orphan');

    const report = await wm.cleanupOrphanedWorktrees(persister);
    expect(report.removedWorktrees.length).toBe(1);
  });

  it('removes stale auto/* branches', async () => {
    execSync(`git -C ${repoRoot} branch auto/stale/integration main`);
    const report = await wm.cleanupOrphanedWorktrees(persister);
    expect(report.removedBranches).toContain('auto/stale/integration');
  });

  it('does not touch non-auto branches', async () => {
    execSync(`git -C ${repoRoot} branch feature/keep main`);
    const report = await wm.cleanupOrphanedWorktrees(persister);
    expect(report.removedBranches).not.toContain('feature/keep');
  });

  it('handles no orphans gracefully', async () => {
    const report = await wm.cleanupOrphanedWorktrees(persister);
    expect(report.removedWorktrees.length).toBe(0);
    expect(report.removedBranches.length).toBe(0);
  });
});
```

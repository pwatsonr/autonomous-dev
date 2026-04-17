# SPEC-006-1-2: Worktree Core Operations and Health Monitoring

## Metadata
- **Parent Plan**: PLAN-006-1
- **Tasks Covered**: Task 3, Task 4, Task 5
- **Estimated effort**: 12 hours

## Description

Implement the `WorktreeManager` class that wraps git worktree commands with precondition checks, idempotency, disk-usage monitoring, and health validation. This is the core runtime component that all other plans depend on for creating isolated workspaces.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/parallel/worktree-manager.ts` | **Create** | Core worktree CRUD, disk monitoring, health checks |
| `src/parallel/events.ts` | **Create** | Event type definitions and emission stubs |
| `tests/parallel/worktree-manager.test.ts` | **Create** | Integration tests against real temp git repos |

## Implementation Details

### 1. WorktreeManager class

```typescript
export class WorktreeManager {
  constructor(
    private config: ParallelConfig,
    private repoRoot: string,
    private eventEmitter: EventEmitter
  ) {}

  // --- Creation ---

  async createIntegrationBranch(requestId: string, baseBranch: string): Promise<string>;
  async createTrackWorktree(requestId: string, trackName: string): Promise<WorktreeInfo>;
  
  // --- Listing ---

  async listWorktrees(requestId?: string): Promise<WorktreeInfo[]>;
  async getWorktree(requestId: string, trackName: string): Promise<WorktreeInfo | null>;
  async getActiveWorktreeCount(): Promise<number>;

  // --- Removal ---

  async removeWorktree(requestId: string, trackName: string, force?: boolean): Promise<void>;
  async cleanupRequest(requestId: string): Promise<void>;

  // --- Disk monitoring ---

  async checkDiskUsage(): Promise<{ totalBytes: number; perWorktree: Record<string, number> }>;
  getDiskPressureLevel(): DiskPressureLevel;
  startDiskMonitor(intervalMs?: number): void;
  stopDiskMonitor(): void;

  // --- Health ---

  async validateWorktreeHealth(requestId: string, trackName: string): Promise<WorktreeHealthReport>;
  async validateAllWorktrees(): Promise<WorktreeHealthReport[]>;
}
```

### 2. Git command sequences

**`createIntegrationBranch(requestId, baseBranch)`**:
```bash
# Precondition: verify baseBranch exists
git rev-parse --verify refs/heads/{baseBranch}

# Create integration branch from baseBranch
git branch auto/{requestId}/integration {baseBranch}
```
Idempotency: if branch already exists, verify it points to expected base and return success.

**`createTrackWorktree(requestId, trackName)`**:
```bash
# Precondition checks (run before any git command):
#   1. getActiveWorktreeCount() < config.max_worktrees
#   2. getDiskPressureLevel() !== 'critical'
#   3. Integration branch exists: git rev-parse --verify refs/heads/auto/{requestId}/integration

# Create track branch from integration
git branch auto/{requestId}/{trackName} auto/{requestId}/integration

# Create worktree at the designated path
git worktree add {worktreeRoot}/{requestId}/{trackName} auto/{requestId}/{trackName}
```
Idempotency: if worktree directory already exists and branch matches, return existing `WorktreeInfo`.

**`removeWorktree(requestId, trackName, force = false)`**:
```bash
# Remove the worktree
git worktree remove {worktreeRoot}/{requestId}/{trackName} [--force if force=true]

# Delete the track branch
git branch -D auto/{requestId}/{trackName}

# Prune stale worktree metadata
git worktree prune
```
Idempotency: if directory does not exist, skip worktree remove; if branch does not exist, skip branch delete.

**`cleanupRequest(requestId)`**:
```bash
# List all worktrees for this request
# For each: removeWorktree(requestId, trackName, force=true)
# Then remove the integration branch:
git branch -D auto/{requestId}/integration

# Remove the request directory if empty:
rm -rf {worktreeRoot}/{requestId}
```

### 3. Disk monitoring

Use Node.js `fs.stat` with recursive directory walk (not shell `du`) for cross-platform compatibility:

```typescript
async function calculateDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      totalSize += await calculateDirectorySize(fullPath);
    } else if (entry.isFile()) {
      const stat = await fs.stat(fullPath);
      totalSize += stat.size;
    }
  }
  return totalSize;
}
```

Pressure levels:
- `normal`: usage < `disk_warning_threshold_gb`
- `warning`: usage >= `disk_warning_threshold_gb` and < `disk_hard_limit_gb`
- `critical`: usage >= `disk_hard_limit_gb`

The monitor runs on a `setInterval` (default 60s). On threshold crossings, emit `worktree.disk_warning` or `worktree.disk_critical`.

### 4. Health validation

`validateWorktreeHealth` checks:

```bash
# 1. Directory exists
stat {worktreePath}

# 2. Worktree is registered
git worktree list --porcelain
# Parse output to confirm worktreePath is listed

# 3. Branch exists
git rev-parse --verify refs/heads/auto/{requestId}/{trackName}

# 4. Working tree is clean
git -C {worktreePath} status --porcelain
# Non-empty output means dirty worktree (warning, not error)
```

Return a `WorktreeHealthReport`:

```typescript
export interface WorktreeHealthReport {
  requestId: string;
  trackName: string;
  directoryExists: boolean;
  registeredInGit: boolean;
  branchExists: boolean;
  isClean: boolean;
  healthy: boolean; // all checks pass
  issues: string[];
}
```

### 5. Events stub (`src/parallel/events.ts`)

```typescript
export interface WorktreeCreatedEvent {
  type: 'worktree.created';
  requestId: string;
  trackName: string;
  worktreePath: string;
  timestamp: string;
}

export interface WorktreeRemovedEvent {
  type: 'worktree.removed';
  requestId: string;
  trackName: string;
  timestamp: string;
}

export interface WorktreeDiskWarningEvent {
  type: 'worktree.disk_warning';
  totalBytes: number;
  thresholdBytes: number;
  timestamp: string;
}

export interface WorktreeDiskCriticalEvent {
  type: 'worktree.disk_critical';
  totalBytes: number;
  thresholdBytes: number;
  timestamp: string;
}

export type ParallelEvent =
  | WorktreeCreatedEvent
  | WorktreeRemovedEvent
  | WorktreeDiskWarningEvent
  | WorktreeDiskCriticalEvent;
  // Extended by other plans
```

## Acceptance Criteria

1. `createIntegrationBranch` creates a branch at the correct commit; re-calling is a no-op.
2. `createTrackWorktree` refuses when `max_worktrees` reached (throws `MaxWorktreesExceededError`).
3. `createTrackWorktree` refuses when disk pressure is `critical` (throws `DiskPressureCriticalError`).
4. `createTrackWorktree` creates both the branch and worktree directory; files are accessible in the new path.
5. `listWorktrees()` returns all active worktrees; `listWorktrees(requestId)` filters correctly.
6. `removeWorktree` deletes the directory, the branch, and prunes git metadata.
7. `cleanupRequest` removes all worktrees, the integration branch, and the request directory.
8. All operations are idempotent: calling create on existing or remove on missing is safe.
9. Disk monitoring emits `worktree.disk_warning` when crossing the warning threshold.
10. Disk monitoring emits `worktree.disk_critical` when crossing the hard limit.
11. `validateWorktreeHealth` returns a correct report for healthy, missing-directory, unregistered, and dirty worktrees.
12. `validateAllWorktrees` aggregates health for all tracked worktrees.
13. No operation leaves the repo in a dirty state on failure (error paths call `git worktree prune`).

## Test Cases

```
// worktree-manager.test.ts
// All tests use a real temp git repo created in beforeEach via:
//   tmpDir = mkdtempSync(...)
//   git init {tmpDir} && git commit --allow-empty -m "init"

describe('createIntegrationBranch', () => {
  it('creates branch from base', async () => {
    await wm.createIntegrationBranch('req-001', 'main');
    const sha = execSync(`git -C ${repoRoot} rev-parse auto/req-001/integration`).toString().trim();
    const mainSha = execSync(`git -C ${repoRoot} rev-parse main`).toString().trim();
    expect(sha).toBe(mainSha);
  });
  it('is idempotent', async () => {
    await wm.createIntegrationBranch('req-001', 'main');
    await expect(wm.createIntegrationBranch('req-001', 'main')).resolves.not.toThrow();
  });
});

describe('createTrackWorktree', () => {
  it('creates worktree directory and branch', async () => {
    await wm.createIntegrationBranch('req-001', 'main');
    const info = await wm.createTrackWorktree('req-001', 'track-a');
    expect(fs.existsSync(info.worktreePath)).toBe(true);
    const branch = execSync(`git -C ${info.worktreePath} branch --show-current`).toString().trim();
    expect(branch).toBe('auto/req-001/track-a');
  });
  it('rejects when max_worktrees reached', async () => {
    // config.max_worktrees = 1
    await wm.createIntegrationBranch('req-001', 'main');
    await wm.createTrackWorktree('req-001', 'track-a');
    await expect(wm.createTrackWorktree('req-001', 'track-b')).rejects.toThrow(/max.*worktrees/i);
  });
  it('rejects when disk pressure is critical', async () => {
    // mock getDiskPressureLevel to return 'critical'
    await expect(wm.createTrackWorktree('req-001', 'track-a')).rejects.toThrow(/disk.*pressure/i);
  });
});

describe('removeWorktree', () => {
  it('removes directory and branch', async () => {
    await wm.createIntegrationBranch('req-001', 'main');
    const info = await wm.createTrackWorktree('req-001', 'track-a');
    await wm.removeWorktree('req-001', 'track-a');
    expect(fs.existsSync(info.worktreePath)).toBe(false);
  });
  it('is idempotent on missing worktree', async () => {
    await expect(wm.removeWorktree('req-001', 'nonexistent')).resolves.not.toThrow();
  });
});

describe('cleanupRequest', () => {
  it('removes all worktrees and integration branch', async () => {
    await wm.createIntegrationBranch('req-001', 'main');
    await wm.createTrackWorktree('req-001', 'track-a');
    await wm.createTrackWorktree('req-001', 'track-b');
    await wm.cleanupRequest('req-001');
    expect((await wm.listWorktrees('req-001')).length).toBe(0);
  });
});

describe('disk monitoring', () => {
  it('returns disk usage per worktree', async () => {
    await wm.createIntegrationBranch('req-001', 'main');
    await wm.createTrackWorktree('req-001', 'track-a');
    const usage = await wm.checkDiskUsage();
    expect(usage.totalBytes).toBeGreaterThan(0);
  });
  it('emits warning event when threshold exceeded', async () => {
    // configure very low warning threshold, create worktrees
    const events: any[] = [];
    emitter.on('worktree.disk_warning', (e) => events.push(e));
    await wm.checkDiskUsage(); // triggers threshold check
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('health validation', () => {
  it('reports healthy worktree', async () => {
    await wm.createIntegrationBranch('req-001', 'main');
    await wm.createTrackWorktree('req-001', 'track-a');
    const report = await wm.validateWorktreeHealth('req-001', 'track-a');
    expect(report.healthy).toBe(true);
  });
  it('detects missing directory', async () => {
    // manually remove the directory after creation
    await wm.createIntegrationBranch('req-001', 'main');
    await wm.createTrackWorktree('req-001', 'track-a');
    fs.rmSync(worktreePath, { recursive: true });
    const report = await wm.validateWorktreeHealth('req-001', 'track-a');
    expect(report.directoryExists).toBe(false);
    expect(report.healthy).toBe(false);
  });
  it('detects dirty worktree', async () => {
    // create a file in the worktree without committing
    const report = await wm.validateWorktreeHealth('req-001', 'track-a');
    expect(report.isClean).toBe(false);
  });
});
```

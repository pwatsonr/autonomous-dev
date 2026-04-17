# SPEC-006-1-1: Worktree Types, Configuration, and Naming Utilities

## Metadata
- **Parent Plan**: PLAN-006-1
- **Tasks Covered**: Task 1, Task 2
- **Estimated effort**: 5 hours

## Description

Define the foundational TypeScript interfaces, configuration schema, and naming/path utilities that every other parallel-execution component depends on. This spec covers the `WorktreeInfo` and `PersistedExecutionState` data models, the `parallel.*` configuration loader with defaults from TDD Appendix A, and the naming-validation/slugification/path-construction functions that enforce the `auto/` branch naming convention.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/parallel/types.ts` | **Create** | Shared interfaces for the parallel execution engine |
| `src/parallel/config.ts` | **Create** | Configuration loading, validation, and defaults |
| `src/parallel/naming.ts` | **Create** | Name validation, slugification, branch/path construction |
| `tests/parallel/naming.test.ts` | **Create** | Unit tests for naming utilities |

## Implementation Details

### 1. `src/parallel/types.ts`

```typescript
/** Represents a single git worktree managed by the engine. */
export interface WorktreeInfo {
  requestId: string;
  trackName: string;
  worktreePath: string;       // absolute path under worktreeRoot
  branchName: string;         // e.g. "auto/{requestId}/{trackName}"
  integrationBranch: string;  // e.g. "auto/{requestId}/integration"
  createdAt: string;          // ISO-8601
  status: WorktreeStatus;
}

export type WorktreeStatus = 'active' | 'merging' | 'removing' | 'orphaned';

export type DiskPressureLevel = 'normal' | 'warning' | 'critical';

/** Top-level persisted state for a single parallel-execution request. */
export interface PersistedExecutionState {
  version: 1;
  requestId: string;
  baseBranch: string;
  integrationBranch: string;
  phase: ExecutionPhase;
  worktrees: Record<string, WorktreeInfo>;
  // Fields from other plans will extend this via module augmentation
  createdAt: string;
  updatedAt: string;
}

export type ExecutionPhase =
  | 'initializing'
  | 'fan-out'
  | 'merging'
  | 'testing'
  | 'revising'
  | 'complete'
  | 'failed'
  | 'escalated';
```

### 2. `src/parallel/config.ts`

Load from the project's `.autonomous-dev/config.yaml` (or programmatic override). Apply these defaults from TDD Appendix A:

| Parameter | Default | Validation |
|-----------|---------|------------|
| `parallel.max_worktrees` | `5` | integer >= 1 |
| `parallel.max_tracks` | `5` | integer >= 1 |
| `parallel.disk_warning_threshold_gb` | `5` | number > 0 |
| `parallel.disk_hard_limit_gb` | `2` | number > 0, must be < warning threshold |
| `parallel.worktree_cleanup_delay_seconds` | `300` | integer >= 0 |
| `parallel.worktree_root` | `.worktrees` | non-empty string, relative or absolute |
| `parallel.state_dir` | `.autonomous-dev/state` | non-empty string |
| `parallel.base_branch` | `main` | non-empty string |
| `parallel.stall_timeout_minutes` | `15` | integer >= 1 |
| `parallel.max_revision_cycles` | `2` | integer >= 0 |
| `parallel.conflict_ai_confidence_threshold` | `0.85` | number in (0, 1] |
| `parallel.merge_conflict_escalation_threshold` | `5` | integer >= 1 |

Implementation:

```typescript
export interface ParallelConfig { /* one field per row above */ }

export function loadConfig(overrides?: Partial<ParallelConfig>): ParallelConfig;
export function validateConfig(cfg: ParallelConfig): void; // throws on invalid
```

`validateConfig` must reject:
- Negative or zero limits where positive is required.
- `disk_hard_limit_gb >= disk_warning_threshold_gb` (hard must be stricter).
- Non-existent absolute paths for `worktree_root` when an absolute path is given (relative paths are resolved lazily at runtime against the repo root).

### 3. `src/parallel/naming.ts`

```typescript
const NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

export function isValidName(name: string): boolean;

/**
 * Convert an arbitrary spec name (e.g. "Add User Authentication Flow")
 * to a valid track name ("add-user-authentication-flow").
 * Steps: lowercase -> replace non-alnum with '-' -> collapse runs of '-'
 *        -> trim leading/trailing '-' -> truncate to 64 chars
 *        -> ensure still matches NAME_REGEX (trim trailing '-' after truncate)
 */
export function slugify(input: string): string;

export function integrationBranchName(requestId: string): string;
// returns "auto/{requestId}/integration"

export function trackBranchName(requestId: string, trackName: string): string;
// returns "auto/{requestId}/{trackName}"

export function worktreePath(worktreeRoot: string, requestId: string, trackName: string): string;
// returns "{worktreeRoot}/{requestId}/{trackName}"
```

Reject names that collide with reserved filesystem names on Windows/macOS (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, `.`, `..`).

## Acceptance Criteria

1. All interfaces from TDD Sections 3.1, 3.9.1, 4.4 are defined and exported from `types.ts`.
2. `loadConfig()` with no arguments returns valid defaults matching TDD Appendix A.
3. `validateConfig` throws with a descriptive message for each invalid parameter combination.
4. `isValidName` returns true for `"track-a"`, `"a1"`, `"my-long-track-name-42"` and false for `""`, `"-bad"`, `"UPPER"`, `"has spaces"`, `"x".repeat(65)`.
5. `slugify("Add User Authentication Flow")` returns `"add-user-authentication-flow"`.
6. `slugify` always produces output that passes `isValidName` (property test).
7. `integrationBranchName("req-001")` returns `"auto/req-001/integration"`.
8. `trackBranchName("req-001", "track-a")` returns `"auto/req-001/track-a"`.
9. `worktreePath("/repo/.worktrees", "req-001", "track-a")` returns `"/repo/.worktrees/req-001/track-a"`.

## Test Cases

```
// naming.test.ts

describe('isValidName', () => {
  it('accepts lowercase alphanumeric with hyphens', () => expect(isValidName('track-a')).toBe(true));
  it('accepts minimum length (2 chars)', () => expect(isValidName('ab')).toBe(true));
  it('rejects empty string', () => expect(isValidName('')).toBe(false));
  it('rejects leading hyphen', () => expect(isValidName('-bad')).toBe(false));
  it('rejects trailing hyphen', () => expect(isValidName('bad-')).toBe(false));
  it('rejects uppercase', () => expect(isValidName('UPPER')).toBe(false));
  it('rejects spaces', () => expect(isValidName('has space')).toBe(false));
  it('rejects names exceeding 64 chars', () => expect(isValidName('a'.repeat(65))).toBe(false));
  it('rejects single character', () => expect(isValidName('a')).toBe(false));
  it('rejects reserved names (CON)', () => expect(isValidName('con')).toBe(false));
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => expect(slugify('Add User Auth')).toBe('add-user-auth'));
  it('collapses multiple hyphens', () => expect(slugify('a--b')).toBe('a-b'));
  it('truncates to 64 chars', () => {
    const result = slugify('a'.repeat(100));
    expect(result.length).toBeLessThanOrEqual(64);
    expect(isValidName(result)).toBe(true);
  });
  it('property: output always valid', () => {
    for (const input of ['Hello World', '  foo  ', '123-test', 'a/b/c', 'émojis!']) {
      expect(isValidName(slugify(input))).toBe(true);
    }
  });
});

describe('branch name construction', () => {
  it('builds integration branch', () =>
    expect(integrationBranchName('req-001')).toBe('auto/req-001/integration'));
  it('builds track branch', () =>
    expect(trackBranchName('req-001', 'track-a')).toBe('auto/req-001/track-a'));
  it('rejects invalid requestId', () =>
    expect(() => trackBranchName('INVALID', 'track-a')).toThrow());
  it('rejects invalid trackName', () =>
    expect(() => trackBranchName('req-001', '')).toThrow());
});

describe('config', () => {
  it('returns valid defaults', () => {
    const cfg = loadConfig();
    expect(cfg.max_worktrees).toBe(5);
    expect(cfg.disk_hard_limit_gb).toBeLessThan(cfg.disk_warning_threshold_gb);
  });
  it('rejects negative max_worktrees', () =>
    expect(() => validateConfig({ ...loadConfig(), max_worktrees: -1 })).toThrow());
  it('rejects hard limit >= warning threshold', () =>
    expect(() => validateConfig({ ...loadConfig(), disk_hard_limit_gb: 10, disk_warning_threshold_gb: 5 })).toThrow());
});
```

# SPEC-005-1-2: Committed-State Integrity Checker and Agent Registry Core

## Metadata
- **Parent Plan**: PLAN-005-1
- **Tasks Covered**: Task 3 (Committed-state integrity checker), Task 4 (Agent Registry core)
- **Estimated effort**: 16 hours

## Description

Implement the security-critical committed-state integrity checker that ensures only git-committed, unmodified agent files can be loaded, and the central Agent Registry that provides the in-memory catalog of all validated agents with full lifecycle management. The registry orchestrates the loading sequence (scan -> verify -> parse -> validate -> register) and exposes the `AgentRegistry` API.

## Files to Create/Modify

### New Files

**`src/agent-factory/integrity.ts`**
- Exports: `checkIntegrity(agentsDir: string): IntegrityResult`
- Exports: `checkFileIntegrity(filePath: string): FileIntegrityResult`

**`src/agent-factory/registry.ts`**
- Exports: `AgentRegistry` class implementing the `IAgentRegistry` interface

### Modified Files

**`src/agent-factory/types.ts`** (extend with registry types)
- Add: `AgentRecord`, `AgentState`, `RegistryLoadResult`, `IAgentRegistry`, `IntegrityResult`, `FileIntegrityResult`

## Implementation Details

### Integrity Checker (`integrity.ts`)

1. **Batch porcelain check**: Run `git status --porcelain agents/` as a single subprocess call. Parse output to identify files with any status indicator:
   - `M` (modified) -> reject
   - `?` (untracked) -> reject
   - `A` (staged/added) -> reject
   - `D` (deleted) -> reject
   - Any other status -> reject

2. **Per-file SHA-256 verification**: For each `.md` file in `agents/`:
   - Compute SHA-256 hash of the file on disk: read file contents, compute `crypto.createHash('sha256').update(contents).digest('hex')`
   - Retrieve committed version hash: run `git show HEAD:<relative-path>` and compute SHA-256 of that content
   - Compare hashes; reject if they differ

3. **Security logging**: On any rejection, log a security alert via the audit log writer (from SPEC-005-1-3) with event type `integrity_check_failed`, including the file path, rejection reason, and detected status.

```typescript
interface IntegrityResult {
  passed: FileIntegrityResult[];
  rejected: FileIntegrityResult[];
  allPassed: boolean;
}

interface FileIntegrityResult {
  filePath: string;
  passed: boolean;
  reason?: string;           // e.g., "modified (M)", "untracked (?)", "hash mismatch"
  diskHash?: string;
  gitHash?: string;
  gitStatus?: string;
}
```

4. **Implementation notes**:
   - Use `child_process.execSync` or `child_process.execFileSync` for git commands to avoid shell injection
   - Pass file paths as arguments, not via shell interpolation
   - Handle the case where `agents/` directory does not exist (return empty result, not error)
   - Handle the case where git is not available (throw clear error)

### Agent Registry (`registry.ts`)

```typescript
type AgentState = 'REGISTERED' | 'ACTIVE' | 'FROZEN' | 'UNDER_REVIEW' | 'VALIDATING' | 'CANARY' | 'PROMOTED' | 'REJECTED';

interface AgentRecord {
  agent: ParsedAgent;
  state: AgentState;
  loadedAt: Date;
  diskHash: string;
  filePath: string;
}

interface RegistryLoadResult {
  loaded: number;
  rejected: number;
  errors: Array<{ file: string; reason: string }>;
  duration_ms: number;
}

interface IAgentRegistry {
  load(agentsDir: string): Promise<RegistryLoadResult>;
  reload(agentsDir: string): Promise<RegistryLoadResult>;
  list(): AgentRecord[];
  get(name: string): AgentRecord | undefined;
  getForTask(taskDescription: string, taskDomain?: string): RankedAgent[];
  freeze(name: string): void;
  unfreeze(name: string): void;
  getState(name: string): AgentState | undefined;
  setState(name: string, state: AgentState): void;
}
```

**Loading sequence** (matches TDD 3.2.2 exactly):

1. **Scan**: Glob `agents/*.md` to discover all agent definition files.
2. **Verify**: Run integrity checker on all discovered files. Remove rejected files from the pipeline.
3. **Parse**: Run parser on each verified file. Remove files with parse errors.
4. **Validate**: Run validator on each parsed agent. Provide `existingNames` set built incrementally. Remove agents with validation errors.
5. **Check uniqueness**: Final uniqueness check (redundant with RULE_001 but acts as a safety net).
6. **Register**: Insert into the in-memory `Map<string, AgentRecord>` with state `REGISTERED`. Transition to `ACTIVE` unless `frozen: true` in frontmatter (then `FROZEN`).

**`reload()`**: Clear the existing map, re-run the full loading sequence. Return new `RegistryLoadResult`.

**`freeze(name)`**: Set state to `FROZEN`. Guards: agent must exist, must not already be `FROZEN`. Log to audit.

**`unfreeze(name)`**: Set state to `ACTIVE`. Guards: agent must exist, must be `FROZEN`. Log to audit.

**Performance target**: Load 50 agents in under 2 seconds. The bottleneck is git operations; batch them where possible.

## Acceptance Criteria

1. Integrity checker runs `git status --porcelain agents/` as a single batch call (not per-file).
2. Modified files (M status) are rejected with reason containing "modified".
3. Untracked files (? status) are rejected with reason containing "untracked".
4. Staged files (A status) are rejected with reason containing "staged".
5. Files where disk hash differs from git hash are rejected with reason "hash mismatch".
6. Security alert logged for every rejection.
7. Registry `load()` executes the 6-step sequence: scan -> verify -> parse -> validate -> uniqueness -> register.
8. `RegistryLoadResult` reports accurate loaded/rejected counts and per-file error details.
9. `get()` returns the `AgentRecord` by exact name match.
10. `list()` returns all registered agents.
11. `freeze()` / `unfreeze()` toggle state with guards and audit logging.
12. Agents with `frozen: true` in frontmatter load into `FROZEN` state.
13. Loading 50 agent files completes in under 2 seconds.
14. `reload()` fully replaces the registry contents.

## Test Cases

### Integrity Checker Unit Tests

```
test_committed_file_passes
  Setup: Create a git repo, commit an agent .md file
  Expected: FileIntegrityResult with passed=true

test_modified_file_rejected
  Setup: Commit agent file, then modify it without committing
  Expected: passed=false, reason contains "modified"

test_untracked_file_rejected
  Setup: Place a new .md file in agents/ without git add
  Expected: passed=false, reason contains "untracked"

test_staged_file_rejected
  Setup: Create and git add a new agent file without committing
  Expected: passed=false, reason contains "staged"

test_hash_mismatch_rejected
  Setup: Commit file, replace file content with same git status (simulate race)
  Expected: passed=false, reason contains "hash mismatch"

test_batch_check_multiple_files
  Setup: 5 committed files, 2 modified
  Expected: 5 passed, 2 rejected

test_empty_agents_directory
  Setup: agents/ exists but is empty
  Expected: IntegrityResult with 0 passed, 0 rejected, allPassed=true

test_no_agents_directory
  Setup: agents/ does not exist
  Expected: IntegrityResult with 0 passed, 0 rejected, allPassed=true

test_path_traversal_in_filename
  Setup: File named ../sneaky.md appears in status output
  Expected: Rejected (cannot escape agents/ directory)
```

### Registry Unit Tests

```
test_load_valid_agents
  Setup: 3 committed, valid agent files
  Expected: RegistryLoadResult with loaded=3, rejected=0

test_load_rejects_invalid_agents
  Setup: 2 valid + 1 with invalid YAML
  Expected: loaded=2, rejected=1, errors includes the invalid file

test_load_rejects_uncommitted_agents
  Setup: 2 committed + 1 untracked
  Expected: loaded=2, rejected=1

test_get_by_name
  Setup: Load agents including "code-executor"
  Expected: get("code-executor") returns AgentRecord with correct data

test_get_unknown_returns_undefined
  Expected: get("nonexistent") returns undefined

test_list_returns_all
  Setup: Load 3 agents
  Expected: list() returns array of length 3

test_freeze_active_agent
  Setup: Load agent in ACTIVE state
  Action: freeze("agent-name")
  Expected: getState() returns FROZEN

test_freeze_already_frozen_throws
  Setup: Agent in FROZEN state
  Action: freeze("agent-name")
  Expected: Error thrown

test_unfreeze_frozen_agent
  Setup: freeze("agent-name"), then unfreeze("agent-name")
  Expected: getState() returns ACTIVE

test_frozen_frontmatter_loads_as_frozen
  Setup: Agent .md with frozen: true
  Expected: After load, getState() returns FROZEN

test_reload_replaces_registry
  Setup: Load 3 agents, modify one file (commit change), reload
  Expected: Registry reflects updated content

test_load_performance_50_agents
  Setup: Generate 50 valid, committed agent files
  Expected: load() completes in < 2000ms

test_loading_sequence_order
  Setup: Mock scan/verify/parse/validate steps
  Expected: Steps execute in exact order: scan -> verify -> parse -> validate -> uniqueness -> register
```

### Integration Tests

```
test_full_load_cycle
  Setup: Git repo with 10+ agent files (some valid, some invalid, one uncommitted)
  Expected: Valid committed files loaded, invalid rejected with errors, uncommitted rejected

test_integrity_then_parse_then_validate
  Setup: Agent file that passes integrity but fails validation (e.g., invalid semver)
  Expected: Rejected at validation step, not at integrity step; error message references validation
```

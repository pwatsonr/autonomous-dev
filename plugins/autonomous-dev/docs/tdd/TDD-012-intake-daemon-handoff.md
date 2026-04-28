# TDD-012: Intake-to-Daemon Handoff (Two-Phase Commit)

| Field        | Value                                              |
|--------------|----------------------------------------------------|
| **Title**    | Intake-to-Daemon Handoff (Two-Phase Commit)        |
| **TDD ID**   | TDD-012                                            |
| **Version**  | 1.0                                                |
| **Date**     | 2026-04-28                                         |
| **Status**   | Draft                                              |
| **Author**   | Patrick Watson                                     |
| **Parent PRD** | PRD-008: Unified Request Submission Packaging   |
| **Plugin**   | autonomous-dev                                     |

---

## 1. Summary

This TDD specifies the technical design for bridging the intake layer's SQLite repository to the daemon's filesystem-based state consumption through a robust two-phase commit protocol. The design enables reliable request handoff from any intake channel (CLI, Claude App, Discord, Slack) to the autonomous development pipeline while maintaining ACID properties and crash-safety guarantees.

The core architectural challenge is that the intake layer writes to SQLite (`intake/db/repository.ts`) as the canonical index, but the daemon expects `state.json` files in `<repo>/.autonomous-dev/requests/<REQ-id>/` for consumption via `select_request()`. This design implements a dual-write pattern with atomic consistency: temporary file write → SQLite transaction → atomic rename on commit, or cleanup on rollback.

Key capabilities delivered:
- **Two-phase commit handoff**: Atomically writes both SQLite records and state.json files with rollback safety
- **Path traversal protection**: Request ID validation and path resolution with security boundaries
- **Source metadata tracking**: Records originating channel and adapter-specific metadata for audit trails  
- **State transition handling**: Pause/resume/cancel/priority operations maintain dual-write consistency
- **Schema validation**: All state.json writes validated against daemon-compatible schema
- **Reconciliation tooling**: CLI subcommand for detecting and repairing state.json/SQLite drift
- **Concurrency control**: File locking strategy for safe multi-process access

## 2. Goals & Non-Goals

### Goals
- Implement atomic dual-write from SQLite to state.json with crash recovery
- Support all intake channels (CLI, Claude App, Discord, Slack) transparently  
- Add `source` and `adapter_metadata` fields to both SQLite and state.json schemas
- Provide path resolution with protection against traversal attacks
- Enable state transitions (pause/resume/cancel/priority) with consistency guarantees
- Deliver reconciliation tooling for operational drift detection and repair
- Ensure backward compatibility with existing daemon `select_request()` logic
- Maintain zero data loss guarantees under crash conditions

### Non-Goals
- Modifying daemon state consumption patterns (TDD-001 scope)
- Implementing intake adapters (TDD-011 scope)
- Building web portal data layer integration (TDD-015 scope)
- Adding audit log HMAC integrity chains (TDD-014 scope)
- Supporting cross-repository atomic transactions
- Implementing distributed consensus protocols

## 3. Background

PRD-008 identifies the critical architectural gap preventing request submission across all channels: the intake layer writes to SQLite, but the daemon expects filesystem state. This dual-storage requirement emerges from two design constraints:

1. **SQLite as canonical index**: The intake layer requires ACID properties, query capabilities, and structured data for duplicate detection, rate limiting, and queue management
2. **Filesystem as daemon input**: The bash-based daemon expects `state.json` files discoverable via directory scanning for simplicity and zero-dependency operation

The challenge is maintaining consistency between these two storage systems under crash conditions. A naive approach (write SQLite, then write file) creates a window where SQLite succeeds but file write fails, leaving the request invisible to the daemon.

The two-phase commit pattern solves this by using the filesystem's atomic rename operation as the commit point:
1. Write temporary state file
2. Begin SQLite transaction
3. On SQLite success: rename temp file (atomic commit)
4. On SQLite failure: delete temp file (atomic rollback)

This ensures both systems are consistent or the operation fails cleanly with no partial state.

## 4. Architecture

### 4.1 Component Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Intake Layer                                   │
│  ┌─────────────────┬─────────────────┬─────────────────┬─────────────────┐  │
│  │  CLI Channel    │ Claude Channel  │ Discord Channel │ Slack Channel   │  │
│  └─────────────────┴─────────────────┴─────────────────┴─────────────────┘  │
│                                     │                                       │
│                          ┌──────────▼──────────┐                           │
│                          │   IntakeRouter      │                           │
│                          │   (unchanged)       │                           │
│                          └──────────┬──────────┘                           │
│                                     │                                       │
│               ┌─────────────────────┼─────────────────────┐                │
│               │                     ▼                     │                │
│    ┌──────────▼─────────┐                    ┌──────────▼─────────┐        │
│    │   SQLite Repository │                    │ State.json Bridge  │        │
│    │   (canonical)      │                    │ (NEW component)    │        │
│    │                    │                    │                    │        │
│    │ - requests table   │ ◄─── txn ────────► │ - path resolution  │        │
│    │ + source column    │                    │ - atomic write     │        │
│    │ + adapter_metadata │                    │ - schema validate  │        │
│    │   column           │                    │ - file locking     │        │
│    └────────────────────┘                    └──────────┬─────────┘        │
│                                                         │                  │
└─────────────────────────────────────────────────────────┼─────────────────┘
                                                          │
                                   ┌──────────────────────▼──────────────────┐
                                   │            Filesystem                    │
                                   │                                         │
                                   │  {repo}/.autonomous-dev/requests/      │
                                   │    REQ-NNNNNN/                         │
                                   │      state.json.tmp.{pid}.{random}     │
                                   │      state.json  ◄──── atomic rename   │
                                   │                                         │
                                   └──────────────────┬──────────────────────┘
                                                      │
                              ┌───────────────────────▼───────────────────────┐
                              │                Daemon Layer                    │
                              │  ┌─────────────────────────────────────────┐  │
                              │  │          supervisor-loop.sh             │  │
                              │  │                                         │  │
                              │  │  select_request() {                     │  │
                              │  │    scan for state.json files             │  │
                              │  │    filter by actionable states          │  │
                              │  │    return highest priority              │  │
                              │  │  }                                      │  │
                              │  │          (unchanged)                    │  │
                              │  └─────────────────────────────────────────┘  │
                              └─────────────────────────────────────────────────┘
```

### 4.2 Data Flow Sequence

#### Submit Request (Happy Path)
```
User → CLI/Claude/Discord/Slack
  │
  ▼
IntakeRouter.route('submit', args)
  │
  ▼  
SubmitHandler.execute()
  │
  ├─── Parse & Validate Input
  │
  ├─── Generate Request ID (REQ-NNNNNN)
  │
  ├─── Two-Phase Commit:
  │    │
  │    ├─── 1. buildStatePath(requestId, targetRepo)
  │    │         ├─── Validate requestId format
  │    │         ├─── Resolve target path  
  │    │         └─── Check path traversal
  │    │
  │    ├─── 2. writeTemporaryState(statePath + '.tmp.' + pid + '.' + random)
  │    │         ├─── Serialize request to JSON
  │    │         ├─── Validate against schema
  │    │         ├─── Write temp file
  │    │         └─── fsync()
  │    │
  │    ├─── 3. beginSqliteTransaction()
  │    │         └─── INSERT into requests (...)
  │    │
  │    ├─── 4. commitPhase()
  │    │         ├─── COMMIT SQLite transaction
  │    │         └─── rename(tempFile, statePath)  // atomic
  │    │
  │    └─── 5. cleanup()
  │              └─── On error: ROLLBACK + unlink(tempFile)
  │
  ▼
Response { requestId, position, estimatedWait }
```

#### Daemon Discovery (Unchanged)
```
supervisor-loop.sh main loop
  │
  ▼
select_request()
  │
  ├─── for repo in allowlist:
  │      scan {repo}/.autonomous-dev/requests/*/state.json
  │
  ├─── filter actionable states
  │      (skip: paused, failed, cancelled, monitor)
  │
  ├─── sort by priority (0=highest) then created_at
  │
  └─── return best_id|best_project
       │
       ▼
     Session spawned with state.json as input
```

## 5. Two-Phase Commit Protocol

### 5.1 Formal Specification

The handoff follows a strict two-phase commit with the following invariants:

**Phase 1: Preparation**
- P1.1: Validate request ID against regex `^REQ-\d{6}$`
- P1.2: Build target path: `{targetRepo}/.autonomous-dev/requests/{requestId}/state.json`
- P1.3: Resolve path to absolute form and verify within repository boundary
- P1.4: Generate temporary filename: `state.json.tmp.{pid}.{random_hex}`
- P1.5: Serialize request state to JSON and validate against schema
- P1.6: Write temporary file with `O_CREAT | O_EXCL | O_WRONLY` flags
- P1.7: Call `fsync()` to ensure data reaches persistent storage
- P1.8: Begin SQLite transaction

**Phase 2: Commit Decision**
- C2.1: Execute SQLite INSERT/UPDATE operation
- C2.2: If SQLite succeeds → C2.3, else → R2.4
- C2.3: COMMIT SQLite transaction, then `rename(tempFile, targetFile)` (atomic)
- R2.4: ROLLBACK SQLite transaction, then `unlink(tempFile)`

**Failure Points & Recovery Actions**

| Failure Point | Observable State | Recovery Action |
|---------------|------------------|-----------------|
| F1: Temp file write fails | No temp file, no SQLite row | Return error to user |
| F2: fsync() fails | Temp file exists, no SQLite row | unlink(tempFile), return error |
| F3: SQLite INSERT fails | Temp file exists, no SQLite row | unlink(tempFile), return error | 
| F4: rename() fails | Temp file exists, SQLite row exists | ROLLBACK SQLite, unlink(tempFile), return error |

**Startup Recovery for Orphaned Files**
```bash
# On daemon startup
for req_dir in {repo}/.autonomous-dev/requests/*/; do
  if [[ -f "${req_dir}/state.json.tmp.*" && -f "${req_dir}/state.json" ]]; then
    # Incomplete write from crashed process - safe to delete temp
    rm -f "${req_dir}"/state.json.tmp.*
  elif [[ -f "${req_dir}/state.json.tmp.*" && ! -f "${req_dir}/state.json" ]]; then
    # Crash between temp write and rename - attempt recovery
    temp_file=$(ls "${req_dir}"/state.json.tmp.* | head -1)
    if validate_json_schema "${temp_file}"; then
      mv "${temp_file}" "${req_dir}/state.json"
      log_info "Recovered orphaned state file: ${req_dir}"
    else
      mkdir -p "${req_dir}/corrupt"
      mv "${temp_file}" "${req_dir}/corrupt/"
      log_error "Corrupted temp file moved to corrupt/: ${req_dir}"
    fi
  fi
done
```

### 5.2 Implementation Pseudocode

```typescript
async function submitRequestWithHandoff(
  request: RequestSubmission,
  targetRepo: string
): Promise<{ requestId: string; position: number }> {
  const requestId = generateRequestId(); // REQ-NNNNNN format
  let tempFilePath: string | null = null;
  
  try {
    // Phase 1: Preparation
    const statePath = buildStatePath(requestId, targetRepo);
    validatePathSecurity(statePath, targetRepo);
    
    tempFilePath = `${statePath}.tmp.${process.pid}.${randomHex(4)}`;
    const stateData = buildStateData(request, requestId);
    validateStateSchema(stateData);
    
    await writeTemporaryFile(tempFilePath, stateData);
    await fsyncFile(tempFilePath);
    
    // Phase 2: Commit
    return await db.transaction(async () => {
      const sqliteInsert = await db.insertRequest({
        request_id: requestId,
        title: request.title,
        description: request.description,
        priority: request.priority,
        target_repo: targetRepo,
        status: 'queued',
        source: request.source,
        adapter_metadata: JSON.stringify(request.adapterMetadata),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      
      // Atomic commit point
      await renameFile(tempFilePath, statePath);
      tempFilePath = null; // Prevent cleanup
      
      return {
        requestId,
        position: await db.getQueuePosition(requestId)
      };
    });
  } catch (error) {
    // Phase 2: Rollback
    if (tempFilePath) {
      await unlinkFile(tempFilePath).catch(() => {}); // Best effort cleanup
    }
    throw error;
  }
}
```

### 5.3 Concurrency Control

**File Locking Strategy: Advisory Locking Per Request Directory**

The system uses `flock(2)` advisory file locking to coordinate access:

```bash
# Create lock file per request directory
lock_file="${req_dir}/.lock"

# Exclusive lock for state modifications (submit, pause, resume, cancel, priority)
exec 200>"${lock_file}"
if ! flock -w 10 200; then
  echo "ERROR: Could not acquire lock for ${req_id} within 10 seconds"
  return 1
fi

# Perform two-phase commit while holding lock
perform_state_transition

# Lock automatically released when file descriptor closes
exec 200>&-
```

**Why per-request-directory locking instead of per-repository:**
- **Granularity**: Multiple requests in the same repository can be modified concurrently
- **Performance**: No serialization bottleneck for high-volume repositories  
- **Deadlock prevention**: Single lock ordering (always acquire request lock, never multiple)
- **Simplicity**: No complex lock hierarchy or distributed coordination

**SQLite WAL Mode Configuration**
```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 10000;  -- 10 second timeout for lock contention
PRAGMA wal_autocheckpoint = 1000;
```

WAL mode enables concurrent readers while maintaining ACID properties for the two-phase commit writes.

## 6. Path Resolution & Security

### 6.1 Path Resolution Algorithm

```typescript
function buildStatePath(requestId: string, targetRepo: string): string {
  // Step 1: Validate request ID format
  if (!/^REQ-\d{6}$/.test(requestId)) {
    throw new SecurityError(`Invalid request ID format: ${requestId}`);
  }
  
  // Step 2: Resolve repository path to absolute form
  const resolvedRepo = path.resolve(targetRepo);
  
  // Step 3: Check repository is on allowlist
  const allowlist = config.repositories.allowlist;
  if (!allowlist.includes(resolvedRepo)) {
    throw new SecurityError(`Repository not on allowlist: ${resolvedRepo}`);
  }
  
  // Step 4: Build target path
  const requestDir = path.join(resolvedRepo, '.autonomous-dev', 'requests', requestId);
  const statePath = path.join(requestDir, 'state.json');
  
  // Step 5: Verify resolved path stays within repository boundary  
  const resolvedStatePath = path.resolve(statePath);
  if (!resolvedStatePath.startsWith(resolvedRepo + path.sep)) {
    throw new SecurityError(`Path traversal attempt detected: ${statePath}`);
  }
  
  return resolvedStatePath;
}
```

### 6.2 Security Properties

**SP-1: Request ID Validation**
- Request IDs must match `^REQ-\d{6}$` exactly
- Prevents injection of path components like `../../../etc/passwd`
- Enforces the canonical ID format expected by the daemon

**SP-2: Repository Allowlist Enforcement**  
- Target repository must be explicitly allowlisted in configuration
- Path resolution happens after allowlist check to prevent TOCTOU races
- Absolute path comparison prevents bypass via symlinks or `..` components

**SP-3: Path Traversal Prevention**
- All paths resolved to absolute form before boundary checking
- Boundary check uses string prefix matching with separator enforcement
- Symlinks within the repository are allowed but cannot escape boundaries

**SP-4: Directory Creation with Secure Permissions**
```bash
# Create request directory with owner-only permissions
mkdir -p "${request_dir}" && chmod 700 "${request_dir}"

# Create .autonomous-dev directory with secure permissions if not exists
autonomous_dev_dir="${repo}/.autonomous-dev"
if [[ ! -d "${autonomous_dev_dir}" ]]; then
  mkdir -p "${autonomous_dev_dir}" && chmod 700 "${autonomous_dev_dir}"
fi
```

### 6.3 Attack Scenarios & Mitigations

| Attack Vector | Mitigation | Verification |
|---------------|------------|--------------|
| Path traversal via request ID (`REQ-../../etc`) | Regex validation before any path operations | Unit test with malicious IDs |
| Symlink escape from repository | Absolute path resolution + prefix check | Integration test with symlink farms |
| Repository allowlist bypass | Allowlist check before path building | Security test with various bypass attempts |
| Race condition on directory creation | `mkdir -p` is atomic for path creation | Concurrent test with multiple processes |
| Privilege escalation via file permissions | Explicit `chmod 700` on created directories | Permission audit in test suite |

## 7. Schema Definitions

### 7.1 TypeScript Interfaces

```typescript
/**
 * Source channel enumeration for audit trails and channel-specific handling.
 */
export type RequestSource = 
  | 'cli'
  | 'claude-app'  
  | 'discord'
  | 'slack'
  | 'production-intelligence'
  | 'portal';

/**
 * Adapter-specific metadata captured at request submission.
 */
export interface AdapterMetadata {
  // CLI metadata
  cli_pid?: number;
  cli_working_directory?: string;
  cli_git_branch?: string;
  
  // Claude App metadata
  claude_session_id?: string;
  claude_user_id?: string;
  claude_workspace?: string;
  
  // Discord metadata
  discord_guild_id?: string;
  discord_channel_id?: string;
  discord_user_id?: string;
  discord_message_id?: string;
  
  // Slack metadata
  slack_team_id?: string;
  slack_channel_id?: string;
  slack_user_id?: string;
  slack_message_ts?: string;
  
  // Portal metadata (future)
  portal_session_id?: string;
  portal_user_agent?: string;
}

/**
 * Extended state.json schema with source tracking.
 */
export interface StateFile {
  schema_version: 1;
  id: string;
  status: RequestStatus;
  priority: number;
  title: string;
  description?: string;
  repository: string;
  branch: string;
  worktree_path: string | null;
  created_at: string;
  updated_at: string;
  cost_accrued_usd: number;
  turn_count: number;
  escalation_count: number;
  blocked_by: string[];
  phase_history: PhaseHistoryEntry[];
  current_phase_metadata: Record<string, unknown>;
  error: ErrorInfo | null;
  last_checkpoint: string | null;
  paused_from: string | null;
  paused_reason: string | null;
  failure_reason: string | null;
  generation: number;
  tags: string[];
  
  // NEW: Source tracking fields
  source: RequestSource;
  adapter_metadata: AdapterMetadata;
}

/**
 * Extended SQLite request entity with source fields.
 */
export interface RequestEntity {
  request_id: string;
  title: string;
  description: string;
  raw_input: string;
  priority: Priority;
  target_repo: string | null;
  status: RequestStatus;
  current_phase: string;
  phase_progress: string | null;
  requester_id: string;
  source_channel: ChannelType;
  notification_config: string;
  deadline: string | null;
  related_tickets: string;
  technical_constraints: string | null;
  acceptance_criteria: string | null;
  blocker: string | null;
  promotion_count: number;
  last_promoted_at: string | null;
  paused_at_phase: string | null;
  created_at: string;
  updated_at: string;
  
  // NEW: Source tracking fields
  source: RequestSource;
  adapter_metadata: string; // JSON serialized AdapterMetadata
}
```

### 7.2 JSON Schema for state.json Validation

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "StateFileV1WithSource", 
  "description": "Extended state.json schema with source tracking for TDD-012",
  "type": "object",
  "required": [
    "schema_version", "id", "status", "priority", "title", "repository", 
    "branch", "created_at", "updated_at", "cost_accrued_usd", "turn_count",
    "escalation_count", "blocked_by", "phase_history", "current_phase_metadata",
    "error", "last_checkpoint", "source", "adapter_metadata"
  ],
  "properties": {
    "schema_version": { "const": 1 },
    "id": { 
      "type": "string", 
      "pattern": "^REQ-\\d{6}$" 
    },
    "source": {
      "type": "string",
      "enum": ["cli", "claude-app", "discord", "slack", "production-intelligence", "portal"]
    },
    "adapter_metadata": {
      "type": "object",
      "properties": {
        "cli_pid": { "type": "integer", "minimum": 1 },
        "cli_working_directory": { "type": "string" },
        "cli_git_branch": { "type": "string" },
        
        "claude_session_id": { "type": "string" },
        "claude_user_id": { "type": "string" },
        "claude_workspace": { "type": "string" },
        
        "discord_guild_id": { "type": "string", "pattern": "^\\d+$" },
        "discord_channel_id": { "type": "string", "pattern": "^\\d+$" },
        "discord_user_id": { "type": "string", "pattern": "^\\d+$" },
        "discord_message_id": { "type": "string", "pattern": "^\\d+$" },
        
        "slack_team_id": { "type": "string", "pattern": "^T[A-Z0-9]+$" },
        "slack_channel_id": { "type": "string", "pattern": "^C[A-Z0-9]+$" },
        "slack_user_id": { "type": "string", "pattern": "^U[A-Z0-9]+$" },
        "slack_message_ts": { "type": "string", "pattern": "^\\d+\\.\\d+$" },
        
        "portal_session_id": { "type": "string" },
        "portal_user_agent": { "type": "string" }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

## 8. SQLite Migration

### 8.1 Migration Script (v1.3 → v1.4)

```sql
-- ==========================================================================
-- Migration: Add source tracking to requests table
-- Version: 1.3 → 1.4
-- TDD: TDD-012 Intake-to-Daemon Handoff
-- ==========================================================================

BEGIN TRANSACTION;

-- Add source column with default 'cli' for backward compatibility
ALTER TABLE requests ADD COLUMN source TEXT NOT NULL DEFAULT 'cli' 
  CHECK (source IN ('cli', 'claude-app', 'discord', 'slack', 'production-intelligence', 'portal'));

-- Add adapter_metadata column as JSON blob  
ALTER TABLE requests ADD COLUMN adapter_metadata TEXT DEFAULT '{}';

-- Create index for source-based queries
CREATE INDEX idx_requests_source ON requests(source);

-- Update schema version
UPDATE schema_version SET version = '1.4', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE component = 'intake_db';

COMMIT;
```

### 8.2 Migration Runner Integration

```typescript
export class MigrationRunner {
  private migrations = new Map([
    ['1.3', this.migrateV13ToV14],
    // ... other migrations
  ]);

  async migrateV13ToV14(db: Database): Promise<void> {
    console.log('Migrating intake database from v1.3 to v1.4 (source tracking)...');
    
    // Read migration SQL
    const migrationPath = path.join(__dirname, 'migrations', '1.3-to-1.4-source-tracking.sql');
    const migrationSQL = await fs.readFile(migrationPath, 'utf-8');
    
    // Execute migration in transaction
    await db.exec(migrationSQL);
    
    // Verify migration success
    const result = db.prepare("SELECT COUNT(*) as count FROM pragma_table_info('requests') WHERE name IN ('source', 'adapter_metadata')").get() as { count: number };
    if (result.count !== 2) {
      throw new Error('Migration verification failed: source tracking columns not found');
    }
    
    console.log('Migration completed successfully. Source tracking enabled.');
  }
}
```

### 8.3 Backward Compatibility Strategy

**Gradual Migration for Existing Requests**
```sql
-- Backfill source for existing requests based on source_channel  
UPDATE requests 
SET source = CASE source_channel 
  WHEN 'claude_app' THEN 'claude-app'
  WHEN 'discord' THEN 'discord' 
  WHEN 'slack' THEN 'slack'
  ELSE 'cli'  -- Default for any unknown values
END
WHERE source = 'cli' AND created_at < '2026-04-28T00:00:00Z';

-- Verify no data loss occurred
SELECT COUNT(*) as total_requests, 
       COUNT(CASE WHEN source IS NOT NULL THEN 1 END) as requests_with_source
FROM requests;
-- Should show total_requests = requests_with_source
```

**Schema Version Compatibility Matrix**

| State Schema Version | SQLite Schema Version | Compatibility |
|----------------------|----------------------|---------------|
| v1 (legacy) | v1.3 (legacy) | ✅ Full compatibility (no source fields) |
| v1 + source (new) | v1.4 (new) | ✅ Full compatibility |
| v1 (legacy) | v1.4 (new) | ✅ Compatible (source defaults to 'cli') |
| v1 + source (new) | v1.3 (legacy) | ❌ Incompatible (missing columns) |

## 9. Failure Modes & Recovery

### 9.1 Failure Classification

**Class 1: Preparation Failures (F1-F3)**
- **Impact**: Request submission fails cleanly, user receives error
- **Data consistency**: No data written to either SQLite or filesystem  
- **Recovery**: None needed; user can retry submission
- **Examples**: Disk full during temp file write, invalid target repository, malformed request data

**Class 2: Commit Failures (F4)**
- **Impact**: SQLite transaction committed but filesystem rename failed
- **Data consistency**: SQLite contains request, but no state.json exists
- **Recovery**: Automatic reconciliation detects and repairs missing state.json
- **Examples**: Permission denied on target directory, filesystem becomes read-only

**Class 3: Crash Failures**
- **Impact**: Process terminated during two-phase commit
- **Data consistency**: Depends on crash timing; orphaned temp files possible
- **Recovery**: Startup recovery process handles temp file cleanup/promotion
- **Examples**: SIGKILL during rename, machine power loss, Out of Memory killer

### 9.2 Failure Recovery Matrix

| Failure Point | SQLite State | Filesystem State | Recovery Action | Data Loss |
|---------------|--------------|------------------|-----------------|-----------|
| Temp file write fails | None | None | Return error, no cleanup needed | None |
| fsync() fails | None | Temp file exists | unlink(tempFile), return error | None |
| SQLite BEGIN fails | None | Temp file exists | unlink(tempFile), return error | None |
| SQLite INSERT fails | None | Temp file exists | unlink(tempFile), return error | None |
| SQLite COMMIT fails | None | Temp file exists | unlink(tempFile), return error | None |
| rename() fails | Row inserted | Temp file exists | ROLLBACK SQLite, unlink(tempFile) | None |
| Crash before rename | Row inserted | Temp file exists | ROLLBACK SQLite on restart | None |
| Crash during rename | Row inserted | Partial state | Reconciliation recreates state.json | None |
| Crash after rename | Row inserted | state.json exists | Normal operation | None |

### 9.3 Reconciliation Algorithm

```typescript
class StateReconciler {
  async reconcileRepository(repositoryPath: string): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      scanned: 0,
      inconsistencies: 0,
      repaired: 0,
      errors: []
    };
    
    const requestsDir = path.join(repositoryPath, '.autonomous-dev', 'requests');
    if (!fs.existsSync(requestsDir)) return report;
    
    // Phase 1: Scan for missing state.json files
    const sqliteRequests = await this.db.getRequestsByRepo(repositoryPath);
    for (const request of sqliteRequests) {
      report.scanned++;
      
      const statePath = path.join(requestsDir, request.request_id, 'state.json');
      if (!fs.existsSync(statePath)) {
        report.inconsistencies++;
        
        try {
          // Recreate state.json from SQLite data
          const stateData = this.buildStateFromSQLite(request);
          await this.writeStateFile(statePath, stateData);
          report.repaired++;
        } catch (error) {
          report.errors.push(`Failed to repair ${request.request_id}: ${error.message}`);
        }
      }
    }
    
    // Phase 2: Scan for orphaned state.json files  
    const stateFiles = await this.findStateFiles(requestsDir);
    for (const statePath of stateFiles) {
      const requestId = this.extractRequestId(statePath);
      const sqliteRequest = await this.db.getRequest(requestId);
      
      if (!sqliteRequest) {
        report.inconsistencies++;
        
        try {
          // Import state.json into SQLite
          const stateData = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
          const requestEntity = this.buildSQLiteFromState(stateData);
          await this.db.insertRequest(requestEntity);
          report.repaired++;
        } catch (error) {
          report.errors.push(`Failed to import ${requestId}: ${error.message}`);
        }
      }
    }
    
    return report;
  }
}
```

### 9.4 Monitoring & Alerting

**Reconciliation Metrics**
```typescript
interface ReconcileMetrics {
  lastRunTimestamp: string;
  repositoriesScanned: number;
  totalInconsistencies: number;
  autoRepaired: number;
  manualRepairNeeded: number;
  avgReconcileTimeMs: number;
}

// Alert thresholds
const ALERT_THRESHOLDS = {
  inconsistencyRate: 0.01,      // Alert if >1% of requests are inconsistent  
  manualRepairNeeded: 5,        // Alert if >5 requests need manual repair
  reconcileTimeMs: 30_000,      // Alert if reconcile takes >30s
};
```

**Operational Runbook**

| Alert | Severity | Investigation Steps | Resolution |
|-------|----------|-------------------|------------|
| High inconsistency rate | P2 | Check disk space, filesystem errors, process crashes during high load | Run manual reconcile, investigate root cause |
| Manual repair needed | P3 | Check state.json schema validation errors, SQLite corruption | Export problematic requests, manual data recovery |
| Slow reconcile | P4 | Check filesystem performance, large number of requests | Tune reconcile batch size, consider archival |

## 10. State Transitions with Two-Phase Pattern

### 10.1 Transition Operations

All state-mutating operations (pause, resume, cancel, priority change) follow the same two-phase pattern:

```typescript
async function pauseRequest(requestId: string, reason: string): Promise<void> {
  const currentRequest = await db.getRequest(requestId);
  if (!currentRequest) throw new Error(`Request not found: ${requestId}`);
  
  validateStateTransition(currentRequest.status, 'pause');
  
  let tempFilePath: string | null = null;
  
  try {
    // Phase 1: Compute new state and write temp file
    const newState = computePausedState(currentRequest, reason);
    const statePath = buildStatePath(requestId, currentRequest.target_repo!);
    
    tempFilePath = `${statePath}.tmp.${process.pid}.${randomHex(4)}`;
    await writeTemporaryFile(tempFilePath, newState);
    await fsyncFile(tempFilePath);
    
    // Phase 2: Commit
    await db.transaction(async () => {
      await db.updateRequest(requestId, {
        status: 'paused',
        paused_at_phase: currentRequest.current_phase,
        updated_at: new Date().toISOString()
      });
      
      await renameFile(tempFilePath, statePath);
      tempFilePath = null; // Prevent cleanup
    });
    
    emitter.emit('request_paused', { requestId, reason });
    
  } catch (error) {
    if (tempFilePath) {
      await unlinkFile(tempFilePath).catch(() => {});
    }
    throw error;
  }
}

function computePausedState(current: RequestEntity, reason: string): StateFile {
  return {
    ...currentStateFromSQLite(current),
    status: 'paused',
    paused_from: current.status,
    paused_reason: reason,
    updated_at: new Date().toISOString(),
    // Add pause event to phase_history
    phase_history: [
      ...current.phase_history,
      {
        state: 'paused',
        entered_at: new Date().toISOString(),
        exited_at: null,
        session_id: null,
        turns_used: 0,
        cost_usd: 0,
        retry_count: 0,
        exit_reason: null
      }
    ]
  };
}
```

### 10.2 Resume Operation

```typescript
async function resumeRequest(requestId: string): Promise<void> {
  const currentRequest = await db.getRequest(requestId);
  if (!currentRequest) throw new Error(`Request not found: ${requestId}`);
  
  validateStateTransition(currentRequest.status, 'resume');
  
  if (currentRequest.status !== 'paused') {
    throw new Error(`Cannot resume request in ${currentRequest.status} state`);
  }
  
  let tempFilePath: string | null = null;
  
  try {
    // Phase 1: Compute resumed state  
    const newState = computeResumedState(currentRequest);
    const statePath = buildStatePath(requestId, currentRequest.target_repo!);
    
    tempFilePath = `${statePath}.tmp.${process.pid}.${randomHex(4)}`;
    await writeTemporaryFile(tempFilePath, newState);
    await fsyncFile(tempFilePath);
    
    // Phase 2: Commit
    await db.transaction(async () => {
      await db.updateRequest(requestId, {
        status: newState.paused_from as RequestStatus, // Return to original state
        paused_at_phase: null,
        updated_at: new Date().toISOString()
      });
      
      await renameFile(tempFilePath, statePath);
      tempFilePath = null;
    });
    
    emitter.emit('request_resumed', { requestId });
    
  } catch (error) {
    if (tempFilePath) {
      await unlinkFile(tempFilePath).catch(() => {});
    }
    throw error;
  }
}

function computeResumedState(current: RequestEntity): StateFile {
  const currentState = currentStateFromSQLite(current);
  
  return {
    ...currentState,
    status: currentState.paused_from!, // Resume to original state
    paused_from: null,
    paused_reason: null,
    updated_at: new Date().toISOString(),
    // Close pause phase and return to original phase
    phase_history: currentState.phase_history.map((entry, index) => 
      index === currentState.phase_history.length - 1 && entry.state === 'paused'
        ? { ...entry, exited_at: new Date().toISOString(), exit_reason: 'resumed' }
        : entry
    )
  };
}
```

### 10.3 Cancel Operation

```typescript
async function cancelRequest(requestId: string, reason: string): Promise<void> {
  const currentRequest = await db.getRequest(requestId);
  if (!currentRequest) throw new Error(`Request not found: ${requestId}`);
  
  validateStateTransition(currentRequest.status, 'cancel');
  
  let tempFilePath: string | null = null;
  
  try {
    // Phase 1: Compute cancelled state
    const newState = computeCancelledState(currentRequest, reason);
    const statePath = buildStatePath(requestId, currentRequest.target_repo!);
    
    tempFilePath = `${statePath}.tmp.${process.pid}.${randomHex(4)}`;
    await writeTemporaryFile(tempFilePath, newState);
    await fsyncFile(tempFilePath);
    
    // Phase 2: Commit  
    await db.transaction(async () => {
      await db.updateRequest(requestId, {
        status: 'cancelled',
        updated_at: new Date().toISOString()
      });
      
      await renameFile(tempFilePath, statePath);
      tempFilePath = null;
    });
    
    // Phase 3: Cleanup (separate from two-phase commit)
    await triggerCleanup(requestId, currentRequest.target_repo!);
    
    emitter.emit('request_cancelled', { requestId, reason });
    
  } catch (error) {
    if (tempFilePath) {
      await unlinkFile(tempFilePath).catch(() => {});
    }
    throw error;
  }
}

async function triggerCleanup(requestId: string, targetRepo: string): Promise<void> {
  try {
    // Delete worktree if it exists
    const branch = `autonomous/${requestId}`;
    await exec(`git -C "${targetRepo}" worktree remove "${branch}" --force`, { timeout: 30000 });
    
    // Delete remote branch if configured to do so
    if (config.cleanup.delete_remote_branches) {
      await exec(`git -C "${targetRepo}" push origin --delete "${branch}"`, { timeout: 30000 });
    }
    
    // Archive request directory
    const requestDir = path.join(targetRepo, '.autonomous-dev', 'requests', requestId);
    const archiveDir = path.join(os.homedir(), '.autonomous-dev', 'archive', requestId);
    
    await fs.mkdir(path.dirname(archiveDir), { recursive: true });
    await exec(`tar -czf "${archiveDir}.tar.gz" -C "${requestDir}" .`);
    await fs.rm(requestDir, { recursive: true, force: true });
    
  } catch (error) {
    // Cleanup failures are logged but don't fail the cancel operation
    console.error(`Cleanup failed for ${requestId}:`, error);
  }
}
```

## 11. Atomic Rename Portability

### 11.1 POSIX rename() Semantics

The two-phase commit relies on the atomicity of the `rename(2)` system call:

**POSIX.1-2008 Specification:**
> "If the `old` argument and the `new` argument resolve to the same existing file, `rename()` shall return successfully and perform no other action. If the `old` argument points to the pathname of a file that is not a directory, `new` shall not point to the pathname of a directory. If the link named by `new` exists, it shall be removed and `old` renamed to `new`. In this case, a link named `new` shall remain visible to other processes throughout the renaming operation and refer either to the file referred to by `new` or `old` before the operation began."

**Key Atomicity Guarantees:**
1. **All-or-nothing**: The rename either succeeds completely or fails with no side effects
2. **Visibility**: Other processes see either the old file or the new file, never a partial state  
3. **Cross-directory**: Works across directories within the same filesystem
4. **Ordering**: Prior `fsync()` calls ensure data is persistent before the rename

### 11.2 Filesystem-Specific Behavior

**APFS (macOS):**
- ✅ Full POSIX rename atomicity
- ✅ Copy-on-write ensures no data corruption during rename
- ✅ Nanosecond timestamp precision for audit trails
- ⚠️ Case-insensitive by default (may affect request ID uniqueness)

**ext4 (Linux):**
- ✅ Full POSIX rename atomicity
- ✅ Journal ensures consistency across crashes during rename
- ✅ Extended attributes preserved across rename
- ⚠️ Requires `fsync()` on parent directory for durability in some configurations

**NTFS (Windows via WSL):**
- ✅ POSIX rename atomicity maintained by WSL translation layer
- ⚠️ Performance penalty due to Windows filesystem semantics translation
- ⚠️ Path length limitations may affect deep repository structures

**ZFS:**
- ✅ Copy-on-write provides stronger guarantees than required
- ✅ Checksums detect corruption even if rename succeeds
- ✅ Snapshots can provide additional recovery points

### 11.3 fsync() Requirements

**Pre-rename fsync() Pattern:**
```c
// Pseudocode for atomic write sequence
fd = open(temp_file, O_WRONLY | O_CREAT | O_EXCL, 0600);
write(fd, data, data_len);
fsync(fd);        // Ensure data reaches persistent storage
close(fd);
rename(temp_file, target_file);  // Atomic commit point
```

**Why fsync() before rename():**
- Without `fsync()`, data may still be in OS page cache during rename
- If crash occurs after rename but before cache flush, state.json exists but is empty
- `fsync()` forces data to persistent storage before commit decision

**Directory fsync() Requirements (ext4):**
```bash
# Some filesystems require directory fsync for metadata durability
fsync_dir() {
  local dir="$1"
  python3 -c "
import os
fd = os.open('${dir}', os.O_RDONLY)
os.fsync(fd) 
os.close(fd)
" 2>/dev/null || true  # Best effort
}

# After rename operation
rename "${temp_file}" "${target_file}"
fsync_dir "$(dirname "${target_file}")"
```

### 11.4 Error Handling & Verification

```typescript
async function atomicRename(tempPath: string, targetPath: string): Promise<void> {
  try {
    // Verify temp file exists and has expected content
    const tempStats = await fs.stat(tempPath);
    if (tempStats.size === 0) {
      throw new Error('Temporary file is empty after fsync');
    }
    
    // Perform atomic rename
    await fs.rename(tempPath, targetPath);
    
    // Verify target file exists with expected content
    const targetStats = await fs.stat(targetPath);
    if (targetStats.size !== tempStats.size) {
      throw new Error('File size mismatch after rename - possible corruption');
    }
    
    // Optional: fsync parent directory for metadata durability
    await fsyncDirectory(path.dirname(targetPath));
    
  } catch (error) {
    // Clean up temp file on failure
    await fs.unlink(tempPath).catch(() => {});
    throw new Error(`Atomic rename failed: ${error.message}`);
  }
}

async function fsyncDirectory(dirPath: string): Promise<void> {
  try {
    const fd = await fs.open(dirPath, 'r');
    await fd.sync();
    await fd.close();
  } catch (error) {
    // Directory fsync is optional - log but don't fail
    console.warn(`Directory fsync failed for ${dirPath}:`, error.message);
  }
}
```

### 11.5 Cross-Platform Testing Strategy

```typescript
describe('Atomic Rename Portability', () => {
  test('rename atomicity under concurrent reads', async () => {
    const tempFile = '/tmp/test.json.tmp';
    const targetFile = '/tmp/test.json';
    const testData = JSON.stringify({ test: 'data' });
    
    // Start concurrent reader
    const readerPromise = Promise.resolve().then(async () => {
      for (let i = 0; i < 1000; i++) {
        try {
          const content = await fs.readFile(targetFile, 'utf-8');
          const parsed = JSON.parse(content);
          expect(parsed).toEqual({ test: 'data' }); // Should never see partial content
        } catch (error) {
          // File doesn't exist yet - continue
        }
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    });
    
    // Perform atomic write
    await fs.writeFile(tempFile, testData);
    await fsyncFile(tempFile);
    await atomicRename(tempFile, targetFile);
    
    await readerPromise;
  });
  
  test('rename failure leaves temp file intact', async () => {
    const tempFile = '/tmp/test.json.tmp';
    const targetFile = '/readonly/test.json'; // Permission denied
    
    await fs.writeFile(tempFile, '{"test": "data"}');
    
    await expect(atomicRename(tempFile, targetFile)).rejects.toThrow();
    
    // Temp file should still exist
    expect(await fs.stat(tempFile)).toBeDefined();
    
    // Target should not exist  
    await expect(fs.stat(targetFile)).rejects.toThrow();
  });
});
```

## 12. Reconciliation Tooling

### 12.1 CLI Subcommand Interface

```bash
# Basic reconciliation check
autonomous-dev request reconcile

# Reconcile specific repository
autonomous-dev request reconcile --repo /path/to/repo

# Dry-run mode (report only, no repairs)
autonomous-dev request reconcile --dry-run

# Verbose output with details
autonomous-dev request reconcile --verbose

# Force repair of all inconsistencies
autonomous-dev request reconcile --force-repair

# Export report to JSON for automation
autonomous-dev request reconcile --output-json /tmp/reconcile-report.json
```

### 12.2 Reconciliation Report Format

```typescript
interface ReconcileReport {
  timestamp: string;
  repositories_scanned: number;
  total_requests_checked: number;
  inconsistencies_found: number;
  repairs_attempted: number;
  repairs_successful: number;
  manual_intervention_needed: string[];
  
  details: {
    missing_state_files: RequestInconsistency[];
    orphaned_state_files: RequestInconsistency[];
    schema_validation_failures: RequestInconsistency[];
    metadata_mismatches: RequestInconsistency[];
  };
  
  performance: {
    scan_duration_ms: number;
    repair_duration_ms: number;
    avg_request_check_ms: number;
  };
}

interface RequestInconsistency {
  request_id: string;
  repository: string;
  issue_type: 'missing_state' | 'orphaned_state' | 'schema_invalid' | 'metadata_mismatch';
  description: string;
  sqlite_state?: Partial<RequestEntity>;
  filesystem_state?: unknown;
  repair_action: 'auto_repaired' | 'manual_required' | 'skipped';
  error_message?: string;
}
```

### 12.3 Implementation

```typescript
class ReconciliationEngine {
  constructor(
    private db: Repository,
    private config: { repositories: { allowlist: string[] } }
  ) {}
  
  async reconcile(options: ReconcileOptions): Promise<ReconcileReport> {
    const startTime = Date.now();
    const report: ReconcileReport = this.initializeReport();
    
    const repositories = options.repo ? [options.repo] : this.config.repositories.allowlist;
    
    for (const repo of repositories) {
      if (!fs.existsSync(repo)) {
        console.warn(`Repository not found: ${repo}`);
        continue;
      }
      
      report.repositories_scanned++;
      await this.reconcileRepository(repo, options, report);
    }
    
    report.performance.scan_duration_ms = Date.now() - startTime;
    return report;
  }
  
  private async reconcileRepository(
    repoPath: string, 
    options: ReconcileOptions,
    report: ReconcileReport
  ): Promise<void> {
    const requestsDir = path.join(repoPath, '.autonomous-dev', 'requests');
    if (!fs.existsSync(requestsDir)) return;
    
    // Phase 1: Check SQLite → Filesystem consistency  
    const sqliteRequests = await this.db.getAllRequestsForRepo(repoPath);
    for (const request of sqliteRequests) {
      report.total_requests_checked++;
      
      const statePath = path.join(requestsDir, request.request_id, 'state.json');
      const inconsistency = await this.checkSQLiteToFilesystem(request, statePath);
      
      if (inconsistency) {
        report.inconsistencies_found++;
        this.categorizeInconsistency(inconsistency, report);
        
        if (!options.dryRun) {
          await this.attemptRepair(inconsistency, report);
        }
      }
    }
    
    // Phase 2: Check Filesystem → SQLite consistency
    const stateFiles = await this.findStateFiles(requestsDir);
    for (const statePath of stateFiles) {
      const requestId = this.extractRequestIdFromPath(statePath);
      const sqliteRequest = await this.db.getRequest(requestId);
      
      if (!sqliteRequest) {
        const inconsistency = await this.checkFilesystemToSQLite(statePath);
        if (inconsistency) {
          report.inconsistencies_found++;
          this.categorizeInconsistency(inconsistency, report);
          
          if (!options.dryRun) {
            await this.attemptRepair(inconsistency, report);
          }
        }
      }
    }
  }
  
  private async checkSQLiteToFilesystem(
    request: RequestEntity, 
    expectedStatePath: string
  ): Promise<RequestInconsistency | null> {
    try {
      if (!fs.existsSync(expectedStatePath)) {
        return {
          request_id: request.request_id,
          repository: request.target_repo!,
          issue_type: 'missing_state',
          description: `state.json missing for request ${request.request_id}`,
          sqlite_state: request,
          repair_action: 'manual_required'
        };
      }
      
      const stateContent = await fs.readFile(expectedStatePath, 'utf-8');
      const stateData = JSON.parse(stateContent);
      
      // Validate schema
      const validationResult = await this.validateStateSchema(stateData);
      if (!validationResult.valid) {
        return {
          request_id: request.request_id,
          repository: request.target_repo!,
          issue_type: 'schema_invalid',
          description: `state.json schema validation failed: ${validationResult.errors.join(', ')}`,
          sqlite_state: request,
          filesystem_state: stateData,
          repair_action: 'auto_repaired'
        };
      }
      
      // Check metadata consistency
      if (stateData.source !== request.source) {
        return {
          request_id: request.request_id,
          repository: request.target_repo!,
          issue_type: 'metadata_mismatch',
          description: `Source mismatch: SQLite has '${request.source}', state.json has '${stateData.source}'`,
          sqlite_state: request,
          filesystem_state: stateData,
          repair_action: 'auto_repaired'
        };
      }
      
      return null; // No inconsistency
      
    } catch (error) {
      return {
        request_id: request.request_id,
        repository: request.target_repo!,
        issue_type: 'schema_invalid',
        description: `Failed to parse state.json: ${error.message}`,
        sqlite_state: request,
        repair_action: 'auto_repaired',
        error_message: error.message
      };
    }
  }
  
  private async attemptRepair(
    inconsistency: RequestInconsistency,
    report: ReconcileReport
  ): Promise<void> {
    report.repairs_attempted++;
    
    try {
      switch (inconsistency.issue_type) {
        case 'missing_state':
          await this.repairMissingStateFile(inconsistency);
          break;
          
        case 'orphaned_state':
          await this.repairOrphanedStateFile(inconsistency);
          break;
          
        case 'schema_invalid':
        case 'metadata_mismatch':
          await this.repairInconsistentState(inconsistency);
          break;
          
        default:
          throw new Error(`Unknown inconsistency type: ${inconsistency.issue_type}`);
      }
      
      inconsistency.repair_action = 'auto_repaired';
      report.repairs_successful++;
      
    } catch (error) {
      inconsistency.repair_action = 'manual_required';
      inconsistency.error_message = error.message;
      report.manual_intervention_needed.push(
        `${inconsistency.request_id}: ${error.message}`
      );
    }
  }
  
  private async repairMissingStateFile(inconsistency: RequestInconsistency): Promise<void> {
    const request = inconsistency.sqlite_state!;
    const targetRepo = request.target_repo!;
    const requestDir = path.join(targetRepo, '.autonomous-dev', 'requests', request.request_id);
    
    // Create directory if missing
    await fs.mkdir(requestDir, { recursive: true, mode: 0o700 });
    
    // Build state.json from SQLite data
    const stateData = this.buildStateFromSQLiteRequest(request);
    
    // Use two-phase commit for consistency
    await this.writeStateFileAtomic(requestDir, stateData);
  }
  
  private async repairOrphanedStateFile(inconsistency: RequestInconsistency): Promise<void> {
    const stateData = inconsistency.filesystem_state as StateFile;
    
    // Import state.json data into SQLite
    const requestEntity = this.buildSQLiteFromStateFile(stateData);
    
    await this.db.insertRequest(requestEntity);
  }
}
```

### 12.4 Operational Integration

```bash
#!/bin/bash
# /etc/cron.daily/autonomous-dev-reconcile
# Daily reconciliation check with alerting

RECONCILE_LOG="/var/log/autonomous-dev/reconcile.log"
ALERT_THRESHOLD=5  # Alert if more than 5 inconsistencies

# Run reconciliation
OUTPUT=$(autonomous-dev request reconcile --output-json /tmp/reconcile-report.json 2>&1)
RESULT=$?

# Log results
echo "$(date): Reconciliation completed with exit code $RESULT" >> "$RECONCILE_LOG"
echo "$OUTPUT" >> "$RECONCILE_LOG"

if [ $RESULT -ne 0 ]; then
  echo "ALERT: Reconciliation failed" | mail -s "autonomous-dev reconcile failure" ops@company.com
  exit 1
fi

# Check for high inconsistency count
INCONSISTENCIES=$(jq -r '.inconsistencies_found' /tmp/reconcile-report.json)
if [ "$INCONSISTENCIES" -gt $ALERT_THRESHOLD ]; then
  echo "ALERT: High inconsistency count: $INCONSISTENCIES" | mail -s "autonomous-dev reconcile alert" ops@company.com
fi

# Cleanup
rm -f /tmp/reconcile-report.json
```

## 13. Test Strategy

### 13.1 Chaos Testing Scenarios

**Chaos Test 1: Kill Process During Two-Phase Commit**
```typescript
describe('Two-Phase Commit Chaos Tests', () => {
  test('process killed during SQLite transaction', async () => {
    const requestData = createTestRequest();
    
    // Fork process for isolation
    const childProcess = spawn('node', ['./test-submit-with-kill.js']);
    
    // Let child start two-phase commit
    await sleep(100);
    
    // Send SIGKILL at random point during commit
    childProcess.kill('SIGKILL');
    
    // Verify no partial state exists
    const sqliteRequest = await db.getRequest(requestData.requestId);
    const statePath = buildStatePath(requestData.requestId, requestData.targetRepo);
    const stateExists = fs.existsSync(statePath);
    
    // Either both exist (commit succeeded) or neither exist (commit failed)
    expect(!!sqliteRequest).toBe(stateExists);
    
    // No orphaned temp files
    const tempFiles = glob.sync(`${statePath}.tmp.*`);
    expect(tempFiles).toHaveLength(0);
  });
  
  test('disk full during temp file write', async () => {
    // Fill disk to capacity (in test environment)
    await fillDiskToCapacity('/tmp');
    
    const result = await submitRequest(createTestRequest());
    
    // Should fail cleanly with disk space error
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('DISK_FULL');
    
    // No partial state in SQLite or filesystem
    expect(await db.getRequest(result.requestId)).toBeNull();
    expect(fs.existsSync(buildStatePath(result.requestId, '/tmp/repo'))).toBe(false);
  });
  
  test('concurrent requests to same repository', async () => {
    const requests = Array.from({ length: 10 }, () => createTestRequest());
    
    // Submit all requests concurrently
    const results = await Promise.allSettled(
      requests.map(request => submitRequest(request))
    );
    
    // All should succeed (no deadlocks)
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    expect(successCount).toBe(10);
    
    // All state files should exist and be valid
    for (const request of requests) {
      const statePath = buildStatePath(request.requestId, request.targetRepo);
      expect(fs.existsSync(statePath)).toBe(true);
      
      const stateData = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      expect(validateStateSchema(stateData)).toBe(true);
    }
  });
});
```

**Chaos Test 2: Filesystem Edge Cases**
```typescript
describe('Filesystem Chaos Tests', () => {
  test('permission denied during rename', async () => {
    const request = createTestRequest();
    const targetDir = path.dirname(buildStatePath(request.requestId, request.targetRepo));
    
    // Create target directory but make it read-only
    await fs.mkdir(targetDir, { recursive: true });
    await fs.chmod(targetDir, 0o444); // Read-only
    
    try {
      await expect(submitRequest(request)).rejects.toThrow('Permission denied');
      
      // SQLite should be rolled back
      expect(await db.getRequest(request.requestId)).toBeNull();
      
    } finally {
      // Cleanup
      await fs.chmod(targetDir, 0o755);
      await fs.rm(targetDir, { recursive: true, force: true });
    }
  });
  
  test('target directory becomes symlink (path traversal attempt)', async () => {
    const request = createTestRequest();
    const targetDir = path.join(request.targetRepo, '.autonomous-dev', 'requests', request.requestId);
    
    // Create symlink pointing outside repository
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    await fs.symlink('/etc', targetDir);
    
    await expect(submitRequest(request)).rejects.toThrow('Path traversal');
    
    // No state should be written to /etc/state.json
    expect(fs.existsSync('/etc/state.json')).toBe(false);
  });
});
```

### 13.2 Property-Based Testing

```typescript
import fc from 'fast-check';

describe('Two-Phase Commit Property Tests', () => {
  test('handoff preserves all request data', () => {
    fc.assert(fc.property(
      requestArbitrary(), // Generated random request data
      async (request) => {
        const result = await submitRequest(request);
        assume(result.success);
        
        // Read back from both SQLite and state.json
        const sqliteRequest = await db.getRequest(result.requestId);
        const statePath = buildStatePath(result.requestId, request.targetRepo);
        const stateData = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        
        // All fields should match
        expect(sqliteRequest.title).toBe(request.title);
        expect(sqliteRequest.source).toBe(request.source);
        expect(stateData.title).toBe(request.title);
        expect(stateData.source).toBe(request.source);
        
        // Metadata should be consistent
        expect(JSON.parse(sqliteRequest.adapter_metadata)).toEqual(stateData.adapter_metadata);
      }
    ), { numRuns: 1000 });
  });
  
  test('state transitions maintain invariants', () => {
    fc.assert(fc.property(
      existingRequestArbitrary(),
      fc.constantFrom('pause', 'resume', 'cancel', 'priority'),
      fc.record({}), // Transition-specific parameters
      async (request, operation, params) => {
        const initialSqlite = await db.getRequest(request.request_id);
        const initialPath = buildStatePath(request.request_id, request.target_repo);
        const initialState = JSON.parse(fs.readFileSync(initialPath, 'utf-8'));
        
        try {
          await performStateTransition(request.request_id, operation, params);
          
          // Both SQLite and state.json should be updated consistently
          const finalSqlite = await db.getRequest(request.request_id);
          const finalState = JSON.parse(fs.readFileSync(initialPath, 'utf-8'));
          
          expect(finalSqlite.status).toBe(finalState.status);
          expect(finalSqlite.updated_at).toBe(finalState.updated_at);
          
        } catch (error) {
          // On failure, state should be unchanged  
          const unchangedSqlite = await db.getRequest(request.request_id);
          const unchangedState = JSON.parse(fs.readFileSync(initialPath, 'utf-8'));
          
          expect(unchangedSqlite.status).toBe(initialSqlite.status);
          expect(unchangedState.status).toBe(initialState.status);
        }
      }
    ), { numRuns: 500 });
  });
});

function requestArbitrary() {
  return fc.record({
    title: fc.string({ minLength: 1, maxLength: 200 }),
    description: fc.string({ maxLength: 10000 }),
    source: fc.constantFrom('cli', 'claude-app', 'discord', 'slack'),
    priority: fc.integer({ min: 0, max: 9 }),
    targetRepo: fc.constant('/tmp/test-repo'), // Fixed for test isolation
    adapterMetadata: fc.record({
      cli_pid: fc.option(fc.integer({ min: 1 })),
      discord_guild_id: fc.option(fc.string({ minLength: 10 })),
    })
  });
}
```

### 13.3 Schema Version Compatibility Tests

```typescript
describe('Schema Version Compatibility', () => {
  test('v1 state files work with v1.4 SQLite', async () => {
    // Load legacy state file fixture
    const legacyState = JSON.parse(
      fs.readFileSync('tests/fixtures/state_v1_intake.json', 'utf-8')
    );
    
    // Import into v1.4 database (has source columns)
    const requestEntity = buildSQLiteFromLegacyState(legacyState);
    await db.insertRequest(requestEntity);
    
    // Should get default values for new columns
    const stored = await db.getRequest(legacyState.id);
    expect(stored.source).toBe('cli'); // Default value
    expect(stored.adapter_metadata).toBe('{}'); // Default value
  });
  
  test('v1.4 state files rejected by v1.3 schema validator', async () => {
    const modernState: StateFile = {
      ...createBaseStateFile(),
      source: 'discord',
      adapter_metadata: { discord_guild_id: '123456789' }
    };
    
    // Validate against legacy schema (without source fields)
    const legacyValidator = new StateValidator('v1.3');
    const result = legacyValidator.validate(modernState);
    
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('Unexpected property: source')
    );
  });
  
  test('migration preserves existing data', async () => {
    // Setup v1.3 database with existing requests
    await setupLegacyDatabase('v1.3');
    const legacyRequests = await db.getAllRequests();
    
    // Run migration
    const migrator = new MigrationRunner(db);
    await migrator.migrateToVersion('1.4');
    
    // Verify all data preserved with new defaults
    const migratedRequests = await db.getAllRequests();
    expect(migratedRequests).toHaveLength(legacyRequests.length);
    
    for (const request of migratedRequests) {
      expect(request.source).toBe('cli'); // Backfilled default
      expect(request.adapter_metadata).toBe('{}'); // Default JSON
    }
  });
});
```

### 13.4 Performance Benchmarks

```typescript
describe('Performance Benchmarks', () => {
  test('handoff latency under load', async () => {
    const requestCount = 100;
    const concurrency = 10;
    const requests = Array.from({ length: requestCount }, () => createTestRequest());
    
    const startTime = Date.now();
    
    // Submit requests with limited concurrency
    await pLimit(concurrency)(
      requests.map(request => () => submitRequest(request))
    );
    
    const totalTime = Date.now() - startTime;
    const avgLatency = totalTime / requestCount;
    
    // Performance targets from PRD-008 NFRs
    expect(avgLatency).toBeLessThan(3000); // p95 < 3s
    
    console.log(`Average handoff latency: ${avgLatency}ms for ${requestCount} requests`);
  });
  
  test('reconciliation performance with large request count', async () => {
    // Setup 1000 requests across 10 repositories
    await setupLargeTestDatabase(1000, 10);
    
    const reconciler = new ReconciliationEngine(db, config);
    const startTime = Date.now();
    
    const report = await reconciler.reconcile({ dryRun: true });
    
    const reconcileTime = Date.now() - startTime;
    const avgPerRequest = reconcileTime / report.total_requests_checked;
    
    // Should handle 1000 requests in reasonable time
    expect(reconcileTime).toBeLessThan(30_000); // < 30s total
    expect(avgPerRequest).toBeLessThan(30); // < 30ms per request
    
    console.log(`Reconciled ${report.total_requests_checked} requests in ${reconcileTime}ms`);
  });
  
  test('state file write throughput', async () => {
    const stateData = createLargeStateFile(); // ~10KB JSON
    const iterations = 1000;
    
    const startTime = Date.now();
    
    for (let i = 0; i < iterations; i++) {
      const tempPath = `/tmp/state.${i}.tmp`;
      const targetPath = `/tmp/state.${i}.json`;
      
      await writeTemporaryFile(tempPath, stateData);
      await fsyncFile(tempPath);
      await renameFile(tempPath, targetPath);
    }
    
    const totalTime = Date.now() - startTime;
    const throughput = iterations / (totalTime / 1000); // Files per second
    
    // Should achieve reasonable filesystem throughput
    expect(throughput).toBeGreaterThan(50); // > 50 files/sec
    
    console.log(`State file write throughput: ${throughput.toFixed(1)} files/sec`);
  });
});
```

## 14. Performance Considerations

### 14.1 Write Latency Budget

**Target Latencies (from PRD-008 NFRs):**

| Operation | p50 Target | p95 Target | Critical Path |
|-----------|------------|------------|---------------|
| CLI submit acknowledgment | < 1s | < 3s | Temp file write + SQLite INSERT |
| Claude App submit | < 2s | < 5s | TypeScript subprocess + handoff |
| Discord interaction response | < 1s | < 3s | Network RTT + handoff |
| State.json write after SQLite | < 100ms | < 500ms | fsync() + rename() only |

**Latency Breakdown Analysis:**

```
Submit Request Total Latency:
├── Input validation: ~5ms
├── Duplicate detection: ~50ms (if enabled)  
├── Request ID generation: ~1ms
├── Two-phase commit: ~150ms
│   ├── Build state data: ~10ms
│   ├── Schema validation: ~5ms
│   ├── Temp file write: ~30ms
│   ├── fsync(): ~50ms (varies by storage)
│   ├── SQLite transaction: ~40ms
│   └── Atomic rename: ~10ms
├── Queue position calculation: ~20ms
└── Response formatting: ~5ms
────────────────────────────────
Total: ~230ms (within p50 < 1s target)
```

**Performance Optimization Strategies:**

1. **Schema Validation Caching**
   ```typescript
   const schemaValidator = new Ajv({ strict: false });
   const validateState = schemaValidator.compile(stateSchemaV1);
   
   // Reuse compiled validator across requests
   function validateStateData(data: unknown): boolean {
     return validateState(data);
   }
   ```

2. **SQLite Prepared Statement Pool**
   ```typescript
   class Repository {
     private insertStmt = this.db.prepare(`
       INSERT INTO requests (request_id, title, description, ...)
       VALUES (?, ?, ?, ...)
     `);
     
     insertRequest(request: RequestEntity): void {
       // Reuse prepared statement - faster than recompiling
       this.insertStmt.run(...Object.values(request));
     }
   }
   ```

3. **Batch fsync() for High Throughput**
   ```typescript
   // For testing/development scenarios with high submission rates
   class BatchedWriter {
     private pendingWrites: Array<{ tempPath: string; targetPath: string }> = [];
     
     async queueWrite(tempPath: string, targetPath: string): Promise<void> {
       this.pendingWrites.push({ tempPath, targetPath });
       
       if (this.pendingWrites.length >= 10) {
         await this.flushBatch();
       }
     }
     
     private async flushBatch(): Promise<void> {
       // fsync all temp files in batch
       await Promise.all(this.pendingWrites.map(w => fsyncFile(w.tempPath)));
       
       // Rename all files atomically
       await Promise.all(this.pendingWrites.map(w => 
         renameFile(w.tempPath, w.targetPath)
       ));
       
       this.pendingWrites = [];
     }
   }
   ```

### 14.2 Throughput Capacity

**Single-Process Throughput:**
- Target: 50+ requests/hour sustained 
- Bottleneck: SQLite single-writer lock + filesystem sync
- Theoretical max: ~200 requests/hour (18s avg including duplicate detection)

**Multi-Repository Scaling:**
- SQLite database per repository would eliminate cross-repo contention
- Trade-off: Complexity vs. throughput (defer until needed)
- Alternative: Connection pooling with WAL mode

**Disk Space Requirements:**

| Component | Size per Request | 1000 Requests | Notes |
|-----------|------------------|---------------|--------|
| state.json | ~2KB | ~2MB | JSON serialization |
| SQLite row | ~500B | ~500KB | Compressed by SQLite |
| Event log (avg) | ~50KB | ~50MB | Grows throughout lifecycle |
| Temp files (peak) | ~2KB | ~2MB | Cleaned up immediately |
| **Total** | ~52.5KB | ~52.5MB | Excluding source code artifacts |

**Archive Storage Growth:**
- Completed requests archived after 30 days (configurable)
- Compressed archive: ~70% size reduction
- Annual storage (100 req/week): ~200MB compressed

### 14.3 Monitoring & Alerting

```typescript
interface HandoffMetrics {
  // Latency metrics
  submit_latency_p50_ms: number;
  submit_latency_p95_ms: number;
  submit_latency_p99_ms: number;
  
  // Throughput metrics  
  requests_submitted_per_hour: number;
  two_phase_commits_per_second: number;
  
  // Error metrics
  handoff_failure_rate: number;
  sqlite_transaction_failures_per_hour: number;
  filesystem_errors_per_hour: number;
  
  // Resource metrics
  sqlite_db_size_mb: number;
  temp_files_orphaned: number;
  disk_space_used_mb: number;
  
  // Consistency metrics
  reconciliation_inconsistencies_found: number;
  auto_repairs_successful: number;
  manual_repairs_needed: number;
}

class MetricsCollector {
  private latencyHistogram = new Map<string, number[]>();
  
  recordHandoffLatency(operation: string, latencyMs: number): void {
    if (!this.latencyHistogram.has(operation)) {
      this.latencyHistogram.set(operation, []);
    }
    
    const samples = this.latencyHistogram.get(operation)!;
    samples.push(latencyMs);
    
    // Keep only last 1000 samples for memory efficiency
    if (samples.length > 1000) {
      samples.splice(0, samples.length - 1000);
    }
  }
  
  getPercentile(operation: string, percentile: number): number {
    const samples = this.latencyHistogram.get(operation) ?? [];
    if (samples.length === 0) return 0;
    
    const sorted = [...samples].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }
}

// Alert thresholds
const ALERT_THRESHOLDS = {
  submit_latency_p95_ms: 5000,     // Alert if p95 > 5s
  handoff_failure_rate: 0.01,      // Alert if >1% of handoffs fail
  reconciliation_inconsistencies: 10, // Alert if >10 inconsistencies found
  disk_space_used_mb: 1000,        // Alert if >1GB disk usage
};
```

## 15. Migration & Rollout

### 15.1 Rollout Phases

**Phase 1: Foundation (Week 1)**
- Implement two-phase commit protocol
- Add SQLite schema migration (v1.3 → v1.4)
- Basic path resolution and security
- Unit tests for commit protocol
- Integration tests for happy path

**Phase 2: Source Tracking (Week 2)**  
- Implement `RequestSource` and `AdapterMetadata` interfaces
- Update all channel adapters to populate source metadata
- State transition handlers (pause/resume/cancel/priority)
- Schema validation with source fields
- Backward compatibility testing

**Phase 3: Reconciliation (Week 3)**
- Build reconciliation engine and CLI subcommand
- Implement drift detection and repair algorithms
- Add operational monitoring and alerting
- Performance testing and optimization
- Chaos testing scenarios

**Phase 4: Production Readiness (Week 4)**
- Cross-platform testing (macOS, Linux, WSL)
- Security audit for path traversal protection
- Documentation and runbook updates
- Gradual rollout with feature flag
- Performance benchmarking under load

### 15.2 Feature Flag Strategy

```typescript
interface HandoffConfig {
  enabled: boolean;
  use_two_phase_commit: boolean;
  enable_source_tracking: boolean;
  enable_reconciliation: boolean;
  fallback_to_sqlite_only: boolean;
}

class FeatureFlags {
  constructor(private config: HandoffConfig) {}
  
  async submitRequest(request: RequestSubmission): Promise<SubmitResult> {
    if (!this.config.enabled) {
      // Legacy SQLite-only path
      return await this.legacySubmit(request);
    }
    
    try {
      if (this.config.use_two_phase_commit) {
        return await this.twoPhaseCommitSubmit(request);
      } else {
        return await this.dualWriteSubmit(request); // Less safe fallback
      }
    } catch (error) {
      if (this.config.fallback_to_sqlite_only) {
        console.error('Handoff failed, falling back to SQLite-only:', error);
        return await this.legacySubmit(request);
      }
      throw error;
    }
  }
}
```

**Gradual Rollout Plan:**

| Week | Feature Flags | Scope | Success Criteria |
|------|---------------|--------|------------------|
| 1 | `enabled: false` | Development only | All tests pass |
| 2 | `enabled: true, fallback_to_sqlite_only: true` | Staging environment | 0 data loss incidents |
| 3 | `enabled: true, fallback_to_sqlite_only: false` | Single production repo | p95 latency < 3s |
| 4 | `enabled: true` | All repositories | Error rate < 0.1% |

### 15.3 Rollback Procedures

**Immediate Rollback Triggers:**
- Data loss detected in any channel
- p95 latency > 10s for > 5 minutes
- Error rate > 5% for > 2 minutes
- Security vulnerability discovered

**Rollback Actions by Severity:**

**L1 - Emergency Rollback (Data Loss)**
```bash
# Disable handoff immediately, revert to SQLite-only
autonomous-dev config set handoff.enabled false
autonomous-dev daemon restart

# Audit for data loss
autonomous-dev request reconcile --output-json /tmp/emergency-audit.json

# Manual recovery if needed
autonomous-dev request reconcile --force-repair
```

**L2 - Performance Rollback (High Latency)**
```bash
# Enable fallback mode
autonomous-dev config set handoff.fallback_to_sqlite_only true

# Monitor for improvement
watch "autonomous-dev metrics | grep submit_latency"

# Full rollback if no improvement in 10 minutes
autonomous-dev config set handoff.enabled false
```

**L3 - Gradual Rollback (Error Rate)**
```bash
# Disable for new requests only
autonomous-dev config set handoff.enabled false

# Existing requests continue with handoff
# Monitor existing state transitions
autonomous-dev logs --filter handoff --tail
```

### 15.4 Migration Validation

```typescript
class MigrationValidator {
  async validateMigration(): Promise<ValidationReport> {
    const report: ValidationReport = {
      total_requests: 0,
      successful_migrations: 0,
      data_integrity_issues: [],
      performance_regressions: []
    };
    
    // Validate data integrity
    const allRequests = await this.db.getAllRequests();
    report.total_requests = allRequests.length;
    
    for (const request of allRequests) {
      const integrity = await this.validateRequestIntegrity(request);
      if (integrity.valid) {
        report.successful_migrations++;
      } else {
        report.data_integrity_issues.push({
          request_id: request.request_id,
          issues: integrity.issues
        });
      }
    }
    
    // Validate performance
    const latencyBenchmark = await this.runLatencyBenchmark();
    if (latencyBenchmark.p95 > MIGRATION_LATENCY_THRESHOLD) {
      report.performance_regressions.push({
        metric: 'submit_latency_p95',
        measured: latencyBenchmark.p95,
        threshold: MIGRATION_LATENCY_THRESHOLD
      });
    }
    
    return report;
  }
  
  private async validateRequestIntegrity(request: RequestEntity): Promise<IntegrityCheck> {
    const issues: string[] = [];
    
    // Check source field is valid
    if (!['cli', 'claude-app', 'discord', 'slack', 'production-intelligence', 'portal'].includes(request.source)) {
      issues.push(`Invalid source: ${request.source}`);
    }
    
    // Check adapter_metadata is valid JSON
    try {
      JSON.parse(request.adapter_metadata);
    } catch {
      issues.push('Invalid adapter_metadata JSON');
    }
    
    // Check state.json exists and matches SQLite
    const statePath = buildStatePath(request.request_id, request.target_repo!);
    if (fs.existsSync(statePath)) {
      const stateData = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      if (stateData.source !== request.source) {
        issues.push(`Source mismatch: SQLite=${request.source}, state.json=${stateData.source}`);
      }
    } else {
      issues.push('Missing state.json file');
    }
    
    return { valid: issues.length === 0, issues };
  }
}
```

## 16. Open Questions

### 16.1 Technical Questions

**OQ-1: Reconciliation Frequency**
- **Question**: Should reconciliation run continuously (daemon) or periodically (cron)?
- **Options**: 
  - Continuous: Lower latency to detect drift, higher resource usage
  - Periodic: Daily/hourly batch, lower resource usage, delayed detection
- **Recommendation**: Start with daily cron, upgrade to continuous if drift becomes common
- **Decision Required By**: Week 2 of implementation

**OQ-2: Cross-Repository SQLite Database Strategy**
- **Question**: Single SQLite database for all repositories vs. database per repository?
- **Trade-offs**: 
  - Single: Simpler, enables cross-repo queries, potential contention bottleneck
  - Per-repo: Better isolation, scaling, higher operational complexity
- **Current**: Single database per intake deployment
- **Future**: Evaluate per-repo if contention becomes an issue

**OQ-3: State.json Schema Evolution Strategy** 
- **Question**: How to handle state.json schema changes while maintaining daemon compatibility?
- **Constraints**: Daemon must remain unchanged (TDD-001 scope), but future features may need new fields
- **Proposal**: Add optional fields as extensions, bump schema version only on breaking changes
- **Example**: `"tdd_012_extensions": { "new_field": "value" }`

### 16.2 Operational Questions

**OQ-4: Reconciliation Repair Authority**
- **Question**: Should reconciliation auto-repair all inconsistencies or require operator approval?
- **Risk**: Auto-repair could mask underlying bugs, manual approval slows recovery
- **Recommendation**: Auto-repair "safe" inconsistencies (missing state.json), manual approval for "risky" ones (metadata mismatches)
- **Safe repairs**: Recreating state.json from SQLite data, importing orphaned state.json
- **Manual repairs**: Schema validation failures, source field mismatches

**OQ-5: Performance Monitoring Granularity**
- **Question**: What level of metrics detail is needed for production operations?
- **Options**:
  - Basic: Success/failure counts, p95 latency
  - Detailed: Per-channel latency, per-operation timing, resource usage
  - Trace: Full request tracing with correlation IDs
- **Recommendation**: Start with detailed, add tracing if needed for debugging

**OQ-6: Disk Space Management Strategy**
- **Question**: How to handle disk space exhaustion during high request volumes?
- **Scenarios**: Temp files fill disk during batch submission, large state files from complex requests
- **Mitigations**: Disk space monitoring, automatic archival of old requests, temp file size limits
- **Alert threshold**: 90% disk usage triggers cleanup, 95% triggers emergency measures

### 16.3 Security Questions

**OQ-7: Repository Allowlist Dynamic Updates**
- **Question**: Should repository allowlist changes require daemon restart?
- **Security**: Hot-reloading could bypass validation if implementation has race conditions
- **Usability**: Restart requirement interrupts active requests
- **Recommendation**: Require restart for MVP security, evaluate hot-reload for future versions

**OQ-8: Adapter Metadata Sanitization**
- **Question**: Should adapter metadata be sanitized before storage?
- **Risk**: Malicious Discord/Slack messages could inject payloads into metadata
- **Examples**: `discord_message_id: "'; DROP TABLE requests; --"`
- **Mitigation**: JSON schema validation limits field types, but doesn't prevent all attacks
- **Recommendation**: Sanitize untrusted adapter metadata (Discord/Slack) but trust local metadata (CLI)

## 17. References

- **[TDD-001: Daemon Engine](/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/tdd/TDD-001-daemon-engine.md)** — `select_request()` implementation and state.json consumption patterns
- **[TDD-002: State Machine & Request Lifecycle](/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/tdd/TDD-002-state-machine.md)** — state.json schema v1 specification and transition rules  
- **[PRD-008: Unified Request Submission Packaging](/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/prd/PRD-008-unified-request-submission.md)** — parent requirements and channel specifications
- **[supervisor-loop.sh lines 640-722](/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/bin/supervisor-loop.sh)** — current daemon request selection implementation
- **[Repository Implementation](/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/intake/db/repository.ts)** — existing SQLite data access layer
- **[Submit Handler](/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/intake/handlers/submit_handler.ts)** — current submission processing pipeline
- **[State Fixture](/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/tests/fixtures/state_v1_intake.json)** — canonical state.json format for daemon compatibility
- **POSIX.1-2008**: rename(2) system call specification for atomic file operations
- **SQLite Documentation**: WAL mode and transaction isolation levels
- **better-sqlite3 Documentation**: prepared statements and transaction API

---

*This TDD establishes the foundation for reliable intake-to-daemon handoff while maintaining the existing daemon's simplicity and the intake layer's rich functionality. The two-phase commit protocol ensures no data loss while enabling comprehensive source tracking and operational visibility across all submission channels.*

---

## 19. Cross-TDD Contract: Handoff API Surface (Pairs with TDD-011)

This TDD owns the canonical schema for the handoff layer; TDD-011 §16 documents how adapters call into it. Both must agree on the exact shapes.

### 19.1 Exported API

The handoff module (`intake/core/handoff_manager.ts`) exports:

```typescript
export async function submitRequestWithHandoff(
  request: SubmitRequest,
  options?: HandoffOptions,
): Promise<HandoffResult>;

export async function transitionRequest(
  requestId: string,
  transition: StateTransition,
  options?: HandoffOptions,
): Promise<HandoffResult>;

export interface SubmitRequest {
  description: string;
  priority: 'high' | 'normal' | 'low';
  targetRepo: string;             // absolute, validated git path
  deadline?: string;              // ISO 8601
  source: RequestSource;          // see §7
  adapterMetadata: AdapterMetadata;
}

export interface HandoffResult {
  success: boolean;
  requestId?: string;             // populated on success
  state?: StateV1Extended;
  error?: HandoffError;
}

export interface HandoffOptions {
  fsync?: boolean;                // default: true
  lockTimeoutMs?: number;         // default: 5000
}
```

### 19.2 SubmitRequest ⇒ State.json Mapping

The handoff manager constructs the v1 state.json record from `SubmitRequest`:

| `SubmitRequest` field | `state.json` field | Notes |
|------------------------|---------------------|-------|
| `description` | `description` | Direct |
| `priority` | `priority` (numeric: high=0, normal=5, low=10) | Mapped |
| `targetRepo` | `repository` | Direct |
| `deadline` | `deadline` | Optional |
| `source` | `source` | New in v1.1 schema |
| `adapterMetadata` | `adapter_metadata` | New in v1.1 schema |

The submit handler (TDD-011 calls this) is responsible for generating the request ID via `generateRequestId()` (atomic SQLite sequence) before invoking `submitRequestWithHandoff()`.

### 19.3 SQLite ⇒ State.json Field Parity

Every successful `transitionRequest()` updates BOTH SQLite columns and state.json fields per the two-phase commit protocol. The mapping is enforced via a single source of truth in `RequestRecord`:

```typescript
export function recordToStateJson(rec: RequestRecord): StateV1Extended { /* ... */ }
export function stateJsonToRecord(s: StateV1Extended): RequestRecord { /* ... */ }
```

Reconciliation tooling (§12) uses these symmetrical converters to detect drift.

---

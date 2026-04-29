# PLAN-012-1: Two-Phase Commit Handoff Implementation

## Metadata
- **Parent TDD**: TDD-012-intake-daemon-handoff
- **Estimated effort**: 4-5 days (architecturally critical)
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0

## Objective
Implement the foundational two-phase commit protocol bridging SQLite-based intake to filesystem-based daemon consumption. Delivers `intake/core/handoff_manager.ts` with atomic dual-write operations ensuring no data loss under crash conditions, plus path security validation and concurrency control.

## Scope
### In Scope
- `intake/core/handoff_manager.ts` exporting canonical API surface per TDD-012 §19 (aligned with TDD-011 §16)
- Two-phase commit per §5: temp file write at `state.json.tmp.<pid>.<random>` → SQLite txn → atomic `fs.rename()` on commit / `fs.unlink()` on rollback
- Request ID validation per §6 (`^REQ-\d{6}$`); path resolution with traversal prevention
- Per-request directory advisory locking via `flock`-style lock file (§10) — concurrent ops on same request blocked
- SQLite WAL mode + `busy_timeout=5000` (§10)
- `fsync()` on temp file before rename for durability (§13.3)
- F1..F4 failure-mode handling per §9 with specific recovery; F4 (rename fails after SQLite commit) marks temp with `.needs_promotion` for reconciliation
- State transitions per §11: `pauseRequest`, `resumeRequest`, `cancelRequest`, `setPriority` — same two-phase pattern
- Error formatting that doesn't leak filesystem paths to untrusted channels

### Out of Scope
- SQLite schema migration for source/adapter_metadata (PLAN-012-2)
- Reconciliation CLI tooling (PLAN-012-3)
- Adapter integration (PLAN-011-* call into this API)

## Tasks

1. **Define core interfaces** -- `SubmitRequest`, `HandoffResult`, `HandoffOptions`, `RequestSource`, `AdapterMetadata` matching TDD-012 §19.
   - Files: `intake/core/handoff_manager.ts` (new)
   - Acceptance: interfaces match §19.1 exactly; RequestSource enum has all 6 channels; AdapterMetadata covers per-adapter shapes.
   - Effort: 1h

2. **Implement path validation & security** -- `validateRequestId()` + `buildRequestPath()` with traversal prevention per §6.
   - Files: `intake/core/handoff_manager.ts`
   - Acceptance: malformed IDs rejected; `realpath()` validation; symlink escapes throw SecurityError; repository allowlist enforced.
   - Effort: 2h

3. **Implement advisory file locking** -- per-request-directory `.lock` files with exclusive flock; auto-release on FD close.
   - Files: `intake/core/handoff_manager.ts`
   - Acceptance: concurrent same-request ops block; different requests don't block; configurable timeout (default 10s); cross-platform tested (macOS/Linux/WSL).
   - Effort: 2.5h

4. **Implement two-phase commit core** -- temp write → SQLite txn → atomic rename.
   - Files: `intake/core/handoff_manager.ts`
   - Acceptance: temp file pattern `state.json.tmp.{pid}.{random}`; `fsync()` before SQLite txn; WAL mode + 5000ms busy_timeout; atomic rename = commit point; uses `O_CREAT|O_EXCL|O_WRONLY` for security.
   - Effort: 3h

5. **Implement rollback & cleanup** -- F1-F3 failures: temp cleaned, no SQLite changes; F4: SQLite rolled back, temp cleaned.
   - Files: `intake/core/handoff_manager.ts`
   - Acceptance: all error paths leave no partial state; error messages sanitize FS paths for untrusted channels; cleanup is idempotent.
   - Effort: 2h

6. **Implement F4 recovery** -- rename failure after SQLite commit → mark temp with `.needs_promotion`; startup recovery completes promotion.
   - Files: `intake/core/handoff_manager.ts`
   - Acceptance: failed rename marks file; startup detects `.needs_promotion` and completes; schema validation before promotion; corrupted temps moved to `corrupt/`; recovery idempotent.
   - Effort: 2h

7. **Implement state transition functions** -- pause/resume/cancel/priority reusing two-phase pattern per §11.
   - Files: `intake/core/handoff_manager.ts`
   - Acceptance: all transitions reuse core; pause stores original in `paused_from`; resume restores; cancel triggers worktree/branch cleanup; priority updates atomically; phase history correct.
   - Effort: 3h

8. **Comprehensive test suite** -- chaos, property, concurrent access tests per §13.
   - Files: `tests/core/test_handoff_manager.test.ts` (new)
   - Acceptance: chaos tests inject failures at each phase; property tests verify invariants; concurrent submission tests; cross-platform (macOS/Linux); permission denied + disk full + corruption scenarios; >90% coverage; <30s runtime.
   - Effort: 4h

## Dependency Graph

```
TASK-001 (Interfaces) → TASK-002 (Path Security) → TASK-003 (Locking)
  → TASK-004 (Two-Phase Core) → TASK-005 (Rollback) → TASK-006 (F4 Recovery)
  → TASK-007 (State Transitions) → TASK-008 (Tests)
```

Sequential due to dependencies. Total ~19.5h.

## Test Scenarios

**Chaos:**
- Kill mid-temp-write → cleanup on restart
- SQLite commit succeeds, rename fails → F4 recovery promotes temp
- Concurrent submissions → no deadlock or corruption
- Disk full during temp write → clean error, no partial state
- Permission denied on rename → SQLite rollback + temp cleanup

**Property:**
- All successful handoffs maintain SQLite ⟷ state.json field parity
- Failed handoffs leave no partial state in either system
- State transitions preserve lifecycle invariants
- Path resolution never escapes repository boundaries

**Integration:**
- Daemon reads state.json during rename window → sees complete state only (POSIX rename atomicity)
- Orphaned temp files from prior crashes detected and handled
- Multiple repos accessed concurrently without interference
- Schema validation catches all malformed state data

## Acceptance Criteria

- [ ] All 8 tasks completed with acceptance met
- [ ] `handoff_manager.ts` exports API matching TDD-012 §19 exactly
- [ ] Two-phase commit handles F1-F4 correctly
- [ ] Path validation prevents traversal attacks
- [ ] File locking enables safe concurrent access
- [ ] State transitions atomic
- [ ] Test suite >90% coverage
- [ ] No data loss under any failure scenario
- [ ] Performance: <3s p95 latency
- [ ] Cross-platform compatibility verified (macOS, Linux)

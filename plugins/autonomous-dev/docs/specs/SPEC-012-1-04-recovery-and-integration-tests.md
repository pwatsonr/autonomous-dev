# SPEC-012-1-04: Recovery — Orphaned Temp Cleanup, Journal Replay, Integration Tests

## Metadata
- **Parent Plan**: PLAN-012-1
- **Tasks Covered**: Task 6 (F4 recovery), Task 8 (Comprehensive test suite)
- **Estimated effort**: 6 hours

## Description
Implement startup recovery for the two-phase commit handoff: detect and resolve every partial-failure mode left behind by prior crashes. This spec covers F4 forward-recovery (`.needs_promotion` files), orphaned-temp cleanup, journal replay against SQLite to reconcile FS-vs-DB drift, and the chaos/property/integration test suite that proves the protocol's correctness end-to-end. Recovery runs at daemon startup BEFORE the read loop begins.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/recovery/recovery_runner.ts` | Create | Orchestrates startup recovery |
| `intake/recovery/temp_cleanup.ts` | Create | Orphaned temp + corrupt handling |
| `intake/recovery/promotion.ts` | Create | F4 `.needs_promotion` forward-recovery |
| `intake/recovery/journal_replay.ts` | Create | Reconciles SQLite ⟷ FS state |
| `tests/core/test_handoff_manager.test.ts` | Create | Chaos + property + concurrency |
| `tests/recovery/test_recovery.test.ts` | Create | Recovery scenarios |
| `tests/integration/test_intake_daemon_handoff.test.ts` | Create | End-to-end producer ⟷ consumer |

## Implementation Details

### Recovery Runner (`intake/recovery/recovery_runner.ts`)

```typescript
export interface RecoveryReport {
  promotedCount: number;
  orphanedCleaned: number;
  corruptQuarantined: number;
  journalReplayed: number;
  errors: Array<{ requestId?: string; phase: string; error: string }>;
  durationMs: number;
}

export async function runStartupRecovery(repo: string): Promise<RecoveryReport>;
```

`runStartupRecovery(repo)` runs the following phases IN ORDER. Each phase MUST complete before the next begins:

1. **Promotion phase** (`promotion.ts`): scan all `*.needs_promotion` files; promote each.
2. **Cleanup phase** (`temp_cleanup.ts`): scan all `*.tmp.*` files; classify and act per SPEC-012-1-03 classifier.
3. **Journal replay phase** (`journal_replay.ts`): reconcile SQLite rows against FS state.
4. **Report phase**: aggregate counts, emit `recovery.complete` event with the report.

The runner runs synchronously at daemon startup. The daemon's read loop MUST NOT begin polling until the runner returns. If the runner throws, the daemon SHOULD exit with a non-zero code — the system is in an unknown state and operator intervention is required.

### Promotion (`intake/recovery/promotion.ts`)

```typescript
export async function promoteNeedsPromotion(tempPath: string): Promise<{ ok: true } | { ok: false; reason: string }>;
```

Behavior:
1. Verify path ends in `.needs_promotion`.
2. Compute target path by stripping the `.tmp.<pid>.<random>.needs_promotion` suffix from the filename, replacing with `state.json` in the same directory.
3. Read the temp file contents; validate against the schema (existing `validateState()`).
   - On schema failure: rename to `${tempPath%.needs_promotion}.corrupt`, return `{ ok: false, reason: 'SCHEMA_INVALID' }`.
4. **Idempotency check**: if `state.json` already exists at the target:
   - Compare contents. If identical: just `unlink(tempPath)` and return `ok: true`.
   - If different: prefer the existing state.json (already-committed wins); rename `tempPath` to `*.corrupt` and log a warning.
5. Otherwise: `fs.rename(tempPath, target)` (atomic). Return `ok: true`.

The promotion MUST be safe to call multiple times on the same file. The recovery runner MUST log if the same file is promoted more than once across recovery runs (indicates a bug).

### Temp Cleanup (`intake/recovery/temp_cleanup.ts`)

```typescript
export async function cleanupOrphanedTemps(repo: string): Promise<{
  cleaned: number;
  quarantined: number;
}>;
```

Behavior:
1. Glob `${repo}/.autonomous-dev/requests/*/state.json.tmp.*` (excluding `.needs_promotion` and `.corrupt` — those are handled separately).
2. For each match, classify via `classifyTempFile` from SPEC-012-1-03:
   - `IN_FLIGHT` — leave alone. (At startup, this should be impossible — there are no live producers from a prior process. But we check anyway.)
   - `ORPHANED` — `unlink` it. Increment `cleaned`.
   - `NEEDS_PROMOTION` — already handled in Phase 1; skip.
   - `CORRUPT` — already quarantined; skip.
3. Verify the temp file's content can be read; if read fails (`EIO`, etc.), rename to `*.corrupt` instead of unlinking. Increment `quarantined`.
4. Return counts.

### Journal Replay (`intake/recovery/journal_replay.ts`)

```typescript
export async function replayJournal(repo: string): Promise<{ replayed: number; mismatches: Array<{ requestId: string; type: string }> }>;
```

This phase reconciles SQLite ⟷ filesystem to detect drift left by F3/F4 partial failures that recovery missed.

For each row in `requests` table:
1. Compute `requestPath = buildRequestPath(repo, requestId)`.
2. Check if `state.json` exists.
3. **Reconciliation rules**:

| SQLite row | state.json | Action |
|-----------|------------|--------|
| Present | Present | Compare `priority`, `status`. If mismatched → log `STATE_DRIFT` mismatch, prefer state.json (it's the more recent commit point). Update SQLite row. |
| Present | Missing | Possible F4 lost forever (rename failed, temp lost). Mark SQLite row `status = 'orphaned_lost'`. Page operator. |
| Missing | Present | Possible F3 partial (temp committed to FS but SQLite rolled back). Read state.json; if valid, INSERT a new SQLite row from it. Log `RECOVERY_INSERT`. |
| Missing | Missing | Nothing to do. |

The `STATE_DRIFT` and `orphaned_lost` cases are operator-pageable. `RECOVERY_INSERT` is best-effort — it's how we recover from a cosmic-ray F3 where the SQLite commit was lost but the FS write made it.

`replayed` count = total rows touched. `mismatches` = list of drift cases.

### Test Suite

#### Chaos Tests (`tests/core/test_handoff_manager.test.ts`)

Each test injects a failure at a specific protocol step and asserts the post-condition.

| Test | Failure Injection | Expected Outcome |
|------|-------------------|------------------|
| `chaos_kill_during_temp_write` | `process.kill` after `O_EXCL` open but before write | No state.json, orphan temp cleaned by recovery |
| `chaos_kill_after_fsync_before_sqlite` | Kill after `fsync` returns | Orphan temp from dead PID; recovery cleans |
| `chaos_kill_during_sqlite_commit` | Kill mid-commit (in test, mock commit to call `process.exit`) | SQLite WAL recovers; either commit applied or not — recovery reconciles |
| `chaos_sqlite_commit_succeeds_rename_fails` | Mock `fs.rename` to throw `EACCES` after SQLite commit | Temp marked `.needs_promotion`; recovery promotes |
| `chaos_disk_full_during_temp_write` | Mock `fs.write` to throw `ENOSPC` | F2; no SQLite changes; no orphan after rollback |
| `chaos_permission_denied_on_rename` | `chmod 000` the request dir | F4 path; recovery handles |
| `chaos_concurrent_submit_same_id` | 10 simultaneous submits with same `requestId` | Exactly one wins; others fail F1 (after first commits) or F1 lock-timeout |

#### Property Tests

Use `fast-check` to generate inputs.

```typescript
test.prop([requestSourceArb, descriptionArb])('parity invariant', async (source, desc) => {
  const result = await submitFromRouter({ ... });
  if (result.ok) {
    const state = JSON.parse(await fs.readFile(`${result.statePath}`, 'utf8'));
    const row = db.prepare('SELECT * FROM requests WHERE request_id = ?').get(result.requestId);
    expect(state.priority).toEqual(row.priority);
    expect(state.repository).toEqual(row.repository);
    expect(state.created_at).toEqual(row.created_at);
  }
});
```

Properties to verify:
1. **Parity**: every successful handoff has matching `priority`, `repository`, `created_at`, `source` in SQLite and state.json.
2. **No-partial-state**: every failed handoff (any F-mode) leaves NEITHER a SQLite row NOR a state.json (except F4 which leaves `.needs_promotion`).
3. **Lifecycle invariants**: state transitions never leave `paused_from` set when `status !== 'paused'`.
4. **Path-bound**: `realpath(statePath)` is always a descendant of `realpath(repository)`.

Run each property with at least 100 random inputs.

#### Concurrency Tests

```typescript
test('50 concurrent submissions to different requests complete without deadlock', async () => {
  const results = await Promise.all(
    range(50).map(i => submitFromRouter({ requestId: `REQ-${String(i).padStart(6, '0')}`, ... }))
  );
  expect(results.every(r => r.ok)).toBe(true);
});
```

Other concurrency scenarios:
- 10 producers submit; 1 daemon consumes — assert daemon ack count == 10.
- 2 daemons race on the same request — assert exactly 1 wins ack, the other gets `ALREADY_ACKED`.
- Producer pauses while daemon is mid-read — assert daemon's read result is one of (pre-pause state, post-pause state), never partial.

#### Integration Tests (`tests/integration/test_intake_daemon_handoff.test.ts`)

End-to-end flows:
1. **End-to-end submit + consume** — Producer submits via `submitFromRouter`; daemon reads + acks; assert event flows match.
2. **Producer crash + daemon recovery** — Spawn producer as subprocess, kill mid-write, start daemon, run recovery, assert orphan cleaned.
3. **Daemon crash mid-ack** — Process the request, simulate crash before ack-commit; restart daemon; assert at-least-once delivery (request re-processed).
4. **Multi-repo concurrent** — Submit to 3 different repos concurrently; assert no cross-repo interference (locks are per-dir).
5. **Long-running pause/resume cycle** — Submit, pause, daemon attempts to consume, daemon sees paused state, resume, daemon consumes successfully.
6. **Cross-platform** — Run the full suite on macOS and Linux (CI matrix).

### Performance Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| Single submit p95 latency | < 3s | 1000 sequential submits, p95 |
| 50 concurrent submits total time | < 6s | Wall clock, no hot caches |
| Recovery time for 100 orphan temps | < 5s | Pre-create 100, time `runStartupRecovery` |
| Test suite total runtime | < 30s | `npm test -- intake/` wall clock |

## Acceptance Criteria

- [ ] `runStartupRecovery` runs phases in order: promotion → cleanup → replay
- [ ] `runStartupRecovery` returns a report with all four counts populated
- [ ] Daemon startup waits for recovery to complete before polling
- [ ] `promoteNeedsPromotion` is idempotent: second call returns `ok: true` no-op
- [ ] `promoteNeedsPromotion` schema-validates BEFORE renaming; corrupt files quarantined
- [ ] `promoteNeedsPromotion` prefers existing state.json over temp on conflict
- [ ] `cleanupOrphanedTemps` does NOT touch `IN_FLIGHT` temps
- [ ] `cleanupOrphanedTemps` does NOT touch `.needs_promotion` or `.corrupt` files
- [ ] `replayJournal` updates SQLite when state.json has newer values
- [ ] `replayJournal` INSERTs missing SQLite rows from valid state.json (F3 recovery)
- [ ] `replayJournal` marks orphaned SQLite rows when state.json is missing
- [ ] All chaos tests pass with no orphan files after recovery
- [ ] All property tests pass with 100+ iterations
- [ ] Single-submit p95 < 3s (verified by perf harness)
- [ ] Test suite total runtime < 30s on CI
- [ ] Test coverage > 90% for `intake/core/handoff_manager.ts` and `intake/recovery/`
- [ ] All tests pass on both macOS and Linux

## Test Cases

1. **Recovery promotes single needs_promotion** — Pre-create one `.needs_promotion`. Run recovery. Assert state.json exists, temp gone, report.promotedCount === 1.
2. **Recovery handles 100 needs_promotion** — Pre-create 100. Run recovery. Assert all promoted, runtime < 5s.
3. **Recovery quarantines corrupt promotion** — Pre-create `.needs_promotion` with invalid JSON. Run recovery. Assert it's renamed to `.corrupt`, target state.json unchanged, report.corruptQuarantined === 1.
4. **Recovery skips when target exists identical** — Pre-create state.json AND identical `.needs_promotion`. Run recovery. Assert temp deleted, target unchanged, no error.
5. **Recovery quarantines on conflict** — Pre-create state.json AND DIFFERENT `.needs_promotion`. Run recovery. Assert temp renamed to `.corrupt`, target unchanged.
6. **Recovery cleans orphaned temp from dead PID** — Pre-create temp with PID 999999. Run recovery. Assert temp gone, count === 1.
7. **Recovery skips IN_FLIGHT** — In a separate test process, hold a temp open with current PID, mtime now. Run recovery. Assert temp still present.
8. **Journal replay inserts F3-survived state** — Manually create state.json without SQLite row. Run recovery. Assert SQLite row inserted with matching fields.
9. **Journal replay marks orphaned-lost** — Manually create SQLite row without state.json. Run recovery. Assert row updated `status='orphaned_lost'`.
10. **Journal replay detects drift** — SQLite priority='low', state.json priority='high'. Run recovery. Assert SQLite updated to 'high', mismatch logged.
11. **Chaos: kill during temp write** — Spawn producer subprocess, kill mid-write via signal, run recovery, assert no orphan, no SQLite row.
12. **Chaos: rename fails after SQLite commit** — Mock to throw EACCES on rename, attempt submit, assert F4 result with `.needs_promotion` file present.
13. **Property: parity** — 100 random submissions; assert SQLite ⟷ state.json field parity.
14. **Property: no partial state on failure** — Inject random failures; assert no scenario leaves a SQLite row without state.json (except F4).
15. **Concurrency: 50 distinct submits** — Run via `Promise.all`; assert all succeed within 6s.
16. **Concurrency: 2 daemons race** — Two daemon instances try to ack same request; assert exactly one wins.
17. **Integration: e2e producer ⟷ consumer** — Submit via router; daemon polls, reads, acks; assert event sequence.
18. **Integration: multi-repo isolation** — Submit to 3 repos concurrently; assert no interference, all complete.
19. **Cross-platform: full suite on macOS** — CI step.
20. **Cross-platform: full suite on Linux** — CI step.

## Dependencies

- SPEC-012-1-01 — Two-phase commit core, types, path validation
- SPEC-012-1-02 — Producer-side state construction, transitions
- SPEC-012-1-03 — `classifyTempFile`, `readState`, `acknowledgeRequest`
- `fast-check` for property-based testing
- Existing test harness (`vitest` or whatever the codebase uses)

## Notes

- Recovery runs at daemon startup, BEFORE the read loop. This is non-negotiable — consuming requests while orphan cleanup runs creates race conditions.
- The order of recovery phases (promotion → cleanup → replay) matters: promotion creates state.json files that replay then reconciles to SQLite. Reversing the order would cause replay to incorrectly mark `orphaned_lost` rows that promotion would later resolve.
- `STATE_DRIFT` from journal replay is rare in practice — it indicates either a bug or a multi-daemon write conflict (which the per-request lock should prevent). Operators paged on this should investigate root cause, not just clear the alert.
- F3 forward-recovery (state.json without SQLite row → INSERT into SQLite) is best-effort. The SQLite row reconstructed from state.json may have a stale `created_at`. We accept this; the alternative is to discard the request, which is worse (data loss).
- Performance targets are validated via a separate perf harness, not the regular test run. Add a `npm run perf:handoff` script.
- Test coverage > 90% means line coverage. Branch coverage is not separately enforced but expected to track closely.
- Cross-platform CI: GitHub Actions matrix `os: [macos-latest, ubuntu-latest]`. Windows is explicitly out of scope (advisory locking semantics differ).

# PLAN-002-1: Data Models & State File Manager

## Metadata
- **Parent TDD**: TDD-002-state-machine
- **Estimated effort**: 3 days
- **Dependencies**: None
- **Blocked by**: None
- **Priority**: P0

## Objective
Deliver the foundational data layer for the state machine subsystem: the state file JSON schema (v1), the event log JSONL schema, and the State File Manager with atomic writes, schema validation, and checkpointing. Every other plan in TDD-002 depends on this one. Without a reliable, crash-safe state file primitive, nothing else can be built.

## Scope
### In Scope
- State file JSON schema definition (v1) per TDD Section 4.1
- Event log JSONL schema definition per TDD Section 4.2
- `state_write_atomic()` function implementing the write-tmp-fsync-mv protocol (TDD Section 3.1.2)
- `state_read()` function with JSON parse and schema validation (TDD Section 3.1.3)
- Schema validation logic: required fields, type checks, enum constraints, temporal consistency, version check
- Orphaned `.tmp` file detection and recovery on startup (TDD Section 3.1.2)
- Checkpoint creation: copy `state.json` to `checkpoint/state.json.{timestamp}` before phase execution (TDD Section 3.1.4)
- Checkpoint pruning: retain only the 5 most recent checkpoints per request
- File permission enforcement: directories at `0700`, files at `0600` (TDD Section 9.2)
- Unit tests for all State File Manager functions

### Out of Scope
- Event Logger append/read functions (PLAN-002-2)
- Request ID generation and discovery (PLAN-002-2)
- Transition logic and lifecycle rules (PLAN-002-3)
- Crash recovery beyond orphaned `.tmp` handling (PLAN-002-4)
- Schema migration framework (PLAN-002-4)
- Cleanup and archival (PLAN-002-4)

## Tasks

1. **Define state file JSON schema** -- Create the v1 schema file matching TDD Section 4.1, including `PhaseHistoryEntry` sub-schema.
   - Files to create: `lib/state/schema/state_v1.json`
   - Acceptance criteria: Schema validates the example state file from TDD Section 4.3 without errors using `jq` and a validation function.
   - Estimated effort: 3 hours

2. **Define event log JSONL schema** -- Create the event schema file matching TDD Section 4.2, including all `event_type` enum values and metadata sub-schemas.
   - Files to create: `lib/state/schema/event_v1.json`
   - Acceptance criteria: Schema validates all example event log entries from TDD Section 4.4.
   - Estimated effort: 2 hours

3. **Implement `state_write_atomic()`** -- The write-tmp-fsync-mv function per TDD Section 3.1.2. Writes JSON to `.tmp`, fsyncs via `python3` with `sync` fallback, then `mv -f` to target.
   - Files to create: `lib/state/state_file_manager.sh`
   - Acceptance criteria: (a) After successful write, `state.json` contains valid JSON matching input. (b) If process is killed during write, `state.json` retains its previous content. (c) `.tmp` file does not persist after successful write.
   - Estimated effort: 3 hours

4. **Implement `state_read()` with schema validation** -- Read `state.json`, parse JSON, validate against schema. On validation failure, return error with specific validation messages.
   - Files to modify: `lib/state/state_file_manager.sh`
   - Acceptance criteria: (a) Returns parsed JSON on valid state file. (b) Returns non-zero exit code with descriptive error on: missing required fields, wrong types, invalid enum values, `updated_at < created_at`, unrecognized `schema_version`. (c) Handles missing file gracefully (returns specific "not found" error).
   - Estimated effort: 4 hours

5. **Implement orphaned `.tmp` recovery** -- On startup scan, detect and handle orphaned `.tmp` files per TDD Section 3.1.2: delete if `state.json` exists alongside; promote if `state.json` is absent and `.tmp` passes validation; move to `corrupt/` subdirectory otherwise.
   - Files to modify: `lib/state/state_file_manager.sh`
   - Acceptance criteria: (a) `.tmp` alongside valid `state.json` is deleted. (b) `.tmp` alone that passes validation is promoted to `state.json`. (c) `.tmp` alone that fails validation is moved to `corrupt/` and request is flagged for failure.
   - Estimated effort: 2 hours

6. **Implement checkpointing** -- `state_checkpoint()` copies current `state.json` to `checkpoint/state.json.{ISO-8601-timestamp}`. `state_restore_checkpoint()` copies a checkpoint back to `state.json` via atomic write. Pruning keeps only the 5 most recent checkpoints.
   - Files to modify: `lib/state/state_file_manager.sh`
   - Acceptance criteria: (a) Checkpoint file is created with correct name format. (b) After 6 checkpoints, only 5 remain (oldest deleted). (c) Restore reads checkpoint and writes it atomically as the new `state.json`. (d) Checkpoint directory is created if it does not exist.
   - Estimated effort: 3 hours

7. **Implement file permission enforcement** -- Set directory permissions to `0700` and file permissions to `0600` on creation. Verify permissions on read and log warning if too open.
   - Files to modify: `lib/state/state_file_manager.sh`
   - Acceptance criteria: (a) Newly created directories have `0700`. (b) Newly created files have `0600`. (c) Warning logged if permissions are more permissive than expected on read.
   - Estimated effort: 1 hour

8. **Unit tests for State File Manager** -- Cover atomic writes, schema validation (valid and invalid), orphaned `.tmp` recovery, checkpointing, and permission enforcement.
   - Files to create: `tests/unit/test_state_file_manager.sh`
   - Acceptance criteria: All tests pass. Minimum 25 test cases covering: 10 schema validation cases (missing fields, wrong types, bad enums, version mismatch, temporal inconsistency), 5 atomic write cases (success, concurrent read, orphaned tmp scenarios), 5 checkpoint cases (create, prune, restore), 5 permission and edge cases.
   - Estimated effort: 6 hours

## Dependencies & Integration Points
- This plan has no upstream dependencies. It is the foundation.
- PLAN-002-2 (Event Logger & Request Tracker) depends on the schema definitions and the `state_write_atomic()` / `state_read()` primitives from this plan.
- PLAN-002-3 (Lifecycle Engine) depends on all State File Manager functions to read, write, validate, and checkpoint state.
- PLAN-002-4 (Recovery, Cleanup & Migration) depends on the checkpoint mechanism and schema validation infrastructure.

## Testing Strategy
- Unit tests validate each function in isolation using fixture JSON data.
- Atomic write tests use a controlled environment: write, verify content, simulate interruption (kill during write), verify previous content survives.
- Schema validation tests use the example state file from TDD Section 4.3 as the golden "valid" fixture, plus intentionally broken variants for negative cases.
- Checkpoint tests create multiple checkpoints and verify pruning and restore behavior.
- All tests run with `bash` and `jq` only -- no external test framework required.

## Risks
1. **`fsync` portability.** The `python3 -c os.fsync()` approach may not be available on minimal systems. Mitigation: fallback to `sync` command, which is universally available but fsyncs all filesystems (coarser granularity). This is acceptable for correctness; only performance differs.
2. **`jq` version differences.** Schema validation relies on `jq` capabilities that may vary across versions. Mitigation: target `jq` 1.6+ and document the minimum version requirement.
3. **JSON schema validation in bash is verbose.** Unlike languages with native JSON Schema libraries, bash validation requires manual field-by-field checks via `jq`. Mitigation: keep the validation function well-structured with one check per required field/constraint; accept the verbosity as the cost of zero external dependencies.

## Definition of Done
- [ ] `state_v1.json` schema file exists and documents all fields from TDD Section 4.1
- [ ] `event_v1.json` schema file exists and documents all fields from TDD Section 4.2
- [ ] `state_write_atomic()` passes all tests including simulated crash scenarios
- [ ] `state_read()` validates against schema and rejects all invalid fixtures
- [ ] Orphaned `.tmp` recovery handles all three scenarios (delete, promote, corrupt)
- [ ] `state_checkpoint()` creates checkpoints and prunes beyond 5
- [ ] `state_restore_checkpoint()` restores via atomic write
- [ ] File permissions set correctly on creation and verified on read
- [ ] 25+ unit tests pass
- [ ] All functions are pure bash with only `jq` as an external dependency (plus optional `python3` for fsync)
- [ ] Code reviewed and merged

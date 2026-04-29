# PLAN-018-1: RequestType Enum + state.json v1.1 Schema + Migration

## Metadata
- **Parent TDD**: TDD-018-request-types-pipeline-variants
- **Estimated effort**: 3 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0

## Objective
Deliver the foundational data structures for request typing: the `RequestType` enum, the `PhaseOverrideConfig` interface and `PHASE_OVERRIDE_MATRIX` constant, the state.json v1.1 schema extension with optional `request_type` and `bug_context` fields, and a migration path for existing v1.0 state files. This plan produces the type definitions and persistence layer; PLAN-018-2 wires these into daemon selection logic and PLAN-018-3 adds the bug-intake schema and CLI surface.

## Scope
### In Scope
- `RequestType` enum at `plugins/autonomous-dev/src/types/request-type.ts` with five members per TDD §5.1: `FEATURE`, `BUG`, `INFRA`, `REFACTOR`, `HOTFIX`
- `isValidRequestType()` type guard and `DEFAULT_REQUEST_TYPE = RequestType.FEATURE` constant
- `PhaseOverrideConfig` interface and `PHASE_OVERRIDE_MATRIX` constant per TDD §5.2 with the documented per-type configurations (skipped/enhanced phases, expedited reviews flag, additional gates, max retries, phase timeouts)
- `getPhaseSequence(type)`, `isEnhancedPhase(type, phase)`, `getAdditionalGates(type)` helper functions
- `RequestStateV1_1` TypeScript interface extending `RequestStateV1_0` with optional `request_type`, optional `bug_context`, computed `phase_overrides[]`, and `type_config: PhaseOverrideConfig`
- `migrateStateV1_0ToV1_1(state)` migration function defaulting to `feature` type per TDD §7.1
- `isLegacyState(state)` predicate for detecting v1.0 state files
- `migrate_state_files.sh` operator script per TDD §7.3 that walks `~/.autonomous-dev` for `state.json` files, backs up v1.0 to `.v1.0.backup`, and rewrites them as v1.1
- JSON schema file `plugins/autonomous-dev/schemas/state-v1.1.json` for runtime validation
- Unit tests covering: enum validation, phase sequence computation per type, migration correctness, `isLegacyState` truth table
- Integration test: load a real v1.0 state file, migrate, verify the result validates against the v1.1 JSON schema

### Out of Scope
- Daemon `select_request()` changes that consume the type/phase data -- PLAN-018-2
- Bug intake schema and `BugReport` interface -- PLAN-018-3
- TDD-author agent prompt extensions -- PLAN-018-3
- CLI `--type` parameter wiring into the dispatcher -- PLAN-018-3
- Hook system integration -- TDD-019 / PLAN-019-*
- Type conversion after submission (NG-04 in TDD-018)
- Multi-tenant or organization-wide type policies (NG-03)

## Tasks

1. **Author `RequestType` enum and helpers** -- Create `src/types/request-type.ts` with the enum, type guard, default constant, and JSDoc per TDD §5.1.
   - Files to create: `plugins/autonomous-dev/src/types/request-type.ts`
   - Acceptance criteria: Enum has exactly five members. `isValidRequestType('feature')` returns true; `isValidRequestType('xyz')` returns false. `DEFAULT_REQUEST_TYPE` is `RequestType.FEATURE`. TypeScript compilation passes with `--strict`.
   - Estimated effort: 1.5h

2. **Author `PhaseOverrideMatrix`** -- Create `src/types/phase-override.ts` with the `PhaseOverrideConfig` interface, the `PHASE_OVERRIDE_MATRIX` constant matching TDD §5.2 verbatim, and the three helper functions (`getPhaseSequence`, `isEnhancedPhase`, `getAdditionalGates`).
   - Files to create: `plugins/autonomous-dev/src/types/phase-override.ts`
   - Acceptance criteria: All five request types have entries in the matrix. `getPhaseSequence(BUG)` returns the 12-phase sequence excluding `prd` and `prd_review`. `getPhaseSequence(HOTFIX)` excludes `prd`, `prd_review`, `plan_review`. `isEnhancedPhase(INFRA, 'tdd')` returns true. `getAdditionalGates(INFRA)` returns `['security_review', 'cost_analysis', 'rollback_plan']`.
   - Estimated effort: 2h

3. **Extend `RequestState` interface to v1.1** -- Update `src/types/request-state.ts` (or create if absent) to define `RequestStateV1_0`, `RequestStateV1_1`, the union type alias, and the v1.1 extension fields per TDD §7.1.
   - Files to modify or create: `plugins/autonomous-dev/src/types/request-state.ts`
   - Acceptance criteria: TypeScript compilation passes. The discriminated union on `schema_version` correctly narrows in switch statements. `RequestStateV1_1` has all required fields plus the optional `request_type` and `bug_context`.
   - Estimated effort: 2h

4. **Implement migration function** -- Add `migrateStateV1_0ToV1_1()` and `isLegacyState()` to `src/types/request-state.ts` per TDD §7.1. The migration sets `schema_version: 1.1`, `request_type: 'feature'`, `bug_context: undefined`, computed `phase_overrides`, and `type_config` from the matrix.
   - Files to modify: `plugins/autonomous-dev/src/types/request-state.ts`
   - Acceptance criteria: Migrating a v1.0 state preserves all original fields. The result has `schema_version === 1.1`, `request_type === 'feature'`, and the full feature phase sequence. `isLegacyState({schema_version: 1.0})` returns true; `isLegacyState({schema_version: 1.1})` returns false.
   - Estimated effort: 1.5h

5. **Author JSON schema for v1.1** -- Create `schemas/state-v1.1.json` (JSON Schema 2020-12) covering all v1.1 fields. Required: `schema_version` (must equal 1.1), all fields from v1.0. Optional: `request_type` (enum of five values), `bug_context` (object, validated separately in PLAN-018-3), `phase_overrides` (array of strings), `type_config` (object matching `PhaseOverrideConfig`).
   - Files to create: `plugins/autonomous-dev/schemas/state-v1.1.json`
   - Acceptance criteria: A v1.1 state file from TDD §7.2 validates clean. A state with `schema_version: 1.0` fails with a clear error pointing at the version field. A state with `request_type: 'invalid'` fails with an enum error.
   - Estimated effort: 2h

6. **Author migration shell script** -- Create `bin/migrate-state-files.sh` per TDD §7.3 that finds all `state.json` under `~/.autonomous-dev`, backs up v1.0 files to `.v1.0.backup`, and rewrites with the default v1.1 fields via `jq`. Idempotent: re-running on an already-migrated file is a no-op.
   - Files to create: `plugins/autonomous-dev/bin/migrate-state-files.sh`
   - Acceptance criteria: Script passes shellcheck. On a directory with three v1.0 state files, all three get migrated and three `.v1.0.backup` files exist. Re-running the script on the same directory produces "Already v1.1" log lines and no further changes. A v1.1 file with `request_type: 'bug'` is left unchanged (idempotency preserves user-provided values).
   - Estimated effort: 2h

7. **Wire schema validation into state loading** -- Update `src/state/state-loader.ts` (or wherever state is read; see PRD-002 / TDD-002) to validate against `state-v1.1.json` after loading. On a v1.0 file, automatically run the migration and persist the upgraded state.
   - Files to modify: `plugins/autonomous-dev/src/state/state-loader.ts` (path may differ; locate via grep)
   - Acceptance criteria: Loading a v1.0 state file produces a v1.1 in-memory object and writes the migrated v1.1 to disk atomically (via the existing two-phase commit pattern from TDD-012). Loading a v1.1 file is a no-op pass-through. Loading a malformed file fails with a JSON-schema error (not a silent crash).
   - Estimated effort: 3h

8. **Unit tests for types and migration** -- Create `tests/types/request-type.test.ts` and `tests/types/state-migration.test.ts` covering: enum membership, type-guard truth table, phase-sequence computation per type (5 cases), gate computation per type, migration correctness for a representative v1.0 fixture, `isLegacyState` truth table.
   - Files to create: `plugins/autonomous-dev/tests/types/request-type.test.ts`, `plugins/autonomous-dev/tests/types/state-migration.test.ts`
   - Acceptance criteria: All tests pass under `npm test`. Coverage ≥95% on the three new type files. Test fixture v1.0 state files live under `tests/fixtures/state/v1.0/`.
   - Estimated effort: 3h

9. **Integration test: load v1.0, migrate, validate** -- Add `tests/integration/state-migration.test.ts` that copies a v1.0 fixture into a temp dir, invokes the state-loader, and verifies the file on disk is now v1.1 and validates against the JSON schema. Tests both single-file and multi-file scenarios.
   - Files to create: `plugins/autonomous-dev/tests/integration/state-migration.test.ts`
   - Acceptance criteria: Test passes under `npm test`. After invoking the loader on a v1.0 fixture, the file's `schema_version` is `1.1` on disk and the in-memory object matches the JSON. The `.v1.0.backup` file exists alongside.
   - Estimated effort: 2h

## Dependencies & Integration Points

**Exposes to other plans:**
- `RequestType`, `PhaseOverrideConfig`, `PHASE_OVERRIDE_MATRIX`, and the helper functions consumed by PLAN-018-2 (daemon selection) and PLAN-018-3 (CLI / TDD-author).
- `RequestStateV1_1` interface used everywhere state is read or written.
- `migrateStateV1_0ToV1_1()` invoked by the state loader and by the operator migration script.
- `state-v1.1.json` schema reused by any future tooling that validates state files (e.g., audit/observability).

**Consumes from other plans:**
- TDD-002 / PLAN-002-1: existing `RequestStateV1_0` interface and state-loader infrastructure (this plan extends them).
- TDD-012 / PLAN-012-1: two-phase commit pattern used when writing migrated state to disk atomically.

## Testing Strategy

- **Unit tests (task 8):** Type-guard, phase-sequence, gate-list, migration correctness; ≥95% coverage on the three new files.
- **Integration test (task 9):** End-to-end loader behavior against a real v1.0 fixture.
- **Schema validation:** AJV roundtrip — every test case validates the constructed object against the JSON schema.
- **Migration script smoke test:** Manually run `bin/migrate-state-files.sh` against a temp directory with three v1.0 files; verify all three migrate, backups exist, and re-running is idempotent.
- **No mocking of state I/O:** Tests use real filesystem in temp dirs (created via `fs.mkdtemp`) so the two-phase commit path is exercised.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Migration silently drops fields when v1.0 file has unexpected extra fields | Medium | High -- data loss on existing requests | Migration uses spread (`...state`) so all original fields are preserved. Schema's `additionalProperties: true` (not false) on the v1.1 schema during the migration window so unknown fields don't trip validation. Add a test fixture with an extra unexpected field to lock in this behavior. |
| `PHASE_OVERRIDE_MATRIX` drifts from the canonical TDD §5.2 specification over time | Medium | Medium -- behavior diverges from the design contract | Include the matrix in a snapshot test (`tests/types/phase-matrix.snapshot.test.ts`) so any unintended change requires a snapshot update with explicit reviewer approval. Cross-reference TDD §5.2 in the source file's JSDoc. |
| Operator runs `migrate-state-files.sh` while the daemon is running, corrupting state files mid-flight | Medium | High -- daemon and migrator both writing to the same file | Script header documents "stop the daemon first." Script checks for `~/.autonomous-dev/daemon.lock`; if present and the PID is alive, refuses to run with a clear message. Document the recovery procedure if the user runs it anyway. |
| Strict TypeScript narrowing of `RequestState` discriminated union breaks existing callers that expect v1.0 shape | High | Medium -- compile errors cascade across the codebase | Provide a `RequestState` type alias = `RequestStateV1_0 \| RequestStateV1_1` and a `requireV1_1(state): RequestStateV1_1` helper that asserts and migrates. Existing callers use the alias; new callers use the v1.1 type explicitly. |
| JSON schema's `request_type` enum diverges from the TypeScript enum if either is updated independently | Low | Medium -- runtime/compile-time mismatch | Generate the JSON schema enum values from the TypeScript enum at build time via a small codegen script in `bin/`. Document the codegen step in the plan's task 5 acceptance criteria. |

## Definition of Done

- [ ] `RequestType` enum, type guard, and default constant exist and pass type-check
- [ ] `PHASE_OVERRIDE_MATRIX` matches TDD §5.2 verbatim across all five request types
- [ ] Helper functions (`getPhaseSequence`, `isEnhancedPhase`, `getAdditionalGates`) return correct values per TDD §5.3
- [ ] `RequestStateV1_1` interface compiles cleanly and all required fields are present
- [ ] `migrateStateV1_0ToV1_1()` produces a valid v1.1 object that validates against `state-v1.1.json`
- [ ] `state-v1.1.json` validates the example from TDD §7.2 and rejects malformed states with clear errors
- [ ] `bin/migrate-state-files.sh` is shellcheck-clean, idempotent, and refuses to run while the daemon is alive
- [ ] State loader auto-migrates v1.0 files on read and persists via the two-phase commit pattern
- [ ] All unit tests pass with ≥95% coverage on new files
- [ ] Integration test demonstrates v1.0 → v1.1 migration end-to-end on the filesystem
- [ ] Snapshot test locks in the canonical `PHASE_OVERRIDE_MATRIX` shape
- [ ] No backwards-incompatible changes for callers using the `RequestState` alias type

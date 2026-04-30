# SPEC-018-1-04: state-loader Integration + Unit & Integration Tests

## Metadata
- **Parent Plan**: PLAN-018-1-request-type-enum-state-schema
- **Tasks Covered**: Task 7 (loader integration), Task 8 (unit tests), Task 9 (integration test)
- **Estimated effort**: 8 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-018-1-04-state-loader-integration-tests.md`

## Description
Wire the v1.1 schema and migration into the state-loader so that any caller reading state from disk receives a v1.1 in-memory object — and so that v1.0 files on disk are silently upgraded via the existing two-phase commit pattern. This spec also produces the full test suite for PLAN-018-1: unit tests for the enum, matrix, helpers, migration, and predicate (SPEC-018-1-01 / 1-02), a snapshot test that locks in the canonical `PHASE_OVERRIDE_MATRIX` shape, and an end-to-end integration test that exercises the loader against real v1.0 fixture files.

The loader change is small in surface area but load-bearing: every downstream consumer trusts the loader to deliver a validated v1.1 object. The implementation must (a) detect v1.0 via `isLegacyState`, (b) call `migrateStateV1_0ToV1_1`, (c) validate the result against `schemas/state-v1.1.json`, (d) persist atomically using the existing two-phase commit utility from TDD-012, and (e) leave a `.v1.0.backup` next to the upgraded file. Pure v1.1 reads are a fast-path with validation only.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/state/state-loader.ts` | Modify | Add validation + auto-migration on read; locate exact path via `grep -r 'state\.json\|schema_version' src/state` |
| `plugins/autonomous-dev/tests/types/request-type.test.ts` | Create | Unit tests for SPEC-018-1-01 |
| `plugins/autonomous-dev/tests/types/phase-matrix.snapshot.test.ts` | Create | Snapshot test locking matrix shape |
| `plugins/autonomous-dev/tests/types/state-migration.test.ts` | Create | Unit tests for SPEC-018-1-02 |
| `plugins/autonomous-dev/tests/integration/state-migration.test.ts` | Create | End-to-end loader integration test |
| `plugins/autonomous-dev/tests/fixtures/state/v1.0/single.json` | Create | Representative v1.0 state fixture |
| `plugins/autonomous-dev/tests/fixtures/state/v1.0/multi/req-a/state.json` | Create | First file for multi-file scenario |
| `plugins/autonomous-dev/tests/fixtures/state/v1.0/multi/req-b/state.json` | Create | Second file for multi-file scenario |
| `plugins/autonomous-dev/tests/fixtures/state/v1.0/with-extra-field.json` | Create | Fixture with unknown extra field for lossless-migration assertion |

## Implementation Details

### Loader Changes (`src/state/state-loader.ts`)

```typescript
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteJson } from '../utils/two-phase-commit'; // TDD-012 utility
import schemaV1_1 from '../../schemas/state-v1.1.json' assert { type: 'json' };
import {
  RequestState,
  RequestStateV1_1,
  isLegacyState,
  migrateStateV1_0ToV1_1,
} from '../types/request-state';

const ajv = addFormats(new Ajv2020({ strict: true, allErrors: true }));
const validateV1_1 = ajv.compile<RequestStateV1_1>(schemaV1_1);

export class StateValidationError extends Error {
  constructor(public readonly errors: unknown, message: string) {
    super(message);
    this.name = 'StateValidationError';
  }
}

/**
 * Loads a state.json file, auto-migrates v1.0 → v1.1 if needed, validates,
 * and (on migration) persists the upgraded file via the two-phase commit utility.
 * Always returns a validated RequestStateV1_1 in memory.
 */
export async function loadState(path: string): Promise<RequestStateV1_1> {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as RequestState;

  let upgraded: RequestStateV1_1;
  let didMigrate = false;

  if (isLegacyState(raw)) {
    upgraded = migrateStateV1_0ToV1_1(raw);
    didMigrate = true;
  } else if (raw.schema_version === 1.1) {
    upgraded = raw as RequestStateV1_1;
  } else {
    throw new StateValidationError(
      [{ keyword: 'schema_version', message: `Unrecognized schema_version: ${(raw as { schema_version: unknown }).schema_version}` }],
      `Unrecognized state schema_version at ${path}`,
    );
  }

  if (!validateV1_1(upgraded)) {
    throw new StateValidationError(
      validateV1_1.errors,
      `State file failed v1.1 validation at ${path}`,
    );
  }

  if (didMigrate) {
    // Backup the original v1.0 file alongside the upgraded one.
    const backupPath = `${path}.v1.0.backup`;
    if (!existsSync(backupPath)) {
      copyFileSync(path, backupPath); // preserves the pre-migration content
    }
    await atomicWriteJson(path, upgraded);
  }

  return upgraded;
}
```

Notes:
- Path may differ; locate via `grep -rn "state\.json\|schema_version" plugins/autonomous-dev/src/state`. If a loader does not yet exist, create it at the path above and document the gap in the PR.
- The two-phase commit utility from TDD-012 is the only acceptable write path. If `atomicWriteJson` does not exist, locate its equivalent via `grep -rn "atomic\|two.phase\|tmp.*rename" plugins/autonomous-dev/src/utils`.
- `existsSync` and `copyFileSync` come from `fs`; backup creation guards against overwriting an existing backup on repeated reads of the same file.

### Unit Tests

#### `tests/types/request-type.test.ts`

Cover:
- `RequestType` enum membership (5 keys, expected string values).
- `isValidRequestType` truth table: all 5 valid values true; `''`, `'xyz'`, `'FEATURE'`, `null as any`, `undefined as any` all false.
- `DEFAULT_REQUEST_TYPE === RequestType.FEATURE`.
- `getPhaseSequence` per type: FEATURE=14, BUG=12 (no prd, prd_review), INFRA=14, REFACTOR=12, HOTFIX=11.
- `isEnhancedPhase` truth table: at least 5 positive cases (one per type) and 5 negative cases.
- `getAdditionalGates` per type, exact array equality.
- `getAdditionalGates` returns a defensive copy: `getAdditionalGates(INFRA) !== PHASE_OVERRIDE_MATRIX[INFRA].additionalGates`.

#### `tests/types/phase-matrix.snapshot.test.ts`

```typescript
import { PHASE_OVERRIDE_MATRIX } from '../../src/types/phase-override';

test('PHASE_OVERRIDE_MATRIX matches TDD-018 §5.2', () => {
  expect(PHASE_OVERRIDE_MATRIX).toMatchSnapshot();
});
```

The first run produces the snapshot; reviewers approve it once. Any subsequent change requires explicit `--updateSnapshot` and a code-review note pointing at TDD-018 §5.2.

#### `tests/types/state-migration.test.ts`

Cover:
- Migrating a minimal v1.0 fixture sets `schema_version: 1.1`, `request_type: 'feature'`, populates `phase_overrides` (length 14), `type_config === PHASE_OVERRIDE_MATRIX[FEATURE]`.
- Migrating a v1.0 fixture with an extra unexpected field preserves that field.
- Migrating preserves: `id`, `status`, `created_at`, `updated_at`, all nested objects (`phase_history`, `current_phase_metadata`).
- `bug_context` is `undefined` after migration (not omitted entirely — verify via `'bug_context' in result` is `true`).
- `isLegacyState` truth table: 8 cases covering v1.0, v1.1, v1.0+request_type, null, undefined, primitive, empty object, missing schema_version.
- `requireV1_1`: pass-through on v1.1, migration on v1.0, throws on `schema_version: 2.0`.
- TypeScript narrowing test: a switch on `state.schema_version` compiles cleanly with no `as` casts.

### Integration Test (`tests/integration/state-migration.test.ts`)

Single-file scenario:
1. `fs.mkdtemp` → temp dir.
2. Copy `tests/fixtures/state/v1.0/single.json` into the temp dir as `state.json`.
3. Call `loadState(tempPath)`.
4. Assert returned object has `schema_version === 1.1`.
5. Assert `tempPath` on disk now has `schema_version: 1.1` (re-read fresh).
6. Assert `${tempPath}.v1.0.backup` exists with original content.
7. Assert in-memory object validates against the v1.1 schema.

Multi-file scenario:
1. Copy `tests/fixtures/state/v1.0/multi/` recursively into temp dir.
2. Walk, calling `loadState` on each `state.json`.
3. Assert all migrated; all backups exist; all re-loads of the same file are now no-op upgrades (the second call should not re-create the backup).

Idempotency assertion: call `loadState` twice on the single-file path; assert the second call does not modify the file mtime and does not create a second backup.

Error path: a fixture with `schema_version: 2.0` should cause `loadState` to throw `StateValidationError` with a message that includes the file path.

### Test Fixtures

Each v1.0 fixture must include at minimum: `schema_version: 1.0`, `id`, `status`, `created_at`, `updated_at`. The `with-extra-field.json` fixture additionally includes `"experimental_field": { "value": 42 }` to lock in lossless-migration behavior.

## Acceptance Criteria

### Loader

- [ ] `loadState(v1_0_path)` returns an object with `schema_version === 1.1` and `request_type === 'feature'`.
- [ ] `loadState(v1_0_path)` writes the migrated content back to `v1_0_path` via `atomicWriteJson`; the file on disk has `schema_version: 1.1` after the call returns.
- [ ] `loadState(v1_0_path)` creates `${v1_0_path}.v1.0.backup` containing the original (pre-migration) bytes.
- [ ] `loadState(v1_1_path)` is a fast-path: it does not call `atomicWriteJson` and does not create a backup.
- [ ] `loadState` on a malformed JSON file throws (the underlying `JSON.parse` error is acceptable; do not catch and swallow).
- [ ] `loadState` on a file failing v1.1 validation throws `StateValidationError` with `errors` populated by AJV.
- [ ] `loadState` on a file with `schema_version: 2.0` throws `StateValidationError` with a message naming the file path.
- [ ] Repeated calls to `loadState` on the same v1.0 file do not create a second `.v1.0.backup` (idempotent backup behavior).

### Unit Tests

- [ ] All tests in `tests/types/request-type.test.ts` pass under `npm test`.
- [ ] All tests in `tests/types/state-migration.test.ts` pass under `npm test`.
- [ ] Snapshot test in `tests/types/phase-matrix.snapshot.test.ts` passes after initial snapshot is committed.
- [ ] Coverage on `src/types/request-type.ts`, `src/types/phase-override.ts`, `src/types/request-state.ts` is ≥ 95% lines and branches (verified via `npm test -- --coverage`).

### Integration Test

- [ ] Single-file scenario passes.
- [ ] Multi-file scenario passes.
- [ ] Idempotency assertion passes (second call does not mutate file or create new backup).
- [ ] Error-path assertion passes for the `schema_version: 2.0` fixture.
- [ ] Tests use real temp filesystem via `fs.mkdtemp`; no mocking of fs.

## Dependencies

- SPEC-018-1-01 (enum, matrix, helpers).
- SPEC-018-1-02 (`RequestStateV1_1`, `migrateStateV1_0ToV1_1`, `isLegacyState`, `requireV1_1`).
- SPEC-018-1-03 (`schemas/state-v1.1.json`).
- TDD-012 / PLAN-012-1 two-phase commit utility (`atomicWriteJson` or equivalent). Locate before writing the loader.
- AJV 2020-12 (`ajv` ≥ 8.12) and `ajv-formats` for `date-time` validation.
- Test runner: project's existing Jest/Vitest harness (no new test framework introduced).

## Notes

- The loader's exact path is "wherever state is read." If multiple call sites read state directly today, refactor each to go through `loadState`. List those call sites in the PR description.
- The v1.0 → v1.1 migration on read is silent by design — operators should not need to run `bin/migrate-state-files.sh` for normal operation. The script exists for offline / disaster-recovery use and is also the only safe option when the daemon is offline.
- Backup creation in the loader uses `existsSync`-guarded `copyFileSync` to avoid clobbering an existing backup. The migration script (SPEC-018-1-03) uses `cp -p` with the same convention; both must produce backups at the same path so operators can recover via either route.
- The snapshot test catches accidental matrix drift but not intentional matrix evolution. When the matrix legitimately changes, update TDD-018 §5.2, the snapshot, and the migration-script defaults in lockstep — the PR template should call this out.
- The integration test deliberately exercises the real filesystem via `fs.mkdtemp`. This is slower than mocking but catches two-phase-commit bugs that mock-based tests cannot.
- If the existing state-loader is in JavaScript rather than TypeScript, port it to TypeScript as part of this spec. Note this in the PR.

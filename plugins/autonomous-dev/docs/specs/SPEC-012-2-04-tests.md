# SPEC-012-2-04: Tests — Schema Validation, Migration Roundtrip, Repository

## Metadata
- **Parent Plan**: PLAN-012-2
- **Tasks Covered**: Task 6 (v1.1 state.json fixtures), Task 8 (comprehensive test suite)
- **Estimated effort**: 3 hours

## Description

Implement the test suite that verifies SPEC-012-2-01 (DDL), SPEC-012-2-02 (runner), and SPEC-012-2-03 (repository) jointly satisfy PLAN-012-2's acceptance criteria. Tests are organized into three layers: **schema-level** (DDL constraints applied to a real DB), **migration-level** (runner ordering + idempotency + transactional rollback), **repository-level** (TS-to-SQL round-trips + state.json compat).

All tests use `:memory:` SQLite databases for isolation and speed; no shared state between tests. Fixtures for state.json validation are committed to the repo so they double as documentation of the v1.0 and v1.1 wire formats.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/__tests__/db/migration_002.test.ts` | Create | Schema + migration tests |
| `intake/__tests__/db/repository_source.test.ts` | Create | Repository round-trip tests |
| `intake/__tests__/types/request_source.test.ts` | Create | Type guard + parser tests |
| `intake/__tests__/state/state_validator_compat.test.ts` | Create | v1.0/v1.1 state.json tests |
| `intake/__tests__/fixtures/state/v1_0_cli.json` | Create | Legacy fixture (no source) |
| `intake/__tests__/fixtures/state/v1_1_cli.json` | Create | v1.1 CLI fixture |
| `intake/__tests__/fixtures/state/v1_1_discord.json` | Create | v1.1 Discord fixture |
| `intake/__tests__/fixtures/state/v1_1_slack.json` | Create | v1.1 Slack fixture |
| `intake/__tests__/fixtures/state/v1_1_claude_app.json` | Create | v1.1 Claude App fixture |

## Implementation Details

### Test Helper

Centralize DB setup in `intake/__tests__/db/_helpers/migration_test_db.ts`:

```typescript
/** Returns an in-memory DB with all migrations applied. */
export async function migratedDb(): Promise<Database>;

/** Returns an in-memory DB with ONLY 001 applied (legacy v1 state). */
export async function v1Db(): Promise<Database>;

/** Returns an in-memory DB with NO migrations applied (raw). */
export async function rawDb(): Database;
```

### `migration_002.test.ts` — Schema + Runner

**Schema-level (DDL constraints):**

1. `applies cleanly to fresh DB` — `migratedDb()` succeeds; `requests` table has columns `source` and `adapter_metadata`; `idx_requests_source` and `idx_requests_source_status` exist.

2. `applies to v1 DB without data loss` — insert 5 rows into a `v1Db()`, run 002, assert all 5 rows have `source='cli'` and `adapter_metadata='{}'` after migration.

3. `source CHECK rejects unknown values` — for each invalid value `['urgent', 'Discord', 'CLI', '', 'unknown']`, assert `INSERT` throws SQLite CHECK violation.

4. `source CHECK accepts all 6 documented values` — for each of `['cli', 'claude-app', 'discord', 'slack', 'production-intelligence', 'portal']`, assert `INSERT` succeeds.

5. `adapter_metadata json_valid CHECK rejects malformed` — `INSERT ... adapter_metadata = 'not json'` throws; `'{"valid":true}'` succeeds; `'{}'` succeeds; `'null'` succeeds (valid JSON null is accepted).

6. `idx_requests_source used by source-only query` — run `EXPLAIN QUERY PLAN SELECT * FROM requests WHERE source='discord'`; assert plan text contains `idx_requests_source`.

7. `idx_requests_source_status used by composite query` — run `EXPLAIN QUERY PLAN SELECT * FROM requests WHERE source='discord' AND status='active'`; assert plan text contains `idx_requests_source_status`.

**Runner-level:**

8. `fresh DB applies 001 + 002 in order` — `runMigrations` returns `applied: ['001_initial.sql', '002_add_source_metadata.sql']`, `schemaVersion: 2`.

9. `idempotent on second run` — call `runMigrations` twice; second call returns `applied: []`, `skipped: ['001_initial.sql', '002_add_source_metadata.sql']`.

10. `legacy v1 DB upgrades to v2` — start from `v1Db()` (only 001 in `_migrations`), run runner, assert `_migrations` has both rows and `schemaVersion === 2`.

11. `transaction rolls back on SQL error` — write a tampered migration with `ALTER TABLE requests ADD COLUMN bad SYNTAX ERROR;` to a temp dir; assert `runMigrations` throws `MigrationError`; `_migrations` does NOT contain the tampered file's row; the `requests` table is unchanged.

12. `duplicate prefix rejected before any apply` — temp dir with `002_a.sql` + `002_b.sql`; assert throws `MigrationError('duplicate migration prefix: 002')` AND `_migrations` is unchanged.

13. `non-sql file skipped with warning` — temp dir contains `README.md`; runner completes successfully; warning log emitted with file name.

14. `out-of-order numeric files apply in numeric order` — temp dir contains `003_c.sql`, `001_a.sql`, `002_b.sql`; `applied` array order is `['001_a.sql', '002_b.sql', '003_c.sql']`.

### `repository_source.test.ts` — Round-Trip

15. `insert with discord source round-trips` — insert with `source: 'discord'`, `adapter_metadata: { source: 'discord', guild_id: 'g1', channel_id: 'c1' }`; `getRequest()` returns the same shape (typed object, not string).

16. `insert without source defaults to cli` — `insertRequest({ /* no source */ })`; `getRequest()` returns `source: 'cli'`, `adapter_metadata: {}`.

17. `insert with invalid source rejected pre-SQL` — `insertRequest({ source: 'urgent' as any })` throws `ValidationError` AND no row is created (verify via `SELECT COUNT(*)`).

18. `update source field validated` — valid update succeeds; `update({ source: 'banana' as any })` throws `ValidationError`.

19. `corrupt JSON in row returns empty metadata` — directly `INSERT` a row with `adapter_metadata = 'corrupt {'` bypassing validation by temporarily setting `PRAGMA ignore_check_constraints = ON` for the test; `getRequest()` returns `adapter_metadata: {}`; warning log emitted.

20. `listRequestsBySource filters correctly` — insert 3 discord, 2 slack, 1 cli rows; `listRequestsBySource('discord')` returns 3 rows; `listRequestsBySource('slack')` returns 2.

21. `listRequestsBySource uses index` — `EXPLAIN QUERY PLAN` for the underlying SQL contains `idx_requests_source_status`.

### `request_source.test.ts` — Types

22. `isRequestSource accepts all 6 valid sources` — for each of the 6, returns `true`.

23. `isRequestSource rejects invalid` — for `['urgent', '', null, undefined, 123, 'CLI', 'Discord']`, returns `false`.

24. `parseAdapterMetadata(null) returns empty object` — `expect(parseAdapterMetadata(null)).toEqual({})`.

25. `parseAdapterMetadata drops excess fields` — `parseAdapterMetadata({ source: 'discord', guild_id: 'g1', extra: 'x' })` returns `{ source: 'discord', guild_id: 'g1' }`.

26. `parseAdapterMetadata throws on unknown source` — `parseAdapterMetadata({ source: 'banana' })` throws `ValidationError`.

27. `parseAdapterMetadata throws on non-object` — for `['string', 123, [1,2,3]]`, throws `ValidationError`.

28. `discriminated union narrows correctly` — TypeScript-only test (`expectType<>` from `tsd` or equivalent): assert that after `if (m.source === 'discord')`, `m.guild_id` is accessible without cast.

### `state_validator_compat.test.ts` — state.json Compat

29. `v1.0 fixture reads with cli defaults` — `readStateJson('v1_0_cli.json')` returns object with `source: 'cli'`, `adapter_metadata: {}`; `state.v10_compat` log emitted.

30. `v1.1 fixtures round-trip` — for each of `v1_1_cli.json`, `v1_1_discord.json`, `v1_1_slack.json`, `v1_1_claude_app.json`: read, then write to a temp file, then `JSON.parse(readFileSync(temp))` deep-equals the original.

31. `v1.1 with invalid source rejected` — fixture-on-the-fly with `source: 'banana'`; `readStateJson` throws `StateValidationError`.

32. `v1.0 + missing adapter_metadata defaults to {}` — fixture with `source: 'cli'` but no `adapter_metadata` key; read returns `adapter_metadata: {}`.

33. `write always emits v1.1 shape` — call `writeStateJson(path, { ...v10ShapedObject, source: 'cli', adapter_metadata: {} })`; read raw JSON; assert `source` and `adapter_metadata` keys both present.

### Fixtures

`v1_0_cli.json` — pre-source state.json (omits `source`, `adapter_metadata`):
```json
{
  "request_id": "REQ-000001",
  "title": "Legacy request",
  "status": "queued",
  "created_at": "2025-12-01T10:00:00.000Z"
}
```

`v1_1_cli.json` — minimal v1.1:
```json
{
  "request_id": "REQ-000002",
  "title": "CLI request",
  "status": "queued",
  "created_at": "2026-04-28T10:00:00.000Z",
  "source": "cli",
  "adapter_metadata": { "source": "cli", "pid": 12345, "cwd": "/Users/pat/repo", "branch": "main" }
}
```

`v1_1_discord.json`:
```json
{
  "request_id": "REQ-000003",
  "title": "Discord request",
  "status": "queued",
  "created_at": "2026-04-28T10:00:00.000Z",
  "source": "discord",
  "adapter_metadata": {
    "source": "discord",
    "guild_id": "111",
    "channel_id": "222",
    "user_id": "333",
    "message_id": "444"
  }
}
```

`v1_1_slack.json` and `v1_1_claude_app.json` follow the same pattern with each adapter's documented fields from SPEC-012-2-03.

## Acceptance Criteria

- [ ] All 33 tests above are implemented and pass.
- [ ] All 5 fixtures are committed and validate against the documented schemas.
- [ ] Test suite runs in `< 5 seconds` total (in-memory DBs only).
- [ ] No test depends on file system state outside `intake/__tests__/`.
- [ ] No test leaks open DB handles (verify via afterEach cleanup).
- [ ] Coverage on `intake/types/request_source.ts` is 100% (small file; achievable).
- [ ] Coverage on `intake/db/migrator.ts` is `>= 95%`.
- [ ] Coverage on the v2 additions in `intake/db/repository.ts` is `>= 95%` (existing v1 paths excluded from this measurement).
- [ ] `tsc --noEmit` passes for the test files.
- [ ] Tests run cleanly under the project's existing test runner (Jest or Vitest per repo convention).

## Test Requirements

This spec IS the test requirement. No additional downstream tests required.

## Dependencies

- **Consumes**: SPEC-012-2-01 DDL file (`002_add_source_metadata.sql`).
- **Consumes**: SPEC-012-2-02 `runMigrations()`, `MigrationError`, `MigrationResult`.
- **Consumes**: SPEC-012-2-03 `RequestEntity`, `RequestSource`, `AdapterMetadata`, `parseAdapterMetadata`, `isRequestSource`, `readStateJson`, `writeStateJson`.
- **Consumes**: Existing test infra (test runner, `:memory:` DB convention, `tmp` directory helper).
- **Exposes**: Test helpers (`migratedDb`, `v1Db`, `rawDb`) that downstream specs in PLAN-012-1 and PLAN-012-3 may reuse.

## Notes

- **Why fixtures committed?** They double as the canonical documentation of the v1.0 and v1.1 wire formats. An engineer adding a new adapter copies the relevant fixture as a starting point.
- **Why no Postgres/MySQL?** SQLite is the only DB target. Tests directly verify SQLite-specific behavior (`json_valid`, CHECK constraint enforcement, `EXPLAIN QUERY PLAN` text) which is the system under test.
- **`PRAGMA ignore_check_constraints` use is scoped to test #19 only.** That test deliberately bypasses validation to construct a corrupt-row scenario that cannot be reached via normal repository APIs. The pragma is reset immediately after the bad insert.
- **`EXPLAIN QUERY PLAN` text matching is fragile** across SQLite versions. Tests #6, #7, #21 use substring matches (`expect(plan).toContain('idx_requests_source')`) rather than exact-match to tolerate version drift.
- **`v10_compat` log assertion approach**: tests use a log-capturing mock injected into `readStateJson`. The test infra spec (existing) covers log capture conventions; this spec just relies on the established pattern.
- **Numbered tests** above (1-33) are for cross-spec referencing only; the test files MAY use descriptive names rather than numeric prefixes.

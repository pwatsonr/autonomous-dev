# SPEC-012-2-01: SQLite Schema DDL — Source Metadata Columns

## Metadata
- **Parent Plan**: PLAN-012-2
- **Tasks Covered**: Task 1 (author migration file), Task 4 (RequestSource + AdapterMetadata types DDL surface)
- **Estimated effort**: 2 hours

## Description

Author the SQLite v1→v2 schema DDL that adds source-tracking metadata to the `requests` table. The migration adds two new columns (`source` enum, `adapter_metadata` JSON) plus an index on `source` to support per-channel audit queries. The DDL is written as an **idempotent** SQL file — safe to apply against a fresh DB or a v1 DB that already has 001 applied. This spec covers ONLY the SQL DDL artifact; the migration runner that executes it is SPEC-012-2-02.

The `source` column is a CHECK-constrained enum that is the authoritative compile-time + runtime source-of-truth for `RequestSource` values across the codebase. The `adapter_metadata` column stores JSON-serialized `AdapterMetadata` discriminated unions per TDD-012 §7.1.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/db/migrations/002_add_source_metadata.sql` | Create | Idempotent v1→v2 migration |
| `intake/db/schema.sql` | Modify | Update reference DDL to include v2 columns |

## Implementation Details

### Task 1: Migration File `002_add_source_metadata.sql`

The migration MUST be wrapped in a transaction (the migration runner in SPEC-012-2-02 will wrap externally; the DDL itself must not contain `BEGIN`/`COMMIT`).

```sql
-- 002_add_source_metadata.sql
-- v1 → v2: adds source-tracking metadata columns to the requests table.
-- Idempotent: safe to apply multiple times via the migration runner.

-- Add source column (NOT NULL, default 'cli' for v1 backward-compat).
-- Existing v1 rows automatically receive source='cli'.
ALTER TABLE requests ADD COLUMN source TEXT NOT NULL DEFAULT 'cli'
  CHECK (source IN (
    'cli',
    'claude-app',
    'discord',
    'slack',
    'production-intelligence',
    'portal'
  ));

-- Add adapter_metadata column (TEXT JSON; default empty object).
-- Existing v1 rows automatically receive '{}'.
ALTER TABLE requests ADD COLUMN adapter_metadata TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(adapter_metadata));

-- Index for per-source audit + reconciliation queries.
CREATE INDEX IF NOT EXISTS idx_requests_source ON requests(source);

-- Composite index for "active requests by source" queries used by
-- reconciliation CLI (PLAN-012-3) and per-channel dashboards.
CREATE INDEX IF NOT EXISTS idx_requests_source_status
  ON requests(source, status, created_at);
```

**DDL constraints:**

1. **`source` CHECK enum** — exact values must match `RequestSource` literal union in `intake/types/request_source.ts` (see SPEC-012-2-03). Adding a new source requires migration 003 + type update + adapter implementation.
2. **`adapter_metadata` `json_valid()` check** — SQLite's `json_valid()` rejects malformed JSON at insert time. Empty object `'{}'` passes validation.
3. **`IF NOT EXISTS` on indexes** — both indexes use `IF NOT EXISTS` to make the migration safe to re-apply if a partial transaction was committed (defense-in-depth for the runner's transactional wrapping).
4. **`ALTER TABLE ADD COLUMN` is NOT idempotent in SQLite** — the runner (SPEC-012-2-02) tracks applied migrations in `_migrations`; the DDL itself does not need to guard `ALTER TABLE`.

### Task 4 (DDL portion): Reference Schema Update

Update `intake/db/schema.sql` (the human-readable reference; not executed by the runner) to reflect the v2 shape of the `requests` table. Add the two columns + indexes inline so engineers reading `schema.sql` see the current state:

```sql
CREATE TABLE IF NOT EXISTS requests (
  -- ... existing columns from 001_initial.sql ...

  -- v2 (002_add_source_metadata.sql):
  source            TEXT NOT NULL DEFAULT 'cli'
                    CHECK (source IN (
                      'cli', 'claude-app', 'discord', 'slack',
                      'production-intelligence', 'portal'
                    )),
  adapter_metadata  TEXT NOT NULL DEFAULT '{}'
                    CHECK (json_valid(adapter_metadata)),
  -- ...
);

-- v2 indexes (002_add_source_metadata.sql):
CREATE INDEX idx_requests_source ON requests(source);
CREATE INDEX idx_requests_source_status ON requests(source, status, created_at);
```

A `-- v2:` comment marker MUST flank the new columns + indexes so reviewers can grep for the migration boundary.

## Acceptance Criteria

- [ ] `002_add_source_metadata.sql` exists at the documented path and contains exactly the DDL above (no `BEGIN`/`COMMIT`, no schema_version row writes).
- [ ] Applying 002 against a fresh DB that has 001 applied succeeds and produces a `requests` table with the two new columns.
- [ ] Existing v1 rows in a DB that has 001 applied receive `source='cli'` and `adapter_metadata='{}'` after applying 002.
- [ ] `INSERT INTO requests (... source ...) VALUES (... 'urgent' ...)` fails with a CHECK constraint error (only the 6 documented sources are accepted).
- [ ] `INSERT INTO requests (... adapter_metadata ...) VALUES (... '{not-json' ...)` fails with a CHECK constraint error.
- [ ] `idx_requests_source` and `idx_requests_source_status` are present after migration (verify via `SELECT name FROM sqlite_master WHERE type='index'`).
- [ ] `intake/db/schema.sql` reference file reflects the v2 columns and indexes with `-- v2:` comment markers.
- [ ] `sqlite3 db.sqlite ".schema requests"` output includes both new columns with their CHECK constraints.

## Test Requirements

Test execution lives in SPEC-012-2-04. This spec defines what the DDL must satisfy when executed by those tests:

| Scenario | DDL Behavior |
|----------|-------------|
| Apply 002 to v1 DB with 100 existing rows | All 100 rows have `source='cli'`, `adapter_metadata='{}'` |
| Insert with `source='discord'` | Succeeds |
| Insert with `source='Discord'` (capitalized) | Fails (CHECK violation) |
| Insert with `adapter_metadata='{"guild":"123"}'` | Succeeds |
| Insert with `adapter_metadata='not json'` | Fails (json_valid CHECK) |
| Query `EXPLAIN QUERY PLAN SELECT * FROM requests WHERE source='discord'` | Uses `idx_requests_source` |
| Query `EXPLAIN QUERY PLAN SELECT * FROM requests WHERE source='discord' AND status='active'` | Uses `idx_requests_source_status` |

## Dependencies

- **Consumes**: `001_initial.sql` (must be applied first; provides `requests` table). The migration runner (SPEC-012-2-02) enforces ordering.
- **Exposes**: v2 schema consumed by repository layer (SPEC-012-2-03) and migration tests (SPEC-012-2-04).
- **External**: SQLite >= 3.38 (required for `json_valid()`); already a dependency from PLAN-008-1.

## Notes

- **Why CHECK enum + TS literal union duplication?** SQLite enforces at write-time; TypeScript enforces at compile-time. Both are needed — the DB protects against rogue/legacy writers, the type system protects callers. SPEC-012-2-03 documents how to keep them in sync.
- **Why `NOT NULL DEFAULT '{}'` on `adapter_metadata`?** Always-present-with-default eliminates a class of "is it null or empty?" bugs in repository code and downstream consumers. The default `'{}'` is a valid empty `AdapterMetadata` (no discriminator means base shape).
- **Why no `paused_at_phase` style migration?** This migration is purely additive; no existing column semantics change. The two new columns have safe defaults so no UPDATE step is required for existing rows.
- **Future migrations** (003+) that need to evolve `source` values must use a multi-step pattern: add new column with new CHECK, copy data, drop old column. Direct CHECK constraint mutation is not supported in SQLite.

# SPEC-012-2-02: Migration Framework — Numbered SQL Migrations + Runner

## Metadata
- **Parent Plan**: PLAN-012-2
- **Tasks Covered**: Task 2 (update migrator to apply v1→v2 migration)
- **Estimated effort**: 2.5 hours

## Description

Extend `intake/db/migrator.ts` to discover, order, and apply numbered SQL migrations from `intake/db/migrations/`, tracking applied migrations in a `_migrations` table. The runner is **idempotent**, **transactional per-migration**, and **stateless across runs** — its sole authoritative state lives in the `_migrations` table inside the database it operates on.

The runner already exists from SPEC-008-1-01 (applied `001_initial.sql`); this spec extends it to handle 002 + arbitrary future migrations via filename-sorted discovery. The contract is: **drop a `NNN_*.sql` file in `migrations/`, restart the daemon, the migration applies on startup**.

This spec is the runtime engine. The DDL it executes is in SPEC-012-2-01. The repository layer that consumes the migrated schema is in SPEC-012-2-03.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/db/migrator.ts` | Modify | Generalize from "apply 001" to "apply all pending" |
| `intake/db/migrator.types.ts` | Create | Types: `Migration`, `MigrationResult`, `AppliedMigration` |

## Implementation Details

### Types (`migrator.types.ts`)

```typescript
/** Represents a discovered migration file on disk. */
export interface Migration {
  /** Filename (e.g. "002_add_source_metadata.sql"). Sort key. */
  readonly filename: string;
  /** Numeric prefix parsed from filename (e.g. 2 for "002_..."). */
  readonly number: number;
  /** Absolute path on disk. */
  readonly path: string;
  /** Raw SQL content (loaded lazily by the runner). */
  readonly sql: string;
}

/** Record of a successfully applied migration, persisted to `_migrations`. */
export interface AppliedMigration {
  readonly name: string;       // Filename
  readonly applied_at: string; // ISO 8601 UTC
}

/** Outcome of a `runMigrations()` invocation. */
export interface MigrationResult {
  readonly applied: readonly string[];   // Filenames newly applied this run
  readonly skipped: readonly string[];   // Filenames already in _migrations
  readonly schemaVersion: number;        // Highest numeric prefix applied
}
```

### Runner Contract

```typescript
/**
 * Discover, order, and apply pending migrations.
 *
 * - Reads all `*.sql` files in `migrationsDir`
 * - Sorts by filename (lexicographic; numeric prefix ensures correct order)
 * - Skips files already recorded in `_migrations`
 * - For each pending file: runs SQL inside a single transaction with
 *   the `_migrations` insert; commits on success, rolls back on any error
 * - Returns the list of applied filenames + new schema version
 *
 * @param db        Open SQLite Database handle
 * @param migrationsDir Absolute path to the migrations directory
 * @throws MigrationError on SQL failure or file IO failure
 */
export async function runMigrations(
  db: Database,
  migrationsDir: string
): Promise<MigrationResult>;
```

### Implementation Steps

1. **Ensure `_migrations` table exists** — at the top of `runMigrations`, idempotently create:

   ```sql
   CREATE TABLE IF NOT EXISTS _migrations (
     name TEXT PRIMARY KEY,
     applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   );
   ```

2. **Discover migrations** — `fs.readdir(migrationsDir)`, filter to `*.sql`, parse leading numeric prefix via regex `^(\d+)_(.+)\.sql$`. Files not matching the pattern are **logged as warnings** and skipped (do not throw — accommodates README files in the directory).

3. **Sort by numeric prefix** — primary sort by parsed number, secondary by filename. Reject duplicates: if two files share the same prefix, throw `MigrationError("duplicate migration prefix: NNN")`.

4. **Query applied set** — `SELECT name FROM _migrations` → `Set<string>`.

5. **Apply each pending migration** — for each file not in the applied set, in order:
   ```typescript
   db.exec('BEGIN');
   try {
     db.exec(migration.sql);
     db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(migration.filename);
     db.exec('COMMIT');
   } catch (err) {
     db.exec('ROLLBACK');
     throw new MigrationError(`failed at ${migration.filename}: ${err.message}`);
   }
   ```

6. **Compute schema version** — after all applications complete, query `SELECT MAX(name) FROM _migrations`, parse the numeric prefix, return as `schemaVersion`.

7. **Logging** — emit structured log entries:
   - `migration.discovered` (with count)
   - `migration.applied` (per-file, with duration_ms)
   - `migration.skipped` (per-file, debug level only)
   - `migration.complete` (summary: applied count, skipped count, final version)

### Error Class

```typescript
export class MigrationError extends Error {
  constructor(
    message: string,
    public readonly migrationFile?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}
```

### Startup Integration

The daemon's startup sequence (defined elsewhere; this spec does not modify it) calls:

```typescript
const result = await runMigrations(db, path.join(__dirname, 'migrations'));
log.info('schema ready', {
  schemaVersion: result.schemaVersion,
  newlyApplied: result.applied
});
```

If `runMigrations` throws, the daemon MUST exit with code `74` (`EX_IOERR`) and a fatal log entry. The intake daemon does not start with an out-of-date schema.

## Acceptance Criteria

- [ ] `runMigrations(db, dir)` applies `001_initial.sql` + `002_add_source_metadata.sql` on a fresh DB; returns `applied: ['001_initial.sql', '002_add_source_metadata.sql']`, `schemaVersion: 2`.
- [ ] Running twice on the same DB returns `applied: []`, `skipped: ['001_initial.sql', '002_add_source_metadata.sql']` on the second run.
- [ ] On a DB with 001 already applied (legacy v1), `runMigrations` applies only 002; `_migrations` ends with both rows.
- [ ] If 002 contains a syntax error, the transaction rolls back; `_migrations` does NOT contain a row for 002; the error is a `MigrationError` with `migrationFile === '002_add_source_metadata.sql'`.
- [ ] Two files with the same numeric prefix (`002_a.sql` + `002_b.sql`) cause `runMigrations` to throw `MigrationError('duplicate migration prefix: 002')` BEFORE applying any migration.
- [ ] A non-`.sql` file (e.g. `README.md`) in `migrations/` is logged as a warning and skipped without error.
- [ ] A `.sql` file without a numeric prefix (e.g. `cleanup.sql`) is logged as a warning and skipped.
- [ ] The `_migrations` table is created with `IF NOT EXISTS` on every run (no error if it exists).
- [ ] All migration runs emit `migration.complete` log entry with `applied`, `skipped`, `schemaVersion` fields.

## Test Requirements

Test implementation lives in SPEC-012-2-04. This spec defines the runner contract those tests verify:

| Test Scenario | Setup | Expected |
|--------------|-------|----------|
| Fresh DB, both migrations | empty `:memory:` DB | applied=[001,002], skipped=[], version=2 |
| Already-migrated DB | run twice | second run: applied=[], skipped=[001,002], version=2 |
| Legacy v1 DB | apply 001 only, then run | applied=[002], skipped=[001], version=2 |
| 002 SQL syntax error | tamper file with bad SQL | throws MigrationError; `_migrations` has only 001 |
| Duplicate prefix | add 002_dupe.sql | throws before applying anything |
| Non-SQL file in dir | add README.md | skipped silently with warning log |
| Out-of-order numeric | files 001, 003, 002 | applies in 001→002→003 order |

## Dependencies

- **Consumes**: `better-sqlite3` Database type (already a dependency from PLAN-008-1).
- **Consumes**: SPEC-012-2-01 DDL file at `intake/db/migrations/002_add_source_metadata.sql`.
- **Exposes**: `runMigrations()` consumed by daemon startup; `MigrationResult` and `MigrationError` consumed by SPEC-012-2-04 tests.
- **External**: Node `fs/promises` for directory scanning.

## Notes

- **Why filename sort instead of `_migrations.applied_at`?** Disk filenames are deterministic; `applied_at` reflects past runs which may have been on different machines. Filename-based ordering means dropping a new SQL file is the only operator action required.
- **Why per-migration transactions?** SQLite DDL inside a transaction is atomic — either all of `002_add_source_metadata.sql` applies or none of it does. This prevents half-migrated states that would be impossible to recover from cleanly.
- **Why `_migrations` (underscore prefix)?** Naming convention from SPEC-008-1-01: underscore-prefixed tables are framework-internal, not part of the application data model. They are excluded from backups by convention (SPEC-008 §backup-policy).
- **Schema version is derived, not stored.** No `schema_version` row anywhere — the truth is "max numeric prefix in `_migrations`". This eliminates a class of skew bugs where the version row disagreed with the actually-applied migrations.
- **No down-migrations.** The runner is forward-only by design. Schema rollback in production is via DB restore from backup, not via a `down` script. This is a deliberate choice documented in TDD-012 §schema-evolution.

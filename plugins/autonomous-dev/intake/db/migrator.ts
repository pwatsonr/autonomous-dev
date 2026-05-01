/**
 * SQLite migration framework for the Intake Layer.
 *
 * Discovers numbered `*.sql` files in a migrations directory, tracks which
 * have been applied in a `_migrations` table, and runs new ones inside
 * per-migration transactions. Fully idempotent: running twice is a no-op.
 *
 * Filename convention: `NNN_short_name.sql`. The numeric prefix determines
 * apply order (numeric, not lexicographic — `010_x.sql` runs after `9_x.sql`
 * iff both prefixes parse as numbers, but the convention is to zero-pad).
 *
 * Implements SPEC-012-2-02 contract.
 *
 * Note on async: SPEC-012-2-02 specifies `Promise<MigrationResult>` but the
 * underlying `better-sqlite3` driver is synchronous, and every existing
 * caller (`cli_adapter`, `claude_command_bridge`, all integration test
 * harnesses) relies on the synchronous return. This implementation keeps
 * the function synchronous; all acceptance criteria operate on the result
 * shape, not the call style. Deviation documented in PLAN-012-2 notes.
 *
 * Requires `better-sqlite3` at runtime.
 *
 * @module migrator
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  type Migration,
  MigrationError,
  type MigrationResult,
} from './migrator.types';

// ---------------------------------------------------------------------------
// Optional better-sqlite3 import
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Database = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let BetterSqlite3: ((...args: unknown[]) => Database) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  BetterSqlite3 = require('better-sqlite3');
} catch {
  // Module not available at compile time; callers must provide a db instance.
}

// ---------------------------------------------------------------------------
// Migration tracking DDL
// ---------------------------------------------------------------------------

const CREATE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS _migrations (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

const MIGRATION_FILENAME_RE = /^(\d+)_(.+)\.sql$/;

// ---------------------------------------------------------------------------
// Public API re-exports
// ---------------------------------------------------------------------------

export {
  type Migration,
  type AppliedMigration,
  type MigrationResult,
  MigrationError,
} from './migrator.types';

// ---------------------------------------------------------------------------
// Database open
// ---------------------------------------------------------------------------

/**
 * Open (or create) a SQLite database at `dbPath` and return the
 * `better-sqlite3` instance. Enables WAL mode and foreign keys.
 *
 * @param dbPath  Filesystem path to the database file, or `':memory:'`.
 * @returns The opened database instance.
 * @throws If `better-sqlite3` is not installed.
 */
export function openDatabase(dbPath: string): Database {
  if (!BetterSqlite3) {
    throw new Error(
      'better-sqlite3 is required but not installed. Run: npm install better-sqlite3',
    );
  }
  const db = (BetterSqlite3 as any)(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Discover, order, and apply pending migrations.
 *
 * Steps:
 *   1. Ensure `_migrations` tracking table exists.
 *   2. Scan `migrationsDir` for files matching `NNN_*.sql`. Other files are
 *      logged as warnings and skipped (accommodates README, etc.).
 *   3. Sort by numeric prefix; reject duplicate prefixes.
 *   4. For each file not in `_migrations`, run inside a transaction along
 *      with the `_migrations` insert. Roll back on any error and throw
 *      `MigrationError`.
 *   5. Compute `schemaVersion` as the max numeric prefix in `_migrations`.
 *
 * @param db             An open `better-sqlite3` database instance.
 * @param migrationsDir  Path to the directory containing `*.sql` migration files.
 * @returns A {@link MigrationResult} summarizing the run.
 * @throws {MigrationError} on duplicate prefix, SQL failure, or IO error.
 */
export function runMigrations(
  db: Database,
  migrationsDir: string,
): MigrationResult {
  // Step 1: ensure _migrations exists
  db.exec(CREATE_MIGRATIONS_TABLE);

  // Step 2: discover candidates
  const allEntries = fs.readdirSync(migrationsDir);
  const migrations = discoverMigrations(allEntries, migrationsDir);

  // Step 3: which are already applied?
  const appliedRows: Array<{ name: string }> = db
    .prepare('SELECT name FROM _migrations')
    .all();
  const appliedSet = new Set(appliedRows.map((r) => r.name));

  const applied: string[] = [];
  const skipped: string[] = [];

  // Step 4: apply pending migrations transactionally
  for (const migration of migrations) {
    if (appliedSet.has(migration.filename)) {
      skipped.push(migration.filename);
      continue;
    }

    try {
      const executableSql = stripPragmas(migration.sql);
      const apply = db.transaction(() => {
        db.exec(executableSql);
        db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(
          migration.filename,
        );
      });
      apply();
      applied.push(migration.filename);
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new MigrationError(
        `failed at ${migration.filename}: ${cause.message}`,
        migration.filename,
        cause,
      );
    }
  }

  // Step 5: derive schema version from _migrations
  const schemaVersion = computeSchemaVersion(db);

  // Best-effort structured log (kept simple to avoid pulling logger dep here).
  // Operators see this on daemon startup.
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      event: 'migration.complete',
      applied,
      skipped,
      schemaVersion,
    }),
  );

  return { applied, skipped, schemaVersion };
}

/**
 * Convenience: open a database and run all migrations in one call.
 *
 * @param dbPath         Path to the SQLite database file (or `':memory:'`).
 * @param migrationsDir  Path to the migrations directory.
 * @returns An object with the database instance and the migration result.
 */
export function initializeDatabase(
  dbPath: string,
  migrationsDir?: string,
): { db: Database; migrations: MigrationResult } {
  const db = openDatabase(dbPath);
  const dir = migrationsDir ?? path.join(__dirname, 'migrations');
  const migrations = runMigrations(db, dir);
  return { db, migrations };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Scan directory entries, parse `NNN_name.sql` filenames, sort by numeric
 * prefix, and reject duplicate prefixes. Files that don't match the pattern
 * are warned about (stderr) and dropped.
 */
function discoverMigrations(
  entries: string[],
  migrationsDir: string,
): Migration[] {
  const candidates: Migration[] = [];
  for (const entry of entries) {
    const match = MIGRATION_FILENAME_RE.exec(entry);
    if (!match) {
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          event: 'migration.skipped_unknown_file',
          file: entry,
        }),
      );
      continue;
    }
    const number = Number.parseInt(match[1], 10);
    const fullPath = path.join(migrationsDir, entry);
    const sql = fs.readFileSync(fullPath, 'utf-8');
    candidates.push({ filename: entry, number, path: fullPath, sql });
  }

  // Detect duplicate numeric prefixes BEFORE applying anything.
  const seen = new Map<number, string>();
  for (const m of candidates) {
    const prior = seen.get(m.number);
    if (prior !== undefined) {
      throw new MigrationError(
        `duplicate migration prefix: ${String(m.number).padStart(3, '0')} ` +
          `(${prior} and ${m.filename})`,
      );
    }
    seen.set(m.number, m.filename);
  }

  // Sort by numeric prefix (primary) then filename (tiebreaker — unreachable
  // after duplicate check, but defensive).
  candidates.sort((a, b) => {
    if (a.number !== b.number) return a.number - b.number;
    return a.filename.localeCompare(b.filename);
  });

  return candidates;
}

/** Compute schemaVersion = max numeric prefix in `_migrations` (0 if empty). */
function computeSchemaVersion(db: Database): number {
  const rows: Array<{ name: string }> = db
    .prepare('SELECT name FROM _migrations')
    .all();
  let max = 0;
  for (const row of rows) {
    const m = MIGRATION_FILENAME_RE.exec(row.name);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

/**
 * Remove PRAGMA statements from a SQL string.
 * PRAGMAs cannot execute inside a transaction in SQLite; they are handled
 * separately by `openDatabase()`.
 */
function stripPragmas(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().toUpperCase().startsWith('PRAGMA'))
    .join('\n');
}

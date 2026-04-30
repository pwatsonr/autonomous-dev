/**
 * Type definitions for the SQLite migration framework.
 *
 * Implements SPEC-012-2-02 §Types. The runtime engine in `migrator.ts`
 * consumes these shapes; tests in `intake/__tests__/db/` assert against them.
 *
 * @module migrator.types
 */

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
  readonly name: string; // Filename
  readonly applied_at: string; // ISO 8601 UTC
}

/** Outcome of a `runMigrations()` invocation. */
export interface MigrationResult {
  /** Filenames newly applied this run. */
  readonly applied: readonly string[];
  /** Filenames already in `_migrations`. */
  readonly skipped: readonly string[];
  /** Highest numeric prefix applied (0 if none). */
  readonly schemaVersion: number;
}

/**
 * Error thrown by the migration runner.
 *
 * The runner uses this exclusively; callers (e.g. daemon startup) can
 * `instanceof MigrationError` to differentiate from generic IO/SQL errors.
 */
export class MigrationError extends Error {
  constructor(
    message: string,
    public readonly migrationFile?: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

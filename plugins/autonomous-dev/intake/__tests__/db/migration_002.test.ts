/**
 * Schema + migration tests for `002_add_source_metadata.sql` (SPEC-012-2-04).
 *
 * Covers:
 *  - Migration applies cleanly to a fresh DB (001 + 002 in order).
 *  - Migration is idempotent (second run = no-op).
 *  - v1 rows get backfilled with defaults (`source='cli'`, `adapter_metadata='{}'`).
 *  - CHECK constraint rejects unknown source values.
 *  - CHECK constraint rejects malformed adapter_metadata JSON.
 *  - schema_version table (`_migrations`) records the applied migration.
 *  - Required indexes exist after migration.
 *
 * All tests use in-memory SQLite (`:memory:`); no shared state.
 *
 * @module __tests__/db/migration_002.test
 */

import * as path from 'path';

import {
  openDatabase,
  runMigrations,
  type MigrationResult,
} from '../../db/migrator';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');
const MIGRATION_001 = '001_initial.sql';
const MIGRATION_002 = '002_add_source_metadata.sql';

const VALID_SOURCES = [
  'cli',
  'claude-app',
  'discord',
  'slack',
  'production-intelligence',
  'portal',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Database = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Open an in-memory DB and return the raw handle. */
function openMemoryDb(): Database {
  return openDatabase(':memory:');
}

/**
 * Insert a v1-shape row into `requests` using ONLY the v1 columns.
 * Used to seed legacy data before applying 002.
 */
function insertV1Row(db: Database, requestId: string): void {
  db.prepare(
    `INSERT INTO requests (
       request_id, title, description, raw_input, priority, status,
       current_phase, requester_id, source_channel
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    requestId,
    'Legacy request',
    'A request inserted before migration 002.',
    'raw input',
    'normal',
    'queued',
    'queued',
    'legacy-user',
    'claude_app',
  );
}

/**
 * Insert a minimal v2-shape row. Optionally override source/adapter_metadata
 * to test CHECK constraints and defaults.
 */
function insertV2Row(
  db: Database,
  requestId: string,
  opts: { source?: string; adapter_metadata?: string } = {},
): void {
  const cols = [
    'request_id',
    'title',
    'description',
    'raw_input',
    'priority',
    'status',
    'current_phase',
    'requester_id',
    'source_channel',
  ];
  const vals: unknown[] = [
    requestId,
    'v2 request',
    'description',
    'raw',
    'normal',
    'queued',
    'queued',
    'user-1',
    'claude_app',
  ];

  if (opts.source !== undefined) {
    cols.push('source');
    vals.push(opts.source);
  }
  if (opts.adapter_metadata !== undefined) {
    cols.push('adapter_metadata');
    vals.push(opts.adapter_metadata);
  }

  const placeholders = cols.map(() => '?').join(', ');
  db.prepare(
    `INSERT INTO requests (${cols.join(', ')}) VALUES (${placeholders})`,
  ).run(...vals);
}

/** Return the column names of a table. */
function columnNames(db: Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.map((r) => r.name);
}

/** Check whether an index by name exists. */
function indexExists(db: Database, name: string): boolean {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`,
    )
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('Migration 002: schema additions', () => {
  let db: Database;

  beforeEach(() => {
    db = openMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  test('applies cleanly to a fresh DB (001 + 002 in order)', () => {
    const result: MigrationResult = runMigrations(db, MIGRATIONS_DIR);

    expect(result.applied).toEqual([MIGRATION_001, MIGRATION_002]);
    expect(result.skipped).toEqual([]);
    expect(result.schemaVersion).toBe(2);

    const cols = columnNames(db, 'requests');
    expect(cols).toContain('source');
    expect(cols).toContain('adapter_metadata');
  });

  test('creates idx_requests_source after migration', () => {
    runMigrations(db, MIGRATIONS_DIR);
    expect(indexExists(db, 'idx_requests_source')).toBe(true);
  });

  test('creates idx_requests_source_status composite index', () => {
    runMigrations(db, MIGRATIONS_DIR);
    expect(indexExists(db, 'idx_requests_source_status')).toBe(true);
  });

  test('records both migrations in _migrations tracking table', () => {
    runMigrations(db, MIGRATIONS_DIR);
    const rows = db
      .prepare('SELECT name FROM _migrations ORDER BY name')
      .all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual([MIGRATION_001, MIGRATION_002]);
  });
});

describe('Migration 002: idempotency', () => {
  let db: Database;

  beforeEach(() => {
    db = openMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  test('second run is a no-op (applied: [], skipped: both)', () => {
    runMigrations(db, MIGRATIONS_DIR); // first run
    const result = runMigrations(db, MIGRATIONS_DIR); // second run

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([MIGRATION_001, MIGRATION_002]);
    expect(result.schemaVersion).toBe(2);
  });

  test('three consecutive runs leave schema_version at 2', () => {
    runMigrations(db, MIGRATIONS_DIR);
    runMigrations(db, MIGRATIONS_DIR);
    const third = runMigrations(db, MIGRATIONS_DIR);
    expect(third.schemaVersion).toBe(2);
    expect(third.applied).toEqual([]);
  });
});

describe('Migration 002: v1 row backfill', () => {
  let db: Database;

  beforeEach(() => {
    db = openMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  test('inserts v1 rows pre-migration; 002 backfills source=cli + adapter_metadata={}', () => {
    // Drive the DB to a "v1-only" state: apply 001 directly via SQL, then
    // pre-populate `_migrations` with 001's row so the runner believes 001
    // is already applied and only runs 002 on this DB. We can't simply call
    // runMigrations twice because 001 uses bare `CREATE INDEX` (no IF NOT
    // EXISTS) and would fail on the second exec.
    const fs = require('fs') as typeof import('fs');
    const initialSql = fs.readFileSync(
      path.join(MIGRATIONS_DIR, MIGRATION_001),
      'utf-8',
    );
    const executable = initialSql
      .split('\n')
      .filter((l: string) => !l.trim().toUpperCase().startsWith('PRAGMA'))
      .join('\n');
    db.exec(executable);

    // Mark 001 as already applied in _migrations so the runner skips it.
    db.exec(
      `CREATE TABLE IF NOT EXISTS _migrations (
         name TEXT PRIMARY KEY,
         applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       )`,
    );
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(MIGRATION_001);

    // Seed three v1 rows (no source / adapter_metadata columns yet).
    insertV1Row(db, 'REQ-V1-001');
    insertV1Row(db, 'REQ-V1-002');
    insertV1Row(db, 'REQ-V1-003');

    // Apply 002 via the runner — the only pending migration.
    const result = runMigrations(db, MIGRATIONS_DIR);
    expect(result.applied).toEqual([MIGRATION_002]);
    expect(result.skipped).toEqual([MIGRATION_001]);

    const rows = db
      .prepare(
        'SELECT request_id, source, adapter_metadata FROM requests ORDER BY request_id',
      )
      .all() as Array<{
      request_id: string;
      source: string;
      adapter_metadata: string;
    }>;

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.source).toBe('cli');
      expect(row.adapter_metadata).toBe('{}');
    }
  });
});

describe('Migration 002: CHECK constraints', () => {
  let db: Database;

  beforeEach(() => {
    db = openMemoryDb();
    runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(() => {
    db.close();
  });

  test('source CHECK accepts every documented value', () => {
    let i = 0;
    for (const src of VALID_SOURCES) {
      i += 1;
      expect(() =>
        insertV2Row(db, `REQ-VALID-${i}`, { source: src }),
      ).not.toThrow();
    }
    const cnt = (
      db.prepare('SELECT COUNT(*) AS c FROM requests').get() as { c: number }
    ).c;
    expect(cnt).toBe(VALID_SOURCES.length);
  });

  test('source CHECK rejects unknown values', () => {
    const bad = ['hax', 'urgent', 'CLI', 'Discord', '', 'unknown'];
    let i = 0;
    for (const src of bad) {
      i += 1;
      expect(() =>
        insertV2Row(db, `REQ-BAD-${i}`, { source: src }),
      ).toThrow(/CHECK constraint failed/i);
    }
  });

  test('adapter_metadata json_valid CHECK rejects malformed JSON', () => {
    expect(() =>
      insertV2Row(db, 'REQ-JSON-1', { adapter_metadata: 'not json' }),
    ).toThrow(/CHECK constraint failed/i);
    expect(() =>
      insertV2Row(db, 'REQ-JSON-2', { adapter_metadata: '{' }),
    ).toThrow(/CHECK constraint failed/i);
  });

  test('adapter_metadata json_valid CHECK accepts valid JSON shapes', () => {
    expect(() =>
      insertV2Row(db, 'REQ-JSON-OK-1', { adapter_metadata: '{}' }),
    ).not.toThrow();
    expect(() =>
      insertV2Row(db, 'REQ-JSON-OK-2', {
        adapter_metadata: '{"source":"cli"}',
      }),
    ).not.toThrow();
    expect(() =>
      insertV2Row(db, 'REQ-JSON-OK-3', {
        adapter_metadata: '{"valid":true}',
      }),
    ).not.toThrow();
  });

  test('default values applied when columns omitted', () => {
    insertV2Row(db, 'REQ-DEFAULT-1');
    const row = db
      .prepare(
        'SELECT source, adapter_metadata FROM requests WHERE request_id = ?',
      )
      .get('REQ-DEFAULT-1') as { source: string; adapter_metadata: string };
    expect(row.source).toBe('cli');
    expect(row.adapter_metadata).toBe('{}');
  });
});

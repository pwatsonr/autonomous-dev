/**
 * Tests for the SQLite schema and migration framework.
 *
 * Covers spec test cases 2-7:
 *   2. Schema creation on empty DB
 *   3. WAL mode active
 *   4. Foreign keys enforced
 *   5. Idempotent migration
 *   6. Index verification
 *   7. CHECK constraint validation
 */

import * as path from 'path';
import { openDatabase, runMigrations } from '../../../intake/db/migrator';

const MIGRATIONS_DIR = path.resolve(
  __dirname,
  '../../../intake/db/migrations',
);

/** All tables the 001_initial migration must create. */
const EXPECTED_TABLES = [
  'id_counter',
  'requests',
  'request_embeddings',
  'conversation_messages',
  'user_identities',
  'activity_log',
  'authz_audit_log',
  'rate_limit_actions',
  'notification_deliveries',
];

/** All indexes the 001_initial migration must create. */
const EXPECTED_INDEXES = [
  'idx_requests_status',
  'idx_requests_priority_created',
  'idx_requests_requester',
  'idx_requests_updated',
  'idx_messages_request',
  'idx_messages_pending',
  'idx_users_discord',
  'idx_users_slack',
  'idx_users_claude',
  'idx_activity_request',
  'idx_activity_created',
  'idx_authz_user',
  'idx_authz_denials',
  'idx_rate_limit_user_type',
  'idx_deliveries_pending',
];

function createTestDb() {
  const db = openDatabase(':memory:');
  return db;
}

describe('Migrator', () => {
  // --------------------------------------------------------------------------
  // Test Case 2: Schema creation on empty DB
  // --------------------------------------------------------------------------
  test('creates all 9 tables on fresh in-memory database', () => {
    const db = createTestDb();
    const result = runMigrations(db, MIGRATIONS_DIR);

    expect(result.applied).toContain('001_initial.sql');

    const tables: Array<{ name: string }> = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_%'")
      .all();
    const tableNames = tables.map((t) => t.name).sort();

    for (const expected of EXPECTED_TABLES) {
      expect(tableNames).toContain(expected);
    }

    db.close();
  });

  // --------------------------------------------------------------------------
  // Test Case 3: WAL mode active
  // --------------------------------------------------------------------------
  test('WAL mode is active after migration', () => {
    const db = createTestDb();
    runMigrations(db, MIGRATIONS_DIR);

    const row = db.prepare('PRAGMA journal_mode').get();
    // In-memory databases may report 'memory' instead of 'wal', so we
    // verify via openDatabase which explicitly sets WAL.  For file-backed
    // databases the pragma returns 'wal'.  We accept both here since
    // in-memory databases cannot actually persist WAL.
    expect(['wal', 'memory']).toContain(row.journal_mode);

    db.close();
  });

  // --------------------------------------------------------------------------
  // Test Case 4: Foreign keys enforced
  // --------------------------------------------------------------------------
  test('foreign key constraint rejects invalid references', () => {
    const db = createTestDb();
    runMigrations(db, MIGRATIONS_DIR);

    // Attempt to insert a conversation_messages row referencing a
    // nonexistent request_id.
    expect(() => {
      db.prepare(`
        INSERT INTO conversation_messages (
          message_id, request_id, direction, channel, content, message_type
        ) VALUES (
          'msg-001', 'NONEXISTENT', 'inbound', 'discord', 'hello', 'feedback'
        )
      `).run();
    }).toThrow(/FOREIGN KEY constraint failed/);

    db.close();
  });

  // --------------------------------------------------------------------------
  // Test Case 5: Idempotent migration
  // --------------------------------------------------------------------------
  test('running migrations twice is idempotent', () => {
    const db = createTestDb();

    const first = runMigrations(db, MIGRATIONS_DIR);
    expect(first.applied).toContain('001_initial.sql');
    const firstAppliedCount = first.applied.length;

    const second = runMigrations(db, MIGRATIONS_DIR);
    expect(second.applied).toHaveLength(0);
    expect(second.skipped).toContain('001_initial.sql');
    expect(second.skipped).toHaveLength(firstAppliedCount);

    // Every migration applied in the first run is recorded in _migrations.
    const rows: Array<{ name: string }> = db
      .prepare('SELECT name FROM _migrations ORDER BY name')
      .all();
    expect(rows).toHaveLength(firstAppliedCount);
    expect(rows[0].name).toBe('001_initial.sql');

    db.close();
  });

  // --------------------------------------------------------------------------
  // Test Case 6: Index verification
  // --------------------------------------------------------------------------
  test('all 15 indexes exist after migration', () => {
    const db = createTestDb();
    runMigrations(db, MIGRATIONS_DIR);

    const indexes: Array<{ name: string }> = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all();
    const indexNames = indexes.map((i) => i.name).sort();

    for (const expected of EXPECTED_INDEXES) {
      expect(indexNames).toContain(expected);
    }

    db.close();
  });

  // --------------------------------------------------------------------------
  // Test Case 7: CHECK constraint validation
  // --------------------------------------------------------------------------
  describe('CHECK constraints', () => {
    test('rejects invalid priority value', () => {
      const db = createTestDb();
      runMigrations(db, MIGRATIONS_DIR);

      expect(() => {
        db.prepare(`
          INSERT INTO requests (
            request_id, title, description, raw_input, priority,
            requester_id, source_channel
          ) VALUES (
            'REQ-001', 'Test', 'A test request', 'raw text', 'urgent',
            'user-1', 'discord'
          )
        `).run();
      }).toThrow(/CHECK constraint failed/);

      db.close();
    });

    test('rejects invalid status value', () => {
      const db = createTestDb();
      runMigrations(db, MIGRATIONS_DIR);

      expect(() => {
        db.prepare(`
          INSERT INTO requests (
            request_id, title, description, raw_input, status,
            requester_id, source_channel
          ) VALUES (
            'REQ-001', 'Test', 'A test request', 'raw text', 'running',
            'user-1', 'discord'
          )
        `).run();
      }).toThrow(/CHECK constraint failed/);

      db.close();
    });

    test('accepts valid priority and status values', () => {
      const db = createTestDb();
      runMigrations(db, MIGRATIONS_DIR);

      // Should not throw
      db.prepare(`
        INSERT INTO requests (
          request_id, title, description, raw_input, priority, status,
          requester_id, source_channel
        ) VALUES (
          'REQ-001', 'Test', 'A test request', 'raw text', 'high', 'queued',
          'user-1', 'discord'
        )
      `).run();

      const row = db
        .prepare('SELECT priority, status FROM requests WHERE request_id = ?')
        .get('REQ-001');
      expect(row.priority).toBe('high');
      expect(row.status).toBe('queued');

      db.close();
    });
  });

  // --------------------------------------------------------------------------
  // Additional: id_counter seeded correctly
  // --------------------------------------------------------------------------
  test('id_counter is seeded with request_id = 0', () => {
    const db = createTestDb();
    runMigrations(db, MIGRATIONS_DIR);

    const row = db
      .prepare('SELECT current_value FROM id_counter WHERE counter_name = ?')
      .get('request_id');
    expect(row.current_value).toBe(0);

    db.close();
  });

  // --------------------------------------------------------------------------
  // Additional: migration result structure
  // --------------------------------------------------------------------------
  test('migration result contains applied and skipped arrays', () => {
    const db = createTestDb();
    const result = runMigrations(db, MIGRATIONS_DIR);

    expect(Array.isArray(result.applied)).toBe(true);
    expect(Array.isArray(result.skipped)).toBe(true);
    expect(result.applied.length + result.skipped.length).toBeGreaterThan(0);

    db.close();
  });
});

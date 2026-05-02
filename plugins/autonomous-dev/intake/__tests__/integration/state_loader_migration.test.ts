/**
 * Integration test for state-loader v1.0 → v1.1 auto-migration on read
 * (SPEC-018-1-04, Task 9).
 *
 * Exercises the real filesystem via `fs.mkdtemp` (no fs mocks) so the
 * temp+rename atomicity path and `.v1.0.backup` creation are observed
 * end-to-end.
 *
 * @module __tests__/integration/state_loader_migration.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  StateValidationError,
  loadState,
  validateV1_1,
} from '../../state/state_loader';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function v1_0Fixture(extra: Record<string, unknown> = {}): unknown {
  return {
    schema_version: 1.0,
    id: 'req-fixture-001',
    status: 'queued',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    phase_history: [],
    current_phase_metadata: {},
    ...extra,
  };
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
}

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'state-loader-it-'));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Single-file scenario
// ---------------------------------------------------------------------------

describe('loadState() — single-file v1.0 migration', () => {
  test('returns v1.1 in memory + persists upgrade + creates .v1.0.backup', () => {
    const file = path.join(tempRoot, 'state.json');
    const original = v1_0Fixture();
    writeJson(file, original);

    const loaded = loadState(file);

    // 1. In-memory: v1.1
    expect(loaded.schema_version).toBe(1.1);
    expect(loaded.request_type).toBe('feature');
    expect(loaded.phase_overrides).toHaveLength(14);

    // 2. On disk: v1.1
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk.schema_version).toBe(1.1);

    // 3. Backup contains the original (pre-migration) v1.0 bytes.
    const backupPath = `${file}.v1.0.backup`;
    expect(fs.existsSync(backupPath)).toBe(true);
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
    expect(backup.schema_version).toBe(1.0);
    expect(backup).toEqual(original);

    // 4. In-memory object passes v1.1 validation.
    expect(validateV1_1(loaded)).toEqual([]);
  });

  test('preserves an unknown extra field through the migration', () => {
    const file = path.join(tempRoot, 'state.json');
    writeJson(file, v1_0Fixture({ experimental_field: { value: 42 } }));

    const loaded = loadState(file);

    expect((loaded as Record<string, unknown>).experimental_field).toEqual({ value: 42 });
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('loadState() — idempotency', () => {
  test('second call does not modify file mtime or create a new backup', () => {
    const file = path.join(tempRoot, 'state.json');
    writeJson(file, v1_0Fixture());

    loadState(file); // first migration
    const mtimeAfter1 = fs.statSync(file).mtimeMs;
    const backupBytes1 = fs.readFileSync(`${file}.v1.0.backup`);

    // Sleep just enough that any rewrite would advance mtime visibly.
    const wait = 25;
    const target = Date.now() + wait;
    while (Date.now() < target) { /* spin */ }

    loadState(file); // fast-path: already v1.1
    const mtimeAfter2 = fs.statSync(file).mtimeMs;
    const backupBytes2 = fs.readFileSync(`${file}.v1.0.backup`);

    expect(mtimeAfter2).toBe(mtimeAfter1);
    expect(backupBytes2.equals(backupBytes1)).toBe(true);
  });

  test('v1.1 fast-path: no backup created, no rewrite', () => {
    const file = path.join(tempRoot, 'state.json');
    writeJson(file, {
      schema_version: 1.1,
      id: 'r',
      status: 'queued',
      request_type: 'bug',
      phase_overrides: ['intake'],
      type_config: {
        skippedPhases: [],
        enhancedPhases: [],
        expeditedReviews: false,
        additionalGates: [],
        maxRetries: 3,
        phaseTimeouts: {},
      },
    });
    const mtimeBefore = fs.statSync(file).mtimeMs;

    const loaded = loadState(file);

    expect(loaded.schema_version).toBe(1.1);
    expect(loaded.request_type).toBe('bug');
    expect(fs.existsSync(`${file}.v1.0.backup`)).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBe(mtimeBefore);
  });
});

// ---------------------------------------------------------------------------
// Multi-file scenario
// ---------------------------------------------------------------------------

describe('loadState() — multi-file scenario', () => {
  test('migrates each file independently; backups exist for all', () => {
    const fileA = path.join(tempRoot, 'req-a', 'state.json');
    const fileB = path.join(tempRoot, 'req-b', 'state.json');
    writeJson(fileA, v1_0Fixture({ id: 'A' }));
    writeJson(fileB, v1_0Fixture({ id: 'B' }));

    const a = loadState(fileA);
    const b = loadState(fileB);

    expect(a.schema_version).toBe(1.1);
    expect(b.schema_version).toBe(1.1);
    expect(a.id).toBe('A');
    expect(b.id).toBe('B');
    expect(fs.existsSync(`${fileA}.v1.0.backup`)).toBe(true);
    expect(fs.existsSync(`${fileB}.v1.0.backup`)).toBe(true);

    // Re-loading neither creates new backups nor modifies the files.
    const mtimeA1 = fs.statSync(fileA).mtimeMs;
    const mtimeB1 = fs.statSync(fileB).mtimeMs;
    loadState(fileA);
    loadState(fileB);
    expect(fs.statSync(fileA).mtimeMs).toBe(mtimeA1);
    expect(fs.statSync(fileB).mtimeMs).toBe(mtimeB1);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('loadState() — error paths', () => {
  test('throws StateValidationError for schema_version 2.0 (message names path)', () => {
    const file = path.join(tempRoot, 'state.json');
    writeJson(file, { schema_version: 2.0, id: 'r' });

    try {
      loadState(file);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StateValidationError);
      expect((err as Error).message).toContain(file);
      expect((err as StateValidationError).errors[0]?.keyword).toBe('const');
    }
  });

  test('throws StateValidationError when an upgraded object fails v1.1 validation', () => {
    const file = path.join(tempRoot, 'state.json');
    // Forge a v1.1 file that violates type_config schema.
    writeJson(file, {
      schema_version: 1.1,
      id: 'r',
      status: 'queued',
      phase_overrides: [],
      type_config: {
        skippedPhases: [],
        enhancedPhases: [],
        expeditedReviews: false,
        additionalGates: [],
        // maxRetries missing; phaseTimeouts missing
      },
    });

    expect(() => loadState(file)).toThrow(StateValidationError);
  });

  test('bubbles up the underlying JSON.parse error on malformed JSON', () => {
    const file = path.join(tempRoot, 'state.json');
    fs.writeFileSync(file, '{not json', 'utf-8');
    expect(() => loadState(file)).toThrow(SyntaxError);
  });
});

/**
 * REQ-000059 regression tests for journal_replay tombstone short-circuits.
 *
 * Verifies that the `CANCELLED_SKIPPED` mismatch type is emitted for:
 *   - Present-Present with tombstone (T-J-01).
 *   - Present-FS-missing with status='cancelled' (legacy back-fill) (T-J-02).
 *   - Missing-Present with tombstone (T-J-03).
 *   - Missing-Present with state.json.status='cancelled' and no tombstone (T-J-04).
 *
 * Covers T-J-01 through T-J-04 from spec §5.4.
 *
 * @module __tests__/recovery/journal_replay_cancelled.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { RequestEntity } from '../../db/repository';
import { replayJournal, type JournalDb } from '../../recovery/journal_replay';
import { CANCELLED_TOMBSTONE_BASENAME } from '../../handlers/cancel_finalizer';

// ---------------------------------------------------------------------------
// In-memory JournalDb adapter
// ---------------------------------------------------------------------------

class MemDb implements JournalDb {
  private rows: Map<string, RequestEntity> = new Map();

  /** Tracking for test assertions. */
  readonly insertCalls: RequestEntity[] = [];
  readonly updateCalls: Array<[string, Partial<RequestEntity>]> = [];

  seed(entities: RequestEntity[]): void {
    for (const e of entities) {
      this.rows.set(e.request_id, e);
    }
  }

  listAll(): RequestEntity[] {
    return Array.from(this.rows.values());
  }

  getRequest(requestId: string): RequestEntity | null {
    return this.rows.get(requestId) ?? null;
  }

  insertRequest(entity: RequestEntity): void {
    this.insertCalls.push(entity);
    this.rows.set(entity.request_id, entity);
  }

  updateRequest(requestId: string, updates: Partial<RequestEntity>): void {
    this.updateCalls.push([requestId, updates]);
    const existing = this.rows.get(requestId);
    if (existing) {
      this.rows.set(requestId, { ...existing, ...updates });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-replay-cancelled-'));
  return fs.realpathSync(dir);
}

function makeEntity(repo: string, idSuffix: number, overrides: Partial<RequestEntity> = {}): RequestEntity {
  const requestId = `REQ-${String(idSuffix).padStart(6, '0')}`;
  const created = new Date('2026-05-01T10:00:00.000Z').toISOString();
  return {
    request_id: requestId,
    title: 'replay test',
    description: 'replay test description',
    raw_input: 'replay test description',
    priority: 'normal',
    target_repo: repo,
    status: 'queued',
    current_phase: 'queued',
    phase_progress: null,
    requester_id: 'cli',
    source_channel: 'claude_app',
    notification_config: '{}',
    deadline: null,
    related_tickets: '[]',
    technical_constraints: null,
    acceptance_criteria: null,
    blocker: null,
    promotion_count: 0,
    last_promoted_at: null,
    paused_at_phase: null,
    type: 'feature',
    source: 'cli',
    adapter_metadata: { source: 'cli', pid: process.pid },
    created_at: created,
    updated_at: created,
    ...overrides,
  };
}

function plantStateJson(repo: string, requestId: string, data: Record<string, unknown>): void {
  const reqDir = path.join(repo, '.autonomous-dev', 'requests', requestId);
  fs.mkdirSync(reqDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(reqDir, 'state.json'), JSON.stringify(data), 'utf-8');
}

function plantTombstone(repo: string, requestId: string): void {
  const reqDir = path.join(repo, '.autonomous-dev', 'requests', requestId);
  fs.mkdirSync(reqDir, { recursive: true, mode: 0o700 });
  const tombPath = path.join(reqDir, CANCELLED_TOMBSTONE_BASENAME);
  if (!fs.existsSync(tombPath)) {
    fs.closeSync(
      fs.openSync(tombPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600),
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('replayJournal tombstone short-circuits (REQ-000059)', () => {
  let repo: string;

  beforeEach(() => {
    repo = tmpRepo();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // T-J-01: Present-Present with tombstone → CANCELLED_SKIPPED, no update
  // -------------------------------------------------------------------------
  test('T-J-01: tombstoned Present-Present emits CANCELLED_SKIPPED and skips SQLite update', async () => {
    const reqId = 'REQ-000001';

    const db = new MemDb();
    // SQLite row status=cancelled, priority=1.
    db.seed([makeEntity(repo, 1, { status: 'cancelled', priority: 'high' })]);

    // state.json with status=running (drift) + tombstone.
    plantStateJson(repo, reqId, {
      id: reqId,
      request_id: reqId,
      status: 'running',
      priority: 'normal',
      description: 'replay test description',
      repository: repo,
      source: 'cli',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    plantTombstone(repo, reqId);

    const report = await replayJournal(repo, db);

    const mismatch = report.mismatches.find(
      (m) => m.requestId === reqId && m.type === 'CANCELLED_SKIPPED',
    );
    expect(mismatch).toBeDefined();
    expect(mismatch!.details).toMatch(/tombstone present/);

    // db.updateRequest must NOT have been called for this request.
    const updateCalls = db.updateCalls.filter(([id]) => id === reqId);
    expect(updateCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // T-J-02: Present-FS-missing with status=cancelled → back-fill tombstone
  // -------------------------------------------------------------------------
  test('T-J-02: legacy cancelled row without tombstone → back-fills tombstone and emits CANCELLED_SKIPPED', async () => {
    const reqId = 'REQ-000002';

    const db = new MemDb();
    // SQLite row with status=cancelled, no state.json on disk, no tombstone.
    db.seed([makeEntity(repo, 2, { status: 'cancelled' })]);
    // Ensure the request directory exists (no state.json though).
    const reqDir = path.join(repo, '.autonomous-dev', 'requests', reqId);
    fs.mkdirSync(reqDir, { recursive: true, mode: 0o700 });

    const report = await replayJournal(repo, db);

    // Tombstone should be back-filled.
    expect(
      fs.existsSync(path.join(reqDir, CANCELLED_TOMBSTONE_BASENAME)),
    ).toBe(true);

    const mismatch = report.mismatches.find(
      (m) => m.requestId === reqId && m.type === 'CANCELLED_SKIPPED',
    );
    expect(mismatch).toBeDefined();
    expect(mismatch!.details).toMatch(/backfilled/);

    // Must NOT have been downgraded to orphaned_lost.
    const orphanMismatch = report.mismatches.find(
      (m) => m.requestId === reqId && m.type === 'ORPHANED_LOST',
    );
    expect(orphanMismatch).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // T-J-03: Missing-Present with tombstone → no INSERT
  // -------------------------------------------------------------------------
  test('T-J-03: Missing-Present with tombstone → CANCELLED_SKIPPED, no INSERT', async () => {
    const reqId = 'REQ-000003';

    const db = new MemDb();
    // No SQLite row. state.json has status=running. Tombstone present.
    plantStateJson(repo, reqId, {
      id: reqId,
      request_id: reqId,
      status: 'running',
      priority: 'normal',
      description: 'replay test description',
      repository: repo,
      source: 'cli',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    plantTombstone(repo, reqId);

    const report = await replayJournal(repo, db);

    const mismatch = report.mismatches.find(
      (m) => m.requestId === reqId && m.type === 'CANCELLED_SKIPPED',
    );
    expect(mismatch).toBeDefined();
    expect(mismatch!.details).toMatch(/tombstone present/);

    // insertRequest must NOT have been called.
    expect(db.insertCalls.filter((e) => e.request_id === reqId)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // T-J-04: Missing-Present with state.json.status=cancelled and no tombstone → no INSERT
  // -------------------------------------------------------------------------
  test('T-J-04: Missing-Present with state.json.status=cancelled → CANCELLED_SKIPPED, no INSERT', async () => {
    const reqId = 'REQ-000004';

    const db = new MemDb();
    // No SQLite row. state.json says cancelled. No tombstone.
    plantStateJson(repo, reqId, {
      id: reqId,
      request_id: reqId,
      status: 'cancelled',
      priority: 'normal',
      description: 'replay test description',
      repository: repo,
      source: 'cli',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const report = await replayJournal(repo, db);

    const mismatch = report.mismatches.find(
      (m) => m.requestId === reqId && m.type === 'CANCELLED_SKIPPED',
    );
    expect(mismatch).toBeDefined();
    expect(mismatch!.details).toMatch(/state\.json\.status=cancelled/);

    // insertRequest must NOT have been called.
    expect(db.insertCalls.filter((e) => e.request_id === reqId)).toHaveLength(0);
  });
});

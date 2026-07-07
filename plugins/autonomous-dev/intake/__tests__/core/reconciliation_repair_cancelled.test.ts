/**
 * REQ-000059 regression tests for ReconciliationManager tombstone short-circuits.
 *
 * Verifies that tombstoned (cancelled) requests are:
 *   - Not surfaced as divergence by detectDivergence (T-R-01).
 *   - Short-circuited in repair with action='skipped' (T-R-02).
 *   - Not resurrected by the "FS newer content_mismatch" path (T-R-03).
 *
 * Covers T-R-01, T-R-02, T-R-03 from spec §5.3.
 *
 * @module __tests__/core/reconciliation_repair_cancelled.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { initializeDatabase } from '../../db/migrator';
import { Repository, type RequestEntity } from '../../db/repository';
import type { Logger } from '../../authz/audit_logger';

import { ReconciliationManager } from '../../core/reconciliation_manager';
import { CANCELLED_TOMBSTONE_BASENAME } from '../../handlers/cancel_finalizer';

// ---------------------------------------------------------------------------
// Test harness (mirrors reconciliation_manager.test.ts)
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

interface Ctx {
  repo: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  repoApi: Repository;
  manager: ReconciliationManager;
}

function noopLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function setup(): Ctx {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-dev-cancel-reconcile-'));
  const repo = fs.realpathSync(repoDir);
  const { db } = initializeDatabase(':memory:', MIGRATIONS_DIR);
  const repoApi = new Repository(db);
  const manager = new ReconciliationManager(repoApi, noopLogger());
  return { repo, db, repoApi, manager };
}

function teardown(ctx: Ctx): void {
  try { ctx.db.close(); } catch { /* ignore */ }
  try { fs.rmSync(ctx.repo, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeEntity(repo: string, idSuffix: number, overrides: Partial<RequestEntity> = {}): RequestEntity {
  const requestId = `REQ-${String(idSuffix).padStart(6, '0')}`;
  const created = new Date('2026-05-01T10:00:00.000Z').toISOString();
  return {
    request_id: requestId,
    title: 'tombstone test',
    description: 'tombstone test description',
    raw_input: 'tombstone test description',
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

function plantTombstone(repo: string, requestId: string): void {
  const reqDir = path.join(repo, '.autonomous-dev', 'requests', requestId);
  fs.mkdirSync(reqDir, { recursive: true, mode: 0o700 });
  fs.closeSync(
    fs.openSync(
      path.join(reqDir, CANCELLED_TOMBSTONE_BASENAME),
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    ),
  );
}

function plantStateJson(
  repo: string,
  requestId: string,
  data: Record<string, unknown>,
  opts?: { mtimeMs?: number },
): string {
  const reqDir = path.join(repo, '.autonomous-dev', 'requests', requestId);
  fs.mkdirSync(reqDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(reqDir, 'state.json');
  fs.writeFileSync(statePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  if (opts?.mtimeMs !== undefined) {
    const seconds = opts.mtimeMs / 1000;
    fs.utimesSync(statePath, seconds, seconds);
  }
  return statePath;
}

// ---------------------------------------------------------------------------
// T-R-01: detectDivergence returns empty for tombstoned request
// ---------------------------------------------------------------------------

describe('ReconciliationManager tombstone short-circuits (REQ-000059)', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { teardown(ctx); });

  test('T-R-01: detectDivergence returns no report for tombstoned request', async () => {
    const reqId = 'REQ-000001';

    // Plant stale state.json (status=running, stale) + tombstone.
    plantStateJson(ctx.repo, reqId, {
      id: reqId,
      status: 'running',
      priority: 'normal',
      description: 'test',
      repository: ctx.repo,
      source: 'cli',
      created_at: new Date('2026-05-01T10:00:00.000Z').toISOString(),
      updated_at: new Date('2026-05-01T10:00:00.000Z').toISOString(),
    });
    plantTombstone(ctx.repo, reqId);

    // SQLite row with status=cancelled.
    ctx.repoApi.insertRequest(makeEntity(ctx.repo, 1, { status: 'cancelled' }));

    const reports = await ctx.manager.detectDivergence(ctx.repo);
    const forReq = reports.filter((r) => r.request_id === reqId);
    expect(forReq).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // T-R-02: repair short-circuits with action='skipped' for tombstoned request
  // -------------------------------------------------------------------------
  test('T-R-02: repair returns skipped with tombstone message for tombstoned request', async () => {
    const reqId = 'REQ-000001';
    plantTombstone(ctx.repo, reqId);

    const result = await ctx.manager.repair(
      {
        request_id: reqId,
        repository: ctx.repo,
        category: 'content_mismatch',
        description: 'test divergence',
        detected_at: new Date().toISOString(),
      },
      { confirm: async () => true },
    );

    expect(result.action).toBe('skipped');
    expect(result.error_message).toMatch(/tombstone/i);
  });

  // -------------------------------------------------------------------------
  // T-R-03: "FS newer content_mismatch" hole no longer resurrects SQLite
  // -------------------------------------------------------------------------
  test('T-R-03: tombstone prevents FS-newer content_mismatch from updating SQLite', async () => {
    const reqId = 'REQ-000001';

    // SQLite row with status=cancelled, updated_at in the past.
    const sqliteUpdatedAt = new Date('2026-05-01T10:00:00.000Z');
    const fsTimestamp = new Date(sqliteUpdatedAt.getTime() + 60_000); // fs is 60s newer

    ctx.repoApi.insertRequest(makeEntity(ctx.repo, 1, {
      status: 'cancelled',
      updated_at: sqliteUpdatedAt.toISOString(),
    }));

    // Plant state.json with status=running (drift) and newer mtime.
    const statePath = plantStateJson(
      ctx.repo,
      reqId,
      {
        id: reqId,
        request_id: reqId,
        status: 'running',
        priority: 'normal',
        description: 'tombstone test description',
        repository: ctx.repo,
        source: 'cli',
        created_at: sqliteUpdatedAt.toISOString(),
        updated_at: fsTimestamp.toISOString(),
      },
      { mtimeMs: fsTimestamp.getTime() },
    );
    void statePath;

    // Plant tombstone.
    plantTombstone(ctx.repo, reqId);

    // Spy on updateRequest to assert it is never called for this request.
    const updateSpy = jest.spyOn(ctx.repoApi, 'updateRequest');

    const reports = await ctx.manager.detectDivergence(ctx.repo);

    // No divergence should be surfaced.
    expect(reports.filter((r) => r.request_id === reqId)).toHaveLength(0);

    // updateRequest should NOT have been called.
    const callsForReq = updateSpy.mock.calls.filter(([id]) => id === reqId);
    expect(callsForReq).toHaveLength(0);

    updateSpy.mockRestore();
  });
});

/**
 * ReconciliationManager.detectDivergence tests (SPEC-012-3-01).
 *
 * Each test sets up a fresh repo + sqlite DB, plants known fixtures on
 * disk and in SQLite, and asserts the {@link DivergenceReport[]} returned
 * by `detectDivergence`.
 *
 * @module __tests__/core/reconciliation_manager.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { initializeDatabase } from '../../db/migrator';
import { Repository, type RequestEntity } from '../../db/repository';
import type { Logger } from '../../authz/audit_logger';

import { ReconciliationManager } from '../../core/reconciliation_manager';
import { ReconcileBusyError } from '../../core/types/reconciliation';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

interface Ctx {
  repo: string;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  db: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  repoApi: Repository;
  manager: ReconciliationManager;
  logger: Logger;
}

function noopLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function setup(): Ctx {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-dev-reconcile-'));
  const realRepo = fs.realpathSync(repoDir);

  const { db } = initializeDatabase(':memory:', MIGRATIONS_DIR);
  const repoApi = new Repository(db);
  const logger = noopLogger();
  const manager = new ReconciliationManager(repoApi, logger);

  return { repo: realRepo, db, repoApi, manager, logger };
}

function teardown(ctx: Ctx): void {
  try {
    ctx.db.close();
  } catch {
    // ignore
  }
  try {
    fs.rmSync(ctx.repo, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function makeRequest(
  repo: string,
  idSuffix: number,
  overrides: Partial<RequestEntity> = {},
): RequestEntity {
  const requestId = `REQ-${String(idSuffix).padStart(6, '0')}`;
  const created = new Date('2026-04-30T10:00:00.000Z').toISOString();
  return {
    request_id: requestId,
    title: 'reconcile test',
    description: 'test description',
    raw_input: 'test description',
    priority: 'normal',
    target_repo: repo,
    status: 'queued',
    current_phase: 'queued',
    phase_progress: null,
    requester_id: 'cli',
    // SQLite v1 CHECK constraint only knows the legacy channel domain;
    // map our v2 'cli' source to 'claude_app' here for storage purposes.
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
    source: 'cli',
    adapter_metadata: { source: 'cli', pid: process.pid },
    created_at: created,
    updated_at: created,
    ...overrides,
  };
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

function plantRawStateFile(
  repo: string,
  requestId: string,
  raw: string,
): string {
  const reqDir = path.join(repo, '.autonomous-dev', 'requests', requestId);
  fs.mkdirSync(reqDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(reqDir, 'state.json');
  fs.writeFileSync(statePath, raw, 'utf-8');
  return statePath;
}

function canonicalState(req: RequestEntity): Record<string, unknown> {
  return {
    schema_version: 1,
    request_id: req.request_id,
    status: req.status,
    priority: req.priority,
    description: req.description,
    repository: req.target_repo,
    source: req.source,
    adapter_metadata: req.adapter_metadata,
    created_at: req.created_at,
    updated_at: req.updated_at,
    phase_history: [],
    current_phase_metadata: {},
    cost_accrued_usd: 0,
    turn_count: 0,
    escalation_count: 0,
    blocked_by: [],
    error: null,
    last_checkpoint: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectDivergence — clean repo', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    teardown(ctx);
  });

  test('returns [] when SQLite + state.json are perfectly aligned', async () => {
    const req = makeRequest(ctx.repo, 1);
    ctx.repoApi.insertRequest(req);

    const futureMs = Date.now() + 5000;
    plantStateJson(ctx.repo, req.request_id, canonicalState(req), {
      mtimeMs: futureMs,
    });

    const reports = await ctx.manager.detectDivergence(ctx.repo);
    expect(reports).toEqual([]);
  });

  test('returns [] when requests dir does not exist at all', async () => {
    const reports = await ctx.manager.detectDivergence(ctx.repo);
    expect(reports).toEqual([]);
  });
});

describe('detectDivergence — missing_file', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    teardown(ctx);
  });

  test('emits exactly one missing_file when SQLite has request but no state.json', async () => {
    // requests dir must exist for detectDivergence to scan
    fs.mkdirSync(path.join(ctx.repo, '.autonomous-dev', 'requests'), {
      recursive: true,
    });

    const req = makeRequest(ctx.repo, 1);
    ctx.repoApi.insertRequest(req);

    const reports = await ctx.manager.detectDivergence(ctx.repo);
    expect(reports).toHaveLength(1);
    expect(reports[0].category).toBe('missing_file');
    expect(reports[0].request_id).toBe(req.request_id);
    expect(reports[0].sqlite_state).toBeDefined();
    expect(reports[0].sqlite_updated_at).toBeDefined();
    expect(typeof reports[0].sqlite_updated_at).toBe('number');
  });
});

describe('detectDivergence — stale_file', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    teardown(ctx);
  });

  test('emits stale_file when state.json mtime is older than SQLite updated_at', async () => {
    // SQLite says "updated 1 hour ago"; FS says "5 hours ago".
    const sqliteUpdatedIso = new Date('2026-04-30T10:00:00.000Z').toISOString();
    const fsMtimeMs = new Date('2026-04-30T05:00:00.000Z').getTime();

    const req = makeRequest(ctx.repo, 2, {
      created_at: sqliteUpdatedIso,
      updated_at: sqliteUpdatedIso,
    });
    ctx.repoApi.insertRequest(req);

    plantStateJson(ctx.repo, req.request_id, canonicalState(req), {
      mtimeMs: fsMtimeMs,
    });

    const reports = await ctx.manager.detectDivergence(ctx.repo);
    expect(reports).toHaveLength(1);
    expect(reports[0].category).toBe('stale_file');
    expect(reports[0].sqlite_updated_at).toBe(new Date(sqliteUpdatedIso).getTime());
    expect(reports[0].filesystem_mtime_ms).toBe(fsMtimeMs);
  });
});

describe('detectDivergence — content_mismatch', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    teardown(ctx);
  });

  test('emits content_mismatch with fields_differing including "priority" when priorities differ', async () => {
    const req = makeRequest(ctx.repo, 3, { priority: 'high' });
    ctx.repoApi.insertRequest(req);

    // state.json shows priority='normal'; same mtime as updated_at (within tolerance).
    const fsState = canonicalState(req);
    fsState.priority = 'normal';
    const updatedMs = new Date(req.updated_at).getTime();
    plantStateJson(ctx.repo, req.request_id, fsState, { mtimeMs: updatedMs });

    const reports = await ctx.manager.detectDivergence(ctx.repo);
    expect(reports).toHaveLength(1);
    expect(reports[0].category).toBe('content_mismatch');
    expect(reports[0].fields_differing).toContain('priority');
  });

  test('unparseable state.json yields content_mismatch with fields_differing=["<parse>"]', async () => {
    const req = makeRequest(ctx.repo, 4);
    ctx.repoApi.insertRequest(req);
    plantRawStateFile(ctx.repo, req.request_id, '{not valid json');

    const reports = await ctx.manager.detectDivergence(ctx.repo);
    expect(reports).toHaveLength(1);
    expect(reports[0].category).toBe('content_mismatch');
    expect(reports[0].fields_differing).toEqual(['<parse>']);
    expect(reports[0].filesystem_state).toBeNull();
  });
});

describe('detectDivergence — orphaned_file', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    teardown(ctx);
  });

  test('emits orphaned_file when state.json exists with no SQLite row', async () => {
    const requestId = 'REQ-000123';
    const fsState = {
      schema_version: 1,
      request_id: requestId,
      status: 'queued',
      priority: 'normal',
      description: 'orphaned',
      repository: ctx.repo,
      source: 'cli',
      adapter_metadata: {},
      created_at: '2026-04-30T08:00:00.000Z',
      updated_at: '2026-04-30T08:00:00.000Z',
    };
    plantStateJson(ctx.repo, requestId, fsState);

    const reports = await ctx.manager.detectDivergence(ctx.repo);
    expect(reports).toHaveLength(1);
    expect(reports[0].category).toBe('orphaned_file');
    expect(reports[0].request_id).toBe(requestId);
    expect(reports[0].filesystem_state).toEqual(fsState);
  });

  test('unparseable orphaned state.json yields filesystem_state: null (no throw)', async () => {
    const requestId = 'REQ-000234';
    plantRawStateFile(ctx.repo, requestId, 'garbage{');

    const reports = await ctx.manager.detectDivergence(ctx.repo);
    expect(reports).toHaveLength(1);
    expect(reports[0].category).toBe('orphaned_file');
    expect(reports[0].filesystem_state).toBeNull();
  });
});

describe('detectDivergence — deduplication', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    teardown(ctx);
  });

  test('Phase A wins when both phases would emit for the same request_id', async () => {
    const req = makeRequest(ctx.repo, 5, { priority: 'high' });
    ctx.repoApi.insertRequest(req);
    const fsState = canonicalState(req);
    fsState.priority = 'normal';
    plantStateJson(ctx.repo, req.request_id, fsState, {
      mtimeMs: new Date(req.updated_at).getTime(),
    });

    const reports = await ctx.manager.detectDivergence(ctx.repo);
    // Exactly one report (Phase A's content_mismatch), not two.
    expect(reports.filter((r) => r.request_id === req.request_id)).toHaveLength(1);
    expect(reports[0].category).toBe('content_mismatch');
  });
});

describe('detectDivergence — locking', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    teardown(ctx);
  });

  test('second concurrent invocation throws ReconcileBusyError while first holds lock', async () => {
    // Plant a slow detector by holding the lock manually before invoking.
    fs.mkdirSync(path.join(ctx.repo, '.autonomous-dev', 'requests'), {
      recursive: true,
    });
    const lockHolderDir = path.join(
      ctx.repo,
      '.autonomous-dev',
      '.reconcile.lock.d',
    );
    fs.mkdirSync(lockHolderDir, { recursive: true, mode: 0o700 });
    // Manually create the .lock file to simulate a concurrent holder.
    const lockPath = path.join(lockHolderDir, '.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }),
      'utf-8',
    );

    try {
      await expect(ctx.manager.detectDivergence(ctx.repo)).rejects.toThrow(
        ReconcileBusyError,
      );
    } finally {
      fs.unlinkSync(lockPath);
    }
  });
});

describe('detectDivergence — non-canonical entries', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    teardown(ctx);
  });

  test('directories not matching ^REQ-\\d{6}$ are silently skipped', async () => {
    const requestsDir = path.join(ctx.repo, '.autonomous-dev', 'requests');
    fs.mkdirSync(requestsDir, { recursive: true });
    // Plant a directory with non-conforming name + a state.json inside.
    const oddDir = path.join(requestsDir, 'not-a-request-id');
    fs.mkdirSync(oddDir, { recursive: true });
    fs.writeFileSync(
      path.join(oddDir, 'state.json'),
      '{"would": "be orphan if matched"}',
      'utf-8',
    );

    const reports = await ctx.manager.detectDivergence(ctx.repo);
    expect(reports).toEqual([]);
  });

  test('files matching state.json.tmp.* are NOT classified as orphans', async () => {
    const requestId = 'REQ-000099';
    const reqDir = path.join(ctx.repo, '.autonomous-dev', 'requests', requestId);
    fs.mkdirSync(reqDir, { recursive: true, mode: 0o700 });
    // No state.json — only a tmp file.
    fs.writeFileSync(
      path.join(reqDir, `state.json.tmp.${process.pid}.deadbeef`),
      '{"tmp": true}',
      'utf-8',
    );

    const reports = await ctx.manager.detectDivergence(ctx.repo);
    expect(reports).toEqual([]);
  });

  test('files matching *.needs_promotion are NOT classified as orphans', async () => {
    const requestId = 'REQ-000100';
    const reqDir = path.join(ctx.repo, '.autonomous-dev', 'requests', requestId);
    fs.mkdirSync(reqDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(reqDir, `state.json.tmp.${process.pid}.feedface.needs_promotion`),
      '{"needs": "promotion"}',
      'utf-8',
    );

    const reports = await ctx.manager.detectDivergence(ctx.repo);
    expect(reports).toEqual([]);
  });
});

describe('detectDivergence — performance', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    teardown(ctx);
  });

  test('100 aligned requests scan in <2s', async () => {
    const futureMs = Date.now() + 5000;
    for (let i = 1; i <= 100; i++) {
      const req = makeRequest(ctx.repo, i);
      ctx.repoApi.insertRequest(req);
      plantStateJson(ctx.repo, req.request_id, canonicalState(req), {
        mtimeMs: futureMs,
      });
    }

    const start = Date.now();
    const reports = await ctx.manager.detectDivergence(ctx.repo);
    const elapsed = Date.now() - start;

    expect(reports).toEqual([]);
    expect(elapsed).toBeLessThan(2000);
  }, 10000);
});

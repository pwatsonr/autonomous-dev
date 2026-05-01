/**
 * State transition tests (SPEC-012-1-02 §"State transition functions").
 *
 * Covers: pauseRequest / resumeRequest / cancelRequest / setPriority.
 *
 * @module __tests__/core/transitions.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  cancelRequest,
  pauseRequest,
  resumeRequest,
  setHandoffDatabase,
  setPriority,
  submitRequest,
} from '../../core/handoff_manager';
import { setAllowedRepositoriesForTest } from '../../core/path_security';
import type { SubmitRequest } from '../../core/types';
import { initializeDatabase } from '../../db/migrator';
import { Repository } from '../../db/repository';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

interface Ctx {
  repo: string;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  db: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  repoApi: Repository;
}

function setup(): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-dev-trans-'));
  const repo = fs.realpathSync(dir);
  setAllowedRepositoriesForTest([repo]);
  const { db } = initializeDatabase(':memory:', MIGRATIONS_DIR);
  const repoApi = new Repository(db);
  setHandoffDatabase({ db, repo: repoApi });
  return { repo, db, repoApi };
}

function teardown(ctx: Ctx): void {
  setHandoffDatabase(null);
  setAllowedRepositoriesForTest(null);
  try {
    ctx.db.close();
  } catch {
    // ignore
  }
  fs.rmSync(ctx.repo, { recursive: true, force: true });
}

function makeReq(repo: string, n: number): SubmitRequest {
  return {
    requestId: `REQ-${String(n).padStart(6, '0')}`,
    description: 'transition test',
    priority: 'normal',
    repository: repo,
    source: 'cli',
    adapterMetadata: { source: 'cli' },
  };
}

function readState(repo: string, requestId: string): Record<string, unknown> {
  const p = path.join(repo, '.autonomous-dev', 'requests', requestId, 'state.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

describe('pauseRequest', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    teardown(ctx);
  });

  test('queued → paused, persists paused_from + history', async () => {
    await submitRequest(makeReq(ctx.repo, 1));
    const result = await pauseRequest('REQ-000001', 'manual');
    expect(result.ok).toBe(true);
    const state = readState(ctx.repo, 'REQ-000001');
    expect(state.status).toBe('paused');
    expect(state.paused_from).toBe('queued');
    const history = state.phase_history as Array<{ type: string; reason?: string }>;
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe('paused');
    expect(history[0].reason).toBe('manual');

    // SQLite is also updated.
    const row = ctx.repoApi.getRequest('REQ-000001');
    expect(row!.status).toBe('paused');
  });

  test('rejects double-pause with INVALID_TRANSITION', async () => {
    await submitRequest(makeReq(ctx.repo, 2));
    await pauseRequest('REQ-000002');
    const second = await pauseRequest('REQ-000002');
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected failure');
    expect(second.error).toContain('INVALID_TRANSITION');
  });
});

describe('resumeRequest', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    teardown(ctx);
  });

  test('paused → restored status; paused_from removed', async () => {
    await submitRequest(makeReq(ctx.repo, 3));
    await pauseRequest('REQ-000003');
    const result = await resumeRequest('REQ-000003');
    expect(result.ok).toBe(true);
    const state = readState(ctx.repo, 'REQ-000003');
    expect(state.status).toBe('queued');
    expect(state.paused_from).toBeUndefined();
    const history = state.phase_history as Array<{ type: string }>;
    expect(history.map((h) => h.type)).toEqual(['paused', 'resumed']);
  });

  test('rejects resume when paused_from absent', async () => {
    await submitRequest(makeReq(ctx.repo, 4));
    const result = await resumeRequest('REQ-000004');
    expect(result.ok).toBe(false);
  });
});

describe('cancelRequest', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    teardown(ctx);
  });

  test('happy path sets status=cancelled', async () => {
    await submitRequest(makeReq(ctx.repo, 5));
    const result = await cancelRequest('REQ-000005', 'no longer needed');
    expect(result.ok).toBe(true);
    const state = readState(ctx.repo, 'REQ-000005');
    expect(state.status).toBe('cancelled');
    const history = state.phase_history as Array<{ type: string; reason?: string }>;
    expect(history.find((h) => h.type === 'cancelled')?.reason).toBe('no longer needed');
  });

  test('rejects cancel of already-cancelled request', async () => {
    await submitRequest(makeReq(ctx.repo, 6));
    await cancelRequest('REQ-000006');
    const second = await cancelRequest('REQ-000006');
    expect(second.ok).toBe(false);
  });
});

describe('setPriority', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    teardown(ctx);
  });

  test('updates priority + appends history entry', async () => {
    await submitRequest(makeReq(ctx.repo, 7));
    const result = await setPriority('REQ-000007', 'high');
    expect(result.ok).toBe(true);
    const state = readState(ctx.repo, 'REQ-000007');
    expect(state.priority).toBe('high');
    const history = state.phase_history as Array<{
      type: string;
      from?: string;
      to?: string;
    }>;
    const entry = history.find((h) => h.type === 'priority_changed');
    expect(entry).toBeDefined();
    expect(entry!.from).toBe('normal');
    expect(entry!.to).toBe('high');

    // SQLite reflects the change.
    const row = ctx.repoApi.getRequest('REQ-000007');
    expect(row!.priority).toBe('high');
  });

  test('rejects invalid priority value at runtime', async () => {
    await submitRequest(makeReq(ctx.repo, 8));
    const result = await setPriority(
      'REQ-000008',
      'urgent' as unknown as 'high',
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('INVALID_TRANSITION');
  });

  test('serialized concurrent setPriority calls both succeed; final state is one of the two', async () => {
    await submitRequest(makeReq(ctx.repo, 9));
    const [a, b] = await Promise.all([
      setPriority('REQ-000009', 'high'),
      setPriority('REQ-000009', 'low'),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const state = readState(ctx.repo, 'REQ-000009');
    expect(['high', 'low']).toContain(state.priority);
    const history = state.phase_history as Array<{ type: string }>;
    const priorityChanges = history.filter((h) => h.type === 'priority_changed');
    expect(priorityChanges).toHaveLength(2);
  });
});

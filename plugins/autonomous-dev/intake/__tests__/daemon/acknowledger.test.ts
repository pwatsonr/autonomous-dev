/**
 * Daemon acknowledger tests (SPEC-012-1-03 §"Acknowledger").
 *
 * @module __tests__/daemon/acknowledger.test
 */

import * as path from 'path';

import { acknowledgeRequest } from '../../daemon/acknowledger';
import { initializeDatabase } from '../../db/migrator';
import { Repository, type RequestEntity } from '../../db/repository';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

function mkEntity(id: string): RequestEntity {
  return {
    request_id: id,
    title: 't',
    description: 'd',
    raw_input: 'r',
    priority: 'normal',
    target_repo: '/tmp/x',
    status: 'queued',
    current_phase: 'queued',
    phase_progress: null,
    requester_id: 'u',
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
    adapter_metadata: { source: 'cli' },
    created_at: '2026-04-30T10:00:00.000Z',
    updated_at: '2026-04-30T10:00:00.000Z',
  };
}

interface Ctx {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  db: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  repo: Repository;
}

function setup(): Ctx {
  const { db } = initializeDatabase(':memory:', MIGRATIONS_DIR);
  return { db, repo: new Repository(db) };
}

function teardown(ctx: Ctx): void {
  try {
    ctx.db.close();
  } catch {
    // ignore
  }
}

describe('acknowledgeRequest', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    teardown(ctx);
  });

  test('happy path sets acknowledged_at + acknowledged_by', async () => {
    ctx.repo.insertRequest(mkEntity('REQ-000001'));
    const result = await acknowledgeRequest(ctx.db, 'REQ-000001', 'daemon-1');
    expect(result.ok).toBe(true);

    const row = ctx.db
      .prepare('SELECT acknowledged_at, acknowledged_by FROM requests WHERE request_id = ?')
      .get('REQ-000001');
    expect(row.acknowledged_at).not.toBeNull();
    expect(row.acknowledged_by).toBe('daemon-1');
  });

  test('NOT_FOUND when request_id does not exist', async () => {
    const result = await acknowledgeRequest(ctx.db, 'REQ-999999', 'daemon-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_FOUND');
  });

  test('ALREADY_ACKED on second call', async () => {
    ctx.repo.insertRequest(mkEntity('REQ-000002'));
    await acknowledgeRequest(ctx.db, 'REQ-000002', 'daemon-1');
    const second = await acknowledgeRequest(ctx.db, 'REQ-000002', 'daemon-2');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('ALREADY_ACKED');

    // First daemon's identity is preserved.
    const row = ctx.db
      .prepare('SELECT acknowledged_by FROM requests WHERE request_id = ?')
      .get('REQ-000002');
    expect(row.acknowledged_by).toBe('daemon-1');
  });

  test('two-daemon race — exactly one wins', async () => {
    ctx.repo.insertRequest(mkEntity('REQ-000003'));
    // Sequential calls (better-sqlite3 is synchronous → impossible to truly
    // race in-process; this asserts the SECOND wins ALREADY_ACKED reliably).
    const a = await acknowledgeRequest(ctx.db, 'REQ-000003', 'daemon-1');
    const b = await acknowledgeRequest(ctx.db, 'REQ-000003', 'daemon-2');
    const okCount = [a, b].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
  });

  test('uses BEGIN IMMEDIATE (asserted via mocked exec)', async () => {
    const calls: string[] = [];
    const fakeDb = {
      exec: (s: string): void => {
        calls.push(s);
      },
      prepare: () => ({
        get: () => ({ acknowledged_at: null }),
        run: () => undefined,
      }),
    };
    await acknowledgeRequest(fakeDb, 'REQ-000004', 'daemon-1');
    expect(calls[0]).toBe('BEGIN IMMEDIATE');
    expect(calls[calls.length - 1]).toBe('COMMIT');
  });
});

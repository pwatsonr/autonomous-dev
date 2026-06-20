/**
 * #551 regression: the CLI lifecycle handlers (cancel/pause/resume/priority)
 * must sync BOTH the SQLite row AND the on-disk state.json. Before the fix they
 * wrote the db row only, so the daemon's select_request (which scans state.json)
 * kept re-selecting cancelled/paused requests.
 *
 * These tests drive the real handler classes against a real db + on-disk
 * state.json and assert the file is synced — the coverage the prior mocked-router
 * cli_adapter test never had.
 *
 * @module __tests__/handlers/lifecycle_state_sync.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  setHandoffDatabase,
  submitRequest,
} from '../../core/handoff_manager';
import { setAllowedRepositoriesForTest } from '../../core/path_security';
import type { SubmitRequest } from '../../core/types';
import { initializeDatabase } from '../../db/migrator';
import { Repository } from '../../db/repository';
import { CancelHandler } from '../../handlers/cancel_handler';
import { PauseHandler } from '../../handlers/pause_handler';
import type { IncomingCommand } from '../../adapters/adapter_interface';
import type { IntakeEventEmitter } from '../../core/intake_router';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');
const noopEmitter: IntakeEventEmitter = { emit: () => {} };

interface Ctx {
  repo: string;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  db: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  repoApi: Repository;
}

function setup(): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-dev-551-'));
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
    description: '551 state-sync test',
    priority: 'normal',
    repository: repo,
    source: 'cli',
    adapterMetadata: { source: 'cli' },
  };
}

function readStateStatus(repo: string, requestId: string): string {
  const p = path.join(repo, '.autonomous-dev', 'requests', requestId, 'state.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8')).status as string;
}

function cmd(args: string[]): IncomingCommand {
  return { commandName: 'x', args, flags: {}, rawText: '', source: 'cli' as IncomingCommand['source'] };
}

describe('#551: CancelHandler syncs state.json', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { teardown(ctx); });

  test('cancel writes "cancelled" to BOTH the db row and state.json', async () => {
    await submitRequest(makeReq(ctx.repo, 1)); // materializes db row + state.json
    expect(readStateStatus(ctx.repo, 'REQ-000001')).toBe('queued');

    const handler = new CancelHandler(ctx.repoApi, noopEmitter);
    const res = await handler.execute(cmd(['REQ-000001', 'CONFIRM']), 'user-1');

    expect(res.success).toBe(true);
    // The on-disk state.json — what the daemon's select_request reads — is synced.
    expect(readStateStatus(ctx.repo, 'REQ-000001')).toBe('cancelled');
    // And the db row.
    expect(ctx.repoApi.getRequest('REQ-000001')!.status).toBe('cancelled');
  });

  test('confirmation gate: first call (no CONFIRM) does not cancel', async () => {
    await submitRequest(makeReq(ctx.repo, 2));
    const handler = new CancelHandler(ctx.repoApi, noopEmitter);
    const res = await handler.execute(cmd(['REQ-000002']), 'user-1');
    expect((res.data as { confirmationRequired?: boolean }).confirmationRequired).toBe(true);
    expect(readStateStatus(ctx.repo, 'REQ-000002')).toBe('queued'); // unchanged
  });

  test('db-only fallback: when state.json is absent the cancel still updates the db row', async () => {
    await submitRequest(makeReq(ctx.repo, 99));
    // Simulate a request whose state.json never materialized (or was removed):
    // delete it so the atomic helper hits F1 and the handler falls back to db-only.
    const p = path.join(ctx.repo, '.autonomous-dev', 'requests', 'REQ-000099', 'state.json');
    fs.rmSync(p);
    const handler = new CancelHandler(ctx.repoApi, noopEmitter);
    const res = await handler.execute(cmd(['REQ-000099', 'CONFIRM']), 'user-1');
    expect(res.success).toBe(true);
    expect(ctx.repoApi.getRequest('REQ-000099')!.status).toBe('cancelled'); // db updated via fallback
    expect(fs.existsSync(p)).toBe(false); // helper did not resurrect it
  });
});

describe('#551: PauseHandler syncs state.json', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { teardown(ctx); });

  test('pause writes "paused" to BOTH the db row and state.json', async () => {
    await submitRequest(makeReq(ctx.repo, 3));
    // Move to active so pause is a valid transition (daemon would do this; here
    // we set it directly in both places to mimic an in-flight request).
    ctx.repoApi.updateRequest('REQ-000003', { status: 'active' });
    const handler = new PauseHandler(ctx.repoApi, noopEmitter);
    const res = await handler.execute(cmd(['REQ-000003']), 'user-1');
    expect(res.success).toBe(true);
    expect(readStateStatus(ctx.repo, 'REQ-000003')).toBe('paused');
    expect(ctx.repoApi.getRequest('REQ-000003')!.status).toBe('paused');
  });
});

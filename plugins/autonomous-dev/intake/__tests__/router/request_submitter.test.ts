/**
 * submitFromRouter tests (SPEC-012-1-02 §"Request Submission").
 *
 * @module __tests__/router/request_submitter.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { setHandoffDatabase } from '../../core/handoff_manager';
import { setAllowedRepositoriesForTest } from '../../core/path_security';
import type { SubmitRequest } from '../../core/types';
import { initializeDatabase } from '../../db/migrator';
import { Repository } from '../../db/repository';
import {
  setEventBusForRouter,
  submitFromRouter,
} from '../../router/request_submitter';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

interface Ctx {
  repo: string;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  db: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  events: Array<{ channel: string; event: unknown }>;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  bus: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

function setup(): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-dev-router-'));
  const repo = fs.realpathSync(dir);
  setAllowedRepositoriesForTest([repo]);

  const { db } = initializeDatabase(':memory:', MIGRATIONS_DIR);
  setHandoffDatabase({ db, repo: new Repository(db) });

  const events: Array<{ channel: string; event: unknown }> = [];
  const bus = {
    emit(channel: string, event: unknown): Promise<void> {
      events.push({ channel, event });
      return Promise.resolve();
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setEventBusForRouter(bus as any);

  return { repo, db, events, bus };
}

function teardown(ctx: Ctx): void {
  setEventBusForRouter(null);
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
    description: 'router test',
    priority: 'normal',
    repository: repo,
    source: 'cli',
    adapterMetadata: { source: 'cli' },
  };
}

describe('submitFromRouter', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    teardown(ctx);
  });

  test('happy path emits request_submitted exactly once', async () => {
    const result = await submitFromRouter(makeReq(ctx.repo, 1));
    expect(result.ok).toBe(true);

    const submitted = ctx.events.filter(
      (e) => (e.event as { type?: string }).type === 'request_submitted',
    );
    expect(submitted).toHaveLength(1);
    expect((submitted[0].event as { requestId: string }).requestId).toBe('REQ-000001');
  });

  test('failure (invalid id) does NOT emit request_submitted', async () => {
    const req = makeReq(ctx.repo, 1);
    req.requestId = 'REQ-12';
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await submitFromRouter(req);
      expect(result.ok).toBe(false);
      const submitted = ctx.events.filter(
        (e) => (e.event as { type?: string }).type === 'request_submitted',
      );
      expect(submitted).toHaveLength(0);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  test('emits with sanitized payload (source + committedAt only)', async () => {
    await submitFromRouter(makeReq(ctx.repo, 2));
    const evt = ctx.events[0].event as { source: string; committedAt: string };
    expect(evt.source).toBe('cli');
    expect(typeof evt.committedAt).toBe('string');
  });
});

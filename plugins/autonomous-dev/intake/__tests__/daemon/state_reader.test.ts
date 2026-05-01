/**
 * Daemon state_reader tests (SPEC-012-1-03 §"State Reader").
 *
 * @module __tests__/daemon/state_reader.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { pollNewRequests, readState } from '../../daemon/state_reader';

function mkRequestPath(repo: string, id: string): string {
  const p = path.join(repo, '.autonomous-dev', 'requests', id);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function writeValidState(p: string, requestId: string): void {
  const state = {
    schema_version: 1,
    request_id: requestId,
    status: 'queued',
    priority: 'normal',
    description: 'demo',
    repository: '/tmp/x',
    source: 'cli',
    adapter_metadata: { source: 'cli' },
    created_at: '2026-04-30T10:00:00.000Z',
    updated_at: '2026-04-30T10:00:00.000Z',
    phase_history: [],
  };
  fs.writeFileSync(path.join(p, 'state.json'), JSON.stringify(state, null, 2));
}

function mkRepo(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-dev-reader-')),
  );
}

describe('readState', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkRepo();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('happy path returns parsed state', async () => {
    const p = mkRequestPath(repo, 'REQ-000001');
    writeValidState(p, 'REQ-000001');
    const result = await readState(p);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.source).toBe('cli');
      expect(result.state.request_id).toBe('REQ-000001');
    }
  });

  test('NOT_FOUND when state.json missing', async () => {
    const p = mkRequestPath(repo, 'REQ-000002');
    const result = await readState(p);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_FOUND');
  });

  test('PARSE_ERROR for malformed JSON', async () => {
    const p = mkRequestPath(repo, 'REQ-000003');
    fs.writeFileSync(path.join(p, 'state.json'), '{broken');
    const result = await readState(p);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('PARSE_ERROR');
      expect(result.details).toContain('malformed JSON');
    }
  });

  test('SCHEMA_INVALID when source is unknown', async () => {
    const p = mkRequestPath(repo, 'REQ-000004');
    fs.writeFileSync(
      path.join(p, 'state.json'),
      JSON.stringify({ source: 'banana', request_id: 'REQ-000004' }),
    );
    const result = await readState(p);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('SCHEMA_INVALID');
    }
  });
});

describe('pollNewRequests', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkRepo();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function fakeDb(rows: Array<{ request_id: string; created_at: string; priority: 'high' | 'normal' | 'low' }>) {
    return { listUnacknowledged: () => rows };
  }

  test('returns ids whose state.json exists, FIFO by db ordering', async () => {
    writeValidState(mkRequestPath(repo, 'REQ-000001'), 'REQ-000001');
    writeValidState(mkRequestPath(repo, 'REQ-000002'), 'REQ-000002');
    writeValidState(mkRequestPath(repo, 'REQ-000003'), 'REQ-000003');

    const ids = await pollNewRequests(
      repo,
      fakeDb([
        { request_id: 'REQ-000001', created_at: '2026-04-30T10:00:00.000Z', priority: 'normal' },
        { request_id: 'REQ-000002', created_at: '2026-04-30T10:00:01.000Z', priority: 'normal' },
        { request_id: 'REQ-000003', created_at: '2026-04-30T10:00:02.000Z', priority: 'normal' },
      ]),
    );
    expect(ids).toEqual(['REQ-000001', 'REQ-000002', 'REQ-000003']);
  });

  test('skips dirs without state.json (in-flight)', async () => {
    writeValidState(mkRequestPath(repo, 'REQ-000001'), 'REQ-000001');
    mkRequestPath(repo, 'REQ-000002'); // no state.json — in-flight
    writeValidState(mkRequestPath(repo, 'REQ-000003'), 'REQ-000003');

    const ids = await pollNewRequests(
      repo,
      fakeDb([
        { request_id: 'REQ-000001', created_at: '2026-04-30T10:00:00.000Z', priority: 'normal' },
        { request_id: 'REQ-000002', created_at: '2026-04-30T10:00:01.000Z', priority: 'normal' },
        { request_id: 'REQ-000003', created_at: '2026-04-30T10:00:02.000Z', priority: 'normal' },
      ]),
    );
    expect(ids).toEqual(['REQ-000001', 'REQ-000003']);
  });

  test('skips directories with non-canonical names', async () => {
    writeValidState(mkRequestPath(repo, 'REQ-000001'), 'REQ-000001');
    fs.mkdirSync(path.join(repo, '.autonomous-dev', 'requests', 'evil-dir'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.autonomous-dev', 'requests', 'evil-dir', 'state.json'),
      '{}',
    );
    const ids = await pollNewRequests(
      repo,
      fakeDb([
        { request_id: 'REQ-000001', created_at: '2026-04-30T10:00:00.000Z', priority: 'normal' },
      ]),
    );
    expect(ids).toEqual(['REQ-000001']);
  });

  test('skips ids that are already-acknowledged (not in db result)', async () => {
    writeValidState(mkRequestPath(repo, 'REQ-000001'), 'REQ-000001');
    writeValidState(mkRequestPath(repo, 'REQ-000002'), 'REQ-000002');

    // db returns only REQ-000002 (REQ-000001 is acked → omitted by query).
    const ids = await pollNewRequests(
      repo,
      fakeDb([
        { request_id: 'REQ-000002', created_at: '2026-04-30T10:00:00.000Z', priority: 'normal' },
      ]),
    );
    expect(ids).toEqual(['REQ-000002']);
  });
});

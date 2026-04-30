/**
 * Repository v2 column round-trip tests (SPEC-012-2-04).
 *
 * Covers:
 *  - insertRequest + getRequest round-trip for source + adapter_metadata.
 *  - Default behaviour when source / adapter_metadata are omitted ('cli', {}).
 *  - Each of the 6 RequestSource values round-trips losslessly.
 *  - AdapterMetadata for at least 3 adapter shapes (cli, discord, slack)
 *    round-trips through JSON serialization.
 *  - Defensive parsing: rows with null or corrupt adapter_metadata return
 *    `{}` from the row mapper.
 *  - updateRequest preserves source + adapter_metadata when not specified.
 *
 * All tests use in-memory SQLite (`:memory:`) with both 001 and 002 applied.
 *
 * @module __tests__/db/repository_source.test
 */

import * as path from 'path';

import { initializeDatabase } from '../../db/migrator';
import { Repository, type RequestEntity } from '../../db/repository';
import {
  REQUEST_SOURCES,
  type AdapterMetadata,
  type RequestSource,
  ValidationError,
} from '../../types/request_source';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Database = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

interface TestCtx {
  db: Database;
  repo: Repository;
}

function setup(): TestCtx {
  const { db } = initializeDatabase(':memory:', MIGRATIONS_DIR);
  return { db, repo: new Repository(db) };
}

function teardown(ctx: TestCtx): void {
  ctx.db.close();
}

/**
 * Build a minimal RequestEntity for insertion, with sensible defaults that
 * satisfy the v1 columns. Tests override the v2 fields as needed.
 */
function makeRequest(
  overrides: Partial<RequestEntity> = {},
): RequestEntity {
  return {
    request_id: overrides.request_id ?? 'REQ-000001',
    title: 'Test request',
    description: 'A test request body.',
    raw_input: 'raw',
    priority: 'normal',
    target_repo: null,
    status: 'queued',
    current_phase: 'queued',
    phase_progress: null,
    requester_id: 'tester',
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
    adapter_metadata: {},
    created_at: '2026-04-30T10:00:00.000Z',
    updated_at: '2026-04-30T10:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('Repository.insertRequest / getRequest — v2 round-trip', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => {
    teardown(ctx);
  });

  test('round-trips source + adapter_metadata as a typed object', () => {
    const meta: AdapterMetadata = {
      source: 'discord',
      guild_id: 'g1',
      channel_id: 'c1',
      user_id: 'u1',
      message_id: 'm1',
    };
    ctx.repo.insertRequest(
      makeRequest({
        request_id: 'REQ-DISCORD-1',
        source: 'discord',
        adapter_metadata: meta,
      }),
    );
    const got = ctx.repo.getRequest('REQ-DISCORD-1');
    expect(got).not.toBeNull();
    expect(got!.source).toBe('discord');
    expect(got!.adapter_metadata).toEqual(meta);
    // The repository must surface a typed object, not a JSON string.
    expect(typeof got!.adapter_metadata).toBe('object');
  });

  test('omitting source defaults to cli + adapter_metadata defaults to {}', () => {
    // Build a request without source/adapter_metadata fields. The repository
    // applies the defaults from `request.source ?? 'cli'` and
    // `request.adapter_metadata ?? {}`.
    const base = makeRequest({ request_id: 'REQ-DEFAULT-1' });
    // Cast to any to remove the v2 fields and emulate a pre-v2 caller.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const partial: any = { ...base };
    delete partial.source;
    delete partial.adapter_metadata;

    ctx.repo.insertRequest(partial as RequestEntity);
    const got = ctx.repo.getRequest('REQ-DEFAULT-1');
    expect(got).not.toBeNull();
    expect(got!.source).toBe('cli');
    expect(got!.adapter_metadata).toEqual({});
  });

  test('every RequestSource value round-trips losslessly', () => {
    let i = 0;
    for (const src of REQUEST_SOURCES) {
      i += 1;
      const requestId = `REQ-SRC-${i}`;
      ctx.repo.insertRequest(
        makeRequest({
          request_id: requestId,
          source: src,
          // Use minimal {source} payload so the parser yields the typed shape.
          adapter_metadata: { source: src } as AdapterMetadata,
        }),
      );
      const got = ctx.repo.getRequest(requestId);
      expect(got).not.toBeNull();
      expect(got!.source).toBe(src);
      expect(got!.adapter_metadata).toEqual({ source: src });
    }
  });

  test('cli adapter metadata round-trips with optional fields', () => {
    const meta: AdapterMetadata = {
      source: 'cli',
      pid: 12345,
      cwd: '/Users/dev/repo',
      branch: 'main',
    };
    ctx.repo.insertRequest(
      makeRequest({
        request_id: 'REQ-CLI-META',
        source: 'cli',
        adapter_metadata: meta,
      }),
    );
    const got = ctx.repo.getRequest('REQ-CLI-META');
    expect(got!.adapter_metadata).toEqual(meta);
  });

  test('discord adapter metadata round-trips with optional fields', () => {
    const meta: AdapterMetadata = {
      source: 'discord',
      guild_id: 'guild-1',
      channel_id: 'chan-1',
      user_id: 'user-1',
      message_id: 'msg-1',
    };
    ctx.repo.insertRequest(
      makeRequest({
        request_id: 'REQ-DISCORD-META',
        source: 'discord',
        adapter_metadata: meta,
      }),
    );
    const got = ctx.repo.getRequest('REQ-DISCORD-META');
    expect(got!.adapter_metadata).toEqual(meta);
  });

  test('slack adapter metadata round-trips with optional fields', () => {
    const meta: AdapterMetadata = {
      source: 'slack',
      team_id: 'team-1',
      channel_id: 'chan-2',
      user_id: 'user-2',
      message_ts: '1700000000.000123',
    };
    ctx.repo.insertRequest(
      makeRequest({
        request_id: 'REQ-SLACK-META',
        source: 'slack',
        adapter_metadata: meta,
      }),
    );
    const got = ctx.repo.getRequest('REQ-SLACK-META');
    expect(got!.adapter_metadata).toEqual(meta);
  });

  test('insertRequest with invalid source throws ValidationError', () => {
    const bad = makeRequest({
      request_id: 'REQ-BAD-1',
      // Force-cast: mimics a runtime caller that escaped TS checks.
      source: 'urgent' as unknown as RequestSource,
    });
    expect(() => ctx.repo.insertRequest(bad)).toThrow(ValidationError);

    // No row should be created when validation fails.
    const cnt = (
      ctx.db.prepare('SELECT COUNT(*) AS c FROM requests').get() as {
        c: number;
      }
    ).c;
    expect(cnt).toBe(0);
  });
});

describe('Repository.getRequest — defensive parsing', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = setup();
    // Suppress the warning logs so the test output stays clean.
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    (console.warn as jest.Mock).mockRestore?.();
    teardown(ctx);
  });

  test('row missing adapter_metadata column entirely (legacy v1) yields {}', () => {
    // Simulates reading a v1-shape row (the column literally does not exist
    // on the result object). The repository's row mapper defends with the
    // `raw == null` branch so daemon startup against a not-yet-migrated DB
    // does not crash. We can't construct this scenario through `getRequest`
    // on a fully-migrated DB (the column always exists), so we exercise the
    // mapper by simulating the row shape via an explicit prepared statement.
    const row = {
      request_id: 'REQ-LEGACY-1',
      title: 't',
      description: 'd',
      raw_input: 'r',
      priority: 'normal',
      target_repo: null,
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
      // adapter_metadata + source intentionally absent (legacy v1 shape)
      created_at: '2026-04-30T10:00:00.000Z',
      updated_at: '2026-04-30T10:00:00.000Z',
    };

    // Internal mapper isn't exported; exercise it via repository's getRequest
    // by pointing at a separate connection that runs ONLY 001 so the column
    // truly doesn't exist on the result row.
    const v1Only = require('../../db/migrator').openDatabase(':memory:');
    try {
      const fs = require('fs') as typeof import('fs');
      const initialSql = fs
        .readFileSync(path.join(MIGRATIONS_DIR, '001_initial.sql'), 'utf-8')
        .split('\n')
        .filter((l: string) => !l.trim().toUpperCase().startsWith('PRAGMA'))
        .join('\n');
      v1Only.exec(initialSql);

      // Insert via raw INSERT against the v1 columns only.
      v1Only
        .prepare(
          `INSERT INTO requests (
             request_id, title, description, raw_input, priority,
             status, current_phase, requester_id, source_channel
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.request_id,
          row.title,
          row.description,
          row.raw_input,
          row.priority,
          row.status,
          row.current_phase,
          row.requester_id,
          row.source_channel,
        );

      const v1Repo = new Repository(v1Only);
      const got = v1Repo.getRequest('REQ-LEGACY-1');
      expect(got).not.toBeNull();
      // Legacy row has neither column → defaults applied by mapper.
      expect(got!.source).toBe('cli');
      expect(got!.adapter_metadata).toEqual({});
    } finally {
      v1Only.close();
    }
  });

  test('row with corrupt JSON in adapter_metadata yields {} and warns', () => {
    ctx.db.pragma('ignore_check_constraints = ON');
    try {
      ctx.db
        .prepare(
          `INSERT INTO requests (
             request_id, title, description, raw_input, priority,
             status, current_phase, requester_id, source_channel,
             source, adapter_metadata
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'REQ-CORRUPT-META',
          't',
          'd',
          'r',
          'normal',
          'queued',
          'queued',
          'u',
          'claude_app',
          'cli',
          'corrupt {',
        );
    } finally {
      ctx.db.pragma('ignore_check_constraints = OFF');
    }

    const got = ctx.repo.getRequest('REQ-CORRUPT-META');
    expect(got).not.toBeNull();
    expect(got!.adapter_metadata).toEqual({});
    expect(console.warn).toHaveBeenCalled();
  });

  test('row with empty-string adapter_metadata yields {}', () => {
    ctx.db.pragma('ignore_check_constraints = ON');
    try {
      ctx.db
        .prepare(
          `INSERT INTO requests (
             request_id, title, description, raw_input, priority,
             status, current_phase, requester_id, source_channel,
             source, adapter_metadata
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'REQ-EMPTY-META',
          't',
          'd',
          'r',
          'normal',
          'queued',
          'queued',
          'u',
          'claude_app',
          'cli',
          '',
        );
    } finally {
      ctx.db.pragma('ignore_check_constraints = OFF');
    }
    const got = ctx.repo.getRequest('REQ-EMPTY-META');
    expect(got!.adapter_metadata).toEqual({});
  });
});

describe('Repository.updateRequest — preserve unchanged v2 columns', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => {
    teardown(ctx);
  });

  test('updating an unrelated field preserves source + adapter_metadata', () => {
    const meta: AdapterMetadata = {
      source: 'discord',
      guild_id: 'g-9',
      channel_id: 'c-9',
    };
    ctx.repo.insertRequest(
      makeRequest({
        request_id: 'REQ-PRESERVE-1',
        source: 'discord',
        adapter_metadata: meta,
      }),
    );

    // Update title only — must not touch source / adapter_metadata.
    ctx.repo.updateRequest('REQ-PRESERVE-1', { title: 'Renamed title' });

    const got = ctx.repo.getRequest('REQ-PRESERVE-1');
    expect(got!.title).toBe('Renamed title');
    expect(got!.source).toBe('discord');
    expect(got!.adapter_metadata).toEqual(meta);
  });

  test('updating source explicitly to a valid value succeeds', () => {
    ctx.repo.insertRequest(
      makeRequest({
        request_id: 'REQ-UPD-1',
        source: 'cli',
        adapter_metadata: { source: 'cli' },
      }),
    );
    ctx.repo.updateRequest('REQ-UPD-1', { source: 'slack' });
    const got = ctx.repo.getRequest('REQ-UPD-1');
    expect(got!.source).toBe('slack');
  });

  test('updating source to an invalid value throws ValidationError', () => {
    ctx.repo.insertRequest(
      makeRequest({
        request_id: 'REQ-UPD-2',
        source: 'cli',
        adapter_metadata: { source: 'cli' },
      }),
    );
    expect(() =>
      ctx.repo.updateRequest('REQ-UPD-2', {
        source: 'banana' as unknown as RequestSource,
      }),
    ).toThrow(ValidationError);
    // Ensure the row was not silently mutated.
    const got = ctx.repo.getRequest('REQ-UPD-2');
    expect(got!.source).toBe('cli');
  });

  test('updating adapter_metadata explicitly serializes the new shape', () => {
    ctx.repo.insertRequest(
      makeRequest({
        request_id: 'REQ-UPD-META',
        source: 'cli',
        adapter_metadata: { source: 'cli' },
      }),
    );
    const newMeta: AdapterMetadata = {
      source: 'cli',
      pid: 999,
      cwd: '/tmp',
      branch: 'feat/foo',
    };
    ctx.repo.updateRequest('REQ-UPD-META', { adapter_metadata: newMeta });
    const got = ctx.repo.getRequest('REQ-UPD-META');
    expect(got!.adapter_metadata).toEqual(newMeta);
  });
});

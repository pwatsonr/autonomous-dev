// #562 / FR-938 — production-intelligence-writer tests.
//
// The observe runner persists a portal-facing summary of each completed cycle
// to `<stateDir>/production-intelligence.json`. These tests pin the projection
// (pure) and the atomic write (honors an explicit stateDir + AUTONOMOUS_DEV_STATE_DIR).

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import type { RunMetadata } from '../../src/runner/observation-runner';
import {
  projectSummary,
  resolveStateDir,
  writeProductionIntelligence,
} from '../../src/runner/production-intelligence-writer';

function makeMetadata(overrides: Partial<RunMetadata> = {}): RunMetadata {
  return {
    run_id: 'RUN-20260621-040000',
    started_at: '2026-06-21T03:59:00Z',
    completed_at: '2026-06-21T04:00:00Z',
    services_in_scope: ['svc-a', 'svc-b', 'svc-c'],
    data_source_status: {},
    observations_generated: 12,
    observations_deduplicated: 2,
    observations_filtered: 4,
    triage_decisions_processed: 7,
    total_tokens_consumed: 5000,
    queries_executed: {},
    errors: ['boom'],
    ...overrides,
  };
}

describe('projectSummary', () => {
  it('projects RunMetadata into the snake_case portal summary', () => {
    const summary = projectSummary(makeMetadata(), '2026-06-21T04:00:05Z');
    expect(summary).toEqual({
      last_run_id: 'RUN-20260621-040000',
      last_run_at: '2026-06-21T04:00:00Z',
      services_scanned: 3,
      observations_generated: 12,
      observations_filtered: 4,
      triage_processed: 7,
      error_count: 1,
      updated_at: '2026-06-21T04:00:05Z',
    });
  });

  it('counts services and errors from array lengths', () => {
    const summary = projectSummary(
      makeMetadata({ services_in_scope: [], errors: [] }),
      '2026-06-21T04:00:05Z',
    );
    expect(summary.services_scanned).toBe(0);
    expect(summary.error_count).toBe(0);
  });
});

describe('resolveStateDir', () => {
  const original = process.env.AUTONOMOUS_DEV_STATE_DIR;
  afterEach(() => {
    if (original === undefined) delete process.env.AUTONOMOUS_DEV_STATE_DIR;
    else process.env.AUTONOMOUS_DEV_STATE_DIR = original;
  });

  it('honors AUTONOMOUS_DEV_STATE_DIR when set', () => {
    process.env.AUTONOMOUS_DEV_STATE_DIR = '/tmp/some-state-dir';
    expect(resolveStateDir()).toBe('/tmp/some-state-dir');
  });

  it('falls back to ~/.autonomous-dev when unset', () => {
    delete process.env.AUTONOMOUS_DEV_STATE_DIR;
    expect(resolveStateDir()).toBe(path.join(os.homedir(), '.autonomous-dev'));
  });

  it('ignores a blank AUTONOMOUS_DEV_STATE_DIR', () => {
    process.env.AUTONOMOUS_DEV_STATE_DIR = '   ';
    expect(resolveStateDir()).toBe(path.join(os.homedir(), '.autonomous-dev'));
  });
});

describe('writeProductionIntelligence', () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prod-intel-writer-'));
  });
  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it('writes production-intelligence.json into the given stateDir', async () => {
    const target = await writeProductionIntelligence(makeMetadata(), {
      stateDir,
      nowIso: '2026-06-21T04:00:05Z',
    });
    expect(target).toBe(path.join(stateDir, 'production-intelligence.json'));
    const parsed = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(parsed.last_run_id).toBe('RUN-20260621-040000');
    expect(parsed.services_scanned).toBe(3);
    expect(parsed.error_count).toBe(1);
    expect(parsed.updated_at).toBe('2026-06-21T04:00:05Z');
  });

  it('creates the state dir if it does not exist', async () => {
    const nested = path.join(stateDir, 'a', 'b');
    const target = await writeProductionIntelligence(makeMetadata(), {
      stateDir: nested,
      nowIso: '2026-06-21T04:00:05Z',
    });
    const parsed = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(parsed.last_run_id).toBe('RUN-20260621-040000');
  });

  it('overwrites a prior summary (per-run snapshot, not append)', async () => {
    await writeProductionIntelligence(makeMetadata({ run_id: 'RUN-OLD' }), {
      stateDir,
      nowIso: '2026-06-21T03:00:00Z',
    });
    await writeProductionIntelligence(makeMetadata({ run_id: 'RUN-NEW' }), {
      stateDir,
      nowIso: '2026-06-21T04:00:00Z',
    });
    const parsed = JSON.parse(
      await fs.readFile(path.join(stateDir, 'production-intelligence.json'), 'utf-8'),
    );
    expect(parsed.last_run_id).toBe('RUN-NEW');
  });
});

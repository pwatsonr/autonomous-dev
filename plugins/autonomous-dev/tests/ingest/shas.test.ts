import {
  loadKnownShas,
  saveKnownShas,
  mergeKnownShas,
  nextKnownShas,
  knownShasPath,
} from '../../src/ingest/shas';
import type { ShaStoreIO } from '../../src/ingest/shas';
import { ingestOrg } from '../../src/ingest/orchestrator';
import type { OrgClient, RepoSource, RepoMeta } from '../../src/ingest/types';
import type { MemoryStoreIO } from '../../src/memory/store';

/**
 * Unit tests for known-HEAD-sha persistence (ONBOARD Phase 1, #588) — the
 * incremental-crawl state the CLI persists between `org ingest` runs. Injected
 * fake IO, never touches operator state.
 */

function fakeShaIO(): ShaStoreIO & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    homedir: () => '/home/test',
    readFile: (p: string) => files[p],
    writeFile: (p: string, data: string) => {
      files[p] = data;
    },
  };
}

function fakeMemoryIO(): MemoryStoreIO & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    homedir: () => '/home/test',
    readFile: (p: string) => files[p],
    writeFile: (p: string, data: string) => {
      files[p] = data;
    },
    listDir: () => [],
  };
}

function fakeRepo(meta: RepoMeta): RepoSource {
  return { meta, readFile: () => undefined, listFiles: () => ['README.md'] };
}

function test_round_trip(): void {
  const io = fakeShaIO();
  assert(Object.keys(loadKnownShas(io)).length === 0, 'missing store reads {}');
  saveKnownShas({ 'o/a': 's1', 'o/b': 's2' }, io);
  const loaded = loadKnownShas(io);
  assert(loaded['o/a'] === 's1' && loaded['o/b'] === 's2', 'round-trips the map');
  assert(typeof io.files[knownShasPath(io)] === 'string', 'written to the canonical path');
  // corrupt store => {} (non-destructive read)
  io.files[knownShasPath(io)] = '{ broken';
  assert(Object.keys(loadKnownShas(io)).length === 0, 'corrupt store reads {}');
  console.log('PASS: test_round_trip');
}

function test_merge_preserves_skipped(): void {
  const prior = { 'o/a': 'old', 'o/stale': 's1' };
  const next = mergeKnownShas(prior, [{ repoId: 'o/a', headSha: 'new' }]);
  assert(next['o/a'] === 'new', 'ingested repo sha updated');
  assert(next['o/stale'] === 's1', 'skipped repo keeps its prior sha');
  console.log('PASS: test_merge_preserves_skipped');
}

function test_next_skips_open_failures(): void {
  const result = {
    org: 'o',
    skipped: [],
    repos: [
      { repoId: 'o/good', headSha: 'g1', topicsWritten: ['overview'], errors: [] },
      { repoId: 'o/bad', headSha: 'b1', topicsWritten: [], errors: [{ topic: 'openRepo', error: 'clone failed' }] },
    ],
  };
  const next = nextKnownShas({}, result);
  assert(next['o/good'] === 'g1', 'opened repo recorded');
  assert(!('o/bad' in next), 'failed-to-open repo NOT recorded (retried next run)');
  console.log('PASS: test_next_skips_open_failures');
}

// Faithful replica of the CLI `org ingest` glue, so the persistence contract is
// exercised end-to-end (round-trip + skip-unchanged + --full force).
async function crawl(
  client: OrgClient,
  memIO: MemoryStoreIO,
  shaIO: ShaStoreIO,
  opts: { full?: boolean } = {},
): Promise<{ ingested: string[]; skipped: string[] }> {
  const known = opts.full ? {} : loadKnownShas(shaIO);
  const result = await ingestOrg('o', client, memIO, { knownShas: known, isBlocked: () => false });
  saveKnownShas(nextKnownShas(known, result), shaIO);
  return { ingested: result.repos.map((r) => r.repoId), skipped: result.skipped };
}

async function test_incremental_across_runs_and_full_force(): Promise<void> {
  const shaIO = fakeShaIO();
  const metas: RepoMeta[] = [
    { id: 'o/one', defaultBranch: 'main', headSha: 'h1' },
    { id: 'o/two', defaultBranch: 'main', headSha: 'h2' },
  ];
  const client: OrgClient = {
    listRepos: async () => metas,
    openRepo: async (m) => fakeRepo(m),
  };

  // Run 1: cold cache => full crawl, then shas persisted.
  const r1 = await crawl(client, fakeMemoryIO(), shaIO);
  assert(r1.ingested.length === 2 && r1.skipped.length === 0, 'run 1 ingests both repos');
  const saved = loadKnownShas(shaIO);
  assert(saved['o/one'] === 'h1' && saved['o/two'] === 'h2', 'run 1 persisted both head shas');

  // Run 2: nothing changed upstream => both skipped (the whole point of #588).
  const r2 = await crawl(client, fakeMemoryIO(), shaIO);
  assert(r2.ingested.length === 0, 'run 2 ingests nothing (all unchanged)');
  assert(r2.skipped.includes('o/one') && r2.skipped.includes('o/two'), 'run 2 skips both via persisted shas');

  // Run 3: one repo's HEAD moved => only that repo re-ingests.
  metas[1] = { id: 'o/two', defaultBranch: 'main', headSha: 'h2b' };
  const r3 = await crawl(client, fakeMemoryIO(), shaIO);
  assert(r3.ingested.join(',') === 'o/two', 'run 3 re-ingests only the changed repo');
  assert(loadKnownShas(shaIO)['o/two'] === 'h2b', 'run 3 updated the changed sha');

  // Run 4: --full ignores the saved shas and re-crawls everything.
  const r4 = await crawl(client, fakeMemoryIO(), shaIO, { full: true });
  assert(r4.ingested.length === 2 && r4.skipped.length === 0, '--full forces a full re-crawl');
  console.log('PASS: test_incremental_across_runs_and_full_force');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('ingest/shas (incremental crawl persistence)', () => {
  it('test_round_trip', test_round_trip);
  it('test_merge_preserves_skipped', test_merge_preserves_skipped);
  it('test_next_skips_open_failures', test_next_skips_open_failures);
  it('test_incremental_across_runs_and_full_force', test_incremental_across_runs_and_full_force);
});

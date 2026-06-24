import { ingestRepo, ingestOrg } from '../../src/ingest/orchestrator';
import { defaultExtractors } from '../../src/ingest/extractors';
import type { OrgClient, RepoSource, RepoMeta, Extractor } from '../../src/ingest/types';
import { memoryRoot } from '../../src/memory/store';
import type { MemoryStoreIO } from '../../src/memory/store';

/**
 * Unit tests for read-only org ingestion (ONBOARD Phase 1, #587).
 * Fake OrgClient + read-only RepoSource + injected memory IO — never touches a
 * real repo, the network, or operator state.
 */

function fakeMemoryIO(): MemoryStoreIO & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    homedir: () => '/home/test',
    readFile: (p: string) => files[p],
    writeFile: (p: string, data: string) => {
      files[p] = data;
    },
    listDir: (dir: string) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const p of Object.keys(files)) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          if (rest.length > 0 && !rest.includes('/')) names.add(rest);
        }
      }
      return [...names];
    },
  };
}

function fakeRepo(meta: RepoMeta, repoFiles: Record<string, string>): RepoSource {
  return {
    meta,
    readFile: (p) => repoFiles[p],
    listFiles: (subdir) => {
      const keys = Object.keys(repoFiles);
      if (!subdir) return keys;
      const prefix = subdir.endsWith('/') ? subdir : `${subdir}/`;
      return keys.filter((k) => k === subdir || k.startsWith(prefix));
    },
  };
}

function test_ingest_repo_writes_memory(): void {
  const io = fakeMemoryIO();
  const repoFiles = {
    'README.md': '# acme/api\nThe orders service.',
    'package.json': '{"name":"api","dependencies":{"express":"^4"}}',
    CODEOWNERS: '* @acme/payments',
  };
  const before = JSON.stringify(repoFiles);
  const repo = fakeRepo({ id: 'acme/api', defaultBranch: 'main', headSha: 'abc' }, repoFiles);

  const res = ingestRepo(repo, defaultExtractors, io);

  assert(res.topicsWritten.includes('overview'), 'overview written');
  assert(res.topicsWritten.includes('dependencies'), 'dependencies written');
  assert(res.topicsWritten.includes('ownership'), 'ownership written');
  assert(res.errors.length === 0, 'no extractor errors');
  // written to the scoped memory path
  assert(
    (io.files[`${memoryRoot(io)}/repo/acme/api/overview.md`] ?? '').includes('orders service'),
    'overview content in memory',
  );
  // READ-ONLY: the repo's files were not mutated (no write surface exists)
  assert(JSON.stringify(repoFiles) === before, 'crawled repo left unmodified');
  console.log('PASS: test_ingest_repo_writes_memory');
}

function test_ingest_repo_best_effort(): void {
  const io = fakeMemoryIO();
  const boom: Extractor = {
    topic: 'boom',
    extract() {
      throw new Error('extractor failure');
    },
  };
  const repo = fakeRepo({ id: 'o/r', defaultBranch: 'main', headSha: 's' }, { 'README.md': 'hi' });
  const res = ingestRepo(repo, [boom, ...defaultExtractors], io);
  assert(res.errors.length === 1 && res.errors[0].topic === 'boom', 'failing extractor recorded');
  assert(res.topicsWritten.includes('overview'), 'other extractors still ran');
  console.log('PASS: test_ingest_repo_best_effort');
}

async function test_ingest_org_incremental(): Promise<void> {
  const io = fakeMemoryIO();
  const metas: RepoMeta[] = [
    { id: 'o/new', defaultBranch: 'main', headSha: 'n1' },
    { id: 'o/stale', defaultBranch: 'main', headSha: 's1' },
    { id: 'o/archived', defaultBranch: 'main', headSha: 'a1', archived: true },
  ];
  const sources: Record<string, RepoSource> = {
    'o/new': fakeRepo(metas[0], { 'README.md': 'new' }),
    'o/stale': fakeRepo(metas[1], { 'README.md': 'stale' }),
    'o/archived': fakeRepo(metas[2], { 'README.md': 'arch' }),
  };
  const client: OrgClient = {
    listRepos: async () => metas,
    openRepo: async (m) => sources[m.id],
  };
  // o/stale is already up-to-date at sha s1 (mixed-case key must still match the lowercased id)
  const res = await ingestOrg('o', client, io, { knownShas: { 'O/Stale': 's1' }, isBlocked: () => false });
  assert(res.repos.length === 1 && res.repos[0].repoId === 'o/new', 'only the new repo ingested');
  assert(res.skipped.includes('o/stale') && res.skipped.includes('o/archived'), 'stale + archived skipped');
  console.log('PASS: test_ingest_org_incremental');
}

async function test_ingest_org_isolates_repo_failures(): Promise<void> {
  const io = fakeMemoryIO();
  const metas: RepoMeta[] = [
    { id: 'o/good', defaultBranch: 'main', headSha: 'g1' },
    { id: 'o/bad', defaultBranch: 'main', headSha: 'b1' },
  ];
  const client: OrgClient = {
    listRepos: async () => metas,
    openRepo: async (m) => {
      if (m.id === 'o/bad') throw new Error('clone failed');
      return fakeRepo(m, { 'README.md': 'ok' });
    },
  };
  const res = await ingestOrg('o', client, io, { isBlocked: () => false });
  assert(res.repos.length === 2, 'both repos recorded (one as a failure)');
  const bad = res.repos.find((r) => r.repoId === 'o/bad');
  assert(!!bad && bad.errors.some((e) => e.topic === 'openRepo'), 'failed repo isolated with error');
  const good = res.repos.find((r) => r.repoId === 'o/good');
  assert(!!good && good.topicsWritten.includes('overview'), 'good repo still ingested after the failure');
  console.log('PASS: test_ingest_org_isolates_repo_failures');
}

async function test_ingest_org_skips_blocked(): Promise<void> {
  const io = fakeMemoryIO();
  const metas: RepoMeta[] = [{ id: 'o/blocked', defaultBranch: 'main', headSha: 'x1' }];
  const client: OrgClient = {
    listRepos: async () => metas,
    openRepo: async (m) => fakeRepo(m, { 'README.md': 'hi' }),
  };
  const res = await ingestOrg('o', client, io, { isBlocked: (id) => id === 'o/blocked' });
  assert(res.repos.length === 0 && res.skipped.includes('o/blocked'), 'blocked repo skipped, not ingested');
  console.log('PASS: test_ingest_org_skips_blocked');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('ingest (read-only org crawl)', () => {
  it('test_ingest_repo_writes_memory', test_ingest_repo_writes_memory);
  it('test_ingest_repo_best_effort', test_ingest_repo_best_effort);
  it('test_ingest_org_incremental', test_ingest_org_incremental);
  it('test_ingest_org_isolates_repo_failures', test_ingest_org_isolates_repo_failures);
  it('test_ingest_org_skips_blocked', test_ingest_org_skips_blocked);
});

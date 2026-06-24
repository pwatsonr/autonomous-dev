import { createGhOrgClient, filesystemRepoSource } from '../../src/ingest/adapters';
import type { CommandRunner, FsLike } from '../../src/ingest/adapters';
import type { RepoMeta } from '../../src/ingest/types';

/**
 * Unit tests for the gh/git ingestion adapters (ONBOARD Phase 1, #587, AC1).
 * Mocks the command runner + filesystem — no real gh/git/network. Also asserts
 * the adapter only ever issues READ-ONLY commands (NFR-1/R1).
 */

interface Recorder extends CommandRunner {
  calls: { cmd: string; args: string[] }[];
}

function recordingRunner(handler: (cmd: string, args: string[]) => { stdout: string; code: number }): Recorder {
  const calls: { cmd: string; args: string[] }[] = [];
  return {
    calls,
    run(cmd, args) {
      calls.push({ cmd, args });
      return handler(cmd, args);
    },
  };
}

const PAGE1 = JSON.stringify({
  data: {
    organization: {
      repositories: {
        nodes: [
          { nameWithOwner: 'Acme/API', isArchived: false, defaultBranchRef: { name: 'main', target: { oid: 'sha1' } } },
          { nameWithOwner: 'acme/empty', isArchived: false, defaultBranchRef: null },
        ],
        pageInfo: { hasNextPage: true, endCursor: 'c1' },
      },
    },
  },
});
const PAGE2 = JSON.stringify({
  data: {
    organization: {
      repositories: {
        nodes: [
          { nameWithOwner: 'acme/old', isArchived: true, defaultBranchRef: { name: 'main', target: { oid: 'sha2' } } },
        ],
        pageInfo: { hasNextPage: false, endCursor: 'c2' },
      },
    },
  },
});

async function test_list_repos_parses_and_paginates(): Promise<void> {
  const runner = recordingRunner((cmd, args) => {
    if (cmd === 'gh' && args[0] === 'api') {
      return { stdout: args.some((a) => a.startsWith('after=')) ? PAGE2 : PAGE1, code: 0 };
    }
    return { stdout: '', code: 0 };
  });
  const client = createGhOrgClient({ scratchDir: '/tmp/scratch', runner });
  const metas = await client.listRepos('acme');
  assert(metas.length === 2, `2 repos (empty skipped), got ${metas.length}`);
  assert(metas[0].id === 'acme/api' && metas[0].headSha === 'sha1', 'id lowercased + sha from page1');
  assert(metas[1].id === 'acme/old' && metas[1].archived === true, 'archived repo from page2');
  console.log('PASS: test_list_repos_parses_and_paginates');
}

async function test_only_readonly_commands(): Promise<void> {
  const runner = recordingRunner((cmd, args) => {
    if (cmd === 'gh' && args[0] === 'api') return { stdout: PAGE2, code: 0 };
    return { stdout: '', code: 0 }; // clone "succeeds"
  });
  const client = createGhOrgClient({ scratchDir: '/tmp/scratch', runner, fsLike: { readFile: () => undefined, listFiles: () => [] } });
  await client.listRepos('acme');
  await client.openRepo({ id: 'acme/old', defaultBranch: 'main', headSha: 'sha2' });

  const forbidden = ['push', 'commit', 'rm', '-X', 'POST', 'PUT', 'PATCH', 'DELETE', 'gh pr', 'gh issue'];
  for (const { cmd, args } of runner.calls) {
    assert(cmd === 'gh' || cmd === 'git', `only gh/git invoked, saw ${cmd}`);
    const line = `${cmd} ${args.join(' ')}`;
    for (const f of forbidden) {
      assert(!line.includes(f), `read-only: command must not contain "${f}" — got: ${line}`);
    }
  }
  // the clone is shallow + to scratch
  const clone = runner.calls.find((c) => c.args[0] === 'repo' && c.args[1] === 'clone');
  assert(!!clone && clone.args.includes('--depth') && clone.args.includes('1'), 'clone is shallow (--depth 1)');
  assert(!!clone && clone.args[3].startsWith('/tmp/scratch'), 'clone target is the scratch dir');
  console.log('PASS: test_only_readonly_commands');
}

function test_filesystem_repo_source(): void {
  const files: Record<string, string> = {
    '/scratch/o__r/README.md': '# hi',
    '/scratch/o__r/.github/workflows/ci.yml': 'on: push',
  };
  const fsLike: FsLike = {
    readFile: (p) => files[p],
    listFiles: (dir) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      return Object.keys(files).filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
    },
  };
  const meta: RepoMeta = { id: 'o/r', defaultBranch: 'main', headSha: 's' };
  const repo = filesystemRepoSource(meta, '/scratch/o__r', fsLike);
  assert(repo.readFile('README.md') === '# hi', 'readFile relative');
  assert(repo.listFiles('.github/workflows').includes('.github/workflows/ci.yml'), 'listFiles returns repo-relative');
  assert(repo.readFile('nope') === undefined, 'missing file => undefined');
  console.log('PASS: test_filesystem_repo_source');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('ingest/adapters (gh/git, read-only)', () => {
  it('test_list_repos_parses_and_paginates', test_list_repos_parses_and_paginates);
  it('test_only_readonly_commands', test_only_readonly_commands);
  it('test_filesystem_repo_source', test_filesystem_repo_source);
});

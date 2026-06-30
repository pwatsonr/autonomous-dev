/**
 * Real gh/git adapters for org ingestion (ONBOARD Phase 1 — #587, AC1).
 *
 * - `OrgClient` via `gh api graphql` (lists an org's repos + default-branch oid
 *   + archived flag in one paginated query — cheap at 100s of repos).
 * - `RepoSource` via a **shallow, single-branch clone to a scratch dir** read
 *   through the filesystem; the only git/gh commands issued are reads
 *   (`api graphql`, `repo clone --depth 1`) — never push/commit, and never the
 *   repo's real working tree. Read-only by construction (NFR-1/R1).
 *
 * The command runner + filesystem are injected so this is unit-tested by
 * mocking gh/git; the live calls are exercised at runtime.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { OrgClient, RepoSource, RepoMeta } from './types';

// A repo id from gh is always `owner/name`; require that shape and a safe path
// charset so it can never escape the scratch dir or the memory root, and never
// be mistaken for a `gh`/`git` flag (no leading dash).
const SAFE_REPO_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;
const ORG_LOGIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

export interface CommandRunner {
  run(cmd: string, args: string[], opts?: { cwd?: string }): { stdout: string; code: number };
}

export const execRunner: CommandRunner = {
  run(cmd, args, opts) {
    try {
      const stdout = execFileSync(cmd, args, {
        cwd: opts?.cwd,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return { stdout, code: 0 };
    } catch (err) {
      const e = err as { stdout?: Buffer | string; status?: number };
      return { stdout: e.stdout ? e.stdout.toString() : '', code: e.status ?? 1 };
    }
  },
};

export interface FsLike {
  readFile(filePath: string): string | undefined;
  /** Absolute paths of entries directly under `dir` ([] if missing). */
  listFiles(dir: string): string[];
}

export const defaultFs: FsLike = {
  readFile: (filePath) =>
    fs.existsSync(filePath) && fs.statSync(filePath).isFile()
      ? fs.readFileSync(filePath, 'utf-8')
      : undefined,
  listFiles: (dir) =>
    fs.existsSync(dir) && fs.statSync(dir).isDirectory()
      ? fs.readdirSync(dir).map((n) => path.join(dir, n))
      : [],
};

/** A read-only RepoSource backed by a (shallow-cloned) directory. */
export function filesystemRepoSource(
  meta: RepoMeta,
  rootDir: string,
  fsLike: FsLike = defaultFs,
): RepoSource {
  return {
    meta,
    readFile: (rel) => fsLike.readFile(path.join(rootDir, rel)),
    listFiles: (subdir) => {
      const dir = subdir ? path.join(rootDir, subdir) : rootDir;
      return fsLike.listFiles(dir).map((p) => path.relative(rootDir, p));
    },
  };
}

const REPOS_QUERY =
  'query($org:String!,$after:String){organization(login:$org){repositories(first:100,after:$after){' +
  'nodes{nameWithOwner isArchived defaultBranchRef{name target{oid}}}' +
  'pageInfo{hasNextPage endCursor}}}}';

interface RepoNode {
  nameWithOwner: string;
  isArchived: boolean;
  defaultBranchRef: { name: string; target: { oid: string } } | null;
}

/** Create a gh/git-backed OrgClient. Clones land under `scratchDir`. */
export function createGhOrgClient(opts: {
  scratchDir: string;
  runner?: CommandRunner;
  fsLike?: FsLike;
}): OrgClient {
  const runner = opts.runner ?? execRunner;
  return {
    async listRepos(org: string): Promise<RepoMeta[]> {
      if (!ORG_LOGIN_RE.test(org) || org.length > 39) {
        throw new Error(`Invalid org login "${org}".`);
      }
      const metas: RepoMeta[] = [];
      let after: string | null = null;
      // paginate. org/after are passed as RAW string fields (`-f`), not `-F`:
      // `-F` would treat an `@`-prefixed value as a local file to upload.
      for (;;) {
        const args = ['api', 'graphql', '-f', `query=${REPOS_QUERY}`, '-f', `org=${org}`];
        if (after) args.push('-f', `after=${after}`);
        const { stdout, code } = runner.run('gh', args);
        if (code !== 0) throw new Error(`gh api graphql failed for org "${org}" (exit ${code})`);
        const conn = JSON.parse(stdout).data.organization.repositories as {
          nodes: RepoNode[];
          pageInfo: { hasNextPage: boolean; endCursor: string };
        };
        for (const n of conn.nodes) {
          if (!n.defaultBranchRef) continue; // empty repo — nothing to crawl
          const id = n.nameWithOwner.toLowerCase();
          if (!SAFE_REPO_ID.test(id)) continue; // skip an id that isn't a safe owner/name path segment
          metas.push({
            id,
            defaultBranch: n.defaultBranchRef.name,
            headSha: n.defaultBranchRef.target.oid,
            archived: n.isArchived,
          });
        }
        if (!conn.pageInfo.hasNextPage) break;
        after = conn.pageInfo.endCursor;
      }
      return metas;
    },

    async openRepo(meta: RepoMeta): Promise<RepoSource> {
      if (!SAFE_REPO_ID.test(meta.id)) {
        throw new Error(`Refusing to clone unsafe repo id "${meta.id}".`);
      }
      const dir = path.join(opts.scratchDir, meta.id.replace(/\//g, '__'));
      // shallow, single-branch, READ-ONLY clone (no push/commit ever issued).
      const { code } = runner.run('gh', [
        'repo',
        'clone',
        meta.id,
        dir,
        '--',
        '--depth',
        '1',
        '--single-branch',
      ]);
      if (code !== 0) throw new Error(`shallow clone failed for "${meta.id}" (exit ${code})`);
      return filesystemRepoSource(meta, dir, opts.fsLike);
    },
  };
}

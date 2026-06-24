/**
 * Read-only org-ingestion types (ONBOARD Phase 1 — #587).
 *
 * SAFETY (NFR-1 / R1): `RepoSource` exposes ONLY read methods — there is no
 * write/commit/push on the crawl surface, so ingestion is read-only by
 * construction. Concrete adapters (shallow clone or GitHub API) implement this
 * read-only interface; the orchestrator only ever writes to the MEMORY tree,
 * never to a crawled repo.
 */

import type { MemoryDoc } from '../memory/types';

export interface RepoMeta {
  /** owner/name, lowercased. */
  id: string;
  defaultBranch: string;
  headSha: string;
  archived?: boolean;
}

/** A READ-ONLY view of a repo's source. No mutation methods by design. */
export interface RepoSource {
  meta: RepoMeta;
  /** File content at a repo-relative path, or undefined if absent. */
  readFile(relPath: string): string | undefined;
  /** Repo-relative file paths (optionally under `subdir`); [] if none. */
  listFiles(subdir?: string): string[];
}

/** The GitHub-org client (injected — real impl uses the authenticated `gh`). */
export interface OrgClient {
  listRepos(org: string): Promise<RepoMeta[]>;
  openRepo(meta: RepoMeta): Promise<RepoSource>;
}

/** Produces one memory doc from a repo source. Best-effort; undefined => skip. */
export interface Extractor {
  topic: string;
  extract(repo: RepoSource): MemoryDoc | undefined;
}

export interface RepoIngestResult {
  repoId: string;
  headSha: string;
  topicsWritten: string[];
  errors: { topic: string; error: string }[];
}

export interface OrgIngestResult {
  org: string;
  repos: RepoIngestResult[];
  /** repo ids skipped (archived or up-to-date by sha). */
  skipped: string[];
}

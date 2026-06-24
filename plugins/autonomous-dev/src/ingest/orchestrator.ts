/**
 * Read-only org-ingestion orchestrator (ONBOARD Phase 1 — #587).
 *
 * Runs per-repo extractors over a read-only `RepoSource` and writes the results
 * into the scoped MEMORY tree (`repo:<id>`). NEVER writes to a crawled repo.
 * Best-effort per extractor; incremental (skips repos unchanged by HEAD sha).
 */

import type {
  OrgClient,
  Extractor,
  RepoSource,
  RepoIngestResult,
  OrgIngestResult,
} from './types';
import { writeMemoryDoc, defaultMemoryIO } from '../memory/store';
import type { MemoryStoreIO } from '../memory/store';
import { defaultExtractors } from './extractors';
import { isRepoBlocked } from './questions';

/** Ingest ONE repo (read-only): run extractors, write per-repo memory. */
export function ingestRepo(
  repo: RepoSource,
  extractors: Extractor[] = defaultExtractors,
  io: MemoryStoreIO = defaultMemoryIO,
): RepoIngestResult {
  const topicsWritten: string[] = [];
  const errors: { topic: string; error: string }[] = [];
  for (const ex of extractors) {
    try {
      const doc = ex.extract(repo);
      if (doc) {
        writeMemoryDoc(`repo:${repo.meta.id}`, doc.topic, doc.content, io);
        topicsWritten.push(doc.topic);
      }
    } catch (err) {
      errors.push({ topic: ex.topic, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { repoId: repo.meta.id, headSha: repo.meta.headSha, topicsWritten, errors };
}

export interface IngestOptions {
  /** repoId -> last ingested headSha; up-to-date repos are skipped (incremental). */
  knownShas?: Record<string, string>;
  extractors?: Extractor[];
  /** Predicate: a repo awaiting a human decision is skipped. Defaults to the question queue. */
  isBlocked?: (repoId: string) => boolean;
}

/**
 * Ingest a whole org (read-only). A repo is skipped when it is archived, when
 * its HEAD sha is unchanged since the last ingest (incremental — the caller
 * supplies `knownShas`), or when it is BLOCKED on a pending question. A single
 * repo that fails to open (e.g. a transient clone error) is isolated: it is
 * recorded with an error and the crawl continues — one bad repo never aborts
 * the whole org (mirrors the best-effort-per-extractor contract).
 */
export async function ingestOrg(
  org: string,
  client: OrgClient,
  io: MemoryStoreIO = defaultMemoryIO,
  opts: IngestOptions = {},
): Promise<OrgIngestResult> {
  const extractors = opts.extractors ?? defaultExtractors;
  // Incremental skip is keyed on the lowercased repo id (adapters lowercase
  // meta.id), so normalise caller-supplied known shas to match.
  const known = Object.fromEntries(
    Object.entries(opts.knownShas ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const isBlocked = opts.isBlocked ?? ((repoId: string) => isRepoBlocked(repoId));
  const repos: RepoIngestResult[] = [];
  const skipped: string[] = [];

  const metas = await client.listRepos(org);
  for (const meta of metas) {
    if (meta.archived || known[meta.id] === meta.headSha || isBlocked(meta.id)) {
      skipped.push(meta.id);
      continue;
    }
    try {
      const repo = await client.openRepo(meta);
      repos.push(ingestRepo(repo, extractors, io));
    } catch (err) {
      // Isolate per-repo failures (clone error, permission, disk) — keep crawling.
      repos.push({
        repoId: meta.id,
        headSha: meta.headSha,
        topicsWritten: [],
        errors: [{ topic: 'openRepo', error: err instanceof Error ? err.message : String(err) }],
      });
    }
  }
  return { org, repos, skipped };
}

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
}

/**
 * Ingest a whole org (read-only). Archived repos and repos whose HEAD sha is
 * unchanged since the last ingest are skipped.
 */
export async function ingestOrg(
  org: string,
  client: OrgClient,
  io: MemoryStoreIO = defaultMemoryIO,
  opts: IngestOptions = {},
): Promise<OrgIngestResult> {
  const extractors = opts.extractors ?? defaultExtractors;
  const known = opts.knownShas ?? {};
  const repos: RepoIngestResult[] = [];
  const skipped: string[] = [];

  const metas = await client.listRepos(org);
  for (const meta of metas) {
    if (meta.archived || known[meta.id] === meta.headSha) {
      skipped.push(meta.id);
      continue;
    }
    const repo = await client.openRepo(meta);
    repos.push(ingestRepo(repo, extractors, io));
  }
  return { org, repos, skipped };
}

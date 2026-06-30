/**
 * Read-only org-ingestion orchestrator (ONBOARD Phase 1 — #587).
 *
 * Runs per-repo extractors over a read-only `RepoSource` and writes the results
 * into the scoped MEMORY tree (`repo:<id>`). NEVER writes to a crawled repo.
 * Best-effort per extractor; incremental (skips repos unchanged by HEAD sha).
 */

import type { OrgClient, Extractor, RepoSource, RepoIngestResult, OrgIngestResult } from './types';
import { writeMemoryDoc, defaultMemoryIO } from '../memory/store';
import type { MemoryStoreIO } from '../memory/store';
import { defaultExtractors } from './extractors';
import { isRepoBlocked, enqueueQuestion, loadQuestions, defaultQuestionIO } from './questions';
import type { QuestionStoreIO } from './questions';
import { findAmbiguousMemberships, signalsFromMemory } from './inference';
import type { RepoSignals } from './inference';
import { writeSignalsSidecar, defaultSignalsIO } from './signals-sidecar';
import type { SignalsSidecarIO } from './signals-sidecar';

/** Ingest ONE repo (read-only): run extractors, write per-repo memory + signals sidecar. */
export function ingestRepo(
  repo: RepoSource,
  extractors: Extractor[] = defaultExtractors,
  io: MemoryStoreIO = defaultMemoryIO,
  signalsIO: SignalsSidecarIO = defaultSignalsIO,
): RepoIngestResult {
  const topicsWritten: string[] = [];
  const errors: { topic: string; error: string }[] = [];
  const produced: { topic: string; content: string }[] = [];
  for (const ex of extractors) {
    try {
      const doc = ex.extract(repo);
      if (doc) {
        writeMemoryDoc(`repo:${repo.meta.id}`, doc.topic, doc.content, io);
        topicsWritten.push(doc.topic);
        produced.push(doc);
      }
    } catch (err) {
      errors.push({ topic: ex.topic, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Decoupling sidecar (#588): write the structured signals derived from THIS
  // crawl's docs so inference/graph can consume facts instead of re-parsing the
  // markdown. Best-effort — a sidecar IO failure never aborts the crawl, and
  // inference still falls back to signalsFromMemory.
  try {
    writeSignalsSidecar(repo.meta.id, signalsFromMemory(repo.meta.id, produced), signalsIO);
  } catch {
    /* best-effort: missing sidecar => inference falls back to the markdown parse */
  }
  return { repoId: repo.meta.id, headSha: repo.meta.headSha, topicsWritten, errors };
}

export interface IngestOptions {
  /** repoId -> last ingested headSha; up-to-date repos are skipped (incremental). */
  knownShas?: Record<string, string>;
  extractors?: Extractor[];
  /** Predicate: a repo awaiting a human decision is skipped. Defaults to the question queue. */
  isBlocked?: (repoId: string) => boolean;
  /** Injected IO for the per-repo structured-signals sidecar (#588). */
  signalsIO?: SignalsSidecarIO;
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
      repos.push(ingestRepo(repo, extractors, io, opts.signalsIO ?? defaultSignalsIO));
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

/**
 * Question-queue PRODUCER (#587 AC3 / #588). Turns project-membership AMBIGUITY
 * into answerable blocking questions: a repo whose signals place it in 2+
 * candidate projects gets ONE question (id `ambiguity:<repoId>`) offering those
 * candidate project ids as the options. This is what finally feeds the queue +
 * portal/CLI that already exist (the CONSUMER skips `isRepoBlocked` repos).
 *
 * Idempotent — an existing question for the repo (pending OR already answered)
 * is never re-enqueued, so a human's answer is never clobbered. Best-effort —
 * never throws; a single malformed question never aborts the batch. Returns the
 * ids actually enqueued this call.
 */
export function enqueueAmbiguityQuestions(
  signals: RepoSignals[],
  io: QuestionStoreIO = defaultQuestionIO,
): string[] {
  const enqueued: string[] = [];
  try {
    const existing = new Set(loadQuestions(io).map((q) => q.id));
    for (const a of findAmbiguousMemberships(signals)) {
      const id = `ambiguity:${a.repoId}`;
      if (existing.has(id)) continue; // dedupe — don't double-enqueue or clobber an answer
      try {
        enqueueQuestion(
          {
            id,
            repoId: a.repoId,
            question: `Repo "${a.repoId}" matches multiple candidate projects (${a.candidateProjectIds.join(', ')}). Which does it belong to?`,
            options: a.candidateProjectIds,
          },
          io,
        );
        enqueued.push(id);
      } catch {
        // best-effort: skip a single malformed question, keep producing the rest
      }
    }
  } catch {
    // never throw from a producer
  }
  return enqueued;
}

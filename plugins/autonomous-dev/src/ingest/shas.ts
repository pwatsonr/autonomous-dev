/**
 * Known-HEAD-sha persistence for incremental org crawls (ONBOARD Phase 1 — #588).
 *
 * `ingestOrg` already skips a repo whose HEAD sha is unchanged since the last
 * run (`opts.knownShas`), but nothing persisted that map between runs — so every
 * `org ingest` was a full crawl. This stores `repoId -> headSha` as a JSON file
 * under `~/.autonomous-dev/ingest/known-shas.json`, written atomically (tmp +
 * rename, mode 0600) via injected IO — mirroring the question/ownership stores.
 */

import * as fs from 'fs';
import * as path from 'path';

import { resolveAbsoluteHome } from '../home';
import type { OrgIngestResult } from './types';

export interface ShaStoreIO {
  homedir(): string;
  readFile(filePath: string): string | undefined;
  writeFile(filePath: string, data: string): void;
}

export const defaultShaIO: ShaStoreIO = {
  homedir: () => resolveAbsoluteHome(),
  readFile: (filePath) => (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : undefined),
  writeFile: (filePath, data) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, data, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  },
};

export function knownShasPath(io: ShaStoreIO = defaultShaIO): string {
  return path.join(io.homedir(), '.autonomous-dev', 'ingest', 'known-shas.json');
}

/** Load the persisted `repoId -> headSha` map; missing/corrupt store reads as {}. */
export function loadKnownShas(io: ShaStoreIO = defaultShaIO): Record<string, string> {
  const raw = io.readFile(knownShasPath(io));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function saveKnownShas(shas: Record<string, string>, io: ShaStoreIO = defaultShaIO): void {
  io.writeFile(knownShasPath(io), `${JSON.stringify(shas, null, 2)}\n`);
}

/** Merge freshly-ingested head shas over the prior map (skipped repos keep their entry). */
export function mergeKnownShas(
  prior: Record<string, string>,
  ingested: { repoId: string; headSha: string }[],
): Record<string, string> {
  const next = { ...prior };
  for (const r of ingested) next[r.repoId] = r.headSha;
  return next;
}

/**
 * The next `repoId -> headSha` map after a crawl. Repos that OPENED are recorded
 * at their crawled sha; a repo that failed to even open (`openRepo` error) is
 * deliberately NOT recorded, so it is retried on the next run rather than being
 * skipped as "unchanged". Skipped (unchanged/archived) repos keep their prior
 * entry via `prior`.
 */
export function nextKnownShas(
  prior: Record<string, string>,
  result: OrgIngestResult,
): Record<string, string> {
  const ingested = result.repos
    .filter((r) => !r.errors.some((e) => e.topic === 'openRepo'))
    .map((r) => ({ repoId: r.repoId, headSha: r.headSha }));
  return mergeKnownShas(prior, ingested);
}

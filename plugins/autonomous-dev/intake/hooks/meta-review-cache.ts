/**
 * MetaReviewCache — file-backed cache for `agent-meta-reviewer` verdicts
 * (SPEC-019-3-03, Task 7).
 *
 * One JSON file per `<plugin-id>-<version>` keyed in `cacheDir`
 * (`~/.autonomous-dev/meta-review-cache/` by default). Bumping the
 * manifest version invalidates the cache automatically — there is no
 * TTL because the verdict is a deterministic function of the manifest
 * bytes.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write leaves
 * either the previous verdict or no entry, never partial JSON.
 *
 * @module intake/hooks/meta-review-cache
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface MetaReviewVerdict {
  pass: boolean;
  findings: string[];
  reviewedAt: string;
}

export class MetaReviewCache {
  constructor(private readonly cacheDir: string) {}

  private path(id: string, version: string): string {
    return join(this.cacheDir, `${id}-${version}.json`);
  }

  /**
   * Read the cached verdict for `id`@`version`. Returns null on cache
   * miss, on read error, or if the cached JSON is corrupt — callers
   * treat all three identically (re-run the meta-reviewer).
   */
  async get(id: string, version: string): Promise<MetaReviewVerdict | null> {
    try {
      const buf = await fs.readFile(this.path(id, version), 'utf8');
      return JSON.parse(buf) as MetaReviewVerdict;
    } catch {
      return null;
    }
  }

  /**
   * Write a verdict atomically. Creates the cache dir on first call.
   * The on-disk shape adds a `reviewedAt` ISO timestamp so operators
   * can `cat` an entry to see when the verdict was rendered.
   */
  async set(
    id: string,
    version: string,
    verdict: { pass: boolean; findings: string[] },
  ): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const entry: MetaReviewVerdict = {
      ...verdict,
      reviewedAt: new Date().toISOString(),
    };
    const finalPath = this.path(id, version);
    const tmp = `${finalPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entry, null, 2));
    await fs.rename(tmp, finalPath);
  }
}

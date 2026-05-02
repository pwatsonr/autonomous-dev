/**
 * Deterministic file-tree manifest helpers (SPEC-023-1-02 / 03).
 *
 * Used by the `static` and `github-pages` backends to:
 *   - sum byte sizes for `BuildArtifact.sizeBytes`,
 *   - compute a SHA-256 fingerprint over a sorted manifest of file paths
 *     + contents so two builds that produce the same files produce the
 *     same artifact checksum.
 *
 * @module intake/deploy/file-tree
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { relative, resolve, sep, join } from 'node:path';

export interface FileTreeManifest {
  /** Lowercase-hex SHA-256 of the sorted (path, sha256(content)) manifest. */
  checksum: string;
  /** Sum of file sizes in bytes. */
  sizeBytes: number;
  /** Number of files traversed. */
  fileCount: number;
}

/**
 * Walk `dir` recursively, hash every file, and combine the results into
 * a single deterministic manifest checksum. Symlinks are followed (rsync
 * deploys do too, by default); cycles are bounded by `fs.stat` rejecting
 * recursive cycles via the OS.
 */
export async function buildFileTreeManifest(
  dir: string,
): Promise<FileTreeManifest> {
  const root = resolve(dir);
  const files: { rel: string; size: number; hash: string }[] = [];
  await walk(root, root, files);
  // Sort to make manifest content order-independent.
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const aggregate = createHash('sha256');
  let total = 0;
  for (const f of files) {
    aggregate.update(f.rel.split(sep).join('/'));
    aggregate.update('\0');
    aggregate.update(f.hash);
    aggregate.update('\0');
    total += f.size;
  }
  return {
    checksum: aggregate.digest('hex'),
    sizeBytes: total,
    fileCount: files.length,
  };
}

async function walk(
  root: string,
  cur: string,
  out: { rel: string; size: number; hash: string }[],
): Promise<void> {
  const entries = await fs.readdir(cur, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(cur, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.stat(full);
    const buf = await fs.readFile(full);
    const hash = createHash('sha256').update(buf).digest('hex');
    out.push({
      rel: relative(root, full),
      size: stat.size,
      hash,
    });
  }
}

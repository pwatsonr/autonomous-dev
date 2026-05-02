/**
 * Build-artifact persistence (SPEC-023-1-02, Task 3).
 *
 * Stores each artifact at:
 *
 *     <repoPath>/.autonomous-dev/builds/<artifactId>/
 *       ├── manifest.json     # serialized BuildArtifact
 *       └── checksum.sha256   # sha256 of canonical(manifest.json)
 *
 * Uses two-phase commit (write `<file>.tmp` → fsync → rename) consistent
 * with the existing PLAN-002-1 persistence patterns.
 *
 * @module intake/deploy/artifact-store
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { canonicalJSON } from '../chains/canonical-json';
import type { BuildArtifact } from './types';

/** Subdir under the repo where build artifacts are persisted. */
export const BUILDS_DIRNAME = '.autonomous-dev/builds';

/** Subdir where signed deployment records are persisted. */
export const DEPLOYMENTS_DIRNAME = '.autonomous-dev/deployments';

/** Compute the directory a given artifact lives in. */
export function artifactDir(repoPath: string, artifactId: string): string {
  return join(repoPath, BUILDS_DIRNAME, artifactId);
}

/** Compute the directory deployment records live in. */
export function deploymentsDir(repoPath: string): string {
  return join(repoPath, DEPLOYMENTS_DIRNAME);
}

/**
 * Write an artifact's manifest + checksum atomically.
 *
 * Returns the absolute path of the written manifest.
 */
export async function writeArtifact(
  repoPath: string,
  artifact: BuildArtifact,
): Promise<{ manifestPath: string; checksumPath: string }> {
  const dir = artifactDir(repoPath, artifact.artifactId);
  await fs.mkdir(dir, { recursive: true });
  const manifest = canonicalJSON(artifact);
  const checksum = createHash('sha256').update(manifest).digest('hex');
  const manifestPath = join(dir, 'manifest.json');
  const checksumPath = join(dir, 'checksum.sha256');
  await atomicWrite(manifestPath, manifest);
  await atomicWrite(checksumPath, checksum);
  return { manifestPath, checksumPath };
}

/** Read a previously persisted artifact's manifest. */
export async function readArtifact(
  repoPath: string,
  artifactId: string,
): Promise<BuildArtifact> {
  const manifestPath = join(artifactDir(repoPath, artifactId), 'manifest.json');
  const data = await fs.readFile(manifestPath, 'utf8');
  return JSON.parse(data) as BuildArtifact;
}

/**
 * Verify that the persisted `checksum.sha256` matches the bytes of the
 * persisted `manifest.json`. Returns `true` iff they agree.
 */
export async function verifyArtifactChecksum(
  repoPath: string,
  artifactId: string,
): Promise<boolean> {
  const dir = artifactDir(repoPath, artifactId);
  const manifest = await fs.readFile(join(dir, 'manifest.json'), 'utf8');
  const checksum = (await fs.readFile(join(dir, 'checksum.sha256'), 'utf8')).trim();
  const expected = createHash('sha256').update(manifest).digest('hex');
  return checksum === expected;
}

/** Two-phase write: <path>.tmp → fsync → rename. */
async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp.${randomUUID()}`;
  await fs.mkdir(dirname(path), { recursive: true });
  const fh = await fs.open(tmp, 'w', 0o644);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, path);
}

/**
 * Persist a deployment record (signed JSON) under `<repo>/.autonomous-dev/
 * deployments/<deployId>.json` atomically. Returns the absolute path.
 */
export async function writeDeploymentRecord(
  repoPath: string,
  record: { deployId: string } & Record<string, unknown>,
): Promise<string> {
  const dir = deploymentsDir(repoPath);
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, `${record.deployId}.json`);
  await atomicWrite(path, JSON.stringify(record));
  return path;
}

/**
 * List previously written deployment records as parsed objects, oldest
 * first by `deployedAt` (ISO-8601 sorts lexicographically).
 *
 * Used by `static.rollback()` and `docker-local.rollback()` to find the
 * previous deploy for a given backend+environment.
 */
export async function listDeploymentRecords(
  repoPath: string,
): Promise<Record<string, unknown>[]> {
  const dir = deploymentsDir(repoPath);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: Record<string, unknown>[] = [];
  for (const entry of entries.filter((e) => e.endsWith('.json'))) {
    try {
      const raw = await fs.readFile(join(dir, entry), 'utf8');
      out.push(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      // Skip unreadable / corrupt records; a verifier will flag them.
    }
  }
  out.sort((a, b) => {
    const ad = String(a.deployedAt ?? '');
    const bd = String(b.deployedAt ?? '');
    return ad.localeCompare(bd);
  });
  return out;
}

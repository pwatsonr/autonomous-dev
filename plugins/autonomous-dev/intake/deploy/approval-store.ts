/**
 * Filesystem persistence for approval state with two-phase commit
 * (SPEC-023-2-03).
 *
 * Path layout:
 *   <requestDir>/.autonomous-dev/deployments/<deployId>.approval.json
 *
 * Mode invariants:
 *   - approval file: 0600
 *   - parent directory `deployments/`: 0700 if newly created
 *
 * Two-phase commit (atomic on POSIX):
 *   tmp = path + ".tmp." + random
 *   open(tmp, O_WRONLY|O_CREAT|O_EXCL, 0600)
 *   write(canonical_json(state)); fsync; close
 *   rename(tmp, path)
 *   fsync(parent_dir)   (best-effort; not all filesystems support directory fsync)
 *
 * @module intake/deploy/approval-store
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { canonicalJSON } from '../chains/canonical-json';
import type { ApprovalState } from './approval-types';

/** Directory under a request root that holds approval-state files. */
export function deploymentsDir(requestDir: string): string {
  return join(requestDir, '.autonomous-dev', 'deployments');
}

/** Conventional approval file path for a deploy id. */
export function approvalPathFor(requestDir: string, deployId: string): string {
  return join(deploymentsDir(requestDir), `${deployId}.approval.json`);
}

/** Read the raw approval state from disk; null when no file exists. */
export async function readApprovalFile(
  requestDir: string,
  deployId: string,
): Promise<ApprovalState | null> {
  const path = approvalPathFor(requestDir, deployId);
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(text) as ApprovalState;
}

/**
 * Two-phase write: temp file + atomic rename. The temp file is created
 * O_EXCL so that two concurrent writers do not collide on the same
 * tmp path. Mode `0600` from the start (no chmod race window).
 */
export async function writeApprovalFile(
  requestDir: string,
  state: ApprovalState,
): Promise<void> {
  const path = approvalPathFor(requestDir, state.deployId);
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // chmod is idempotent and hardens existing perms.
  await fs.chmod(dir, 0o700).catch(() => undefined);

  const tmp = `${path}.tmp.${randomBytes(8).toString('hex')}`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(canonicalJSON(state as unknown as Record<string, unknown>), {
      encoding: 'utf8',
    });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, path);
  // Best-effort directory durability fsync.
  try {
    const dirH = await fs.open(dir, 'r');
    try {
      await dirH.sync();
    } finally {
      await dirH.close();
    }
  } catch {
    // Some filesystems / platforms do not support fsync on a directory fd.
  }
}

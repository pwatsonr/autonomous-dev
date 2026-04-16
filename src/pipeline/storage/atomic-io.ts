import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Writes content to targetPath atomically using write-then-rename.
 *
 * Algorithm (POSIX atomic rename):
 *   1. Create a temp file at `{targetPath}.{Date.now()}.tmp`
 *   2. Write content to temp file
 *   3. fsync the temp file to ensure durability
 *   4. rename temp file to targetPath (atomic on POSIX)
 *   5. On failure: unlink temp file (best-effort cleanup)
 *
 * @param targetPath Absolute path to the destination file
 * @param content String content to write
 * @throws AtomicWriteError on permission denied, disk full, or invalid path
 */
export async function atomicWrite(
  targetPath: string,
  content: string,
): Promise<void> {
  const tmpPath = `${targetPath}.${Date.now()}.tmp`;
  try {
    const fd = await fs.open(tmpPath, 'w');
    try {
      await fd.writeFile(content, 'utf-8');
      await fd.sync(); // fsync for durability
    } finally {
      await fd.close();
    }
    await fs.rename(tmpPath, targetPath);
  } catch (err: unknown) {
    // Best-effort cleanup of temp file
    await fs.unlink(tmpPath).catch(() => {});
    throw new AtomicWriteError(
      `Atomic write to ${targetPath} failed`,
      err as Error,
    );
  }
}

/**
 * Atomically swaps a symlink to point to a new target.
 *
 * Algorithm:
 *   1. Create a temp symlink at `{linkPath}.{Date.now()}.tmp`
 *   2. rename temp symlink to linkPath (atomic on POSIX)
 *   3. On failure: unlink temp symlink (best-effort cleanup)
 *
 * @param target Relative path the symlink should point to (e.g. "v1.1.md")
 * @param linkPath Absolute path of the symlink (e.g. "/path/to/current.md")
 */
export async function atomicSymlink(
  target: string,
  linkPath: string,
): Promise<void> {
  const tmpLink = `${linkPath}.${Date.now()}.tmp`;
  try {
    await fs.symlink(target, tmpLink);
    await fs.rename(tmpLink, linkPath);
  } catch (err: unknown) {
    await fs.unlink(tmpLink).catch(() => {});
    throw new AtomicWriteError(
      `Atomic symlink swap at ${linkPath} failed`,
      err as Error,
    );
  }
}

export class AtomicWriteError extends Error {
  constructor(message: string, public readonly cause: Error) {
    super(message);
    this.name = 'AtomicWriteError';
  }
}

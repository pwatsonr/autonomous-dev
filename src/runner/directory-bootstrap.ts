import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * All directories that must exist under the project root before
 * any observation run can begin.
 */
export const REQUIRED_DIRS = [
  '.autonomous-dev/config',
  '.autonomous-dev/observations',
  '.autonomous-dev/observations/archive',
  '.autonomous-dev/observations/digests',
  '.autonomous-dev/baselines',
  '.autonomous-dev/fingerprints',
  '.autonomous-dev/logs/intelligence',
  '.autonomous-dev/prd',
] as const;

/**
 * Creates the full `.autonomous-dev/` directory tree if any part is missing.
 *
 * This function is idempotent -- calling it on an existing tree is a no-op.
 * It also creates a `YYYY/MM` subdirectory under `observations/` for the
 * current month.
 *
 * @param rootDir The project root directory
 * @param now Optional Date for testability (defaults to current time)
 */
export async function bootstrapDirectories(
  rootDir: string,
  now: Date = new Date(),
): Promise<void> {
  for (const dir of REQUIRED_DIRS) {
    const fullPath = path.join(rootDir, dir);
    await fs.mkdir(fullPath, { recursive: true });
  }

  // Create YYYY/MM subdirectory for the current month
  const year = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const yearMonthPath = path.join(
    rootDir,
    '.autonomous-dev/observations',
    year,
    month,
  );
  await fs.mkdir(yearMonthPath, { recursive: true });
}

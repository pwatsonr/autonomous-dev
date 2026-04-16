/**
 * Observation file naming and directory placement
 * (SPEC-007-4-1, Task 2).
 *
 * File name format: `OBS-YYYYMMDD-HHMMSS-<hex4>.md`
 * Directory placement: `.autonomous-dev/observations/YYYY/MM/`
 *
 * Handles directory auto-creation and (extremely unlikely) collision
 * regeneration.
 */

import { randomBytes } from 'crypto';
import * as path from 'path';
import * as fs from 'fs/promises';

// ---------------------------------------------------------------------------
// Observation ID generation
// ---------------------------------------------------------------------------

/**
 * Generates a unique observation ID from the current timestamp and
 * 4 random hex characters.
 *
 * Format: `OBS-YYYYMMDD-HHMMSS-<hex4>`
 *
 * @param now  Optional date to use (defaults to current time).
 *             Exposed for testability.
 * @returns A string like `OBS-20260408-143022-a1b2`.
 */
export function generateObservationId(now: Date = new Date()): string {
  const dateStr = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  // dateStr is now "YYYYMMDDHHMMSS" (14 chars)
  const datePart = dateStr.slice(0, 8);
  const timePart = dateStr.slice(8, 14);
  const shortId = randomBytes(2).toString('hex'); // 4 hex chars
  return `OBS-${datePart}-${timePart}-${shortId}`;
}

// ---------------------------------------------------------------------------
// File path resolution
// ---------------------------------------------------------------------------

/**
 * Computes the file path for an observation report based on its ID.
 *
 * Extracts the year and month from the ID to determine the directory:
 * `<rootDir>/.autonomous-dev/observations/YYYY/MM/<id>.md`
 *
 * @param id       The observation ID (e.g., `OBS-20260408-143022-a1b2`).
 * @param rootDir  The project root directory.
 * @returns Absolute file path for the observation report.
 * @throws Error if the ID format is invalid.
 */
export function getObservationFilePath(id: string, rootDir: string): string {
  const match = id.match(/^OBS-(\d{4})(\d{2})\d{2}-\d{6}-[a-f0-9]{4}$/);
  if (!match) {
    throw new Error(`Invalid observation ID format: ${id}`);
  }
  const [, year, month] = match;
  const dir = path.join(rootDir, '.autonomous-dev', 'observations', year, month);
  return path.join(dir, `${id}.md`);
}

// ---------------------------------------------------------------------------
// Collision-safe file writing
// ---------------------------------------------------------------------------

/**
 * Regenerates the 4-hex-char suffix of an observation ID while keeping
 * the timestamp portion unchanged.
 *
 * @param id  The original observation ID.
 * @returns A new ID with a different hex suffix.
 */
export function regenerateShortId(id: string): string {
  const prefix = id.slice(0, id.length - 4); // "OBS-YYYYMMDD-HHMMSS-"
  const newHex = randomBytes(2).toString('hex');
  return `${prefix}${newHex}`;
}

/**
 * Checks whether a file exists at the given path.
 *
 * @param filePath  Absolute file path.
 * @returns True if the file exists.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes an observation report to disk with collision-safe naming.
 *
 * 1. Resolves the file path from the observation ID.
 * 2. Creates the directory tree if it does not exist.
 * 3. Checks for collision (extremely unlikely with random hex).
 * 4. On collision, regenerates the hex suffix and retries.
 *
 * @param id       The observation ID.
 * @param content  The full report content (YAML frontmatter + Markdown).
 * @param rootDir  The project root directory.
 * @returns The absolute path where the file was written.
 */
export async function writeObservationReport(
  id: string,
  content: string,
  rootDir: string,
): Promise<string> {
  const filePath = getObservationFilePath(id, rootDir);

  // Ensure directory exists
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // Collision check (extremely unlikely with random hex)
  if (await fileExists(filePath)) {
    const newId = regenerateShortId(id);
    return writeObservationReport(
      newId,
      content.replace(new RegExp(escapeRegex(id), 'g'), newId),
      rootDir,
    );
  }

  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Escapes special regex characters in a string for use in `new RegExp()`.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

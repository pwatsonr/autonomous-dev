/**
 * File retention policy for observations (SPEC-007-4-4, Task 10).
 *
 * Runs as a cleanup step at the end of each observation run.
 *
 * Phase 1: Archive observations older than `observation_days` (default 90)
 *   - Moved from `.autonomous-dev/observations/` to
 *     `.autonomous-dev/observations/archive/`
 *   - Promoted observations with active PRDs are exempt
 *
 * Phase 2: Delete archived observations older than `archive_days` (default 365)
 *   - Permanently removed from `.autonomous-dev/observations/archive/`
 *
 * All moves and deletes are logged via the audit logger.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Retention policy configuration.
 */
export interface RetentionConfig {
  /** Days before an observation is moved to archive. Default: 90 */
  observation_days: number;
  /** Days before an archived observation is permanently deleted. Default: 365 */
  archive_days: number;
}

/**
 * Result of a retention policy run.
 */
export interface RetentionResult {
  /** File paths that were moved to the archive directory */
  archived: string[];
  /** File paths that were permanently deleted */
  deleted: string[];
  /** File paths that were exempt from retention (e.g., promoted with active PRD) */
  skipped: string[];
}

/**
 * Audit logger interface for retention operations.
 * Compatible with both the TriageAuditLogger and run-level logging.
 */
export interface AuditLogger {
  info(message: string): void;
}

/**
 * Frontmatter fields relevant to retention decisions.
 */
interface RetentionFrontmatter {
  id: string;
  timestamp: string;
  triage_status: string;
  linked_prd: string | null;
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  observation_days: 90,
  archive_days: 365,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively finds all OBS-*.md files in a directory, excluding the
 * archive subdirectory.
 */
async function findObservationFiles(
  baseDir: string,
  currentDir: string = baseDir,
): Promise<string[]> {
  const results: string[] = [];

  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      // Skip the archive directory when scanning observations
      if (entry.name === 'archive' && currentDir === baseDir) continue;
      const subResults = await findObservationFiles(baseDir, fullPath);
      results.push(...subResults);
    } else if (
      entry.isFile() &&
      entry.name.startsWith('OBS-') &&
      entry.name.endsWith('.md')
    ) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Finds all OBS-*.md files in a flat directory (archive).
 */
async function findArchiveFiles(archiveDir: string): Promise<string[]> {
  const results: string[] = [];

  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(archiveDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (
      entry.isFile() &&
      entry.name.startsWith('OBS-') &&
      entry.name.endsWith('.md')
    ) {
      results.push(path.join(archiveDir, entry.name));
    }
  }

  return results;
}

/**
 * Reads the YAML frontmatter from an observation file and extracts
 * retention-relevant fields.
 *
 * Uses a lightweight parser (no full YAML dependency) consistent
 * with frontmatter-io.ts conventions.
 */
export async function readFrontmatter(
  filePath: string,
): Promise<RetentionFrontmatter | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;

    const parsed: Record<string, string | null> = {};
    for (const line of fmMatch[1].split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.substring(0, colonIdx).trim();
      let val = line.substring(colonIdx + 1).trim();
      if (val === 'null' || val === '~' || val === '') {
        parsed[key] = null;
      } else if (val.startsWith('"') && val.endsWith('"')) {
        parsed[key] = val.slice(1, -1);
      } else {
        parsed[key] = val;
      }
    }

    if (!parsed.id || !parsed.timestamp) return null;

    return {
      id: parsed.id,
      timestamp: parsed.timestamp,
      triage_status: parsed.triage_status ?? 'pending',
      linked_prd: parsed.linked_prd ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Checks whether a linked PRD is in an active (non-terminal) state.
 *
 * Active states: draft, in-progress, review (or any state that is NOT
 * completed or cancelled).
 *
 * Terminal states: completed, cancelled.
 *
 * If the PRD file does not exist, returns false (not active).
 */
export async function isPrdInActiveState(
  prdId: string,
  rootDir: string,
): Promise<boolean> {
  const prdPath = path.join(rootDir, '.autonomous-dev', 'prd', `${prdId}.md`);
  try {
    const content = await fs.readFile(prdPath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return false;

    for (const line of fmMatch[1].split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.substring(0, colonIdx).trim();
      const val = line.substring(colonIdx + 1).trim();
      if (key === 'status') {
        return val !== 'completed' && val !== 'cancelled';
      }
    }

    return false;
  } catch {
    return false; // PRD not found = not active
  }
}

// ---------------------------------------------------------------------------
// Retention policy
// ---------------------------------------------------------------------------

/**
 * Applies the retention policy to observation files.
 *
 * Phase 1: Archive observations older than `observation_days`
 *   - Scans `.autonomous-dev/observations/` (excluding archive/)
 *   - Checks frontmatter `timestamp` to determine age
 *   - Exempts promoted observations with active PRDs
 *   - Moves eligible files to `archiveDir`
 *
 * Phase 2: Delete archived observations older than `archive_days`
 *   - Scans `archiveDir` for OBS-*.md files
 *   - Permanently deletes files whose timestamp exceeds the threshold
 *
 * @param observationsDir  Absolute path to `.autonomous-dev/observations/`
 * @param archiveDir       Absolute path to `.autonomous-dev/observations/archive/`
 * @param config           Retention configuration (days thresholds)
 * @param auditLog         Logger for recording retention actions
 * @param rootDir          Project root (for PRD lookups)
 * @param now              Optional "now" override for testing
 * @returns Retention result with lists of archived, deleted, and skipped files
 */
export async function applyRetentionPolicy(
  observationsDir: string,
  archiveDir: string,
  config: RetentionConfig,
  auditLog: AuditLogger,
  rootDir: string,
  now: Date = new Date(),
): Promise<RetentionResult> {
  const result: RetentionResult = { archived: [], deleted: [], skipped: [] };
  const msPerDay = 24 * 60 * 60 * 1000;

  // Ensure archive directory exists
  await fs.mkdir(archiveDir, { recursive: true });

  // Phase 1: Archive observations older than observation_days
  const observationFiles = await findObservationFiles(observationsDir);
  for (const filePath of observationFiles) {
    const fm = await readFrontmatter(filePath);
    if (!fm) continue;

    const obsDate = new Date(fm.timestamp);
    const daysSinceObs = (now.getTime() - obsDate.getTime()) / msPerDay;

    if (daysSinceObs > config.observation_days) {
      // Check exemption: promoted observations with active PRDs
      if (fm.triage_status === 'promoted' && fm.linked_prd) {
        const prdActive = await isPrdInActiveState(fm.linked_prd, rootDir);
        if (prdActive) {
          result.skipped.push(filePath);
          auditLog.info(`Retention: skipping ${fm.id} (promoted, PRD active)`);
          continue;
        }
      }

      // Move to archive
      const archivePath = path.join(archiveDir, path.basename(filePath));
      await fs.rename(filePath, archivePath);
      result.archived.push(filePath);
      auditLog.info(`Retention: archived ${fm.id}`);
    }
  }

  // Phase 2: Delete archived observations older than archive_days
  const archiveFiles = await findArchiveFiles(archiveDir);
  for (const filePath of archiveFiles) {
    const fm = await readFrontmatter(filePath);
    if (!fm) continue;

    const obsDate = new Date(fm.timestamp);
    const daysSinceObs = (now.getTime() - obsDate.getTime()) / msPerDay;

    if (daysSinceObs > config.archive_days) {
      await fs.unlink(filePath);
      result.deleted.push(filePath);
      auditLog.info(`Retention: deleted archived ${fm.id}`);
    }
  }

  return result;
}

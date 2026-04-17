/**
 * Override scheduler: schedule and execute override window checks
 * (SPEC-007-5-4, Task 8).
 *
 * Manages the override window for auto-promoted observations.
 * When an observation is auto-promoted, a pending override check
 * is written to disk. At the start of each observation run,
 * pending overrides are processed:
 *
 * - If the PM Lead overrode within the window: PRD cancelled
 * - If no override: auto-promotion confirmed
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { AuditLogger } from '../runner/audit-logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OverrideCheck {
  observation_id: string;
  prd_id: string;
  override_deadline: string;
  created_at: string;
  status: 'pending' | 'confirmed' | 'overridden';
}

export interface OverrideProcessingResult {
  confirmed: number;
  overridden: number;
  still_pending: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Parse YAML frontmatter from a Markdown file.
 * Returns null if the file cannot be read or has no frontmatter.
 */
function parseFrontmatterFromFile(filePath: string): Record<string, any> | null {
  const fsSync = require('fs');
  try {
    const content = fsSync.readFileSync(filePath, 'utf-8');
    if (!content.startsWith('---')) return null;

    const endIndex = content.indexOf('\n---', 3);
    if (endIndex === -1) return null;

    const yamlBlock = content.substring(4, endIndex);
    const result: Record<string, any> = {};

    for (const line of yamlBlock.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) continue;

      const key = trimmed.substring(0, colonIndex).trim();
      let value: any = trimmed.substring(colonIndex + 1).trim();

      if (value === 'null' || value === '~' || value === '') {
        value = null;
      } else if (value === 'true') {
        value = true;
      } else if (value === 'false') {
        value = false;
      } else if ((value.startsWith('"') && value.endsWith('"')) ||
                 (value.startsWith("'") && value.endsWith("'"))) {
        value = value.substring(1, value.length - 1);
      }

      result[key] = value;
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Locate an observation file by its ID within the observations directory.
 */
function findObservationFileById(rootDir: string, observationId: string): string | null {
  const obsDir = path.join(rootDir, '.autonomous-dev', 'observations');
  const fsSync = require('fs');
  return findFileRecursive(fsSync, obsDir, observationId);
}

function findFileRecursive(
  fsSync: any,
  dir: string,
  observationId: string
): string | null {
  let entries: any[];
  try {
    entries = fsSync.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(fsSync, fullPath, observationId);
      if (found) return found;
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      try {
        const content = fsSync.readFileSync(fullPath, 'utf-8');
        if (content.includes(`id: ${observationId}`) || content.includes(`id: "${observationId}"`)) {
          return fullPath;
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Schedule override check
// ---------------------------------------------------------------------------

/**
 * Schedule an override check for an auto-promoted observation.
 *
 * The check runs at the end of the override window. It reads
 * the observation file to determine if the PM Lead overrode
 * the auto-promotion during the window.
 *
 * Override is detected by:
 * - triage_decision changed from 'promote' to something else
 * - triage_by changed from 'auto-promote-engine' to a human
 * - A specific 'override' action in the triage audit log
 */
export async function scheduleOverrideCheck(
  observationId: string,
  prdId: string,
  deadline: Date,
  rootDir: string,
  logger: AuditLogger
): Promise<void> {
  const checkFile = path.join(
    rootDir,
    '.autonomous-dev',
    'governance',
    'pending-overrides',
    `${observationId}.json`
  );
  await fs.mkdir(path.dirname(checkFile), { recursive: true });

  const check: OverrideCheck = {
    observation_id: observationId,
    prd_id: prdId,
    override_deadline: deadline.toISOString(),
    created_at: new Date().toISOString(),
    status: 'pending',
  };

  await fs.writeFile(checkFile, JSON.stringify(check, null, 2), 'utf-8');

  logger.info(
    `Override check scheduled for ${observationId}: ` +
    `deadline ${deadline.toISOString()}`
  );
}

// ---------------------------------------------------------------------------
// Process pending overrides
// ---------------------------------------------------------------------------

/**
 * Process all pending override checks.
 * Called at the start of each observation run.
 *
 * For each check past its deadline:
 * - Read the observation file
 * - If triage_decision is still 'promote' and triage_by is 'auto-promote-engine':
 *     auto-promotion stands, mark check as 'confirmed'
 * - If triage_decision has changed or triage_by is a human:
 *     PM Lead overrode, cancel the PRD, mark check as 'overridden'
 */
export async function processPendingOverrides(
  rootDir: string,
  logger: AuditLogger,
  now?: Date
): Promise<OverrideProcessingResult> {
  const pendingDir = path.join(
    rootDir,
    '.autonomous-dev',
    'governance',
    'pending-overrides'
  );
  const result: OverrideProcessingResult = {
    confirmed: 0,
    overridden: 0,
    still_pending: 0,
  };

  const files = await safeReadDir(pendingDir);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const checkPath = path.join(pendingDir, file);

    let check: OverrideCheck;
    try {
      check = JSON.parse(await fs.readFile(checkPath, 'utf-8'));
    } catch {
      continue;
    }

    if (check.status !== 'pending') continue;

    const deadline = new Date(check.override_deadline);
    const currentTime = now ?? new Date();

    if (currentTime < deadline) {
      result.still_pending++;
      continue;
    }

    // Deadline passed -- check if overridden
    const obsFile = findObservationFileById(rootDir, check.observation_id);
    if (!obsFile) {
      logger.error(`Override check: observation ${check.observation_id} not found`);
      continue;
    }

    const frontmatter = parseFrontmatterFromFile(obsFile);
    if (!frontmatter) {
      logger.error(`Override check: failed to parse ${obsFile}`);
      continue;
    }

    const wasOverridden = (
      frontmatter.triage_decision !== 'promote' ||
      (frontmatter.triage_by !== 'auto-promote-engine' && frontmatter.triage_by !== null)
    );

    if (wasOverridden) {
      // Cancel the PRD
      await cancelPrd(rootDir, check.prd_id, logger);
      check.status = 'overridden';
      result.overridden++;
      logger.info(
        `Auto-promotion overridden: ${check.observation_id}. ` +
        `PRD ${check.prd_id} cancelled.`
      );
    } else {
      check.status = 'confirmed';
      result.confirmed++;
      logger.info(
        `Auto-promotion confirmed: ${check.observation_id}. ` +
        `PRD ${check.prd_id} stands.`
      );
    }

    await fs.writeFile(checkPath, JSON.stringify(check, null, 2), 'utf-8');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Cancel PRD
// ---------------------------------------------------------------------------

/**
 * Cancel an auto-promoted PRD by marking it as cancelled.
 * Moves the file to a cancelled/ subdirectory and updates
 * the observation's linked_prd to null.
 */
async function cancelPrd(
  rootDir: string,
  prdId: string,
  logger: AuditLogger
): Promise<void> {
  const prdDir = path.join(rootDir, '.autonomous-dev', 'prd');
  const prdFile = path.join(prdDir, `${prdId}.md`);
  const cancelledDir = path.join(prdDir, 'cancelled');

  await fs.mkdir(cancelledDir, { recursive: true });

  if (await fileExists(prdFile)) {
    const cancelledPath = path.join(cancelledDir, `${prdId}.md`);
    await fs.rename(prdFile, cancelledPath);
    logger.info(`PRD ${prdId} moved to cancelled/`);
  }
}

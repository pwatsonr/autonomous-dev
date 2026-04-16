/**
 * Notification receiver: parse incoming triage commands and write
 * back to observation files (SPEC-007-5-4, Task 7).
 *
 * Commands are received as plain-text messages from the notification
 * channel. The file-based system remains the source of truth.
 *
 * Supported formats:
 *   /promote OBS-20260408-143022-a7f3 Connection pool issue confirmed
 *   /dismiss OBS-20260408-143022-a7f3 False positive, not actionable
 *   /defer OBS-20260408-143022-a7f3 2026-04-15 Wait for next sprint
 *   /investigate OBS-20260408-143022-a7f3
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { updateFrontmatter } from './frontmatter-io';
import type { AuditLogger } from '../runner/audit-logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TriageCommand {
  action: 'promote' | 'dismiss' | 'defer' | 'investigate';
  observation_id: string;
  reason?: string;
  defer_until?: string;
}

export interface ApplyTriageResult {
  applied: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Triage decision mapping
// ---------------------------------------------------------------------------

const ACTION_TO_STATUS: Record<string, string> = {
  promote: 'promoted',
  dismiss: 'dismissed',
  defer: 'deferred',
  investigate: 'investigating',
};

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

/**
 * Parse an incoming triage command from the notification channel.
 * Commands are received as plain-text messages.
 *
 * Returns null if the input does not match any supported command format.
 */
export function parseTriageCommand(input: string): TriageCommand | null {
  const trimmed = input.trim();

  // /promote OBS-YYYYMMDD-HHMMSS-xxxx <reason>
  const promoteMatch = trimmed.match(
    /^\/promote\s+(OBS-\d{8}-\d{6}-[a-f0-9]{4})\s+(.+)$/i
  );
  if (promoteMatch) {
    return { action: 'promote', observation_id: promoteMatch[1], reason: promoteMatch[2] };
  }

  // /dismiss OBS-YYYYMMDD-HHMMSS-xxxx <reason>
  const dismissMatch = trimmed.match(
    /^\/dismiss\s+(OBS-\d{8}-\d{6}-[a-f0-9]{4})\s+(.+)$/i
  );
  if (dismissMatch) {
    return { action: 'dismiss', observation_id: dismissMatch[1], reason: dismissMatch[2] };
  }

  // /defer OBS-YYYYMMDD-HHMMSS-xxxx YYYY-MM-DD <reason>
  const deferMatch = trimmed.match(
    /^\/defer\s+(OBS-\d{8}-\d{6}-[a-f0-9]{4})\s+(\d{4}-\d{2}-\d{2})\s+(.+)$/i
  );
  if (deferMatch) {
    return {
      action: 'defer',
      observation_id: deferMatch[1],
      defer_until: deferMatch[2],
      reason: deferMatch[3],
    };
  }

  // /investigate OBS-YYYYMMDD-HHMMSS-xxxx
  const investigateMatch = trimmed.match(
    /^\/investigate\s+(OBS-\d{8}-\d{6}-[a-f0-9]{4})$/i
  );
  if (investigateMatch) {
    return { action: 'investigate', observation_id: investigateMatch[1] };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Find observation file by ID
// ---------------------------------------------------------------------------

/**
 * Locate an observation file by its ID within the observations directory.
 * Searches recursively through year/month subdirectories.
 */
export function findObservationFileById(
  rootDir: string,
  observationId: string
): string | null {
  const obsDir = path.join(rootDir, '.autonomous-dev', 'observations');

  try {
    const fsSync = require('fs');
    return findFileRecursive(fsSync, obsDir, observationId);
  } catch {
    return null;
  }
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
      // Check if file contains the observation ID in frontmatter
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
// Apply triage command
// ---------------------------------------------------------------------------

/**
 * Apply a triage command to the observation file.
 * Delegates to the existing triage processor from SPEC-007-4-2,
 * ensuring the file remains the source of truth.
 */
export async function applyTriageCommand(
  command: TriageCommand,
  actor: string,
  rootDir: string,
  logger: AuditLogger
): Promise<ApplyTriageResult> {
  // Find the observation file by ID
  const filePath = findObservationFileById(rootDir, command.observation_id);
  if (!filePath) {
    return { applied: false, error: `Observation ${command.observation_id} not found` };
  }

  try {
    // Build frontmatter updates
    const updates: Record<string, unknown> = {
      triage_decision: command.action,
      triage_status: ACTION_TO_STATUS[command.action] ?? command.action,
      triage_by: actor,
      triage_at: new Date().toISOString(),
      triage_reason: command.reason ?? null,
    };

    if (command.action === 'defer' && command.defer_until) {
      updates.defer_until = command.defer_until;
    }

    await updateFrontmatter(filePath, updates);

    logger.info(
      `Triage command applied from notification channel: ` +
      `${command.action} on ${command.observation_id} by ${actor}`
    );

    return { applied: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to apply triage command: ${errorMsg}`);
    return { applied: false, error: errorMsg };
  }
}

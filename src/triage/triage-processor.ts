/**
 * File-based triage processor (SPEC-007-4-2, Task 4).
 *
 * Runs at step 2 of the runner lifecycle (before data collection).
 * Scans all observation files in `.autonomous-dev/observations/`,
 * detects PM Lead edits to YAML frontmatter, validates triage
 * decisions, and dispatches to the appropriate action handler.
 *
 * Also handles deferred observation re-triage (Task 6): observations
 * with `triage_status: deferred` and `defer_until <= now` are reset
 * to `pending` with `triage_decision: null`.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { validateOnRead, updateFrontmatter, appendToBody } from './frontmatter-io';
import { executePromote } from './actions/promote';
import { executeDismiss } from './actions/dismiss';
import { executeDefer } from './actions/defer';
import { executeInvestigate } from './actions/investigate';
import type { GeneratePrdFromObservationFn } from './actions/promote';
import type { UpdateFingerprintStoreFn } from './actions/dismiss';
import type { WriteInvestigationRequestFn } from './actions/investigate';
import type {
  TriageDecision,
  TriageProcessingResult,
  TriageAuditLogger,
  ObservationFrontmatter,
} from './types';
import { VALID_TRIAGE_DECISIONS, type TriageDecisionValue } from './types';

// ---------------------------------------------------------------------------
// Glob helper (recursive file discovery)
// ---------------------------------------------------------------------------

/**
 * Recursively finds all .md files in a directory.
 * Returns paths relative to the base directory.
 */
async function findMarkdownFiles(
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
      const subResults = await findMarkdownFiles(baseDir, fullPath);
      results.push(...subResults);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(path.relative(baseDir, fullPath));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Triage action dispatcher
// ---------------------------------------------------------------------------

export interface TriageActionDependencies {
  generatePrd?: GeneratePrdFromObservationFn;
  updateFingerprintStore?: UpdateFingerprintStoreFn;
  writeInvestigationRequest?: WriteInvestigationRequestFn;
}

/**
 * Dispatches a validated triage decision to the appropriate action handler.
 */
async function executeTriageAction(
  decision: TriageDecision,
  filePath: string,
  auditLog: TriageAuditLogger,
  deps: TriageActionDependencies = {},
): Promise<void> {
  switch (decision.decision) {
    case 'promote':
      await executePromote(decision, filePath, auditLog, deps.generatePrd);
      break;
    case 'dismiss':
      await executeDismiss(decision, filePath, auditLog, deps.updateFingerprintStore);
      break;
    case 'defer':
      await executeDefer(decision, filePath, auditLog);
      break;
    case 'investigate':
      await executeInvestigate(decision, filePath, auditLog, deps.writeInvestigationRequest);
      break;
  }
}

// ---------------------------------------------------------------------------
// Deferred observation return (Task 6)
// ---------------------------------------------------------------------------

/**
 * Resets a deferred observation to pending when its `defer_until` date
 * has passed.
 *
 * 1. Resets `triage_status` to `pending` and `triage_decision` to null
 * 2. Appends a note to the Markdown body preserving original deferral details
 * 3. Logs the deferred return to the audit trail
 */
async function returnDeferredObservation(
  filePath: string,
  frontmatter: ObservationFrontmatter,
  auditLog: TriageAuditLogger,
  now: Date = new Date(),
): Promise<void> {
  // 1. Reset triage fields
  await updateFrontmatter(filePath, {
    triage_status: 'pending',
    triage_decision: null,
  });

  // 2. Append note to Markdown body
  const note =
    `\n\n---\n\n**Deferred observation returned for re-triage** (${now.toISOString()})\n\n` +
    `Original deferral by ${frontmatter.triage_by} on ${frontmatter.triage_at}. ` +
    `Reason: "${frontmatter.triage_reason}". ` +
    `Deferred until: ${frontmatter.defer_until}.\n`;

  await appendToBody(filePath, note);

  // 3. Log the return
  auditLog.log({
    observation_id: frontmatter.id,
    action: 'deferred_return',
    actor: 'system',
    timestamp: now.toISOString(),
    reason: `defer_until ${frontmatter.defer_until} has passed`,
    generated_prd: null,
    auto_promoted: false,
  });
}

// ---------------------------------------------------------------------------
// Main triage processor
// ---------------------------------------------------------------------------

export interface ProcessPendingTriageOptions {
  /** Override "now" for testing deferred observation logic. */
  now?: Date;
  /** Action handler dependencies (PRD generator, fingerprint store, etc.). */
  deps?: TriageActionDependencies;
}

/**
 * Scans all observation files, detects PM Lead triage edits, validates
 * decisions, dispatches actions, and handles deferred re-triage.
 *
 * @param observationsDir Absolute path to `.autonomous-dev/observations/`
 * @param auditLog        Triage audit logger
 * @param options         Optional overrides for testing
 * @returns Processing result with counts of processed, errors, and deferred returns
 */
export async function processPendingTriage(
  observationsDir: string,
  auditLog: TriageAuditLogger,
  options: ProcessPendingTriageOptions = {},
): Promise<TriageProcessingResult> {
  const now = options.now ?? new Date();
  const deps = options.deps ?? {};

  const result: TriageProcessingResult = {
    processed: [],
    errors: [],
    deferred_returned: [],
  };

  // Step 1: Scan all observation files
  const files = await findMarkdownFiles(observationsDir);

  for (const file of files) {
    const filePath = path.join(observationsDir, file);
    const validation = await validateOnRead(filePath);

    if (!validation.valid) {
      result.errors.push({
        file: filePath,
        error: `Schema validation failed: ${validation.errors.join('; ')}`,
      });
      continue;
    }

    const fm = validation.frontmatter!;

    // Step 2: Detect files where triage_decision is set but triage_status is still 'pending'
    if (fm.triage_decision !== null && fm.triage_status === 'pending') {
      // Validate the decision value
      if (
        !(VALID_TRIAGE_DECISIONS as readonly string[]).includes(
          fm.triage_decision as string,
        )
      ) {
        result.errors.push({
          file: filePath,
          error: `Invalid triage_decision: "${fm.triage_decision}". Must be one of: ${VALID_TRIAGE_DECISIONS.join(', ')}`,
        });
        auditLog.logError(
          fm.id,
          `Invalid decision: ${fm.triage_decision}`,
        );
        continue;
      }

      // Validate required fields
      if (!fm.triage_by) {
        result.errors.push({
          file: filePath,
          error: 'triage_by is required when triage_decision is set',
        });
        continue;
      }
      if (!fm.triage_at) {
        result.errors.push({
          file: filePath,
          error: 'triage_at is required when triage_decision is set',
        });
        continue;
      }

      // For defer: validate defer_until
      if (fm.triage_decision === 'defer' && !fm.defer_until) {
        result.errors.push({
          file: filePath,
          error: 'defer_until is required when triage_decision is "defer"',
        });
        continue;
      }

      const decision: TriageDecision = {
        observation_id: fm.id,
        file_path: filePath,
        decision: fm.triage_decision as TriageDecisionValue,
        triage_by: fm.triage_by,
        triage_at: fm.triage_at,
        triage_reason: fm.triage_reason ?? '',
        defer_until: fm.defer_until ?? undefined,
      };

      // Dispatch to action handler
      await executeTriageAction(decision, filePath, auditLog, deps);
      result.processed.push(decision);
    }

    // Step 3: Check deferred observations (Task 6)
    if (fm.triage_status === 'deferred' && fm.defer_until) {
      const deferDate = new Date(fm.defer_until);
      if (deferDate <= now) {
        await returnDeferredObservation(filePath, fm, auditLog, now);
        result.deferred_returned.push(fm.id);
      }
    }
  }

  return result;
}

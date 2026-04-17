/**
 * Investigate triage action handler (SPEC-007-4-2, Task 5).
 *
 * When a PM Lead sets `triage_decision: investigate` on an observation:
 *   1. Updates `triage_status` to `investigating`
 *   2. Writes an investigation request JSON file that the runner picks
 *      up on the next observation run for deeper data collection
 *   3. Logs the action to the triage audit trail
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { updateFrontmatter, readFrontmatter, extractErrorClass } from '../frontmatter-io';
import type {
  TriageDecision,
  TriageAuditLogger,
  InvestigationRequest,
} from '../types';

// ---------------------------------------------------------------------------
// Investigation request writer delegate
// ---------------------------------------------------------------------------

/**
 * Function type for writing an investigation request.
 * Default implementation writes JSON to
 * `.autonomous-dev/observations/investigations/`.
 */
export type WriteInvestigationRequestFn = (
  request: InvestigationRequest,
) => Promise<void>;

/**
 * Creates an investigation request writer bound to a directory.
 *
 * @param investigationsDir Absolute path to the investigations directory
 * @returns A WriteInvestigationRequestFn
 */
export function createInvestigationRequestWriter(
  investigationsDir: string,
): WriteInvestigationRequestFn {
  return async (request: InvestigationRequest): Promise<void> => {
    await fs.mkdir(investigationsDir, { recursive: true });
    const fileName = `investigate-${request.observation_id}.json`;
    const filePath = path.join(investigationsDir, fileName);
    await fs.writeFile(filePath, JSON.stringify(request, null, 2), 'utf-8');
  };
}

// ---------------------------------------------------------------------------
// Investigate action
// ---------------------------------------------------------------------------

export async function executeInvestigate(
  decision: TriageDecision,
  filePath: string,
  auditLog: TriageAuditLogger,
  writeInvestigationRequest?: WriteInvestigationRequestFn,
): Promise<void> {
  // 1. Update observation file: triage_status -> 'investigating'
  await updateFrontmatter(filePath, {
    triage_status: 'investigating',
  });

  // 2. Write investigation request for the runner
  if (writeInvestigationRequest) {
    const errorClass = await extractErrorClass(filePath);
    const frontmatter = await readFrontmatter(filePath);

    await writeInvestigationRequest({
      observation_id: frontmatter.id,
      service: frontmatter.service,
      error_class: errorClass,
      requested_at: decision.triage_at,
      requested_by: decision.triage_by,
    });
  }

  // 3. Log to triage audit
  auditLog.log({
    observation_id: decision.observation_id,
    action: 'investigate',
    actor: decision.triage_by,
    timestamp: decision.triage_at,
    reason: decision.triage_reason,
    generated_prd: null,
    auto_promoted: false,
  });
}

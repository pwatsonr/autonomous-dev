/**
 * Promote triage action handler (SPEC-007-4-2, Task 5).
 *
 * When a PM Lead sets `triage_decision: promote` on an observation:
 *   1. Updates `triage_status` to `promoted`
 *   2. Triggers PRD generation (SPEC-007-4-3)
 *   3. Links the generated PRD to the observation via `linked_prd`
 *   4. Logs the action to the triage audit trail
 */

import { updateFrontmatter } from '../frontmatter-io';
import type { TriageDecision, TriageAuditLogger } from '../types';

// ---------------------------------------------------------------------------
// PRD generation delegate
// ---------------------------------------------------------------------------

/**
 * Function type for PRD generation from an observation.
 * The real implementation is provided by SPEC-007-4-3.
 * Returns the generated PRD ID (e.g., "PRD-042").
 */
export type GeneratePrdFromObservationFn = (
  observationFilePath: string,
  decision: TriageDecision,
) => Promise<string>;

/**
 * Default stub for PRD generation.
 * Returns a placeholder PRD ID until SPEC-007-4-3 is implemented.
 */
export const defaultGeneratePrd: GeneratePrdFromObservationFn = async (
  _filePath,
  decision,
) => {
  return `PRD-${decision.observation_id}`;
};

// ---------------------------------------------------------------------------
// Promote action
// ---------------------------------------------------------------------------

export async function executePromote(
  decision: TriageDecision,
  filePath: string,
  auditLog: TriageAuditLogger,
  generatePrd: GeneratePrdFromObservationFn = defaultGeneratePrd,
): Promise<void> {
  // 1. Update observation file: triage_status -> 'promoted'
  await updateFrontmatter(filePath, {
    triage_status: 'promoted',
  });

  // 2. Trigger PRD generation (SPEC-007-4-3)
  const prdId = await generatePrd(filePath, decision);

  // 3. Update observation with linked PRD
  await updateFrontmatter(filePath, {
    linked_prd: prdId,
  });

  // 4. Log to triage audit
  auditLog.log({
    observation_id: decision.observation_id,
    action: 'promote',
    actor: decision.triage_by,
    timestamp: decision.triage_at,
    reason: decision.triage_reason,
    generated_prd: prdId,
    auto_promoted: false,
  });
}

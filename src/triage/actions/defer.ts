/**
 * Defer triage action handler (SPEC-007-4-2, Task 5).
 *
 * When a PM Lead sets `triage_decision: defer` on an observation:
 *   1. Updates `triage_status` to `deferred`
 *   2. The `defer_until` date is already set by the PM Lead in YAML
 *      -- no additional scheduling needed
 *   3. Logs the action to the triage audit trail
 *
 * The processor checks `defer_until` on each run and resets deferred
 * observations to `pending` when the date arrives (Task 6).
 */

import { updateFrontmatter } from '../frontmatter-io';
import type { TriageDecision, TriageAuditLogger } from '../types';

// ---------------------------------------------------------------------------
// Defer action
// ---------------------------------------------------------------------------

export async function executeDefer(
  decision: TriageDecision,
  filePath: string,
  auditLog: TriageAuditLogger,
): Promise<void> {
  // 1. Update observation file: triage_status -> 'deferred'
  await updateFrontmatter(filePath, {
    triage_status: 'deferred',
  });

  // 2. defer_until is already set by the PM Lead in the YAML.
  //    No additional scheduling needed -- the processor checks
  //    defer_until on each run.

  // 3. Log to triage audit
  auditLog.log({
    observation_id: decision.observation_id,
    action: 'defer',
    actor: decision.triage_by,
    timestamp: decision.triage_at,
    reason: decision.triage_reason,
    generated_prd: null,
    auto_promoted: false,
  });
}

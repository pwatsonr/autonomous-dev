/**
 * Stateful-deploy contract types and precondition evaluation (issue #666).
 *
 * A deploy target is considered **stateful** when its `capabilities` array
 * includes the `'stateful'` token. Stateful deploys may require a verified
 * backup before proceeding, expressed via `requiresVerifiedBackup: true` on
 * the deploy request.
 *
 * Core only checks the flag and surfaces `backup_class`; it delegates the
 * actual backup operation to the homelab plugin. The plugin consumes
 * `BackupClass` to select the appropriate verification path.
 *
 * This module is shared-types-first (mirrors `credential-proxy-types.ts`):
 * it exports pure types + a pure precondition function with no I/O or
 * side effects, so the homelab plugin can import it without a cross-repo
 * import.
 *
 * Governing invariant #674: all branching uses capability flags and tags —
 * never instance ids or hard-coded service/node lists.
 *
 * @module intake/deploy/stateful-contract
 */

/**
 * Backup class for a stateful target.
 *
 * - `none`         — target carries no persistent state; backup not applicable.
 * - `snapshot`     — target uses filesystem / volume snapshots (fast, atomic).
 * - `orchestrated` — backup is managed by an external orchestrator (e.g.,
 *                    a database dump tool, Proxmox Backup Server). Verification
 *                    requires the homelab plugin's backup orchestrator.
 *
 * Core does not act on the specific class; the homelab plugin selects the
 * verification path from it.
 */
export type BackupClass = 'none' | 'snapshot' | 'orchestrated';

/**
 * Input to `evaluateStatefulPrecondition`.
 *
 * All branching is on capability flags and `requiresVerifiedBackup` — never
 * on instance ids (invariant #674).
 */
export interface StatefulPreconditionInput {
  /**
   * Capability tokens declared by the resolved target.
   * Presence of `'stateful'` activates the precondition check.
   */
  targetCapabilities: string[];

  /**
   * Backup class resolved from the target's `backup_class` tag or default.
   * Reported in the blocked reason so operators know which verification path
   * is required.
   */
  backupClass: BackupClass;

  /**
   * When `true`, a verified backup reference must be present (or an explicit
   * override applied) before the deploy is allowed to proceed.
   */
  requiresVerifiedBackup: boolean;

  /**
   * A backup manifest id verified by a prior backup operation.
   * When present and non-empty, satisfies the `requiresVerifiedBackup`
   * precondition without an override.
   */
  verifiedBackupRef?: string;

  /**
   * Admin-level explicit override. When `true`, the precondition is bypassed
   * and the deploy proceeds. The orchestrator records `overrideApplied: true`
   * in the handoff context so the homelab plugin's audit trail reflects it.
   */
  backupOverride?: boolean;
}

/**
 * Result of `evaluateStatefulPrecondition`.
 *
 * When `blocked` is `true` the deploy MUST NOT proceed; the orchestrator
 * throws `StatefulPreconditionError(backupClass)`. When `false` the deploy
 * may proceed on the stateful path.
 */
export interface StatefulPreconditionResult {
  /** True iff the deploy is blocked by an unsatisfied backup precondition. */
  blocked: boolean;
  /**
   * Human-readable reason when `blocked: true`. Undefined when `blocked: false`.
   * Includes `backupClass` so the operator knows which verification path is
   * required.
   */
  reason?: string;
}

/**
 * Evaluate whether a stateful deploy's backup precondition is satisfied.
 *
 * Returns `{ blocked: false }` when:
 *   - The target is not stateful (no `'stateful'` in `targetCapabilities`).
 *   - `requiresVerifiedBackup` is `false`.
 *   - `verifiedBackupRef` is present and non-empty.
 *   - `backupOverride` is `true`.
 *
 * Returns `{ blocked: true, reason }` when the target is stateful,
 * `requiresVerifiedBackup` is `true`, and neither a `verifiedBackupRef`
 * nor an explicit `backupOverride` is supplied.
 *
 * Pure function — no I/O, no side effects.
 *
 * @param input - Precondition evaluation inputs.
 * @returns `StatefulPreconditionResult`.
 */
export function evaluateStatefulPrecondition(
  input: StatefulPreconditionInput,
): StatefulPreconditionResult {
  const isStateful = input.targetCapabilities.includes('stateful');

  if (!isStateful) {
    return { blocked: false };
  }

  if (!input.requiresVerifiedBackup) {
    return { blocked: false };
  }

  if (input.backupOverride === true) {
    return { blocked: false };
  }

  if (input.verifiedBackupRef !== undefined && input.verifiedBackupRef.length > 0) {
    return { blocked: false };
  }

  return {
    blocked: true,
    reason:
      `Stateful deploy requires a verified backup (backup_class: ${input.backupClass}). ` +
      'Supply a verifiedBackupRef from a completed backup, or set backupOverride=true ' +
      '(admin-level override, will be recorded in the audit trail). ' +
      'Actual backup execution is delegated to the homelab plugin.',
  };
}

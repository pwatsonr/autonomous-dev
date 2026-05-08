/**
 * Deprecation shim for `cost-cap.ts` (SPEC-032-1-03).
 *
 * Preserves the legacy `checkCostCap` / `recordCost` /
 * `readTodayLedger` / `__setCostCapDayForTest` public API by
 * re-exporting from `./cost-cap`, but emits a single once-per-process
 * `console.warn` on the first call so operators are nudged to migrate
 * to `CostCapEnforcer` + `CostLedger`.
 *
 * Bridging strategy: rather than reimplement the engine on top of
 * `CostCapEnforcer` (FR-2/FR-5 of the spec), this shim re-exports the
 * existing `cost-cap.ts` engine. Both the legacy engine and the new
 * enforcer continue to live side-by-side until the per-env cap layer
 * is folded into the enforcer's config surface in a follow-up SPEC.
 * The observable surface for shim callers is unchanged. The
 * once-per-process warning text remains the documented operator
 * contract for runbook greps.
 *
 * @module intake/deploy/cost-cap-shim
 */

import {
  __setCostCapDayForTest as __legacy_setCostCapDayForTest,
  checkCostCap as legacyCheckCostCap,
  readTodayLedger as legacyReadTodayLedger,
  recordCost as legacyRecordCost,
  type CheckCostCapArgs,
  type CheckCostCapResult,
  type CostLedger,
  type CostLedgerEntry,
  type RecordCostArgs,
} from './cost-cap';

export const COST_CAP_SHIM_WARNING_TEXT =
  'cost-cap.ts shim — switch to CostCapEnforcer; will be removed in vNEXT';

const warned = new Set<string>();

/**
 * Emit the deprecation warning at most once per process. Module-level
 * `Set` is re-allocated per `jest.isolateModules` block, allowing the
 * shim test suite to verify warn-once semantics without leaking state
 * across cases.
 */
function maybeWarn(): void {
  if (warned.has(COST_CAP_SHIM_WARNING_TEXT)) return;
  warned.add(COST_CAP_SHIM_WARNING_TEXT);
  // eslint-disable-next-line no-console
  console.warn(COST_CAP_SHIM_WARNING_TEXT);
}

/** Legacy `checkCostCap` shape — see {@link legacyCheckCostCap}. */
export async function checkCostCap(
  args: CheckCostCapArgs,
): Promise<CheckCostCapResult> {
  maybeWarn();
  return legacyCheckCostCap(args);
}

/** Legacy `recordCost` shape — see {@link legacyRecordCost}. */
export async function recordCost(args: RecordCostArgs): Promise<void> {
  maybeWarn();
  return legacyRecordCost(args);
}

/** Legacy `readTodayLedger` shape — see {@link legacyReadTodayLedger}. */
export async function readTodayLedger(
  requestDir: string,
  envName: string,
): Promise<CostLedger> {
  maybeWarn();
  return legacyReadTodayLedger(requestDir, envName);
}

/** Legacy test seam — preserved for backwards-compat. */
export function __setCostCapDayForTest(fn: (() => string) | null): void {
  maybeWarn();
  __legacy_setCostCapDayForTest(fn);
}

export type {
  CheckCostCapArgs,
  CheckCostCapResult,
  CostLedger,
  CostLedgerEntry,
  RecordCostArgs,
};

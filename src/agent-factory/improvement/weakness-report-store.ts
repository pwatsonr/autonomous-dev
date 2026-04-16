/**
 * Re-export of WeaknessReportStore from types (SPEC-005-3-1, Task 2).
 *
 * The WeaknessReportStore class is defined in ./types.ts alongside the
 * schemas it persists.  This module re-exports it for consumers that
 * expect a dedicated import path.
 */

export { WeaknessReportStore } from './types';
export type { ReportStoreLogger as WeaknessReportLogger } from './types';

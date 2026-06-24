/**
 * Ownership & scope model (ONBOARD Phase 0). Barrel export.
 */
export * from './types';
export * from './loader';
// The canonical auto-improvement enrollment gate (FR-G2) + enrollment query, on
// the package surface so Phase 2/4 consume them without a deep import.
export { isEnrolled, mayAutoImproveScope, repoIdFromScope, isOrgLogin } from './commands';

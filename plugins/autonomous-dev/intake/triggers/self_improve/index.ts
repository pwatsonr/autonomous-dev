/**
 * Public re-exports for the self_improve module.
 *
 * Consumers outside the module (e.g., `watch_tick.ts`, `triggers-cli.ts`)
 * import from this barrel file.
 *
 * @module intake/triggers/self_improve
 */

export type { SelfImproveConfig, ConfigWarning } from './config';
export { readSelfImproveConfig } from './config';

export {
  LABEL_PIPELINE_FAILED,
  LABEL_REVIEWER_FINDING,
  LABEL_AUTO_FIX,
  LABEL_SELF_FIX_PR,
  LABEL_IN_PROGRESS,
  PRIORITY_LABEL_RE,
  TYPE_LABEL_RE,
  DETECTED_LABELS,
  parsePriorityLabel,
  parseTypeLabel,
} from './labels';
export type { PriorityTag, TypeTag } from './labels';

export type {
  LedgerStatus,
  LedgerOutcome,
  LedgerEntry,
  WindowCost,
  LedgerFile,
  LedgerIO,
  LedgerReader,
  LedgerMutator,
} from './ledger';
export {
  ledgerPath,
  lockPath,
  loadLedger,
  saveLedger,
  makeReader,
  makeMutator,
  toHourKey,
  parseHourKeyToMs,
  LedgerLockBusyError,
  LedgerKeyInvalidError,
} from './ledger';

export type {
  ActionableClassId,
  IssueSnapshot,
  IssueEventsSnapshot,
  ClassifierRow,
  ClassifyResult,
} from './actionable';
export { ACTIONABLE_CATALOG, classify } from './actionable';

export type { EvidenceCheck, EvidenceDeps, Ownership } from './evidence';
export { checkEvidence } from './evidence';

export type {
  GuardId,
  GuardTrip,
  ConcurrencyView,
  CostWindowView,
  GuardCtx,
  GuardResult,
} from './guards';
export { evaluateGuards, computeBackoffUntil } from './guards';

export type { ListOpenResult, GhIssueClient } from './gh_issues';
export { ghIssueClient } from './gh_issues';

export type { SourceIssueMeta, SubmitPayload } from './description';
export { buildSubmitPayload } from './description';

export type { SelfImproveEvent, EventEmitter, EmitterDeps } from './events';
export { createEmitter } from './events';

export type {
  RequestSubmitInput,
  RequestSubmitResult,
  SubmitDeps,
  SubmitOutcome,
} from './submit';
export { submitFromIssue } from './submit';

export type { StateShape, AutoMergeDecision } from './merge_gate';
export { isSelfImproveRequest, checkAutoMergeAllowed } from './merge_gate';

export type { ScanResult, SelfImproveDeps } from './scan';
export { scanEnrolledRepos, buildDefaultSelfImproveDeps } from './scan';

/**
 * Triage processor public API (SPEC-007-4-2 + SPEC-007-4-3).
 */

export { processPendingTriage } from './triage-processor';
export type { ProcessPendingTriageOptions, TriageActionDependencies } from './triage-processor';

export { DefaultTriageAuditLogger } from './audit-logger';

export {
  validateOnRead,
  readFrontmatter,
  updateFrontmatter,
  appendToBody,
  extractErrorClass,
} from './frontmatter-io';

export { executePromote } from './actions/promote';
export type { GeneratePrdFromObservationFn } from './actions/promote';

export { executeDismiss, createFingerprintStoreUpdater } from './actions/dismiss';
export type { UpdateFingerprintStoreFn } from './actions/dismiss';

export { executeDefer } from './actions/defer';

export { executeInvestigate, createInvestigationRequestWriter } from './actions/investigate';
export type { WriteInvestigationRequestFn } from './actions/investigate';

export type {
  TriageDecision,
  TriageDecisionValue,
  TriageStatus,
  TriageError,
  TriageProcessingResult,
  TriageAuditEntry,
  TriageAuditLogger,
  InvestigationRequest,
  ObservationFrontmatter,
  ObservationValidationResult,
} from './types';

export { VALID_TRIAGE_DECISIONS, TRIAGE_STATUSES } from './types';

// SPEC-007-4-3: Observation-to-PRD promotion pipeline
export {
  generatePrdFromObservation,
  createPrdGenerator,
  extractSection,
  extractEvidenceFromBody,
  extractMetricsFromBody,
} from './prd-generator';
export type {
  PrdGenerationResult,
  GeneratePrdViaLlmFn,
  GetPreviousObservationsFn,
} from './prd-generator';

export {
  buildPrdContent,
  buildPrdPrompt,
  serializePrdFrontmatter,
  PRD_AUTHOR,
  PRD_STATUS,
  PRD_SOURCE,
  PRD_VERSION,
  PRD_GENERATION_PROMPT,
} from './prd-template';
export type {
  ObservationData,
  LlmPrdContent,
} from './prd-template';

// SPEC-007-4-3: Triage audit log (file-based JSONL)
export { TriageAuditLogger as FileTriageAuditLogger } from './audit-log';
export type { TriageAuditEntry as FileTriageAuditEntry } from './audit-log';

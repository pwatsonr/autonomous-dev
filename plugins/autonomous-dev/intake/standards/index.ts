/**
 * Standards module barrel — re-exports the public API of the standards
 * substrate (PLAN-021-1).
 *
 * Current surface:
 *   - Types (SPEC-021-1-01):  Severity, ServiceType, RuleSource, Predicate,
 *                             Assertion, Rule, Metadata, StandardsArtifact
 *   - Loader (SPEC-021-1-02): loadStandardsFile, LoaderResult, LoaderErrorRecord,
 *                             MAX_FILE_BYTES
 *   - Resolver (SPEC-021-1-02): resolveStandards, ResolvedStandards
 *   - Errors (SPEC-021-1-02): ValidationError, AuthorizationError, LoaderError
 *   - Auth (SPEC-021-1-02):   isAdminRequest
 *
 * Subsequent specs in PLAN-021-1 expand this barrel with the auto-detection
 * scanner and CLI subcommands.
 *
 * @module intake/standards
 */

export type {
  Severity,
  ServiceType,
  RuleSource,
  Predicate,
  Assertion,
  Rule,
  Metadata,
  StandardsArtifact,
} from './types';

export {
  loadStandardsFile,
  MAX_FILE_BYTES,
  __resetValidatorCacheForTests,
} from './loader';
export type { LoaderResult, LoaderErrorRecord } from './loader';

export { resolveStandards } from './resolver';
export type { ResolvedStandards } from './resolver';

export { ValidationError, AuthorizationError, LoaderError } from './errors';
export { isAdminRequest } from './auth';

export {
  AutoDetectionScanner,
  writeInferredStandards,
  CONFIDENCE,
  ESLINT_RULE_CAP,
  FRAMEWORK_MAP,
  README_TOOLS,
} from './auto-detection';
export type { DetectedRule, ScanResult, SignalKind } from './auto-detection-types';

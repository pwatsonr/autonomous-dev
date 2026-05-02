/**
 * RequestType enum + helpers (SPEC-018-1-01, Task 1).
 *
 * Classifies what KIND of work a request represents (feature, bug, infra,
 * refactor, hotfix). This is distinct from `RequestSource` (in
 * `request_source.ts`), which classifies which CHANNEL originated the
 * request (cli, claude-app, discord, ...). Both enums coexist:
 *
 *   - RequestSource = "where did this come from?"
 *   - RequestType   = "what kind of work is this?"
 *
 * The matrix of per-type pipeline overrides lives in `phase-override.ts`.
 *
 * Canonical source: TDD-018 §5.1.
 *
 * @module intake/types/request-type
 */

/**
 * Supported request types with distinct pipeline optimizations.
 * String values match the lowercase member name so they round-trip through
 * JSON without translation.
 */
export enum RequestType {
  /** Standard product feature development (default). */
  FEATURE = 'feature',
  /** Bug fix with structured problem context. */
  BUG = 'bug',
  /** Infrastructure changes with enhanced gates. */
  INFRA = 'infra',
  /** Code quality improvements. */
  REFACTOR = 'refactor',
  /** Critical issue hotfix with expedited processing. */
  HOTFIX = 'hotfix',
}

/** All RequestType string values, in declaration order. */
export const REQUEST_TYPES: readonly RequestType[] = [
  RequestType.FEATURE,
  RequestType.BUG,
  RequestType.INFRA,
  RequestType.REFACTOR,
  RequestType.HOTFIX,
] as const;

/**
 * Type guard for RequestType validation.
 *
 * Returns true iff `value` is one of the RequestType enum string values.
 * Casing-sensitive: `'FEATURE'` returns false. The empty string returns
 * false. Non-string inputs are widened via the parameter type but a runtime
 * `typeof` check is unnecessary because `Object.values(...).includes` is
 * strict-equality based.
 */
export function isValidRequestType(value: string): value is RequestType {
  return Object.values(RequestType).includes(value as RequestType);
}

/**
 * Default request type for backward compatibility (v1.0 → v1.1 migration).
 * Anything that does not declare a request type is assumed to be a feature.
 */
export const DEFAULT_REQUEST_TYPE: RequestType = RequestType.FEATURE;

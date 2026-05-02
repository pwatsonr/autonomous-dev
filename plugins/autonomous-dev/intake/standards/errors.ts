/**
 * Error classes for the standards substrate (SPEC-021-1-02).
 *
 * Three named errors discriminated by `name` so callers can switch on the
 * class without losing structured information:
 *
 *   - `ValidationError`    — schema/business-rule violation (e.g., repo
 *                            tries to override an immutable org rule).
 *   - `AuthorizationError` — caller lacks the privilege required for the
 *                            requested action (e.g., per-request override
 *                            without admin).
 *   - `LoaderError`        — file I/O or YAML parsing failure exposed as
 *                            an exception (most loader paths return errors
 *                            in a `LoaderResult` instead, see loader.ts).
 *
 * @module intake/standards/errors
 */

/** Schema/business-rule violation. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Caller lacks the privilege required (e.g., admin-only action). */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

/** File I/O or YAML parsing failure exposed as an exception. */
export class LoaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoaderError';
  }
}

// ---------------------------------------------------------------------------
// PLAN-021-2 evaluator/sandbox errors (SPEC-021-2-03)
// ---------------------------------------------------------------------------

/** Operator-supplied custom evaluator violated the sandbox trust boundary. */
export class SecurityError extends Error {
  readonly code = 'EVALUATOR_SECURITY';
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

/** Requested evaluator name is not registered. */
export class EvaluatorNotFoundError extends Error {
  readonly code = 'EVALUATOR_NOT_FOUND';
  constructor(public readonly evaluatorName: string) {
    super(`Evaluator "${evaluatorName}" is not registered`);
    this.name = 'EvaluatorNotFoundError';
  }
}

/** Wraps any error thrown during evaluator dispatch, preserving the rule id. */
export class EvaluatorRunError extends Error {
  readonly code = 'EVALUATOR_RUN';
  constructor(
    public readonly ruleId: string,
    public readonly cause: Error,
  ) {
    super(`Evaluator failed for rule "${ruleId}": ${cause.message}`);
    this.name = 'EvaluatorRunError';
  }
}

/** Custom evaluator exceeded the 30s wall-clock cap. */
export class SandboxTimeoutError extends Error {
  readonly code = 'SANDBOX_TIMEOUT';
  constructor(
    public readonly path: string,
    public readonly elapsedMs: number,
  ) {
    super(
      `Custom evaluator "${path}" exceeded 30s wall clock (ran for ${elapsedMs}ms)`,
    );
    this.name = 'SandboxTimeoutError';
  }
}

/** Custom evaluator exceeded the 256MB memory cap (Linux prlimit). */
export class SandboxMemoryError extends Error {
  readonly code = 'SANDBOX_MEMORY';
  constructor(public readonly path: string) {
    super(`Custom evaluator "${path}" exceeded 256MB memory cap`);
    this.name = 'SandboxMemoryError';
  }
}

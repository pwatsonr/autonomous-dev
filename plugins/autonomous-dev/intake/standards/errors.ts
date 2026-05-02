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

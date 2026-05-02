/**
 * Admin authorization stub for the standards substrate (SPEC-021-1-02).
 *
 * Per-request overrides require admin authorization. This stub returns
 * `false` unconditionally so untested code paths default-deny. The full
 * implementation lands in PRD-009's trust ladder; until then, tests that
 * need admin behavior mock this function via `jest.spyOn`.
 *
 * @module intake/standards/auth
 */

/**
 * Returns `true` iff the current request was issued by an admin.
 * Always `false` in v1; mocked in tests when the admin path is exercised.
 */
export function isAdminRequest(): boolean {
  return false;
}

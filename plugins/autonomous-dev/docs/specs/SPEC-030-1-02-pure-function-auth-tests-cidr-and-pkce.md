# SPEC-030-1-02: Pure-Function Auth Tests — `cidr-utils` and `pkce-utils`

## Metadata
- **Parent Plan**: PLAN-030-1 (TDD-014 security test backfill)
- **Parent TDD**: TDD-030 §5.2 (cidr-utils, pkce-utils blocks)
- **Tasks Covered**: TASK-002 (cidr-utils.test.ts), TASK-003 (pkce-utils.test.ts)
- **Estimated effort**: 1 day (0.5 day per file)
- **Depends on**: SPEC-030-1-01 phase A merged
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-030-1-02-pure-function-auth-tests-cidr-and-pkce.md`

## Description

Ship the two simplest auth tests first: pure functions, no I/O, no mocks. Together they validate the SPEC-030-1-01 jest config end-to-end (the canary value of these tests is as load-bearing as the coverage value).

Both files cover code already in production at `plugins/autonomous-dev-portal/server/auth/cidr-utils.ts` and `plugins/autonomous-dev-portal/server/auth/oauth/pkce-utils.ts`. No production code is modified.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-portal/server/auth/__tests__/cidr-utils.test.ts` | Create | Pure-function tests against `../cidr-utils.ts` |
| `plugins/autonomous-dev-portal/server/auth/__tests__/pkce-utils.test.ts` | Create | Pure-crypto tests with RFC-7636 fixed vectors |

No `package.json`, schema, or production-code changes.

## Implementation Details

### `cidr-utils.test.ts`

Read `plugins/autonomous-dev-portal/server/auth/cidr-utils.ts` first to confirm the public surface (TDD-030 §3.2 confirms the file exists at `main@2937725`; the test imports its named exports as-is, no re-export shim).

Test groups (Jest `describe` blocks; `it` per scenario):

```ts
describe('cidr-utils — IPv4 membership', () => {
  it('matches an address inside a /8 block');           // 10.0.0.0/8 → 10.1.2.3
  it('rejects an address outside a /8 block');          // 10.0.0.0/8 → 192.168.1.1
  it('handles /32 exact match');                        // 1.2.3.4/32 → 1.2.3.4 only
});

describe('cidr-utils — IPv6 membership', () => {
  it('matches an address inside a /32 block');          // 2001:db8::/32 → 2001:db8:1::1
  it('rejects an address outside a /32 block');         // 2001:db8::/32 → 2001:db9::1
  it('handles /128 exact match');                       // ::1/128 → ::1 only
});

describe('cidr-utils — malformed input', () => {
  it.each([
    [''],
    ['not-a-cidr'],
    ['10.0.0.0/33'],
    ['::1/129'],
    ['10.0.0.0/-1'],
  ])('throws a typed error for %p', (input) => { /* expect.toThrow() and assert error.code or instanceof */ });
});

describe('cidr-utils — deny-by-default invariant', () => {
  it('returns false for any address against an empty allowlist');
});
```

Constraints:
- Assertions on errors MUST be on a typed property (`error.code`, `error.name`, or `instanceof MyTypedError`). Do NOT match against `error.message` substrings — those are free to change without API impact.
- The "deny by default" test is the security-critical assertion in this file. Document its rationale in a one-line comment referencing TDD-030 §5.2.

### `pkce-utils.test.ts`

Read `plugins/autonomous-dev-portal/server/auth/oauth/pkce-utils.ts` first to confirm the public surface.

Test groups:

```ts
describe('pkce-utils — code_verifier', () => {
  it('generates a verifier whose length is within RFC-7636 bounds (43..128)');
  it('produces unique verifiers across 100 generations');
});

describe('pkce-utils — code_challenge (S256)', () => {
  it('matches the RFC-7636 appendix-B example vector', async () => {
    // Verifier: dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
    // Expected challenge: E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
  });
  it('produces a base64url challenge with no padding character (=)');
});

describe('pkce-utils — method enforcement', () => {
  it('rejects the "plain" method with a typed error');
});
```

Constraints:
- All `crypto.subtle` calls are async; every test using them MUST `await`. A missing `await` will silently pass an empty challenge.
- The RFC-7636 vector assertion is byte-for-byte against the literal string `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`. Implementation choices (encoding library, etc.) cannot drift from the RFC without breaking this test. That is the point.
- The "uniqueness across 100 generations" loop is `Promise.all` over 100 iterations into a `Set`; assertion is `set.size === 100`.

### Common conventions

- Both files use plain Jest globals (`describe`, `it`, `expect`); no `import` of the test framework.
- File header is a 3-line comment: title, target module path, link to TDD-030 §5.2.
- No use of `bun:test`, `bun:` URLs, or any Bun-specific globals.
- Tests are deterministic; no `Math.random` for uniqueness checks (use the production code's randomness end-to-end).

## Acceptance Criteria

### `cidr-utils.test.ts`

- AC-1: `npx jest plugins/autonomous-dev-portal/server/auth/__tests__/cidr-utils.test.ts` from the autonomous-dev plugin root exits 0.
- AC-2: All eight `describe`/`it` groups in §"Implementation Details" are present and pass.
- AC-3: Line coverage of `server/auth/cidr-utils.ts`, measured by `npx jest --coverage` scoped to this test, is ≥ 95 %.
- AC-4: Every `expect(...).toThrow(...)` assertion targets a typed error property (NOT a message substring). Verified by code review.
- AC-5: The "empty allowlist → deny" assertion is present and includes a comment referencing TDD-030 §5.2.

### `pkce-utils.test.ts`

- AC-6: `npx jest plugins/autonomous-dev-portal/server/auth/__tests__/pkce-utils.test.ts` from the autonomous-dev plugin root exits 0.
- AC-7: The RFC-7636 vector assertion compares against the literal string `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`. A grep for that string in the test file returns exactly one hit.
- AC-8: The "uniqueness across 100 generations" test asserts `set.size === 100` (NOT a probabilistic threshold).
- AC-9: The "plain method rejected" test asserts on a typed error property (per AC-4 rule).
- AC-10: Line coverage of `server/auth/oauth/pkce-utils.ts` is ≥ 95 %.

### Negative-path Given/When/Then

```
Given the cidr-utils allowlist is empty
When isAllowed('10.0.0.5') is invoked
Then the function returns false
And no exception is thrown

Given a malformed CIDR string '10.0.0.0/33'
When the cidr parser is invoked with that string
Then it throws an error
And the error has a typed code (e.g., error.code === 'INVALID_CIDR')

Given the PKCE code_verifier 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
When the S256 challenge derivation is invoked
Then the resulting challenge equals 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
And the result has no '=' padding characters

Given a request to generate a PKCE challenge with method 'plain'
When the generator is invoked
Then it throws an error
And the error has a typed property indicating method-not-supported
```

## Test Requirements

This spec is itself the test. The "test of the test" is:

1. Both files pass under `npx jest --runInBand`.
2. Each file passes in isolation: `npx jest <path>`.
3. Coverage report shows ≥ 95 % on each target module.

## Implementation Notes

- These two files are the **canaries** for SPEC-030-1-01's jest config. If either file fails to compile or run, the bug is in SPEC-030-1-01's setup, not in the test code. Inspect `jest.config.cjs` first before debugging the test.
- If `cidr-utils.ts` does not export typed errors today and only throws `new Error('...')`, **flag it** in the PR description (per TDD-030 §8.1, R-03). Author the test to assert on `error instanceof Error` and `error.message` matches a specific string only as a last resort — strongly prefer requesting a small typed-error patch in a separate hotfix PR.
- The two test files can be authored in parallel; they share no fixtures.

## Rollout Considerations

Pure additive. Revert the two files to roll back. No production impact.

## Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `crypto.subtle` async oversight (missing `await`) | Low | High (silent pass) | Lint rule for await; reviewer checks every call-site |
| `cidr-utils` does not export typed errors | Low | Low | Document; consider hotfix PR per TDD-030 R-03 |
| Coverage < 95 % due to dead code in target module | Low | Low | Per TDD-030 §5.3, prefer dead-code removal in a separate PR |

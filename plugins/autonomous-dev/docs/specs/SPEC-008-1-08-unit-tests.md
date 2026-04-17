# SPEC-008-1-08: Unit Test Suite

## Metadata
- **Parent Plan**: PLAN-008-1
- **Tasks Covered**: Task 16
- **Estimated effort**: 8 hours

## Description

Write the unit test suite covering all pure logic components in isolation: sanitizer rules, authz permission matrix, rate limiter edge cases, cosine similarity, duplicate detector, request parser, request queue ordering, starvation promotion, state machine transitions, and intake router dispatch. Database access is mocked for unit tests.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/__tests__/sanitizer.test.ts` | Create |
| `intake/__tests__/authz_engine.test.ts` | Create |
| `intake/__tests__/rate_limiter.test.ts` | Create |
| `intake/__tests__/duplicate_detector.test.ts` | Create |
| `intake/__tests__/request_parser.test.ts` | Create |
| `intake/__tests__/request_queue.test.ts` | Create |
| `intake/__tests__/state_machine.test.ts` | Create |
| `intake/__tests__/intake_router.test.ts` | Create |

## Implementation Details

### Test file specifications

**`sanitizer.test.ts`:**
- Load the 7 default rules from `injection-rules.yaml`.
- Test each rule individually with a targeted input string.
- Test clean inputs that should NOT trigger any rule.
- Test inputs that trigger multiple rules simultaneously.
- Test `escape` action produces correct character replacements.
- Test invalid rule file handling (missing fields, bad regex).
- Target: 100% coverage of `sanitize()` and `loadRules()`.

**`authz_engine.test.ts`:**
- Mock the database for author-of-request lookups.
- Load a test `intake-auth.yaml` with users in all 4 roles and repo overrides.
- Test the full permission matrix: 4 roles x 12 actions = 48 combinations.
- Test repo-scoped permission elevation and restriction.
- Test author-of-request special case for all 5 author-allowed actions.
- Test review gate approval for designated and non-designated reviewers.
- Test unknown user returns deny.
- Target: 100% of the permission matrix.

**`rate_limiter.test.ts`:**
- Mock the database `countActions`, `recordAction`, `getOldestActionInWindow`.
- Test under-limit (returns allowed with correct remaining).
- Test at-limit (returns denied with retryAfterMs).
- Test sliding window expiry (old actions no longer counted).
- Test role-based override resolution.
- Test both action types (submission: 1h window, query: 1m window).
- Target: 100% branch coverage on `checkLimit` and `resolveLimit`.

**`duplicate_detector.test.ts`:**
- Test `cosineSimilarity` with known vector pairs: identical (1.0), orthogonal (0.0), zero vector (0.0), computed pair.
- Test disabled config skips detection.
- Test with mocked embedder and database to verify the detection flow.
- Target: 100% of `cosineSimilarity` and `detectDuplicate` branches.

**`request_parser.test.ts`:**
- Mock Claude API calls.
- Test structured extraction with valid response.
- Test repo extraction priority: flag > URL > known-repos > null.
- Test fallback on API failure.
- Test ambiguity conditions: low confidence, no repo, short non-technical input.
- Test clarifying question generation (mocked).
- Test 5-round limit enforcement.
- Target: 100% of parse pipeline stages.

**`request_queue.test.ts`:**
- Test priority ordering (high > normal > low).
- Test FIFO within same priority.
- Test depth enforcement at max capacity.
- Test estimated wait time calculation with known inputs.
- Test estimated wait time fallback when no history exists.
- Target: 100% of enqueue logic and wait time estimation.

**`state_machine.test.ts`:**
- Test every valid (state, action) pair from the state transition table: `(queued, cancel)`, `(queued, priority)`, `(active, cancel)`, `(active, pause)`, `(active, feedback)`, `(paused, cancel)`, `(paused, resume)`, `(failed, resume)`, `(failed, cancel)`.
- Test every invalid pair: `(queued, pause)`, `(queued, resume)`, `(queued, feedback)`, `(active, priority)`, `(active, resume)`, `(paused, pause)`, `(paused, priority)`, `(paused, feedback)`, `(cancelled, *)`, `(done, *)`, `(failed, pause)`, `(failed, priority)`, `(failed, feedback)`.
- Verify `InvalidStateError` message includes current state and allowed actions.
- Target: 100% of `validateStateTransition`.

**`intake_router.test.ts`:**
- Mock authz, rate limiter, database, and all handlers.
- Test dispatch to correct handler by command name.
- Test unknown command returns `VALIDATION_ERROR`.
- Test authz denial short-circuits before rate limit check.
- Test rate limit denial short-circuits before handler execution.
- Test handler exception returns `INTERNAL_ERROR`.
- Test `InvalidStateError` from handler returns `INVALID_STATE`.
- Target: 100% of `route()` method branches.

## Acceptance Criteria

1. All 8 test files exist and pass.
2. Sanitizer tests cover all 7 rules with positive and negative cases.
3. Authz tests cover all 48 role/action combinations plus special cases.
4. Rate limiter tests cover under/at/over limit, window expiry, and role overrides.
5. Duplicate detector tests cover cosine similarity math and detection flow.
6. Request parser tests cover extraction, fallback, ambiguity, and round limits.
7. Queue tests cover ordering, depth enforcement, and wait time estimation.
8. State machine tests cover all valid and invalid transitions.
9. Router tests cover the full dispatch pipeline and error handling.
10. Overall branch coverage >= 95% on core logic modules.

## Test Cases

See each test file specification above. Total estimated test case count:

| File | Estimated Cases |
|------|----------------|
| `sanitizer.test.ts` | 12 |
| `authz_engine.test.ts` | 55+ |
| `rate_limiter.test.ts` | 10 |
| `duplicate_detector.test.ts` | 8 |
| `request_parser.test.ts` | 12 |
| `request_queue.test.ts` | 8 |
| `state_machine.test.ts` | 20+ |
| `intake_router.test.ts` | 8 |
| **Total** | **~133** |

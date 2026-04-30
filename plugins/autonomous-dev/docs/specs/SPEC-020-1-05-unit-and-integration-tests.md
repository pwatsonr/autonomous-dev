# SPEC-020-1-05: Unit & Integration Tests for Specialist Reviewer Suite

## Metadata
- **Parent Plan**: PLAN-020-1
- **Tasks Covered**: Task 11 (unit tests for frontend-detection helper), Task 12 (integration tests for all four reviewer agents)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-020-1-05-unit-and-integration-tests.md`

## Description
Closes out PLAN-020-1 with the test suite that validates the specialist reviewers can be loaded, dispatched, and produce schema-valid output. Unit tests cover `detectFrontendChanges()` and its cache; integration tests run each of the four agent definitions through a mocked Claude responder against a single fixture diff containing a known issue from that agent's domain. No real Claude API calls in CI (deterministic, no flaky network failures, no token spend).

The unit tests target ≥95% line coverage on `frontend-detection.ts`. The integration tests are coarse-grained smoke tests — one happy-path case per reviewer — because the deep behavioral coverage lives in the eval suites (SPEC-020-1-03 and SPEC-020-1-04). What these tests prove: the agent file is well-formed, the mocked dispatch works end-to-end, the response validates against `reviewer-finding-v1.json`, and the response contains a finding matching the planted issue.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/reviewers/test-frontend-detection.test.ts` | Create | Vitest spec: framework detection, cache hit/miss, `clearCache` semantics |
| `plugins/autonomous-dev/tests/reviewers/fixtures/package-react.json` | Create | Stub `package.json` with `react` in deps |
| `plugins/autonomous-dev/tests/reviewers/fixtures/package-vue.json` | Create | Stub with `vue` |
| `plugins/autonomous-dev/tests/reviewers/fixtures/package-svelte.json` | Create | Stub with `svelte` |
| `plugins/autonomous-dev/tests/reviewers/fixtures/package-angular.json` | Create | Stub with `@angular/core` |
| `plugins/autonomous-dev/tests/reviewers/fixtures/package-vanilla.json` | Create | Stub with no framework deps |
| `plugins/autonomous-dev/tests/integration/test-qa-reviewer.test.ts` | Create | Mocked dispatch against fixture diff with SQL injection |
| `plugins/autonomous-dev/tests/integration/test-ux-reviewer.test.ts` | Create | Mocked dispatch against fixture diff with color-only error signal |
| `plugins/autonomous-dev/tests/integration/test-a11y-reviewer.test.ts` | Create | Mocked dispatch against fixture diff with missing alt text |
| `plugins/autonomous-dev/tests/integration/test-standards-reviewer.test.ts` | Create | Mocked dispatch + stub evaluator script returning known violations |
| `plugins/autonomous-dev/tests/integration/fixtures/diffs/qa-sql-injection.diff` | Create | Unified diff: SQL injection in `db/users.ts` |
| `plugins/autonomous-dev/tests/integration/fixtures/diffs/ux-color-only.diff` | Create | Unified diff: error indicated by red text only |
| `plugins/autonomous-dev/tests/integration/fixtures/diffs/a11y-missing-alt.diff` | Create | Unified diff: `<img>` without alt |
| `plugins/autonomous-dev/tests/integration/fixtures/diffs/standards-no-lodash.diff` | Create | Unified diff: `import _ from 'lodash'` |
| `plugins/autonomous-dev/tests/integration/fixtures/stub-evaluator.js` | Create | Node script that emits `{"violations":[...]}` for the standards integration test |

## Implementation Details

### Unit Test Structure (`test-frontend-detection.test.ts`)

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { detectFrontendChanges, clearCache, __cacheForTests } from '../../src/reviewers/frontend-detection';

describe('detectFrontendChanges', () => {
  beforeEach(() => clearCache());

  describe('framework detection', () => {
    it.each([
      ['react',   'package-react.json',   ['src/components/Button.tsx']],
      ['vue',     'package-vue.json',     ['src/components/Card.vue']],
      ['svelte',  'package-svelte.json',  ['src/routes/Page.svelte']],
      ['angular', 'package-angular.json', ['src/app/app.component.ts']],
      ['vanilla', 'package-vanilla.json', ['src/components/widget.tsx']],
    ])('detects %s', (expected, pkg, files) => {
      const result = detectFrontendChanges('req-1', `tests/reviewers/fixtures/${pkg.replace('.json','')}`, files);
      expect(result.isFrontendChange).toBe(true);
      expect(result.framework).toBe(expected);
    });
  });

  describe('non-frontend changes', () => {
    it('returns isFrontendChange:false for backend-only diff', () => {
      const result = detectFrontendChanges('req-2', 'tests/reviewers/fixtures/package-react', ['src/services/auth.ts']);
      expect(result.isFrontendChange).toBe(false);
      expect(result.detectedFiles).toEqual([]);
      expect(result.framework).toBeUndefined();
    });
  });

  describe('cache semantics', () => {
    it('returns same object reference on cache hit', () => {
      const a = detectFrontendChanges('req-3', 'tests/reviewers/fixtures/package-react', ['src/Button.tsx']);
      const b = detectFrontendChanges('req-3', 'tests/reviewers/fixtures/package-react', ['src/Button.tsx']);
      expect(a).toBe(b);
    });

    it('clearCache(id) evicts only the specified entry', () => {
      detectFrontendChanges('req-4', 'tests/reviewers/fixtures/package-react', ['x.tsx']);
      detectFrontendChanges('req-5', 'tests/reviewers/fixtures/package-react', ['y.tsx']);
      clearCache('req-4');
      expect(__cacheForTests.has('req-4')).toBe(false);
      expect(__cacheForTests.has('req-5')).toBe(true);
    });

    it('clearCache() with no arg evicts all entries', () => {
      detectFrontendChanges('req-6', 'tests/reviewers/fixtures/package-react', ['x.tsx']);
      detectFrontendChanges('req-7', 'tests/reviewers/fixtures/package-react', ['y.tsx']);
      clearCache();
      expect(__cacheForTests.size).toBe(0);
    });
  });

  describe('viewport meta detection', () => {
    it('detects <meta name="viewport"> in scanned files', () => {
      // fixture file contains the meta tag
      const result = detectFrontendChanges('req-8', 'tests/reviewers/fixtures/package-react', ['fixtures/index.html']);
      expect(result.hasViewportMeta).toBe(true);
    });
  });
});
```

Coverage target: ≥95% line coverage on `src/reviewers/frontend-detection.ts`. Enforced by Vitest's `--coverage` flag in CI.

### Integration Test Pattern

Each integration test follows this shape:

```ts
import { describe, it, expect } from 'vitest';
import { dispatchAgent } from '../../src/agent-factory/dispatch'; // assumed existing
import { validateAgainstSchema } from '../../src/schema-validator';
import findingSchema from '../../schemas/reviewer-finding-v1.json';
import { readFileSync } from 'node:fs';

const MOCK_RESPONSES = {
  'qa-edge-case-reviewer': {
    reviewer: 'qa-edge-case-reviewer',
    verdict: 'REQUEST_CHANGES',
    score: 75,
    findings: [{
      file: 'src/db/users.ts',
      line: 3,
      severity: 'critical',
      category: 'input-validation',
      title: 'SQL injection via string interpolation',
      description: '...',
      suggested_fix: 'Use parameterized queries.',
    }],
  },
};

describe('qa-edge-case-reviewer integration', () => {
  it('produces a schema-valid finding for a SQL-injection diff', async () => {
    const diff = readFileSync('tests/integration/fixtures/diffs/qa-sql-injection.diff', 'utf8');
    const response = await dispatchAgent('qa-edge-case-reviewer', { diff }, {
      mock: MOCK_RESPONSES['qa-edge-case-reviewer'],
    });
    expect(validateAgainstSchema(response, findingSchema)).toBe(true);
    expect(response.verdict).toBe('REQUEST_CHANGES');
    expect(response.findings).toHaveLength(1);
    expect(response.findings[0].category).toContain('input-validation');
  });
});
```

The `dispatchAgent` helper accepts a `mock` option that bypasses the real Claude SDK and returns the canned response. This mirrors the existing pattern in other integration tests in `plugins/autonomous-dev/tests/integration/`.

### Standards Reviewer Integration Test

Unique to the standards reviewer: the test must run with a fixture `standards.yaml` and a stub evaluator. Setup:

1. Stage `tests/integration/fixtures/standards-no-lodash.diff` (the input).
2. Stage a temporary `.autonomous-dev/standards.yaml` with one rule referencing `tests/integration/fixtures/stub-evaluator.js`.
3. Stub `bin/run-evaluator.js` to delegate to `stub-evaluator.js` (or, in this test, mock `dispatchAgent` to skip the Bash invocation entirely and return a canned violation).

The test asserts the response contains a finding with `rule_id: "no-lodash"` and the schema validates.

## Acceptance Criteria

- [ ] `tests/reviewers/test-frontend-detection.test.ts` exists and runs under Vitest.
- [ ] All five framework cases (react, vue, svelte, angular, vanilla) pass.
- [ ] Cache hit test asserts object reference equality (`expect(a).toBe(b)`), not just deep equality.
- [ ] `clearCache('id')` test verifies only the named entry is evicted.
- [ ] `clearCache()` test verifies all entries are evicted.
- [ ] Viewport-meta detection test passes against a fixture HTML file containing the meta tag.
- [ ] Vitest coverage report shows ≥95% line coverage on `src/reviewers/frontend-detection.ts`.
- [ ] Four integration test files exist (`test-qa-reviewer`, `test-ux-reviewer`, `test-a11y-reviewer`, `test-standards-reviewer`).
- [ ] Each integration test loads its fixture diff and asserts the response validates against `schemas/reviewer-finding-v1.json`.
- [ ] Each integration test asserts the response contains at least one finding whose `category` matches the planted issue (substring match acceptable).
- [ ] Standards integration test asserts the emitted finding has `rule_id` set to the rule that was triggered by the fixture.
- [ ] No integration test makes a real Claude API call; all dispatches are mocked.
- [ ] All tests run green in `vitest run` invoked from `plugins/autonomous-dev/`.
- [ ] Test files follow existing naming convention (`test-*.test.ts`) used elsewhere in `plugins/autonomous-dev/tests/`.

## Dependencies

- **Upstream**: SPEC-020-1-01 (schema), SPEC-020-1-02 (frontend-detection module + UX/a11y agents), SPEC-020-1-03 (standards reviewer agent + fixture YAMLs).
- **Existing infrastructure**: `dispatchAgent` helper at `src/agent-factory/dispatch.ts` (assumed available; if absent, integration tests stub the call inline). Vitest is already configured in `plugins/autonomous-dev/`.
- **No downstream dependencies** — this is the final spec in PLAN-020-1; PLAN-020-2 picks up after these tests pass.

## Notes

- Integration tests are intentionally shallow. The eval suites (SPEC-020-1-03, SPEC-020-1-04) provide the deep behavioral coverage. Duplicating that coverage in unit tests would be wasteful and would couple tests to specific finding text.
- Mocking the Claude SDK keeps CI deterministic and free of token spend. The trade-off: these tests cannot catch prompt regressions. That is the eval suite's job (run nightly with real API calls per PLAN-017-3).
- The viewport-meta detection test requires a fixture HTML file. If `frontend-detection.ts` reads `package.json` only and not file contents, this test can be omitted. The unit test scope follows what the implementation actually does; if the implementation in SPEC-020-1-02 omits viewport-meta scanning, drop the test.
- `__cacheForTests` is exposed solely for unit-test introspection. It is documented as internal in the JSDoc on the export. Production code must NOT import it.
- Coverage threshold (95%) follows the existing pattern in other `tests/reviewers/` test specs. Lower thresholds are acceptable for integration tests (they cover only happy paths).
- If the integration tests reveal a missing helper (e.g. a JSON-schema validator), add it as a sibling task in this spec rather than blocking on a follow-up plan. Keep the scope as "tests work end-to-end."

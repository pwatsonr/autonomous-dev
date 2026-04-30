# SPEC-019-2-05: Unit + Integration Tests for Validation Pipeline

## Metadata
- **Parent Plan**: PLAN-019-2 (Hook Output Validation Pipeline: AJV + Custom Formats)
- **Tasks Covered**: Task 9 (unit tests for formats, keywords, pipeline), Task 10 (integration test: pipeline + executor)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-2-05-unit-and-integration-tests.md`

## Description
Author the test suite that proves every behavior promised by SPEC-019-2-01 through SPEC-019-2-04 is actually delivered. Three unit-test files cover the custom formats, the custom keywords, and the pipeline class itself (including stats and version negotiation). One integration-test file exercises the pipeline + executor wiring with fixture hooks: one well-behaved (passes through cleanly), one that emits extra fields (gets sanitized), and one with invalid input (gets skipped). The integration test also asserts `getStats()` returns correct counts after the run.

Coverage targets: ≥ 95% lines and branches on `validation-pipeline.ts`, `formats.ts`, `keywords.ts`, and `validation-stats.ts`. The unit suite must complete in < 5 seconds wall-clock; the integration test in < 2 seconds. All tests are deterministic — no sleeps, no time-based flakiness, no network.

The test framework is the project's existing `node:test` setup (per PLAN-019-1's test conventions). Coverage is measured via the project's existing `c8` (or built-in `node --experimental-test-coverage`) configuration; this spec does not introduce a new coverage tool.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/hooks/test-validation-formats.test.ts` | Create | Per-format positive/negative cases + idempotency |
| `plugins/autonomous-dev/tests/hooks/test-validation-keywords.test.ts` | Create | x-allow-extensions, x-redact-on-failure, auto-redaction |
| `plugins/autonomous-dev/tests/hooks/test-validation-pipeline.test.ts` | Create | Loading, version negotiation, stats, sanitization |
| `plugins/autonomous-dev/tests/integration/test-hook-validation.test.ts` | Create | End-to-end with fixture hooks through the executor |
| `plugins/autonomous-dev/tests/fixtures/hooks/valid-hook.ts` | Create | Fixture: returns valid output |
| `plugins/autonomous-dev/tests/fixtures/hooks/extras-hook.ts` | Create | Fixture: returns output with extra fields |
| `plugins/autonomous-dev/tests/fixtures/hooks/invalid-input-hook.ts` | Create | Fixture: declares required input the test will violate |
| `plugins/autonomous-dev/tests/fixtures/schemas/hooks/test-point/1.0.0/input.json` | Create | Test schema requiring `name: string` |
| `plugins/autonomous-dev/tests/fixtures/schemas/hooks/test-point/1.0.0/output.json` | Create | Test schema with `properties` declaring `result: string` |

## Implementation Details

### `test-validation-formats.test.ts`

Test groups:

1. **`semver` format**
   - Valid: `'1.2.3'`, `'0.0.1'`, `'1.0.0-beta.1+build.5'`, `'10.20.30'`
   - Invalid: `'1.2'`, `'not-a-version'`, `''`, `'1.2.3.4'`
   - Idempotency: register twice, count `ajv.formats.semver` references — must be 1 not 2

2. **`iso-duration` format**
   - Valid: `'PT1H30M'`, `'P1Y'`, `'P1W'`, `'P1Y2M10DT2H30M5S'`, `'P1D'`, `'PT5S'`
   - Invalid: `'1h30m'`, `'PT'`, `'P'`, `''`, `'P1H'` (H must be in time component)

3. **`path-glob` format**
   - Valid: `'src/**/*.ts'`, `'**/*'`, `'foo/{a,b}.txt'`, `'!exclude/**'`, `'*.md'`
   - Invalid: `'src/[unclosed'`, `'src/{unclosed'`

4. **End-to-end through pipeline**
   - Build a tiny schema: `{ "type": "string", "format": "semver" }`
   - Validate `'1.0.0'` → isValid=true
   - Validate `'bad'` → isValid=false, errors include `format` keyword

Use `node:test`'s `describe` + `it` pattern (project convention from PLAN-019-1).

### `test-validation-keywords.test.ts`

Test groups:

1. **`x-allow-extensions` — happy path**
   - Schema: `{ "type": "object", "properties": { "name": { "type": "string" } }, "x-allow-extensions": ["customField"] }`
   - Input `{ "name": "x", "customField": 42 }` → sanitized output retains both keys
   - Input `{ "name": "x", "customField": 42, "junk": true }` → `junk` stripped, `customField` retained

2. **`x-allow-extensions` — empty list**
   - Schema with `"x-allow-extensions": []` behaves identically to no keyword

3. **`x-redact-on-failure` — explicit declaration**
   - Schema: `{ "properties": { "secret": { "type": "string", "minLength": 100 } }, "x-redact-on-failure": ["/secret"] }`
   - Input `{ "secret": "abc123XYZ" }` → errors do NOT contain `'abc123XYZ'`; contain `'[REDACTED]'`

4. **`x-redact-on-failure` — auto-redaction (no explicit list)**
   - Schema: `{ "properties": { "apiKey": { "type": "string", "minLength": 50 } } }` (no x-redact-on-failure)
   - Input `{ "apiKey": "supersecret123" }` → errors do NOT contain `'supersecret123'`
   - Field name `password`, `token`, `credential`, `secret` all auto-redact

5. **`x-redact-on-failure` — glob paths**
   - Schema: `{ "properties": { "creds": { "type": "object", ... } }, "x-redact-on-failure": ["/creds/**"] }`
   - Input `{ "creds": { "password": "p1", "apiKey": "k1" } }` with a triggering error → both `'p1'` and `'k1'` scrubbed

6. **`x-redact-on-failure` — non-matching paths NOT redacted**
   - A field with a benign value at a path not in the redact list keeps its value visible in errors

7. **Both keywords idempotent**
   - Calling `registerCustomKeywords(ajv)` twice does not throw and does not re-register

### `test-validation-pipeline.test.ts`

Test groups:

1. **`loadSchemas()` happy path**
   - Point at `tests/fixtures/schemas/hooks` → loads test-point's input + output
   - Cache contains 2 entries

2. **`loadSchemas()` malformed JSON**
   - Write a temp schema file with invalid JSON → `loadSchemas()` throws `SchemaLoadError` containing the file path

3. **`loadSchemas()` missing `$schema`**
   - Temp file lacking `$schema` declaration → throws `SchemaLoadError`

4. **Validation success**
   - Validate `{ "name": "alice" }` against the test input schema → `isValid: true`, `validationTime > 0`

5. **Validation failure**
   - Validate `{}` (missing required `name`) → `isValid: false`, errors include the missing required field

6. **No mutation of caller payload**
   - Validate `{ "name": "x", "extra": true }` → caller's object still has `extra: true`; `sanitizedOutput` does not (with strict-additionalProperties test schema)

7. **Schema-version negotiation: exact match**
   - Schemas at `1.0.0` and `1.1.0`. Request `1.1.0` → uses 1.1.0, no warning

8. **Schema-version negotiation: fallback**
   - Schemas at `1.0.0` only. Request `1.0.5` → uses 1.0.0, warning contains `'Falling back to '1.0.0''`

9. **Schema-not-found**
   - Request `'unknown-point'` → throws `SchemaNotFoundError` whose message includes the search path

10. **Stats: counters**
    - 950 success + 50 failure validations → `getStats().overall = { total: 1000, passed: 950, failed: 50 }`

11. **Stats: percentiles**
    - Feed 1000 samples with known durations; assert p50/p95/p99 within ±1ms of expected

12. **Stats: window rolling**
    - 1500 samples to a 1000-window bucket; counters keep counting (1500), percentiles reflect last 1000

13. **Stats: insufficient data**
    - < 10 samples → percentiles return 0

14. **Stats: reset**
    - Record 100 → reset() → `getStats().overall.total === 0`

### Integration: `test-hook-validation.test.ts`

Setup:
- Build a `ValidationPipeline` pointed at `tests/fixtures/schemas/hooks`
- Build a `HookRegistry` (from PLAN-019-1) and register the three fixture hooks at `test-point`
- Build a `HookExecutor` wired with the pipeline

Scenarios:

1. **Valid hook executes cleanly**
   - Invoke executor with valid input → result includes `valid-hook` with `status: 'success'`, `output` matches expected sanitized form

2. **Extras-hook output is sanitized**
   - The fixture returns `{ result: 'ok', extra: 'stripped' }` against an output schema declaring only `result`
   - Result has `status: 'success-with-warnings'`, `output = { result: 'ok' }` — `extra` removed
   - Warning log contains the hook name

3. **Invalid-input-hook is skipped**
   - Invoke executor with input that violates the fixture's schema requirement
   - Result has `status: 'skipped-invalid-input'`, hook's invoke spy never called
   - The other two hooks at the same point still execute (chain not broken)

4. **Stats reflect the run**
   - After all three scenarios, `pipeline.getStats().overall` shows the expected counts:
     - input validations: 3 (one per registered hook)
     - output validations: 2 (only the two whose input passed)
     - failed input: 1 (invalid-input-hook)
     - failed output: 1 (extras-hook had extras → still counts as fail per stats, even though sanitization recovers it for the caller)

5. **Determinism**
   - Run scenarios 1-4 in a loop 5 times; assert identical results (no flakes)

### Fixture Hooks

`valid-hook.ts`:
```typescript
export const validHook = {
  pluginName: 'test-plugin',
  name: 'valid-hook',
  point: 'test-point',
  schemaVersion: '1.0.0',
  invoke: async (_input: unknown) => ({ result: 'ok' }),
};
```

`extras-hook.ts`:
```typescript
export const extrasHook = {
  pluginName: 'test-plugin',
  name: 'extras-hook',
  point: 'test-point',
  schemaVersion: '1.0.0',
  invoke: async (_input: unknown) => ({ result: 'ok', extra: 'should-be-stripped', other: 42 }),
};
```

`invalid-input-hook.ts`:
```typescript
import { spy } from 'node:test';
export const invalidInputHookSpy = spy(async (_input: unknown) => ({ result: 'ok' }));
export const invalidInputHook = {
  pluginName: 'test-plugin',
  name: 'invalid-input-hook',
  point: 'test-point',
  schemaVersion: '1.0.0',
  invoke: invalidInputHookSpy,
};
```

### Fixture Schemas

`tests/fixtures/schemas/hooks/test-point/1.0.0/input.json`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://autonomous-dev/schemas/hooks/test-point/1.0.0/input.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["name"],
  "properties": { "name": { "type": "string" } }
}
```

`tests/fixtures/schemas/hooks/test-point/1.0.0/output.json`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://autonomous-dev/schemas/hooks/test-point/1.0.0/output.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["result"],
  "properties": { "result": { "type": "string" } }
}
```

Note: these fixture schemas use `additionalProperties: false` (strict) deliberately — different from the baseline production schemas (which use `additionalProperties: true`) — because the integration test specifically validates the strip-extras behavior, which requires a strict schema to exercise.

## Acceptance Criteria

### Coverage & Performance

- [ ] All four test files run via `npm test` (the project's existing test command).
- [ ] Coverage on `src/hooks/validation-pipeline.ts` ≥ 95% lines, ≥ 95% branches.
- [ ] Coverage on `src/hooks/formats.ts` ≥ 95% lines, ≥ 95% branches.
- [ ] Coverage on `src/hooks/keywords.ts` ≥ 95% lines, ≥ 95% branches.
- [ ] Coverage on `src/hooks/validation-stats.ts` ≥ 95% lines, ≥ 95% branches.
- [ ] Total wall-clock for the three unit-test files combined: < 5 seconds.
- [ ] Wall-clock for the integration test file: < 2 seconds.
- [ ] All tests pass deterministically: 10 consecutive runs of `npm test` all pass with no flakes.

### Per-Test-File Acceptance

- [ ] `test-validation-formats.test.ts`: every format has at minimum 4 positive and 3 negative cases; idempotency tested for the registration helper.
- [ ] `test-validation-keywords.test.ts`: both keywords tested in isolation AND through the pipeline; auto-redaction tested on at least 4 different field names.
- [ ] `test-validation-pipeline.test.ts`: covers `loadSchemas()` success + 2 failure paths, version negotiation (exact + fallback + missing), stats (counts + percentiles + window + reset), no-mutation invariant.
- [ ] `test-hook-validation.test.ts`: all 5 scenarios pass; spy on `invalid-input-hook.invoke` confirms it was never called; final `getStats()` snapshot matches the documented expected values.

### Hygiene

- [ ] No `console.log` in test output (use `node:test` reporter).
- [ ] No `setTimeout` / `sleep` / time-based waits in any test.
- [ ] Tests do not write to `plugins/autonomous-dev/schemas/` (only the fixture path under `tests/fixtures/`).
- [ ] Fixture cleanup: any temp files written by tests (e.g., the malformed-JSON test) are removed in `afterEach` or `t.after()`.
- [ ] Fixture hooks live under `tests/fixtures/hooks/` and are NOT loaded by production discovery (verified by inspecting test isolation — production `loadPlugins()` should not see them).

## Dependencies

- **Blocked by**: SPEC-019-2-01 (pipeline class), SPEC-019-2-02 (formats/keywords), SPEC-019-2-03 (stats + baseline schemas), SPEC-019-2-04 (executor wiring), PLAN-019-1 (`HookRegistry`, `HookExecutor`, `HookManifest` types).
- **Consumed by**: PLAN-019-2 Definition of Done — these tests are what the merge gate runs.
- No new runtime or dev deps introduced.

## Notes

- Test framework choice (`node:test`) follows PLAN-019-1's convention. If that plan adopted a different runner (e.g., `vitest`, `jest`), this spec's `describe`/`it` patterns translate directly.
- The 95% coverage threshold is enforced via the project's existing CI coverage gate (configured in PLAN-019-1). This spec does not change that configuration; it just authors tests sufficient to clear the bar.
- The integration test deliberately registers fixture hooks programmatically rather than loading them via the discovery pipeline. This keeps the test focused on validation behavior, not discovery (which has its own coverage in PLAN-019-1).
- Why count extras-hook's output as a stats failure even though sanitization recovers? Because the contract is "your hook emitted invalid output." The recovery is a courtesy to keep the chain running; the metric should reflect the underlying contract violation so operators can identify and fix the misbehaving hook. This matches the PLAN-019-2 risk-register rationale for the `removeAdditional: 'all'` policy.
- The malformed-JSON `loadSchemas()` test writes its temp fixture in a hook's `t.before` and removes it in `t.after`. Use `node:fs/promises` and `os.tmpdir()` to keep the fixture out of the repo.
- We do NOT test the performance benchmark from SPEC-019-2-04 here. That benchmark has its own CI job (`npm test:perf`) and lives outside the standard test suite to avoid slowing local dev runs.
- Spy/mock on the invalid-input-hook is critical: simply asserting `result.status === 'skipped-invalid-input'` is necessary but not sufficient — we must prove the hook function was never invoked, otherwise a future regression that calls the function before checking validation could pass the status assertion while breaking the security guarantee.

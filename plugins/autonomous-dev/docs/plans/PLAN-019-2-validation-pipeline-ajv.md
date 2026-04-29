# PLAN-019-2: Hook Output Validation Pipeline (AJV + Custom Formats)

## Metadata
- **Parent TDD**: TDD-019-extension-hook-system
- **Estimated effort**: 4 days
- **Dependencies**: []
- **Blocked by**: [PLAN-019-1]
- **Priority**: P0

## Objective
Deliver the schema-driven validation pipeline that gates every hook input and output, ensuring plugin extensions cannot inject malformed data into the daemon's pipeline. This plan implements the AJV-backed `ValidationPipeline` class per TDD §9 (lines 1-130 reference impl), the per-hook-point schema registry (`schemas/hooks/<hook-point>/<version>/{input,output}.json`), the custom formats (`semver`, `iso-duration`, `path-glob`), the custom keywords (`x-redact-on-failure`, `x-allow-extensions`), and the validation-stats collection that powers performance monitoring. All hook outputs are sanitized (extra fields stripped via `removeAdditional: 'all'`) before being passed to downstream consumers.

## Scope
### In Scope
- `ValidationPipeline` class at `src/hooks/validation-pipeline.ts` matching TDD §9 reference implementation: AJV instance configured with `strict: true`, `allErrors: false`, `coerceTypes: true`, `removeAdditional: 'all'`, `useDefaults: true`, `validateFormats: true`
- Schema registry: filesystem layout `schemas/hooks/<hook-point>/<version>/input.json` and `output.json` for all 10 hook points × at least version `1.0.0`
- `loadSchemas()` startup method that walks the schema dir and pre-compiles all validators (cached for runtime perf)
- `validateHookInput(point, version, input)` and `validateHookOutput(point, version, output)` methods returning `ValidationResult` with `isValid`, `sanitizedOutput`, `errors[]`, `warnings[]`, `validationTime`
- Custom formats registered via `addFormats`: `semver` (semver string), `iso-duration` (ISO 8601 duration), `path-glob` (glob pattern compatible with `picomatch`)
- Custom keywords: `x-redact-on-failure` (when validation fails, redact specified field paths from error output to prevent secret leakage in logs), `x-allow-extensions` (whitelist of additional properties allowed despite `removeAdditional`)
- `ValidationStats` collection: per-hook-point counters for success/failure rates and p95 validation time, exposed via `getStats()` method
- Integration with `HookExecutor` from PLAN-019-1: every hook invocation calls `validateHookInput` before invocation and `validateHookOutput` after; failures gate the executor's behavior per the hook's `failure_mode` (handled in PLAN-019-4)
- Schema version negotiation: each hook entry in the manifest declares the schema version it implements; the pipeline picks the matching validator, falling back with a warning if the version isn't found
- Unit tests covering: each custom format, each custom keyword, validation success path, validation failure path with structured errors, schema-version negotiation, performance (validation completes in <5ms per call for typical payloads)
- Integration test: register a hook, invoke it through the executor, verify both input and output were validated and sanitized

### Out of Scope
- The `HookRegistry`, `HookExecutor`, `PluginDiscovery` classes -- delivered by PLAN-019-1
- Plugin trust / signature verification / agent-meta-reviewer integration -- PLAN-019-3
- Reviewer slot mechanics, sequential execution, audit log -- PLAN-019-4
- Hook-point-specific schema content (this plan delivers the pipeline; the actual JSON schemas for each hook point's input/output shape are out of scope and will be authored as part of the consumers, e.g., when PLAN-005-X integrates with `intake-pre-validate`)
- Sandbox / worker_thread isolation -- coordinated with PRD-001 sandbox plan
- Schema versioning conflict resolution beyond "use the latest matching" -- TDD-019 §17.1 open question

## Tasks

1. **Author `ValidationPipeline` class skeleton** -- Create `src/hooks/validation-pipeline.ts` with the constructor wiring AJV, the `loadSchemas()` method, and the two validate methods (`validateHookInput`, `validateHookOutput`). Match the TDD §9 reference implementation field-by-field.
   - Files to create: `plugins/autonomous-dev/src/hooks/validation-pipeline.ts`
   - Acceptance criteria: TypeScript compiles. AJV options match TDD §9 verbatim. `loadSchemas()` is async and walks the schema directory. The validate methods return `Promise<ValidationResult>` with the documented shape.
   - Estimated effort: 3h

2. **Implement schema-version negotiation** -- The validate methods accept a `version` parameter. Cache key is `${hookPoint}:${version}:${input|output}`. If a validator for the requested version isn't found, log a warning and fall back to the latest available version for that hook point.
   - Files to modify: `plugins/autonomous-dev/src/hooks/validation-pipeline.ts`
   - Acceptance criteria: A hook declaring `schema_version: 1.0.0` resolves the `1.0.0` validator. If the schema dir only has `1.1.0`, it falls back with a warning. If no schema exists for the hook point at all, the call fails with a clear error pointing at the missing path.
   - Estimated effort: 2h

3. **Register custom formats** -- Add `registerCustomFormats()` per TDD §9 covering `semver`, `iso-duration`, `path-glob`. Each format has a regex or function-based validator. Tests cover positive and negative cases for each format.
   - Files to modify: `plugins/autonomous-dev/src/hooks/validation-pipeline.ts`
   - Files to create: `plugins/autonomous-dev/src/hooks/formats.ts`
   - Acceptance criteria: `1.2.3` validates as `semver`; `not-a-version` fails. `PT1H30M` validates as `iso-duration`; `1h30m` fails. `src/**/*.ts` validates as `path-glob`; an unclosed bracket fails. Format registration is idempotent (calling `registerCustomFormats()` twice doesn't duplicate).
   - Estimated effort: 3h

4. **Register custom keywords** -- Add `registerCustomKeywords()` per TDD §9 covering `x-redact-on-failure` (paths in this list are redacted from error messages when validation fails) and `x-allow-extensions` (additional properties in this list are allowed despite `removeAdditional: 'all'`).
   - Files to modify: `plugins/autonomous-dev/src/hooks/validation-pipeline.ts`
   - Files to create: `plugins/autonomous-dev/src/hooks/keywords.ts`
   - Acceptance criteria: A schema with `"x-redact-on-failure": ["secret"]` and a failing input containing `{"secret": "abc123"}` produces an error message that does NOT contain `"abc123"` (redacted to `"[REDACTED]"`). A schema with `"x-allow-extensions": ["customField"]` allows `customField` to pass through unchanged while stripping other extras.
   - Estimated effort: 4h

5. **Implement `ValidationStats` collection** -- Add `recordValidationStats(point, version, isValid, duration)` and `getStats()` methods. Stats are stored in-memory (per-process, not persisted across restarts). The `getStats()` output includes total/passed/failed counts and p95 validation time per hook-point/version.
   - Files to modify: `plugins/autonomous-dev/src/hooks/validation-pipeline.ts`
   - Acceptance criteria: After 1000 validations split 950/50 success/fail, `getStats()` shows the right counts. p95 latency is computed from a rolling window of the last 1000 samples (configurable via constructor option). Stats reset is exposed for tests.
   - Estimated effort: 3h

6. **Author baseline schemas for all 10 hook points** -- Create a minimal `input.json` and `output.json` per hook point under `schemas/hooks/<point>/1.0.0/`. Each schema is intentionally permissive at v1 (just typing, no business rules) since this plan delivers the pipeline, not the contracts. Hook-point-specific contracts are added by the consumers.
   - Files to create: 20 schema files under `plugins/autonomous-dev/schemas/hooks/`
   - Acceptance criteria: Every hook point has a v1.0.0 input and output schema. Schemas validate when given an empty object (the most permissive baseline). Each schema declares `$schema: "https://json-schema.org/draft/2020-12/schema"` and `$id` matching the file path.
   - Estimated effort: 4h

7. **Wire the pipeline into `HookExecutor`** -- Modify `src/hooks/executor.ts` (from PLAN-019-1) so that `executeHooks()` calls `validateHookInput()` before each hook invocation and `validateHookOutput()` after. On input validation failure, the hook is skipped with a logged warning. On output validation failure, the sanitized output is used (extras stripped) and a warning is logged. Full failure-mode semantics (block/warn/ignore) are PLAN-019-4's job.
   - Files to modify: `plugins/autonomous-dev/src/hooks/executor.ts`
   - Acceptance criteria: A hook with valid input/output runs to completion. A hook with invalid input is skipped with a warning that names the plugin and hook point. A hook with extra output fields has them stripped before the result is returned to the caller. Tests verify each path with fixture hooks.
   - Estimated effort: 3h

8. **Performance benchmark** -- Add `tests/perf/test-validation-pipeline.bench.ts` that exercises a typical payload (100 fields, ~5KB JSON) and asserts validation completes in <5ms p95. Runs as part of `npm test:perf` in CI.
   - Files to create: `plugins/autonomous-dev/tests/perf/test-validation-pipeline.bench.ts`
   - Acceptance criteria: Benchmark passes on a CI runner (ubuntu-latest, Node 20). p95 < 5ms for the synthetic payload. p99 < 20ms (allows for occasional GC pause). Benchmark output is captured as a workflow artifact.
   - Estimated effort: 2h

9. **Unit tests for formats, keywords, and pipeline** -- `tests/hooks/test-validation-formats.test.ts`, `test-validation-keywords.test.ts`, `test-validation-pipeline.test.ts` covering all paths from tasks 1-5. Use small inline schemas; no fixture files needed.
   - Files to create: three test files under `plugins/autonomous-dev/tests/hooks/`
   - Acceptance criteria: All tests pass. Coverage ≥95% on `validation-pipeline.ts`, `formats.ts`, `keywords.ts`. Tests run in <5s total.
   - Estimated effort: 4h

10. **Integration test: pipeline + executor** -- `tests/integration/test-hook-validation.test.ts` that registers two fixture hooks (one returns valid output, one returns extra fields), invokes them through the executor, asserts the first passes through unchanged and the second has extras stripped. Stats endpoint shows correct counts.
    - Files to create: `plugins/autonomous-dev/tests/integration/test-hook-validation.test.ts`
    - Acceptance criteria: Test passes deterministically. Output of fixture 2 has the documented extra fields removed. `getStats()` returns 2 successes after the test, with non-zero validation time.
    - Estimated effort: 2h

## Dependencies & Integration Points

**Exposes to other plans:**
- `ValidationPipeline` class consumed by PLAN-019-3 (trust gate validates manifest schema before trust check), PLAN-019-4 (sequential execution depends on validation results to decide gating), and any future plan that adds new hook points.
- Custom format registration pattern (`semver`, `iso-duration`, `path-glob`) reusable by other validation domains in the system.
- Custom keyword pattern (`x-redact-on-failure`, `x-allow-extensions`) extensible by future security-sensitive schemas.
- `ValidationStats` data shape consumed by observability dashboards (TDD-007 / PRD-007).

**Consumes from other plans:**
- **PLAN-019-1** (blocking): `HookPoint` enum, `HookManifest` interface, `HookExecutor` class. Without these, the pipeline has nothing to validate.
- TDD-007 / PLAN-007-3: existing analytics infrastructure that the `ValidationStats` integrates with for dashboard surfacing.

## Testing Strategy

- **Unit tests (task 9):** Each format, each keyword, success/failure paths of the pipeline, version negotiation. ≥95% coverage.
- **Integration test (task 10):** Pipeline + executor end-to-end with fixture hooks.
- **Performance benchmark (task 8):** p95 < 5ms for a 100-field payload, captured as a CI artifact.
- **Schema-content tests:** All 20 baseline schemas (10 hook points × input/output) parse cleanly via AJV at startup. The `loadSchemas()` test asserts every expected schema file exists.
- **Negative tests:** Malformed schema (e.g., invalid `$schema` declaration) fails loud at startup with a clear error pointing at the file.
- **Manual smoke:** Author a custom hook with an output containing redacted fields; verify the redaction kicks in on a forced validation failure.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| AJV major version drift breaks the pipeline (e.g., breaking change in validator API) | Low | High -- pipeline crashes at startup | Pin to `ajv@8.x` and `ajv-formats@2.x`. CI smoke test exercises the pipeline at least once per release. AJV v9 migration is a separate plan when it's released. |
| `removeAdditional: 'all'` strips fields that downstream consumers actually expect (poor schema design + missing field) | High | Medium -- silent data loss in hook outputs | Mitigation is operational: every hook author must validate their schema covers all fields they emit. The `x-allow-extensions` keyword provides an escape hatch for legitimate optional fields. Schema review checklist (PR template) requires confirmation that all expected fields are listed. |
| Custom format `path-glob` accepts patterns that `picomatch` rejects later, causing inconsistent behavior | Medium | Low -- mismatch between validation and runtime | The format validator USES `picomatch.parse()` (not just a regex) so any pattern accepted here works at runtime. Test cases derive from `picomatch`'s own test suite. |
| `x-redact-on-failure` redaction has a bypass via deeply nested fields not covered by the path patterns | Medium | High -- secret leakage through error messages | Path patterns support glob-style traversal (`secrets.**`). Default policy: any field whose name matches `(?i)(secret|token|password|key)` is auto-redacted even without explicit declaration. Documented in the keyword's JSDoc. |
| Validation latency exceeds the 5ms p95 budget on cold cache (first call after startup) | High | Low -- one-time perf hit | `loadSchemas()` pre-compiles all validators at startup, so steady-state validation is hot-cache. The 5ms p95 target excludes cold-start. Documented in the benchmark output. |
| Stats collection holds unbounded memory for high-throughput hooks | Low | Medium -- memory leak over long uptime | Rolling window of 1000 samples per hook-point/version (configurable). Old samples are discarded. Memory budget: ~500KB for 50 hook points × 5 versions × 1000 samples × ~10 bytes per sample. |

## Definition of Done

- [ ] `ValidationPipeline` matches TDD §9 reference implementation field-by-field
- [ ] AJV configured with `strict`, `removeAdditional: 'all'`, `coerceTypes`, `useDefaults`, `validateFormats` per the spec
- [ ] All three custom formats (`semver`, `iso-duration`, `path-glob`) work and have unit-test coverage
- [ ] Both custom keywords (`x-redact-on-failure`, `x-allow-extensions`) work and have unit-test coverage
- [ ] All 10 hook points have v1.0.0 baseline `input.json` and `output.json` schemas
- [ ] `loadSchemas()` pre-compiles all validators at startup; cold-start cost is amortized
- [ ] Schema-version negotiation falls back to latest with a warning when exact version missing
- [ ] `ValidationStats` exposes counts and p95 latency per hook-point/version
- [ ] `HookExecutor` integration validates input before invocation and output after
- [ ] Output sanitization strips extras unless `x-allow-extensions` permits them
- [ ] Unit tests pass with ≥95% coverage on the three new files
- [ ] Performance benchmark confirms p95 < 5ms for typical payloads
- [ ] Integration test demonstrates pipeline + executor with fixture hooks
- [ ] No regressions in PLAN-019-1's discovery, registry, or executor behavior

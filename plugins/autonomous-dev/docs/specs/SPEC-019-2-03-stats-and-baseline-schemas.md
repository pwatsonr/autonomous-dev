# SPEC-019-2-03: ValidationStats Collection & Baseline Schemas for All 10 Hook Points

## Metadata
- **Parent Plan**: PLAN-019-2 (Hook Output Validation Pipeline: AJV + Custom Formats)
- **Tasks Covered**: Task 5 (ValidationStats collection), Task 6 (baseline schemas for all 10 hook points)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-2-03-stats-and-baseline-schemas.md`

## Description
Add the in-process telemetry layer to the `ValidationPipeline` and ship the on-disk schema registry that gives every hook point a v1.0.0 baseline. The stats subsystem collects per-`(hookPoint, version)` counters (total / passed / failed) and a rolling p95 of validation latency, exposed via a `getStats()` method. The schema registry provides the directory tree and 20 minimum-viable JSON Schema files (input + output for each of the 10 hook points), each intentionally permissive at v1 so this plan ships the pipeline rather than the contracts.

Stats are per-process and not persisted across daemon restarts (TDD-007 / PRD-007 own durable telemetry). The rolling window keeps memory bounded; per the PLAN-019-2 risk register, the budget is ~500 KB total for 50 hook points × 5 versions × 1000 samples × ~10 bytes per sample.

The baseline schemas exist solely to wire the pipeline end-to-end. They satisfy the structural contract (`$schema`, `$id`, parsability) and validate `{}` as the most permissive baseline. Hook-point-specific business rules (required fields, enums, semantic constraints) are added later by the consumer plans (e.g., PLAN-005-X populates `intake-pre-validate`'s real schema when it integrates).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/hooks/validation-stats.ts` | Create | `ValidationStats` class with `record()`, `getStats()`, `reset()` |
| `plugins/autonomous-dev/src/hooks/validation-pipeline.ts` | Modify | Construct stats; call `stats.record()` from each `validate*` |
| `plugins/autonomous-dev/schemas/hooks/intake-pre-validate/1.0.0/input.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/intake-pre-validate/1.0.0/output.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/intake-post-classify/1.0.0/input.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/intake-post-classify/1.0.0/output.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/document-pre-render/1.0.0/input.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/document-pre-render/1.0.0/output.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/document-post-render/1.0.0/input.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/document-post-render/1.0.0/output.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/review-pre-execute/1.0.0/input.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/review-pre-execute/1.0.0/output.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/review-post-execute/1.0.0/input.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/review-post-execute/1.0.0/output.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/lifecycle-pre-transition/1.0.0/input.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/lifecycle-pre-transition/1.0.0/output.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/lifecycle-post-transition/1.0.0/input.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/lifecycle-post-transition/1.0.0/output.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/audit-pre-emit/1.0.0/input.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/audit-pre-emit/1.0.0/output.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/error-pre-handle/1.0.0/input.json` | Create | Baseline schema |
| `plugins/autonomous-dev/schemas/hooks/error-pre-handle/1.0.0/output.json` | Create | Baseline schema |

## Implementation Details

### `ValidationStats` Class

```typescript
export interface StatSnapshot {
  total: number;
  passed: number;
  failed: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  windowSize: number;
}

export interface AllStats {
  byHookPoint: Record<string, Record<string, StatSnapshot>>; // [point][version] = snapshot
  overall: StatSnapshot;
}

export class ValidationStats {
  constructor(private readonly windowSize: number = 1000) {}

  record(point: string, version: string, isValid: boolean, durationMs: number): void;
  getStats(): AllStats;
  reset(): void; // exposed for tests
}
```

Internal storage: `Map<string, Map<string, BucketState>>` where `BucketState` holds:
- `total: number` — monotonic counter, never reset by window rolling
- `passed: number` — monotonic
- `failed: number` — monotonic
- `samples: number[]` — circular buffer of the last `windowSize` durations
- `cursor: number` — next write index in `samples`

`record()` is O(1): increment counters, write `samples[cursor]`, advance cursor mod windowSize.

`getStats()` is O(n log n) per bucket (sort the sample window for percentiles). Acceptable because `getStats()` is operator/dashboard-driven, not per-call.

Percentiles: sort the populated samples ascending; pick `samples[ceil(p × len) - 1]` for `p ∈ {0.5, 0.95, 0.99}`. If the window has < 10 samples, return `0` for percentiles (insufficient data; documented in JSDoc).

`overall` is computed by aggregating all buckets: sum `total/passed/failed`, merge sample arrays into one for percentile calculation (capped at the same `windowSize` to keep it O(windowSize)).

### Pipeline Integration

In `ValidationPipeline` constructor:
```typescript
this.stats = new ValidationStats(options.statsWindowSize ?? 1000);
```

In the private `validate()` method, just before returning the result:
```typescript
this.stats.record(point, resolvedVersion, isValid, validationTime);
```

Expose `getStats()` and `resetStats()` (delegating to `this.stats`) on the pipeline so callers don't need to reach inside.

### Baseline Schema Template

Every one of the 20 schema files follows this exact shape (substituting `<hook-point>` and `<input|output>`):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://autonomous-dev/schemas/hooks/<hook-point>/1.0.0/<input|output>.json",
  "title": "<hook-point> <input|output> v1.0.0",
  "description": "Baseline permissive schema. Business-rule constraints are added by consumer plans.",
  "type": "object",
  "additionalProperties": true,
  "properties": {}
}
```

`additionalProperties: true` is intentional at v1 — the baseline lets ANY object through. This is the safest default for a schema that must coexist with consumers we have not yet written. Once a consumer plan (e.g., PLAN-005-X) ships its hook-point contract, that consumer authors `2.0.0` (or `1.1.0`) with the real shape. The pipeline's fallback logic (SPEC-019-2-01) keeps the baseline reachable for legacy hooks.

Note that with `additionalProperties: true` AND the AJV `removeAdditional: 'all'` global option, AJV's behavior is: `removeAdditional` only strips properties NOT covered by `additionalProperties` or `patternProperties`. With `additionalProperties: true`, no properties are stripped, which is the intended permissive-baseline behavior.

The 10 hook-point names are the canonical set from TDD-019 §6 (mirrored here for self-containment):
1. `intake-pre-validate`
2. `intake-post-classify`
3. `document-pre-render`
4. `document-post-render`
5. `review-pre-execute`
6. `review-post-execute`
7. `lifecycle-pre-transition`
8. `lifecycle-post-transition`
9. `audit-pre-emit`
10. `error-pre-handle`

## Acceptance Criteria

### ValidationStats

- [ ] `ValidationStats` class exported from `src/hooks/validation-stats.ts`; TypeScript compiles strict.
- [ ] After 1000 `record()` calls split 950 success / 50 failure, `getStats().overall` shows `total=1000, passed=950, failed=50`.
- [ ] `getStats().byHookPoint['intake-pre-validate']['1.0.0']` returns the bucket-scoped snapshot (sums to its share of the overall).
- [ ] After feeding 1000 durations of `[1,2,3,...,1000]` ms, `p50Ms ≈ 500`, `p95Ms ≈ 950`, `p99Ms ≈ 990` (±1 to allow rounding).
- [ ] When fewer than 10 samples are recorded for a bucket, `p50/p95/p99` return `0` (insufficient-data sentinel). Documented in JSDoc.
- [ ] Window rolling: feeding 1500 samples to a 1000-window bucket means the percentile calculation uses only the most recent 1000 (verified by feeding 1000 small + 500 large samples and confirming p95 reflects the mix, not all 1500).
- [ ] Counters (`total/passed/failed`) are monotonic — they keep climbing past `windowSize` (window only affects latency percentiles, not counts).
- [ ] `reset()` clears everything: counts go to 0, sample buffer is emptied, cursor reset.
- [ ] Memory budget: 50 buckets × 1000 samples × 8 bytes/sample = 400 KB heap floor; verified by snapshot heap diff in unit test.
- [ ] `record()` is O(1) — measured via microbenchmark in unit test that does 100k records in < 50 ms.

### Pipeline Integration

- [ ] `ValidationPipeline.getStats()` and `resetStats()` are public methods that delegate to the internal `ValidationStats`.
- [ ] Every successful `validateHookInput` / `validateHookOutput` call increments `passed`. Every failed call increments `failed`. Both increment `total`.
- [ ] `validationTime` is the value passed into `stats.record()` — so `getStats()` percentiles reflect the same number visible in `ValidationResult.validationTime`.
- [ ] Stats record uses the RESOLVED schema version (after fallback), not the requested one.

### Baseline Schemas

- [ ] All 20 schema files exist at the documented paths.
- [ ] Each file is valid JSON (verified by `jq -e .` exit 0 in CI).
- [ ] Each file declares `$schema: "https://json-schema.org/draft/2020-12/schema"`.
- [ ] Each file's `$id` matches the URL pattern `https://autonomous-dev/schemas/hooks/<hook-point>/1.0.0/<direction>.json` and the hook-point segment matches the directory.
- [ ] Each schema's `type` is `"object"` and `additionalProperties` is `true`.
- [ ] `loadSchemas()` loads all 20 successfully and registers 20 cache entries (10 points × 2 directions).
- [ ] Validating `{}` against any of the 20 schemas returns `isValid: true` (most permissive baseline).
- [ ] Validating `{ "anyField": "anyValue" }` against any baseline schema returns `isValid: true` and `sanitizedOutput` retains the field (because `additionalProperties: true` overrides `removeAdditional`).

## Dependencies

- **Blocked by**: SPEC-019-2-01 (the pipeline class + `loadSchemas()` walker), SPEC-019-2-02 (registered formats/keywords; not directly invoked here but the pipeline construction depends on them).
- **Consumed by**: SPEC-019-2-04 (HookExecutor wires `validate*` calls that the stats see), SPEC-019-2-05 (tests assert correct stat counts after invocations), TDD-007 / PLAN-007-3 (observability dashboard reads `getStats()` output).
- No new runtime deps.

## Notes

- The 1000-sample default window is a deliberate trade-off: large enough that p95/p99 are statistically stable for most hook-point throughputs, small enough that memory stays bounded. Operators with very high-throughput hooks can tune via `ValidationPipelineOptions.statsWindowSize`.
- `getStats()` is intended for periodic polling (every few seconds at most), not per-validation reads. The percentile sort is O(n log n) per bucket; calling it in a tight loop would dominate the validation budget.
- The `overall` aggregate uses a merged sample of up to `windowSize` total samples (proportionally drawn from each bucket) to avoid unbounded memory in pathological cases. This makes the overall p95 a slight approximation, which is acceptable for dashboard surfacing.
- Why baseline schemas instead of "no schema means pass-through"? Because requiring an explicit baseline forces the pipeline's `loadSchemas()` to validate the registry's structural integrity at startup. A missing baseline file points at a misconfiguration; an empty/permissive baseline is a deliberate choice that consumers can override.
- `additionalProperties: true` interaction with `removeAdditional: 'all'`: AJV documents that `removeAdditional: 'all'` only removes properties NOT covered by either `properties`, `patternProperties`, or `additionalProperties` (when truthy). With `additionalProperties: true`, every property is "covered" (allowed to be anything), so nothing is stripped. This is exactly what the baseline schema's permissive-pass-through behavior requires.
- Future versions of a hook point's schema (`1.1.0`, `2.0.0`) live alongside `1.0.0` in the same directory tree. The negotiation logic from SPEC-019-2-01 picks the right one. We do NOT delete or replace `1.0.0` when newer versions land — backwards-compatibility is preserved by keeping every published version on disk.

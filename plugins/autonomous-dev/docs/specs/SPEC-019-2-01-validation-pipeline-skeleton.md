# SPEC-019-2-01: ValidationPipeline Class Skeleton & Schema-Version Negotiation

## Metadata
- **Parent Plan**: PLAN-019-2 (Hook Output Validation Pipeline: AJV + Custom Formats)
- **Tasks Covered**: Task 1 (ValidationPipeline class skeleton), Task 2 (schema-version negotiation)
- **Estimated effort**: 5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-2-01-validation-pipeline-skeleton.md`

## Description
Stand up the `ValidationPipeline` class — the schema-driven gate that every hook input and output flows through. This spec covers the structural skeleton: the AJV instance configuration (matching TDD-019 §9 reference implementation field-for-field), the async `loadSchemas()` method that walks the on-disk schema directory and pre-compiles every validator, the two public `validate*` methods, and the version-negotiation logic that picks the right cached validator per `(hookPoint, version, direction)` cache key.

This is the structural foundation only. Custom formats (semver, iso-duration, path-glob), custom keywords (x-redact-on-failure, x-allow-extensions), the stats collector, the baseline schemas, and the `HookExecutor` wiring all land in sibling specs (SPEC-019-2-02 through SPEC-019-2-05). The skeleton must compile cleanly, accept hook-point/version/payload triples, and correctly route them to the right cached validator — but the validators themselves can be empty pass-throughs at this stage.

The class must be safe to construct multiple times in tests (each instance owns its own AJV) and the schema directory root must be configurable so tests can point at fixture trees without touching the canonical layout.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/hooks/validation-pipeline.ts` | Create | `ValidationPipeline` class + `ValidationResult` type |
| `plugins/autonomous-dev/src/hooks/types.ts` | Modify | Append `ValidationResult`, `ValidationPipelineOptions`, `SchemaCacheKey` types if not already present from PLAN-019-1 |
| `plugins/autonomous-dev/package.json` | Modify | Add `ajv@^8.17.0` and `ajv-formats@^2.1.1` to `dependencies` |

## Implementation Details

### Dependencies

Add to `package.json` `dependencies`:
```json
{
  "ajv": "^8.17.0",
  "ajv-formats": "^2.1.1"
}
```

Pin to AJV 8.x per PLAN-019-2 risk register (AJV v9 migration is a separate plan).

### `ValidationResult` Shape

```typescript
export interface ValidationResult<T = unknown> {
  /** True if the payload satisfied the schema. */
  isValid: boolean;
  /** Sanitized payload (extras stripped via removeAdditional). Equals input when isValid===false. */
  sanitizedOutput: T;
  /** Structured AJV errors, or [] on success. Each entry includes instancePath, message, params. */
  errors: Array<{ instancePath: string; message: string; params?: Record<string, unknown> }>;
  /** Non-fatal warnings (e.g., schema version fallback). */
  warnings: string[];
  /** Wall-clock duration of the validate call in milliseconds (sub-ms precision). */
  validationTime: number;
  /** Hook point this validation was for (echoed back for audit logging). */
  hookPoint: string;
  /** Resolved schema version actually used (may differ from requested if fallback occurred). */
  schemaVersion: string;
  /** Direction: 'input' or 'output'. */
  direction: 'input' | 'output';
}
```

### `ValidationPipelineOptions`

```typescript
export interface ValidationPipelineOptions {
  /** Absolute path to the schemas root. Default: `${pluginRoot}/schemas/hooks`. */
  schemasRoot: string;
  /** Optional logger; defaults to console. */
  logger?: { warn: (msg: string) => void; error: (msg: string) => void; info: (msg: string) => void };
  /** Stats rolling-window size (covered in SPEC-019-2-03). Default: 1000. Reserved here. */
  statsWindowSize?: number;
}
```

### AJV Construction

Per TDD-019 §9, the AJV constructor options are non-negotiable:

```typescript
import Ajv from 'ajv/dist/2020.js'; // draft 2020-12 dialect
import addFormats from 'ajv-formats';

this.ajv = new Ajv({
  strict: true,
  allErrors: false,            // fail fast; first error wins
  coerceTypes: true,           // coerce '5' → 5 where schema says number
  removeAdditional: 'all',     // strip extras unless x-allow-extensions whitelists
  useDefaults: true,           // populate missing fields from schema defaults
  validateFormats: true,       // honor format keyword
});
addFormats(this.ajv);          // ipv4, email, uuid, etc. Custom formats land in SPEC-019-2-02.
```

### `loadSchemas()` Method

Async. Walks `${schemasRoot}/<hook-point>/<version>/{input,output}.json` in O(n) directory entries. For each schema file found:
1. Read + JSON.parse.
2. Confirm `$schema === 'https://json-schema.org/draft/2020-12/schema'`.
3. Confirm `$id` ends with the file's relative path (sanity check).
4. Call `this.ajv.compile(schema)` and store the compiled validator in `this.cache` keyed by `${hookPoint}:${version}:${direction}`.

If any schema file is malformed JSON or fails AJV compilation, throw a `SchemaLoadError` whose message names the offending file path. Do NOT swallow errors — the daemon must fail loud at startup so the operator sees a clear pointer to the broken schema.

After the walk, log `info`: `Loaded N validators across M hook points`.

### `validateHookInput` and `validateHookOutput`

Both methods share the same internals via a private `validate(direction, point, version, payload)`. Public surface:

```typescript
async validateHookInput<T = unknown>(
  point: string,
  version: string,
  input: unknown
): Promise<ValidationResult<T>>;

async validateHookOutput<T = unknown>(
  point: string,
  version: string,
  output: unknown
): Promise<ValidationResult<T>>;
```

Internal flow:
1. Start a `performance.now()` timer.
2. Resolve cache key `${point}:${version}:${direction}`.
3. If exact key hit → use that validator.
4. If exact key miss → invoke `resolveFallback(point, version, direction)` (below). Append a warning to `warnings[]`.
5. If no validator at any version → throw `SchemaNotFoundError` with message `No validator registered for hook point '${point}' direction '${direction}'. Searched: ${schemasRoot}/${point}/`.
6. Run validator on a deep copy of the payload (so the caller's object is never mutated). The deep copy is what gets sanitized and returned as `sanitizedOutput`.
7. Stop timer. Build `ValidationResult` with `validationTime` rounded to 0.001 ms.
8. Return the result.

Errors collected from `validator.errors` are mapped to the `errors[]` shape (raw AJV error redaction is SPEC-019-2-02's job; this spec passes them through verbatim).

### Schema-Version Negotiation: `resolveFallback`

Private helper. Algorithm:
1. List all versions present in cache for `(point, direction)`.
2. If list is empty → return `null` (caller throws `SchemaNotFoundError`).
3. Sort versions descending using semver (highest first).
4. Pick the highest version that is `<= requested` per semver semantics. If none qualify (requested is older than every available version), pick the lowest available.
5. Log `warn`: `Schema version '${requested}' not found for hook point '${point}' direction '${direction}'. Falling back to '${chosen}'.`
6. Return the chosen validator.

The semver comparator is the npm `semver` package (already a transitive dep of AJV). If not present at runtime, fail loud at construction time with a clear error.

### Cache Layout

Internal cache is `Map<string, ValidateFunction>` where the key is `${point}:${version}:${direction}` (e.g., `intake-pre-validate:1.0.0:input`). Cache is populated entirely by `loadSchemas()` at startup; `validate*` methods are read-only.

A secondary index `Map<string, string[]>` maps `${point}:${direction}` → sorted version list, used by `resolveFallback` to avoid re-scanning the primary map on every fallback.

## Acceptance Criteria

- [ ] `ValidationPipeline` class exports from `src/hooks/validation-pipeline.ts` and TypeScript compiles with no `any` warnings under the project's strict tsconfig.
- [ ] AJV constructor options exactly match: `strict: true`, `allErrors: false`, `coerceTypes: true`, `removeAdditional: 'all'`, `useDefaults: true`, `validateFormats: true` (verified by snapshot of the constructor call).
- [ ] AJV is imported from `'ajv/dist/2020.js'` (draft 2020-12 dialect), not the default 7-draft import.
- [ ] `loadSchemas()` is `async`, accepts no arguments, and walks `schemasRoot` discovering every `<point>/<version>/{input,output}.json`.
- [ ] Malformed schema JSON throws `SchemaLoadError` whose `.message` contains the offending absolute file path.
- [ ] Schema missing `$schema: 'https://json-schema.org/draft/2020-12/schema'` throws `SchemaLoadError` naming the file.
- [ ] After `loadSchemas()`, calling `validateHookInput('foo', '1.0.0', {})` for an unregistered hook point rejects with `SchemaNotFoundError` whose message contains the search path.
- [ ] Exact-version match: requesting `'1.0.0'` when the cache has `'1.0.0'` uses that validator and `result.warnings` is `[]`, `result.schemaVersion === '1.0.0'`.
- [ ] Fallback: requesting `'1.0.5'` when only `'1.0.0'` exists picks `'1.0.0'`, appends a warning containing `'Falling back to '1.0.0''`, and `result.schemaVersion === '1.0.0'`.
- [ ] Reverse fallback: requesting `'0.9.0'` when only `'1.0.0'` exists still picks `'1.0.0'` (lowest available) with a warning.
- [ ] `validate*` methods do NOT mutate the caller's payload (assert via `Object.is(input, sanitizedOutput) === false` and original input has unchanged keys after a removeAdditional strip).
- [ ] `ValidationResult.validationTime` is a number `>= 0`, populated for both success and failure paths.
- [ ] Two pipeline instances constructed in the same process do not share state (independent `ajv` and `cache` members).
- [ ] Pre-compilation cost: `loadSchemas()` for 20 schemas (10 points × input+output) completes in < 100 ms on a CI runner (smoke benchmark in unit tests, not the formal perf test).

## Dependencies

- **Blocked by**: PLAN-019-1 (provides `HookPoint` enum and the canonical `schemas/hooks/` directory location convention via `pluginRoot`). The skeleton can compile against a stub `HookPoint` type if PLAN-019-1 has not landed yet, but integration is gated.
- **Consumed by**: SPEC-019-2-02 (custom formats/keywords plug into this same AJV instance), SPEC-019-2-03 (stats collector tracks each `validate*` call), SPEC-019-2-04 (HookExecutor invokes these methods around every hook), SPEC-019-2-05 (test suite).
- New runtime deps: `ajv@^8.17.0`, `ajv-formats@^2.1.1`. No new dev deps.

## Notes

- The `useDefaults: true` option mutates the validated object in place to fill defaults. We deep-copy before validation so the caller's object is never altered. The copy used for validation IS the one that becomes `sanitizedOutput`, so defaults flow through to consumers as intended.
- `removeAdditional: 'all'` strips every property not declared in `properties` or `patternProperties`. The escape hatch — `x-allow-extensions` — is implemented in SPEC-019-2-02 as a custom keyword that injects matching properties into `properties` at compile time.
- We deliberately do NOT cache validators across pipeline instances or processes. Pre-compilation is fast enough (< 100 ms for the full set) that startup cost is amortized, and per-instance ownership keeps tests clean.
- `SchemaLoadError` and `SchemaNotFoundError` are exported from this module so callers can catch them by class. Both extend `Error`.
- Performance budget for this spec: skeleton + load = < 100 ms startup; per-call overhead (excluding validator runtime) < 0.1 ms. The formal < 5 ms p95 budget is enforced in SPEC-019-2-04's benchmark.

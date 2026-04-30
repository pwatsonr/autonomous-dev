# SPEC-019-2-02: Custom Formats (semver / iso-duration / path-glob) & Custom Keywords (x-redact-on-failure / x-allow-extensions)

## Metadata
- **Parent Plan**: PLAN-019-2 (Hook Output Validation Pipeline: AJV + Custom Formats)
- **Tasks Covered**: Task 3 (custom formats), Task 4 (custom keywords)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-2-02-custom-formats-and-keywords.md`

## Description
Extend the `ValidationPipeline` (SPEC-019-2-01) with the autonomous-dev domain vocabulary: three custom formats (`semver`, `iso-duration`, `path-glob`) that hook authors use as validation primitives, and two custom keywords (`x-redact-on-failure`, `x-allow-extensions`) that govern security-sensitive behaviors at validation time.

The formats are simple type-style validators — given a string, return whether it matches the format's grammar. The keywords are richer: `x-redact-on-failure` rewrites validation errors to scrub sensitive field values before they hit logs, and `x-allow-extensions` selectively whitelists named additional properties despite the pipeline's `removeAdditional: 'all'` global policy.

Both subsystems must register idempotently — calling the registration helpers twice on the same AJV instance must not throw and must not duplicate. They are wired into `ValidationPipeline`'s constructor so every instance gets them automatically; explicit registration helpers are also exported so tests can isolate behaviors.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/hooks/formats.ts` | Create | `registerCustomFormats(ajv)` + per-format validators |
| `plugins/autonomous-dev/src/hooks/keywords.ts` | Create | `registerCustomKeywords(ajv)` + redaction/extensions logic |
| `plugins/autonomous-dev/src/hooks/validation-pipeline.ts` | Modify | Constructor invokes both registration helpers; error path runs through redactor before returning |
| `plugins/autonomous-dev/package.json` | Modify | Add `picomatch@^4.0.2` and `semver@^7.6.0` to `dependencies` |

## Implementation Details

### Dependencies

Add to `package.json`:
```json
{
  "picomatch": "^4.0.2",
  "semver": "^7.6.0"
}
```

`semver` is for the `semver` format and version negotiation. `picomatch` is for `path-glob` validation — we use `picomatch.parse()` to ensure any pattern accepted here also works at runtime (per PLAN-019-2 risk register, this prevents validator/runtime mismatch).

### `formats.ts` — Three Custom Formats

```typescript
import type Ajv from 'ajv';
import semver from 'semver';
import picomatch from 'picomatch';

export function registerCustomFormats(ajv: Ajv): void {
  // semver: any valid semver string per https://semver.org
  if (!ajv.formats.semver) {
    ajv.addFormat('semver', {
      type: 'string',
      validate: (s: string) => semver.valid(s) !== null,
    });
  }

  // iso-duration: ISO 8601 duration like 'PT1H30M', 'P1Y2M10D', 'P1W'
  if (!ajv.formats['iso-duration']) {
    const ISO_DURATION = /^P(?!$)(\d+(?:\.\d+)?Y)?(\d+(?:\.\d+)?M)?(\d+(?:\.\d+)?W)?(\d+(?:\.\d+)?D)?(T(?=\d)(\d+(?:\.\d+)?H)?(\d+(?:\.\d+)?M)?(\d+(?:\.\d+)?S)?)?$/;
    ajv.addFormat('iso-duration', {
      type: 'string',
      validate: (s: string) => ISO_DURATION.test(s),
    });
  }

  // path-glob: any pattern picomatch.parse() accepts without throwing
  if (!ajv.formats['path-glob']) {
    ajv.addFormat('path-glob', {
      type: 'string',
      validate: (s: string) => {
        try {
          picomatch.parse([s]);
          return true;
        } catch {
          return false;
        }
      },
    });
  }
}
```

### `keywords.ts` — Two Custom Keywords

#### `x-allow-extensions`

A keyword whose value is a `string[]` listing property names allowed despite `removeAdditional: 'all'`. Implementation pattern (compile-time): rewrite the schema's `additionalProperties` to a `patternProperties` clause matching the union of declared properties and the allow-list.

```typescript
ajv.addKeyword({
  keyword: 'x-allow-extensions',
  type: 'object',
  schemaType: 'array',
  modifying: true,
  compile: (allowed: string[], parentSchema: Record<string, unknown>) => {
    // At schema-compile time, splice each allowed name into `properties` as a
    // permissive entry so removeAdditional won't strip it. We use type:true
    // (any type) because the consumer's schema didn't declare these fields.
    const props = (parentSchema.properties as Record<string, unknown> | undefined) ?? {};
    for (const name of allowed) {
      if (!(name in props)) props[name] = {};
    }
    parentSchema.properties = props;
    // Returning a no-op validate keeps AJV happy; the actual effect is the schema mutation above.
    return () => true;
  },
});
```

The keyword is documented as compile-time only — it influences what `removeAdditional` strips, not runtime validation.

#### `x-redact-on-failure`

A keyword whose value is a `string[]` of JSON-pointer-style paths (e.g., `'/secret'`, `'/credentials/apiKey'`, or glob `'/secrets/**'`). When the validator emits errors, any error whose `instancePath` matches one of these paths has its `params.allowedValue` and `params.passingSchemas` redacted, and any value substring in the message matching the redacted field's value is replaced with `'[REDACTED]'`.

Implementation: the keyword itself is a no-op validator at runtime (always returns `true`). Its presence is detected by `ValidationPipeline.validate()` via reflection on the compiled schema (AJV exposes `validator.schema`). After validation, before returning errors, the pipeline runs them through `redactErrors(errors, payload, redactPaths)` defined in `keywords.ts`.

```typescript
ajv.addKeyword({
  keyword: 'x-redact-on-failure',
  schemaType: 'array',
  validate: () => true, // no-op at validate time; effect applied post-hoc by pipeline
});

export function redactErrors(
  errors: ValidationError[],
  payload: unknown,
  redactPaths: string[],
): ValidationError[] {
  const valuesToScrub = collectValuesAtPaths(payload, redactPaths);
  return errors.map((err) => {
    const matchesPath = redactPaths.some((p) => pathMatches(p, err.instancePath));
    if (!matchesPath) return err;
    return {
      ...err,
      message: scrubString(err.message, valuesToScrub),
      params: scrubObject(err.params ?? {}, valuesToScrub),
    };
  });
}
```

Helpers:
- `collectValuesAtPaths(payload, paths)` walks `payload` per JSON-pointer paths (with `**` glob support) and returns the string-coerced values found.
- `pathMatches(pattern, instancePath)` does glob-style matching where `**` matches any segments.
- `scrubString(s, values)` replaces every occurrence of every collected value in `s` with `'[REDACTED]'`.
- `scrubObject(o, values)` recursively scrubs string-typed values inside the object.

#### Default Auto-Redaction

Per PLAN-019-2 risk register, fields whose name (case-insensitive) matches `/(secret|token|password|key|credential)/` are auto-redacted even without an explicit `x-redact-on-failure` declaration. Implemented as a default path list `['/**/(secret|token|password|key|credential).*']` ORed with whatever the schema declares. Documented in the keyword's exported JSDoc.

### Pipeline Integration (modify `validation-pipeline.ts`)

In the constructor, after AJV construction:
```typescript
import { registerCustomFormats } from './formats.js';
import { registerCustomKeywords } from './keywords.js';

registerCustomFormats(this.ajv);
registerCustomKeywords(this.ajv);
```

In `validate()`, after collecting raw errors but before building `ValidationResult`:
```typescript
import { redactErrors, getRedactPathsFromSchema, AUTO_REDACT_PATTERNS } from './keywords.js';

const declaredPaths = getRedactPathsFromSchema(validator.schema);
const allRedactPaths = [...declaredPaths, ...AUTO_REDACT_PATTERNS];
const redactedErrors = redactErrors(rawErrors, payloadCopy, allRedactPaths);
```

`getRedactPathsFromSchema` walks the schema looking for any `x-redact-on-failure` arrays and returns the union of all paths found.

## Acceptance Criteria

### Custom Formats

- [ ] `'1.2.3'` validates as `semver`. `'1.2.3-beta.1+build.5'` validates. `'not-a-version'` fails. `'1.2'` fails. `''` fails.
- [ ] `'PT1H30M'` validates as `iso-duration`. `'P1Y'`, `'P1W'`, `'P1Y2M10DT2H30M5S'` all validate. `'1h30m'`, `'PT'`, `'P'`, `''` all fail.
- [ ] `'src/**/*.ts'` validates as `path-glob`. `'**/*'`, `'foo/{a,b}.txt'`, `'!exclude/**'` all validate. `'src/[unclosed'` fails (picomatch rejects). `'src/{unclosed'` fails.
- [ ] `registerCustomFormats(ajv)` is idempotent: calling it twice on the same AJV instance does not throw and does not duplicate (verified by inspecting `ajv.formats` count before and after the second call).
- [ ] All three formats are reachable when used inside a schema as `{ "type": "string", "format": "semver" }` (and similar) via the pipeline's normal `validate*` flow.

### Custom Keywords — `x-allow-extensions`

- [ ] Schema `{ "type": "object", "properties": { "name": { "type": "string" } }, "x-allow-extensions": ["customField"] }` allows `{ "name": "x", "customField": 42 }` to pass with `customField` preserved in `sanitizedOutput`.
- [ ] Same schema STRIPS `{ "name": "x", "customField": 42, "junk": true }` to `{ "name": "x", "customField": 42 }` — `junk` is removed but `customField` survives.
- [ ] Empty array `"x-allow-extensions": []` behaves identically to no keyword present (all extras stripped).

### Custom Keywords — `x-redact-on-failure`

- [ ] Schema `{ "type": "object", "properties": { "secret": { "type": "string", "minLength": 100 } }, "x-redact-on-failure": ["/secret"] }` validating `{ "secret": "abc123" }` produces errors whose JSON-stringified form does NOT contain the substring `"abc123"` (the value is replaced by `'[REDACTED]'`).
- [ ] Auto-redaction (no explicit declaration): a field named `apiKey` containing a value that triggers a validation error has its value replaced with `'[REDACTED]'` in the error output.
- [ ] Glob path `"x-redact-on-failure": ["/credentials/**"]` redacts values found under `credentials.password`, `credentials.token`, etc.
- [ ] Field values that would be safely emitted (e.g., a benign string inside a different validation error) are NOT redacted unless their path matches.

### General

- [ ] `registerCustomKeywords(ajv)` is idempotent — calling twice does not throw.
- [ ] `ValidationPipeline` constructor wires both registration helpers; an instance built in tests has all three formats and both keywords available without further setup.
- [ ] Errors after redaction retain the original `instancePath` and `message`-template fields (only values are scrubbed); structured downstream consumers can still tell what failed.
- [ ] Coverage on `formats.ts` ≥ 95% lines/branches; coverage on `keywords.ts` ≥ 95% lines/branches.

## Dependencies

- **Blocked by**: SPEC-019-2-01 (the AJV instance to register against lives there).
- **Consumed by**: SPEC-019-2-04 (HookExecutor relies on the redaction layer to keep secrets out of audit logs), SPEC-019-2-05 (test files exercise every format and keyword combination).
- New runtime deps: `picomatch@^4.0.2`, `semver@^7.6.0`. No new dev deps.

## Notes

- The `iso-duration` regex is intentionally strict — it rejects `'PT'` (no time components) and the empty `'P'` because both are technically malformed per ISO 8601, even though a few permissive parsers accept them.
- `path-glob` validation explicitly delegates to `picomatch.parse()` rather than re-implementing glob grammar. This ties the format's contract to the runtime library: if picomatch is upgraded and starts accepting/rejecting different patterns, our format moves with it. This is intentional — a pattern that fails at runtime should also fail at validation.
- `x-allow-extensions` mutates the parent schema at compile time. AJV considers this safe within `compile` callbacks; we rely on that contract. If AJV ever forbids schema mutation in `compile`, we will need to switch to a wrapper schema generation pass before `ajv.compile` is called.
- `x-redact-on-failure` redaction operates on the value, not the field name. If the same secret string appears elsewhere in the payload (or even in the schema's example values), it will also be scrubbed from error output. This is intentional — defense in depth against accidental secret echoing.
- The auto-redaction pattern list (`secret|token|password|key|credential`) is the floor, not the ceiling. Schemas SHOULD still declare `x-redact-on-failure` for any field they consider sensitive even if its name doesn't match the auto-pattern (e.g., `connectionString`, `bearerToken`). Documented in the keyword JSDoc.

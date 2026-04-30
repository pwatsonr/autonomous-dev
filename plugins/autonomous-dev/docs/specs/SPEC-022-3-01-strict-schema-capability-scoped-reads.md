# SPEC-022-3-01: Strict-Schema Consumer Boundary & Capability-Scoped Artifact Reads

## Metadata
- **Parent Plan**: PLAN-022-3
- **Tasks Covered**: Task 1 (strict-schema consumer boundary), Task 2 (capability-scoped artifact reads)
- **Estimated effort**: 5.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-022-3-01-strict-schema-capability-scoped-reads.md`

## Description
Lock down the inbound side of the consumer boundary in the chain artifact registry. Every artifact a downstream plugin reads must be re-validated against the **consumer's** declared `consumes.schema_version` (not the producer's), and the consumer must have declared the artifact's type in its `consumes[]` list before the registry will surface the artifact. This eliminates two classes of cross-plugin attack: (1) producers leaking extra fields to consumers that didn't ask for them, and (2) consumers reaching outside their declared capabilities to inspect arbitrary artifact types.

This spec extends `ArtifactRegistry.read()` (created in PLAN-022-1) with two enforcement layers: AJV strict-schema validation using `removeAdditional: 'all'` (the same pattern PLAN-019-2 established for hook payloads), and a `consumerPlugin` parameter that drives capability-scoped access checks. Tampering, signing, sanitization, and audit emission are out of scope here — they ship in SPEC-022-3-02 and SPEC-022-3-03.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/chains/artifact-registry.ts` | Modify | Add `consumerPlugin` arg to `read()`; add strict-schema validation; add capability scope check |
| `plugins/autonomous-dev/src/chains/types.ts` | Modify | Add `CapabilityError`, `SchemaValidationError` exports; extend `ConsumerPluginRef` type |
| `plugins/autonomous-dev/src/chains/schema-cache.ts` | Create | Memoized AJV compile cache keyed by `(artifact_type, schema_version)` |
| `plugins/autonomous-dev/tests/chains/test-strict-schema.test.ts` | Create | Unit tests for extra-field stripping and version narrowing |
| `plugins/autonomous-dev/tests/chains/test-capability-scope.test.ts` | Create | Unit tests for the capability truth table |

## Implementation Details

### `ArtifactRegistry.read()` Signature

```typescript
read(
  artifactType: string,
  artifactId: string,
  consumerPlugin: ConsumerPluginRef,
): Promise<ValidatedArtifact>
```

Where `ConsumerPluginRef` is:

```typescript
export interface ConsumerPluginRef {
  pluginId: string;
  consumes: Array<{
    artifact_type: string;
    schema_version: string;        // semver (e.g. "1.0", "1.1")
    optional?: boolean;
  }>;
}
```

### Step Order in `read()`

1. **Capability scope check** (FIRST, before any I/O if possible):
   - Find the entry in `consumerPlugin.consumes[]` where `artifact_type === artifactType`.
   - If absent, throw `CapabilityError` with message: `Plugin '<id>' attempted to read artifact_type '<type>' which is not in its declared consumes[].`
   - Capture the `schema_version` from that entry — call it `consumerSchemaVersion`.

2. **Load raw artifact** from disk (existing behavior from PLAN-022-1).

3. **Strict-schema validation against consumer's declared version**:
   - Look up the schema for `(artifactType, consumerSchemaVersion)` from the schema cache.
   - If schema missing, throw `SchemaNotFoundError` (artifact type or version unknown).
   - Compile (or fetch cached) AJV validator with options:
     ```typescript
     {
       removeAdditional: 'all',
       useDefaults: true,
       coerceTypes: false,
       allErrors: false,
       strict: false,  // schemas may use non-standard keywords like x-allow-extensions
     }
     ```
   - Run `validate(payload)`. If false, throw `SchemaValidationError` with AJV's `errors` attached.
   - The validator MUTATES the payload to strip extras. The mutated payload is what the consumer sees.

4. Return `ValidatedArtifact`:
   ```typescript
   {
     artifact_type: string;
     schema_version: string;       // the CONSUMER's declared version
     payload: Record<string, unknown>;  // post-strip
     producer_plugin_id: string;
     produced_at: string;
   }
   ```

### Schema Cache (`schema-cache.ts`)

```typescript
import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';

const ajv = new Ajv({
  removeAdditional: 'all',
  useDefaults: true,
  coerceTypes: false,
  allErrors: false,
  strict: false,
});

const cache = new Map<string, ValidateFunction>();

export function getValidator(
  artifactType: string,
  schemaVersion: string,
  schemaResolver: (type: string, version: string) => object | null,
): ValidateFunction {
  const key = `${artifactType}@${schemaVersion}`;
  let v = cache.get(key);
  if (v) return v;
  const schema = schemaResolver(artifactType, schemaVersion);
  if (!schema) throw new SchemaNotFoundError(artifactType, schemaVersion);
  v = ajv.compile(schema);
  cache.set(key, v);
  return v;
}

export function clearSchemaCache(): void {
  cache.clear();
}
```

The `schemaResolver` parameter is injected by the registry (defaults to a function that loads from `plugins/autonomous-dev/schemas/artifacts/<type>/<version>.json`); tests can supply an in-memory resolver.

### Error Classes (in `types.ts`)

```typescript
export class CapabilityError extends Error {
  readonly code = 'CAPABILITY_DENIED';
  constructor(public pluginId: string, public artifactType: string) {
    super(`Plugin '${pluginId}' attempted to read artifact_type '${artifactType}' which is not in its declared consumes[].`);
  }
}

export class SchemaValidationError extends Error {
  readonly code = 'SCHEMA_VALIDATION_FAILED';
  constructor(public artifactType: string, public schemaVersion: string, public errors: unknown[]) {
    super(`Artifact ${artifactType}@${schemaVersion} failed strict-schema validation`);
  }
}

export class SchemaNotFoundError extends Error {
  readonly code = 'SCHEMA_NOT_FOUND';
  constructor(public artifactType: string, public schemaVersion: string) {
    super(`No schema registered for ${artifactType}@${schemaVersion}`);
  }
}
```

### Test Fixtures

Tests under `tests/chains/fixtures/schemas/` should provide:
- `security-findings/1.0.json` — minimal: `{findings: Array<{file, line, rule_id}>}`.
- `security-findings/1.1.json` — extends 1.0 with optional `severity` field.
- `code-patches/1.0.json` — `{patches: Array<{file, hunks}>}`.

## Acceptance Criteria

- [ ] `ArtifactRegistry.read()` accepts a `consumerPlugin: ConsumerPluginRef` argument.
- [ ] Producer emits an artifact with extra field `extra_data: 'leak'`; consumer's payload after `read()` does NOT contain `extra_data`. (extra-field stripping)
- [ ] Producer writes a `1.1` schema artifact (with `severity` field); consumer declares `consumes.schema_version: '1.0'`; `read()` returns payload WITHOUT `severity`. (version narrowing)
- [ ] Consumer with `consumes: [{artifact_type: 'security-findings', schema_version: '1.0'}]` calls `read('security-findings', ...)` → succeeds.
- [ ] Same consumer calls `read('code-patches', ...)` → throws `CapabilityError`; error has `code === 'CAPABILITY_DENIED'`; message names both plugin and artifact_type.
- [ ] Capability check runs BEFORE schema load (verified by mocking the loader and asserting it is not called when capability is denied).
- [ ] `read()` of an unknown `(artifactType, schemaVersion)` pair throws `SchemaNotFoundError`.
- [ ] `read()` of an artifact whose payload violates the consumer's schema throws `SchemaValidationError` with `errors` populated by AJV.
- [ ] Schema cache: calling `read()` 100 times for the same `(artifactType, schemaVersion)` calls `ajv.compile` exactly once (verified by spy).
- [ ] Mutated payload is a fresh object — the on-disk artifact is not modified (verified by re-reading raw file).
- [ ] Returned `ValidatedArtifact.schema_version` reflects the consumer's declared version, not the producer's.
- [ ] Coverage on `artifact-registry.ts` (lines added by this spec) and `schema-cache.ts` ≥ 95%.

## Dependencies

- **Blocked by**: PLAN-022-1 (provides base `ArtifactRegistry`, manifest plumbing, and the `consumes[]` field on plugin manifests).
- **Reuses**: PLAN-019-2 AJV pattern (`removeAdditional: 'all'`, schema-cache approach).
- **Library**: `ajv` (already a dependency from PLAN-019-2; no new packages).
- **Schemas**: artifact-type schemas live under `plugins/autonomous-dev/schemas/artifacts/<type>/<version>.json` (directory created by PLAN-022-1).

## Notes

- `removeAdditional: 'all'` is intentionally aggressive. If a future consumer needs to opt into extension fields, it should use the `x-allow-extensions` schema keyword from PLAN-019-2 to mark an object as open. This is documented in the artifact schema authoring guide (separate doc, not this spec).
- The capability check is **type-scoped**, not **artifact-id-scoped** — a consumer that declares `consumes: [{artifact_type: 'security-findings'}]` can read ANY security-findings artifact in the request's registry, not just specific ones. Per-artifact ACLs are out of scope (NG-2204).
- `useDefaults: true` lets schemas backfill missing optional fields; this is safe because the schema is the contract.
- Error class instances are exported so tests can do `expect(...).toThrow(CapabilityError)` instead of string matching.
- HMAC verification, Ed25519 verification, sanitization, and audit emission are added in subsequent specs and slot in AFTER step 2 (load) and BEFORE step 3 (schema validation) for cryptographic checks, and AFTER step 3 for sanitization. This spec sets up the call site so those layers compose cleanly.
- The `clearSchemaCache()` export exists solely for test isolation; production code never calls it.

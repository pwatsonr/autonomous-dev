# SPEC-022-1-02: Artifact Schemas (security-findings, code-patches) and ArtifactRegistry

## Metadata
- **Parent Plan**: PLAN-022-1
- **Tasks Covered**: Task 3 (author the two initial artifact schemas), Task 4 (`ArtifactRegistry` class with load + validate + persist)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-022-1-02-artifact-schemas-and-registry.md`

## Description
Author the two initial artifact JSON Schemas (`security-findings/1.0.json` and `code-patches/1.0.json`) per TDD-022 §6, and implement the `ArtifactRegistry` class that loads every `schemas/artifacts/<type>/<version>.json` at boot, exposes `validate(type, version, payload)`, and persists artifact payloads to disk via the established two-phase commit pattern (temp file → atomic rename, per PLAN-002-1). This spec is the artifact data layer: it owns schema-on-disk shapes and the per-request artifact filesystem, but it does NOT touch the dependency graph (SPEC-022-1-03) or the chain executor (SPEC-022-1-04).

The registry is intentionally schema-agnostic at the code level: adding a new artifact type later means dropping a `schemas/artifacts/<new-type>/<version>.json` file on disk; no source change is required. AJV is the validator (already pulled in by PLAN-019-2) so per-payload validation is fast (<1ms p95 for typical security-findings payloads).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/schemas/artifacts/security-findings/1.0.json` | Create | TDD-022 §6 schema for security findings |
| `plugins/autonomous-dev/schemas/artifacts/code-patches/1.0.json` | Create | Schema for code-patch artifacts |
| `plugins/autonomous-dev/src/chains/types.ts` | Create | Shared chain-layer types: `ArtifactRef`, `ValidationResult`, `ArtifactRecord` |
| `plugins/autonomous-dev/src/chains/artifact-registry.ts` | Create | `ArtifactRegistry` class |
| `plugins/autonomous-dev/src/chains/index.ts` | Create | Barrel re-export |
| `plugins/autonomous-dev/tests/fixtures/artifacts/security-findings.example.json` | Create | TDD §6 canonical example |
| `plugins/autonomous-dev/tests/fixtures/artifacts/code-patches.example.json` | Create | Canonical example |

## Implementation Details

### `schemas/artifacts/security-findings/1.0.json`

Draft 2020-12. `additionalProperties: false` everywhere.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://autonomous-dev.local/schemas/artifacts/security-findings/1.0.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["scan_id", "produced_by", "produced_at", "summary", "findings"],
  "properties": {
    "scan_id":     { "type": "string", "pattern": "^[a-zA-Z0-9_-]+$" },
    "produced_by": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
    "produced_at": { "type": "string", "format": "date-time" },
    "summary":     { "$ref": "#/$defs/FindingsSummary" },
    "findings":    { "type": "array", "items": { "$ref": "#/$defs/SecurityFinding" } }
  },
  "$defs": {
    "FindingsSummary": {
      "type": "object",
      "additionalProperties": false,
      "required": ["total", "by_severity"],
      "properties": {
        "total":       { "type": "integer", "minimum": 0 },
        "by_severity": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "critical": { "type": "integer", "minimum": 0, "default": 0 },
            "high":     { "type": "integer", "minimum": 0, "default": 0 },
            "medium":   { "type": "integer", "minimum": 0, "default": 0 },
            "low":      { "type": "integer", "minimum": 0, "default": 0 },
            "info":     { "type": "integer", "minimum": 0, "default": 0 }
          }
        }
      }
    },
    "SecurityFinding": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "severity", "title", "file", "line"],
      "properties": {
        "id":         { "type": "string", "minLength": 1 },
        "severity":   { "enum": ["critical", "high", "medium", "low", "info"] },
        "title":      { "type": "string", "minLength": 1 },
        "description":{ "type": "string" },
        "file":       { "type": "string", "minLength": 1 },
        "line":       { "type": "integer", "minimum": 1 },
        "rule_id":    { "type": "string" },
        "remediation":{ "type": "string" }
      }
    }
  }
}
```

### `schemas/artifacts/code-patches/1.0.json`

Draft 2020-12. Mirrors the structure of security-findings but for patches:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://autonomous-dev.local/schemas/artifacts/code-patches/1.0.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["patch_id", "produced_by", "produced_at", "patches"],
  "properties": {
    "patch_id":          { "type": "string", "pattern": "^[a-zA-Z0-9_-]+$" },
    "produced_by":       { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
    "produced_at":       { "type": "string", "format": "date-time" },
    "source_artifact":   { "$ref": "#/$defs/ArtifactRef" },
    "patches":           { "type": "array", "items": { "$ref": "#/$defs/CodePatch" } }
  },
  "$defs": {
    "ArtifactRef": {
      "type": "object", "additionalProperties": false,
      "required": ["artifact_type", "scan_id"],
      "properties": {
        "artifact_type": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
        "scan_id":       { "type": "string", "pattern": "^[a-zA-Z0-9_-]+$" }
      }
    },
    "CodePatch": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "file", "before", "after", "confidence", "requires_approval"],
      "properties": {
        "id":               { "type": "string", "minLength": 1 },
        "file":             { "type": "string", "minLength": 1 },
        "before":           { "type": "string" },
        "after":            { "type": "string" },
        "confidence":       { "type": "number", "minimum": 0, "maximum": 1 },
        "requires_approval":{ "type": "boolean" },
        "rationale":        { "type": "string" },
        "fixes_finding_id": { "type": "string" }
      }
    }
  }
}
```

### `src/chains/types.ts`

```ts
export interface ArtifactRef {
  artifact_type: string;
  scan_id: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  /** JSON Pointer into the payload (e.g. `/findings/0/severity`). */
  pointer: string;
  message: string;
  /** The AJV keyword that failed (e.g. `enum`, `required`). */
  keyword?: string;
}

export interface ArtifactRecord {
  artifactType: string;
  schemaVersion: string;
  /** Absolute path to the persisted JSON file. */
  filePath: string;
  payload: unknown;
}
```

### `src/chains/artifact-registry.ts`

```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { ValidationResult, ArtifactRecord } from './types';

export class ArtifactRegistry {
  private validators = new Map<string, ValidateFunction>();
  // key: `${artifactType}@${schemaVersion}`

  constructor(private readonly ajv: Ajv2020 = new Ajv2020({ allErrors: true, strict: true })) {
    addFormats(this.ajv);
  }

  /** Walk `<schemaRoot>/<artifact-type>/<MAJOR.MINOR>.json` and pre-compile each schema. */
  async loadSchemas(schemaRoot: string): Promise<{ loaded: string[]; errors: string[] }> { /* ... */ }

  validate(artifactType: string, schemaVersion: string, payload: unknown): ValidationResult { /* ... */ }

  /** Atomic write: temp file in same dir, then rename. Returns the absolute file path. */
  async persist(requestRoot: string, artifactType: string, scanId: string, payload: unknown): Promise<ArtifactRecord> { /* ... */ }

  /** Reads back a previously persisted artifact for a downstream consumer. */
  async load(requestRoot: string, artifactType: string, scanId: string): Promise<unknown> { /* ... */ }

  knownTypes(): Array<{ artifactType: string; schemaVersion: string }> { /* ... */ }
}
```

Behavior contract:

1. `loadSchemas(schemaRoot)`:
   - `await fs.readdir(schemaRoot, { withFileTypes: true })` → directories are artifact-type names.
   - For each artifact-type dir, walk its files matching `^\d+\.\d+\.json$`. For each, JSON.parse, then `ajv.compile(schema)`. Cache the compiled validator under `${type}@${version}` (version is the file's basename without `.json`).
   - Returns `{ loaded: ['security-findings@1.0', 'code-patches@1.0'], errors: [] }`. Schema files that fail to parse or compile go into `errors[]` with the relative path and message; loading continues for the rest.
   - Idempotent: calling twice with the same root replaces all entries.

2. `validate(artifactType, schemaVersion, payload)`:
   - Look up `${artifactType}@${schemaVersion}` in the cache. If absent → `{ isValid: false, errors: [{ pointer: '', message: 'unknown artifact type or version' }] }`.
   - Run the AJV validator. Map `validator.errors` (if any) into `ValidationError[]`: `pointer = err.instancePath`, `message = err.message`, `keyword = err.keyword`.
   - Returns `{ isValid: validator.errors === null, errors: [...] }`.

3. `persist(requestRoot, artifactType, scanId, payload)`:
   - Compute `targetDir = path.join(requestRoot, '.autonomous-dev', 'artifacts', artifactType)`.
   - `await fs.mkdir(targetDir, { recursive: true })` (mode `0700`).
   - `targetPath = path.join(targetDir, `${scanId}.json`)`.
   - `tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}``.
   - Write `JSON.stringify(payload, null, 2)` to `tempPath` with `fs.writeFile` (UTF-8, mode `0600`).
   - `await fs.rename(tempPath, targetPath)` — atomic on POSIX same-filesystem.
   - On any error after temp write: `await fs.unlink(tempPath).catch(() => {})` so we never leave a stranded `.tmp.*` file.
   - Returns `{ artifactType, schemaVersion: '<looked up from cache or "?">', filePath: targetPath, payload }`. (The `schemaVersion` is informational; persist itself does NOT validate — callers must `validate` first.)

4. `load(requestRoot, artifactType, scanId)`:
   - Reads `path.join(requestRoot, '.autonomous-dev', 'artifacts', artifactType, scanId + '.json')`.
   - `JSON.parse` the file. Throws `Error('artifact not found: ...')` on ENOENT.

5. `knownTypes()`:
   - Returns each cache key parsed back into `{artifactType, schemaVersion}`. Stable lex-sorted by artifactType then version.

Defensive rules:
- `scanId` is enforced kebab-case-and-digits-and-underscore by validation (matches schema pattern); `persist` rejects (throws) any `scanId` containing `/`, `..`, or NUL byte to defend against path traversal.
- `requestRoot` is treated as a trusted absolute path (the daemon controls it). No canonicalization here.
- All filesystem mutations use `fs/promises`; no sync calls.

### Fixture artifacts

`security-findings.example.json` — a valid TDD §6 example: scan_id `req-001-scan-1`, one CRITICAL finding in `src/auth.ts:42`, one MEDIUM in `src/util.ts:7`, summary `{total: 2, by_severity: {critical: 1, medium: 1}}`.

`code-patches.example.json` — patch_id `req-001-fix-1`, source_artifact pointing at the security-findings example, two patches: one against `src/auth.ts` (confidence 0.9, requires_approval false) and one against `src/util.ts` (confidence 0.6, requires_approval true).

## Acceptance Criteria

- [ ] Both schema files parse cleanly (`jq -e .` exit 0) and declare `$schema = draft/2020-12/schema`.
- [ ] Each schema declares a unique `$id`.
- [ ] Both schemas have `additionalProperties: false` at every object level (verified by static check).
- [ ] `security-findings/1.0.json` validates `tests/fixtures/artifacts/security-findings.example.json`.
- [ ] `code-patches/1.0.json` validates `tests/fixtures/artifacts/code-patches.example.json`.
- [ ] `security-findings/1.0.json` REJECTS a payload missing `scan_id` (error at `/required`).
- [ ] `security-findings/1.0.json` REJECTS a finding with `severity: 'urgent'` (enum violation at `/findings/0/severity`).
- [ ] `code-patches/1.0.json` REJECTS a patch with `confidence: 1.5` (max violation).
- [ ] `code-patches/1.0.json` REJECTS a payload with an extra top-level field (`additionalProperties: false`).
- [ ] `ArtifactRegistry.loadSchemas('plugins/autonomous-dev/schemas/artifacts')` returns `loaded.length === 2` and `errors.length === 0`.
- [ ] `loaded` array contains exactly `['code-patches@1.0', 'security-findings@1.0']` (sorted).
- [ ] `validate('security-findings', '1.0', exampleFixture)` returns `{isValid: true, errors: []}`.
- [ ] `validate('security-findings', '1.0', {scan_id: 'x'})` returns `isValid: false` with errors naming the missing `produced_by`, `produced_at`, etc.
- [ ] `validate('unknown-type', '1.0', {})` returns `isValid: false` with one error message containing `unknown artifact type`.
- [ ] `persist(tmpDir, 'security-findings', 'req-001-scan-1', payload)` writes a file at `<tmpDir>/.autonomous-dev/artifacts/security-findings/req-001-scan-1.json` with mode `0600`.
- [ ] After `persist`, no `.tmp.*` file remains in the artifact directory.
- [ ] If the destination disk fills mid-write (simulated by mocking `fs.rename` to throw), the temp file IS unlinked (no stranded .tmp.*).
- [ ] `persist` with `scanId: '../escape'` throws (path-traversal defense); no file is written.
- [ ] `load(tmpDir, 'security-findings', 'req-001-scan-1')` round-trips the persisted payload to a deep-equal object.
- [ ] `load(tmpDir, 'security-findings', 'does-not-exist')` throws an Error whose message contains `artifact not found`.
- [ ] `knownTypes()` returns `[{artifactType: 'code-patches', schemaVersion: '1.0'}, {artifactType: 'security-findings', schemaVersion: '1.0'}]`.
- [ ] Calling `loadSchemas` twice with the same root replaces the cache (no duplicate entries; new content wins).
- [ ] AJV `strict: true` is enabled — schemas with unknown keywords would fail to compile (verified by injecting one and asserting it lands in `errors`).

## Dependencies

- AJV 2020 + ajv-formats — already in repo per PLAN-019-2 (PLAN-019-2 must merge before this spec is implemented; if reordering is needed, this spec adds AJV to `package.json`).
- Node ≥ 18 (`fs/promises`, atomic rename).
- TDD-022 §6 (artifact schema spec) — read-only reference.
- PLAN-002-1 (two-phase commit pattern) — existing convention being followed.
- No dependency on SPEC-022-1-01 at code level (artifact registry is independent of manifest validation), but they ship together for plan coherence.

## Notes

- The `validate` method does NOT auto-load schemas; `loadSchemas` must be called once at daemon boot. This separation lets tests preload exactly the schemas they need.
- Persist uses `${process.pid}.${Date.now()}` in the temp filename to make concurrent persists from different processes safe (no collision); within a single process Node's single-threaded JS plus the `await` boundary makes additional locking unnecessary.
- Atomic rename is POSIX same-filesystem only. The artifact dir lives under the request dir which lives under the daemon's working area, all on one volume in the supported deployment; cross-volume is out of scope and would require a copy-and-delete fallback (not implemented here).
- The `$id` URLs use the `autonomous-dev.local` placeholder host; they are identifiers, not network resources. AJV does not fetch them.
- `code-patches`'s `confidence` is a number 0..1 (continuous); patch consumers (PLAN-022-2's standards-to-fix flow) gate on `requires_approval` rather than confidence directly. The two fields encode different signals.
- The schema-on-disk pattern mirrors `schemas/hook-manifest-v1.json` from SPEC-019-1-01: both ship as static assets so external tooling (IDE plugins, CI validators) can reference them directly.
- File mode `0600` for persisted artifacts matches the daemon socket convention from SPEC-019-1-04: artifacts are local-only data, not world-readable.

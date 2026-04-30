# SPEC-022-1-01: Plugin Manifest v2 (produces/consumes) and Orphan Consumer Validation

## Metadata
- **Parent Plan**: PLAN-022-1
- **Tasks Covered**: Task 1 (extend plugin manifest schema to v2 with `produces[]`/`consumes[]`), Task 2 (manifest validation that rejects orphan consumers)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-022-1-01-plugin-manifest-v2-and-orphan-consumer-validation.md`

## Description
Extend PLAN-019-1's `hook-manifest-v1.json` into `plugin-manifest-v2.json` by adding two optional top-level arrays — `produces[]` and `consumes[]` — so plugins can declare the artifact types they emit and the artifact types they require. Add the matching `ProducesDeclaration` / `ConsumesDeclaration` TypeScript types. Then layer a cross-manifest validation pass into the existing `PluginDiscovery` class (SPEC-019-1-02) that rejects any plugin whose `consumes[].artifact_type` has no matching producer in the registry, with semver-compatible `schema_version` matching.

This spec is structural: pure declarations, schema, and a cross-reference checker. It does NOT load or execute artifact payloads (that lands in SPEC-022-1-02), it does NOT build a dependency graph (SPEC-022-1-03), and it does NOT execute chains (SPEC-022-1-04). v1 manifests without `produces`/`consumes` continue to validate untouched (backward compat is non-negotiable).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/schemas/plugin-manifest-v2.json` | Create | JSON Schema Draft 2020-12; supersedes v1 by extending it |
| `plugins/autonomous-dev/src/hooks/types.ts` | Modify | Add `ProducesDeclaration`, `ConsumesDeclaration`; extend `HookManifest` with optional `produces?`, `consumes?` |
| `plugins/autonomous-dev/src/hooks/discovery.ts` | Modify | Add `validateChainConsistency(results)` method + integration into `scan()` |
| `plugins/autonomous-dev/src/hooks/index.ts` | Modify | Re-export new types |
| `plugins/autonomous-dev/tests/fixtures/plugins/security-reviewer/hooks.json` | Create | Producer of `security-findings@1.0` |
| `plugins/autonomous-dev/tests/fixtures/plugins/code-fixer/hooks.json` | Create | Consumer of `security-findings@1.0`, producer of `code-patches@1.0` |
| `plugins/autonomous-dev/tests/fixtures/plugins/orphan-consumer/hooks.json` | Create | Consumes `widgets@1.0` with no producer (rejection target) |

## Implementation Details

### `schemas/plugin-manifest-v2.json`

Draft 2020-12. `additionalProperties: false` everywhere. Inherits all v1 required fields (`id`, `name`, `version`, `hooks`) and v1 patterns (kebab-case `id`, semver `version`, `entry_point` regex). Adds two new optional arrays at the top level:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://autonomous-dev.local/schemas/plugin-manifest-v2.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "name", "version", "hooks"],
  "properties": {
    "id":      { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
    "name":    { "type": "string", "minLength": 1 },
    "version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[\\w.-]+)?(?:\\+[\\w.-]+)?$" },
    "hooks":   { "type": "array", "items": { "$ref": "#/$defs/HookEntry" } },
    "produces": { "type": "array", "items": { "$ref": "#/$defs/ProducesDeclaration" }, "default": [] },
    "consumes": { "type": "array", "items": { "$ref": "#/$defs/ConsumesDeclaration" }, "default": [] }
  },
  "$defs": {
    "HookEntry": { "...same as v1..." },
    "ProducesDeclaration": {
      "type": "object",
      "additionalProperties": false,
      "required": ["artifact_type", "schema_version", "format"],
      "properties": {
        "artifact_type":   { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
        "schema_version":  { "type": "string", "pattern": "^\\d+\\.\\d+(?:\\.\\d+)?$" },
        "format":          { "enum": ["json", "yaml", "text"] },
        "description":     { "type": "string" }
      }
    },
    "ConsumesDeclaration": {
      "type": "object",
      "additionalProperties": false,
      "required": ["artifact_type", "schema_version"],
      "properties": {
        "artifact_type":   { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
        "schema_version":  { "type": "string", "pattern": "^\\^?\\d+\\.\\d+(?:\\.\\d+)?$" },
        "optional":        { "type": "boolean", "default": false },
        "description":     { "type": "string" }
      }
    }
  },
  "examples": [
    {
      "id": "security-reviewer", "name": "Security Reviewer", "version": "1.0.0",
      "hooks": [{ "id": "scan", "hook_point": "review-pre-score", "entry_point": "./scan.js", "priority": 100, "failure_mode": "warn" }],
      "produces": [{ "artifact_type": "security-findings", "schema_version": "1.0", "format": "json" }]
    }
  ]
}
```

Note: `consumes.schema_version` allows an optional leading `^` (semver caret) so a consumer can declare `"^1.0"` to accept any 1.x.y producer. Producers always declare an exact `MAJOR.MINOR` (no caret).

### `src/hooks/types.ts` additions

```ts
export interface ProducesDeclaration {
  /** Kebab-case artifact identifier, e.g. 'security-findings'. */
  artifact_type: string;
  /** Producer's exact MAJOR.MINOR (or MAJOR.MINOR.PATCH), e.g. '1.0'. */
  schema_version: string;
  format: 'json' | 'yaml' | 'text';
  description?: string;
}

export interface ConsumesDeclaration {
  artifact_type: string;
  /** Caret-allowed range, e.g. '^1.0' or exact '1.0'. */
  schema_version: string;
  /** If true, missing producer does NOT reject this plugin. Default false. */
  optional?: boolean;
  description?: string;
}

export interface HookManifest {
  id: string;
  name: string;
  version: string;
  hooks: HookEntry[];
  produces?: ProducesDeclaration[];   // NEW in v2
  consumes?: ConsumesDeclaration[];   // NEW in v2
}
```

JSDoc on both new interfaces references `TDD-022 §5`.

### `src/hooks/discovery.ts` modifications

Add a new method `validateChainConsistency(results: DiscoveryResult[]): DiscoveryResult[]` that runs **after** all per-manifest schema validation has completed but **before** the discovery results are returned to callers. Behavior:

1. Build an in-memory map: `producerIndex: Map<artifactType, Array<{pluginId, schemaVersion}>>` from every successfully-parsed manifest's `produces[]`.
2. For each manifest's `consumes[]` entry:
   - If `optional === true`, skip.
   - Look up `producerIndex.get(consume.artifact_type)`. If empty → push a `SCHEMA_ERROR` onto that manifest's `errors[]` with `code='SCHEMA_ERROR'`, `pointer='/consumes/<i>/artifact_type'`, `message='no producer found for artifact_type "<type>"'`. Clear the `manifest` field (rejected).
   - If non-empty, check that at least one producer's `schemaVersion` satisfies the consumer's caret-or-exact range (see Semver Compat below). If none satisfies → push a `SCHEMA_ERROR` with `message='no producer satisfies schema_version "<range>" for artifact_type "<type>" (available: <versions>)'`. Clear the `manifest` field.
3. A plugin that produces an artifact it also consumes (self-loop at the artifact level) is allowed by THIS check; cycle detection in SPEC-022-1-03 catches the chain-level self-loop.

Update `scan()` to call `validateChainConsistency(results)` exactly once, just before the final `return`.

### Semver Compat helper

Inline in `discovery.ts` (or extract to `src/hooks/semver-compat.ts`):

```ts
/** True if `producer` satisfies `consumerRange`. Caret means same major. */
export function satisfiesRange(producer: string, consumerRange: string): boolean {
  // Normalize: strip leading '^', split on '.', pad to 3 parts.
  const caret = consumerRange.startsWith('^');
  const range = caret ? consumerRange.slice(1) : consumerRange;
  const [pMaj, pMin] = producer.split('.').map(Number);
  const [rMaj, rMin] = range.split('.').map(Number);
  if (caret) return pMaj === rMaj && pMin >= rMin;
  return pMaj === rMaj && pMin === rMin;
}
```

Patch versions are ignored for compat (artifact schemas evolve at MAJOR.MINOR granularity per TDD-022 §5).

### Fixture manifests

`security-reviewer/hooks.json`: produces `security-findings@1.0`, no consumes.

`code-fixer/hooks.json`: consumes `^1.0` of `security-findings`, produces `code-patches@1.0`.

`orphan-consumer/hooks.json`: consumes `^1.0` of `widgets`. No `widgets` producer in fixtures → rejection target.

## Acceptance Criteria

- [ ] `schemas/plugin-manifest-v2.json` parses cleanly (`jq -e . schemas/plugin-manifest-v2.json` exit 0).
- [ ] Schema's `$schema` is `https://json-schema.org/draft/2020-12/schema`.
- [ ] Schema accepts the embedded `examples[0]` (round-trip).
- [ ] Schema accepts a v1-shaped manifest with no `produces`/`consumes` (backward compat).
- [ ] Schema rejects a `produces[].format` of `xml` (enum violation).
- [ ] Schema rejects a `consumes[]` entry missing `artifact_type` (`required` keyword).
- [ ] Schema rejects a `produces[].schema_version` of `1` (pattern violation: needs `MAJOR.MINOR`).
- [ ] Schema rejects an extra top-level field (e.g. `category`) due to `additionalProperties: false`.
- [ ] `ProducesDeclaration`, `ConsumesDeclaration`, and the extended `HookManifest` compile under `tsc --strict --noEmit`.
- [ ] `satisfiesRange('1.0', '^1.0')` returns `true`; `satisfiesRange('2.0', '^1.0')` returns `false`; `satisfiesRange('1.5', '^1.0')` returns `true`; `satisfiesRange('1.0', '1.0')` returns `true`; `satisfiesRange('1.1', '1.0')` returns `false`.
- [ ] `PluginDiscovery.scan()` over `[security-reviewer, code-fixer]` returns 2 ok results, 0 errors.
- [ ] `PluginDiscovery.scan()` over `[security-reviewer, code-fixer, orphan-consumer]` returns 3 results: `orphan-consumer` has `manifest === undefined` and one `SCHEMA_ERROR` whose message contains `no producer found for artifact_type "widgets"` and `pointer === '/consumes/0/artifact_type'`.
- [ ] When a producer for `widgets` is added on a subsequent `scan()`, `orphan-consumer` is accepted (no errors). This proves load-order independence.
- [ ] A consumer requesting `^2.0` of `security-findings` (when only `1.0` producer exists) is rejected with a message naming the available versions.
- [ ] An `optional: true` consumer with no producer is accepted (no error).
- [ ] Two producers for the same `artifact_type` are allowed by the schema and by `validateChainConsistency` (multi-producer is a valid topology; SPEC-022-1-03 handles edge generation).
- [ ] A v1 manifest fixture from PLAN-019-1 (`simple/hooks.json`) still validates against `plugin-manifest-v2.json` unchanged.

## Dependencies

- SPEC-019-1-01 (HookManifest, HookEntry, schema patterns) — extended.
- SPEC-019-1-02 (`PluginDiscovery`, `DiscoveryResult`, `DiscoveryError`) — modified.
- TDD-022 §5 (manifest extension catalog) — read-only reference.
- No new npm packages.
- No AJV dependency added by this spec; the injected `schemaValidator` from SPEC-019-1-02 stays the contract.

## Notes

- Backward compat is structural (v1 manifests pass v2 schema) AND lexical (v1 schema file remains on disk for tooling that pins to it). Plugins gradually migrate by adding `produces`/`consumes`.
- `validateChainConsistency` runs against the snapshot of currently-discoverable plugins. A plugin in `node_modules` that ships a producer but has not yet been registered will not satisfy a consumer until the next scan picks it up — this is intentional (SIGUSR1 reload from SPEC-019-1-04 re-runs the check).
- The `optional: true` flag on consumers exists so progressive adoption works: a plugin can declare it WOULD use an artifact if available without forcing every operator to install the producer.
- Caret semantics are restricted to MAJOR.MINOR (no patch ranges, no comparator ranges like `>=1.2 <2`). This is a deliberate simplification; fuller semver ranges can be added in a future schema bump if a real need arises.
- The cycle in `produces == consumes` for one plugin is a no-op for chain validity (a plugin doesn't trigger itself); the dependency graph in SPEC-022-1-03 prunes self-edges before cycle detection.
- When PLAN-019-2 wires AJV in, the AJV-backed validator should be pointed at `plugin-manifest-v2.json`. v1 manifests still pass because v2 is a structural superset.

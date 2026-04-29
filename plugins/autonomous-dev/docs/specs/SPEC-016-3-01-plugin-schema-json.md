# SPEC-016-3-01: plugin.schema.json — JSON Schema 2020-12 for Plugin Manifests

## Metadata
- **Parent Plan**: PLAN-016-3
- **Tasks Covered**: Task 1 (author `.github/schemas/plugin.schema.json`)
- **Estimated effort**: 2 hours

## Description

Author the vendored JSON Schema (Draft 2020-12) that describes the autonomous-dev plugin manifest contract. The schema lives at `.github/schemas/plugin.schema.json` and is the **source of truth for the fallback validation path** in PLAN-016-3 (used whenever Claude CLI bootstrap fails per SPEC-016-3-03). It is also reusable by future tooling (pre-commit hooks, marketplace publish workflows) per PLAN-016-3 Dependencies & Integration Points.

The schema enforces: kebab-case `name`, semver `version`, a 10–200-character `description`, an `author` object with required `name`, and a small set of additional optional fields. It uses `additionalProperties: false` so manifests that introduce undocumented fields are rejected by the fallback path — preventing silent contract drift.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/schemas/plugin.schema.json` | Create | JSON Schema Draft 2020-12; vendored, no runtime $ref resolution required |

## Implementation Details

### Schema Identity

The schema MUST declare:

- `"$schema": "https://json-schema.org/draft/2020-12/schema"`
- `"$id": "https://github.com/pwatsonr/autonomous-dev/.github/schemas/plugin.schema.json"`
- `"title": "Autonomous-Dev Plugin Manifest"`
- `"type": "object"`
- `"additionalProperties": false`

### Required Root Fields

| Field | Type | Constraint |
|-------|------|------------|
| `name` | `string` | Pattern `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` (kebab-case, must start with a letter, no leading digits or hyphens) |
| `version` | `string` | Pattern matching SemVer 2.0.0: `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$` |
| `description` | `string` | `minLength: 10`, `maxLength: 200` |
| `author` | `object` | Sub-schema below; `additionalProperties: false` |

Required: `["name", "version", "description", "author"]`.

### Author Sub-Schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["name"],
  "properties": {
    "name":  { "type": "string", "minLength": 1 },
    "email": { "type": "string", "format": "email" },
    "url":   { "type": "string", "format": "uri" }
  }
}
```

`name` is required. `email` and `url` are both optional. The existing `plugins/autonomous-dev/.claude-plugin/plugin.json` and `plugins/autonomous-dev-assist/.claude-plugin/plugin.json` use `author.url`; the schema MUST validate them unchanged.

### Optional Root Fields

| Field | Type | Constraint |
|-------|------|------------|
| `dependencies` | `object` | `additionalProperties: { "type": "string" }` (semver-range strings) |
| `repository` | `string` | `format: "uri"` |
| `entrypoint` | `string` | `minLength: 1` (relative path inside the plugin directory) |
| `homepage` | `string` | `format: "uri"` |
| `keywords` | `array` | `items: { "type": "string", "minLength": 1 }`, `uniqueItems: true`, `maxItems: 20` |
| `license` | `string` | SPDX-style identifier; `pattern: "^[A-Za-z0-9.\\-+]+$"` (permits MIT, Apache-2.0, BSD-3-Clause, etc.) |

`license` is included because the two existing in-repo manifests declare `"license": "MIT"`. Without it, `additionalProperties: false` would reject those manifests and PLAN-016-3 task 1's acceptance criterion "ajv-cli exits 0 against the existing manifest" would fail.

### Full Schema Skeleton

The implementer SHOULD write the schema as a single self-contained JSON document of this shape (regex strings escaped per JSON):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/pwatsonr/autonomous-dev/.github/schemas/plugin.schema.json",
  "title": "Autonomous-Dev Plugin Manifest",
  "type": "object",
  "additionalProperties": false,
  "required": ["name", "version", "description", "author"],
  "properties": {
    "name":        { "type": "string", "pattern": "^[a-z][a-z0-9]*(-[a-z0-9]+)*$", "maxLength": 64 },
    "version":     { "type": "string", "pattern": "<semver-regex-from-table>" },
    "description": { "type": "string", "minLength": 10, "maxLength": 200 },
    "author":      { "$ref": "#/$defs/author" },
    "dependencies":{ "type": "object", "additionalProperties": { "type": "string", "minLength": 1 } },
    "repository":  { "type": "string", "format": "uri" },
    "entrypoint":  { "type": "string", "minLength": 1 },
    "homepage":    { "type": "string", "format": "uri" },
    "keywords":    { "type": "array", "items": { "type": "string", "minLength": 1 }, "uniqueItems": true, "maxItems": 20 },
    "license":     { "type": "string", "pattern": "^[A-Za-z0-9.\\-+]+$", "minLength": 1, "maxLength": 64 }
  },
  "$defs": {
    "author": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name"],
      "properties": {
        "name":  { "type": "string", "minLength": 1 },
        "email": { "type": "string", "format": "email" },
        "url":   { "type": "string", "format": "uri" }
      }
    }
  }
}
```

The `$defs/author` reference is local-only (`#/$defs/author`); no remote `$ref` resolution.

## Acceptance Criteria

- [ ] `.github/schemas/plugin.schema.json` exists and is valid JSON (parses with `python3 -m json.tool` or equivalent without error).
- [ ] Schema declares `"$schema": "https://json-schema.org/draft/2020-12/schema"` and a `"$id"` field.
- [ ] `additionalProperties: false` is set at the root and on the `author` sub-schema.
- [ ] `npx ajv-cli@8 validate -s .github/schemas/plugin.schema.json -d plugins/autonomous-dev/.claude-plugin/plugin.json` exits 0.
- [ ] `npx ajv-cli@8 validate -s .github/schemas/plugin.schema.json -d plugins/autonomous-dev-assist/.claude-plugin/plugin.json` exits 0.
- [ ] Removing `version` from a copy of the autonomous-dev manifest causes ajv-cli to exit non-zero with an error mentioning the missing required property.
- [ ] Setting `name` to `Autonomous_Dev` (snake_case) causes ajv-cli to exit non-zero with a pattern-mismatch error.
- [ ] Setting `version` to `1.0` (not full semver) causes ajv-cli to exit non-zero.
- [ ] Adding an undocumented root field `foo: "bar"` causes ajv-cli to exit non-zero with an `additionalProperties` error.
- [ ] `description` of length 9 is rejected; length 10 is accepted; length 201 is rejected.
- [ ] `author: { "name": "x" }` is accepted; `author: { "url": "..." }` (no `name`) is rejected.

## Test Requirements

Fixture-based test execution lives in SPEC-016-3-04. This spec defines what the schema must satisfy when those fixtures are run against it:

| Fixture | Expected ajv-cli exit code | Reason |
|---------|---------------------------|--------|
| `tests/fixtures/plugins/valid.json` | 0 | All required fields, all constraints satisfied |
| `tests/fixtures/plugins/missing-required.json` | non-zero | `version` (or `description`) absent |
| `tests/fixtures/plugins/extra-field.json` | non-zero | Adds an undocumented root key, e.g. `"build": "..."` |
| `tests/fixtures/plugins/bad-version.json` | non-zero | `version: "1.0"` or `version: "v1.0.0"` |

## Dependencies

- **Consumes**: nothing. Schema is fully self-contained; no remote `$ref` resolution.
- **Exposes**:
  - `.github/schemas/plugin.schema.json` consumed by SPEC-016-3-03 (ajv-cli fallback step) and SPEC-016-3-04 (fixture tests).
  - The schema is referenced by future PRD-001 pre-commit hooks and marketplace publish workflows per PLAN-016-3 Dependencies & Integration Points.
- **External**: None at author-time. Validation tools (`ajv-cli@8.x`) are pulled at CI runtime by SPEC-016-3-03 and SPEC-016-3-04.

## Notes

- **Why vendor the schema instead of resolving a remote `$ref`?** CI must be hermetic; a network fetch on every PR introduces flakes and a supply-chain attack surface. The schema is small (~60 lines) and easy to review on each change.
- **Why permit `license`?** PLAN-016-3 task 1's acceptance criterion requires the schema to validate the existing manifests, both of which declare `"license": "MIT"`. Excluding `license` would force a manifest edit, which is explicitly out-of-scope for PLAN-016-3.
- **Why `additionalProperties: false` at the root?** The Claude CLI's contract is a moving target; without strict additional-property checks the fallback path silently passes manifests that the CLI would reject. The schema is the source-of-truth for the fallback path, so it must reject unknown fields.
- **Schema drift risk** — see PLAN-016-3 Risks table. Mitigated by SPEC-016-3-04 fixture tests that exercise this schema against curated good/bad inputs and by an annual review cadence documented in PLAN-016-3.
- **Why no `$ref` to a remote SemVer schema?** SemVer regex is well-known and stable; inlining is simpler than vendor-then-re-`$ref`. The pattern in the table above matches the official SemVer 2.0.0 ABNF.

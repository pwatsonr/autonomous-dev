# SPEC-021-1-01: standards-v1.json Schema + TypeScript Types

## Metadata
- **Parent Plan**: PLAN-021-1
- **Tasks Covered**: Task 1 (author standards-v1.json schema), Task 2 (author TypeScript types)
- **Estimated effort**: 4.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-021-1-01-standards-schema-typescript-types.md`

## Description
Establish the foundational data contract for the standards DSL: a JSON Schema (`standards-v1.json`) per TDD-021 §5 plus a matching TypeScript types module. The schema defines the on-disk shape of every `standards.yaml` file in the system (defaults, org, repo, request) and is consumed downstream by the loader (SPEC-021-1-02), CLI validator (SPEC-021-1-04), and every plan that produces or consumes standards (PLAN-021-2, PLAN-021-3, PLAN-020-1).

The schema enforces: a namespaced rule ID format (`<plugin>:<id>`), three severity levels (advisory|warn|blocking), optional immutability, predicate/assertion sub-schemas, an evaluator string referencing the catalog from PLAN-021-2, and `additionalProperties: false` at every level to catch typos early. The TypeScript module mirrors the schema field-for-field with discriminated unions on predicate/assertion variants.

This spec ships data definitions only — no runtime code, no I/O, no validation engine wiring. The loader and resolver consume these artifacts in subsequent specs.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/schemas/standards-v1.json` | Create | JSON Schema 2020-12 with predicate/assertion sub-schemas |
| `plugins/autonomous-dev/src/standards/types.ts` | Create | TypeScript interfaces mirroring the schema |
| `plugins/autonomous-dev/src/standards/index.ts` | Create | Barrel re-exporting types from `./types` |

## Implementation Details

### Schema Structure (`standards-v1.json`)

The schema must declare:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://autonomous-dev.dev/schemas/standards-v1.json",
  "title": "Standards Artifact v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "metadata", "rules"],
  "properties": {
    "version": { "const": "1" },
    "metadata": { "$ref": "#/$defs/Metadata" },
    "rules": { "type": "array", "items": { "$ref": "#/$defs/Rule" } }
  },
  "$defs": {
    "Metadata": { ... },
    "Rule": { ... },
    "Predicate": { ... },
    "Assertion": { ... }
  }
}
```

`Metadata` requires: `name` (string), `description` (string), `owner` (string), `last_updated` (ISO 8601 date string).

`Rule` requires: `id`, `severity`, `description`, `applies_to`, `requires`, `evaluator`. Optional: `immutable` (default false). The `id` field uses pattern `^[a-z0-9-]+:[a-z0-9-]+$`. The `severity` field is an enum: `["advisory", "warn", "blocking"]`. The `evaluator` field is a string referencing the catalog populated by PLAN-021-2.

`Predicate` is a discriminated object with mutually exclusive predicate types. At least one of: `language` (string), `service_type` (string enum: `["api", "worker", "cli", "library", "frontend"]`), `framework` (string), `implements` (array of strings), `path_pattern` (string regex). Multiple predicates AND together.

`Assertion` is a discriminated object. At least one of: `framework_match` (string), `exposes_endpoint` (object with `method` and `path_pattern`), `uses_pattern` (string regex), `excludes_pattern` (string regex), `dependency_present` (string), `custom_evaluator_args` (object, free-form).

All sub-schemas use `additionalProperties: false`.

### Worked Example (embedded in schema's `examples` field)

```yaml
version: "1"
metadata:
  name: "Acme Engineering Standards"
  description: "Org-level rules for Acme microservices"
  owner: "platform-team@acme.io"
  last_updated: "2026-04-01"
rules:
  - id: "org:python-fastapi-required"
    severity: "blocking"
    immutable: true
    description: "All Python HTTP services must use FastAPI."
    applies_to:
      language: "python"
      service_type: "api"
    requires:
      framework_match: "fastapi"
    evaluator: "framework-detector"
```

### TypeScript Types (`src/standards/types.ts`)

```typescript
/** Severity levels per TDD-021 §5. */
export type Severity = "advisory" | "warn" | "blocking";

/** Service types eligible for predicate matching. */
export type ServiceType = "api" | "worker" | "cli" | "library" | "frontend";

/** Predicate: matches a target before evaluating `requires`. */
export interface Predicate {
  language?: string;
  service_type?: ServiceType;
  framework?: string;
  implements?: string[];
  path_pattern?: string;
}

/** Assertion: what the rule requires when the predicate matches. */
export interface Assertion {
  framework_match?: string;
  exposes_endpoint?: { method: string; path_pattern: string };
  uses_pattern?: string;
  excludes_pattern?: string;
  dependency_present?: string;
  custom_evaluator_args?: Record<string, unknown>;
}

/** A single standards rule. ID format: `<plugin>:<id>` per TDD-021 §5. */
export interface Rule {
  id: string;             // matches /^[a-z0-9-]+:[a-z0-9-]+$/
  severity: Severity;
  immutable?: boolean;    // default false
  description: string;
  applies_to: Predicate;
  requires: Assertion;
  evaluator: string;      // references catalog from PLAN-021-2
}

export interface Metadata {
  name: string;
  description: string;
  owner: string;
  last_updated: string;   // ISO 8601 date
}

/** Top-level structure of a standards.yaml file. */
export interface StandardsArtifact {
  version: "1";
  metadata: Metadata;
  rules: Rule[];
}

/** Source attribution for a resolved rule (used by InheritanceResolver). */
export type RuleSource = "default" | "org" | "repo" | "request";
```

Each interface and type alias must include a JSDoc block referencing the relevant TDD-021 section.

## Acceptance Criteria

- [ ] `schemas/standards-v1.json` declares `$schema: "https://json-schema.org/draft/2020-12/schema"` and a stable `$id`.
- [ ] Schema validates the embedded worked example clean (verified by running `ajv validate -s standards-v1.json -d <example>`).
- [ ] Schema rejects a rule with `id: "no-namespace"` (missing colon) with a pattern-mismatch error.
- [ ] Schema rejects a rule with `severity: "panic"` with an enum-mismatch error.
- [ ] Schema rejects a rule missing the `evaluator` field with a required-field error.
- [ ] Schema rejects a top-level document with an unknown property (e.g., `extra_key`) due to `additionalProperties: false`.
- [ ] Schema rejects a `Rule` with both no predicate keys and no assertion keys (caught via `minProperties: 1` on Predicate and Assertion).
- [ ] `src/standards/types.ts` compiles under `tsc --strict --noEmit`.
- [ ] Every interface in `types.ts` has fields matching the schema field-for-field (verified by manual review against the schema).
- [ ] Every interface has a JSDoc block citing the relevant TDD-021 section number.
- [ ] `src/standards/index.ts` re-exports `Rule`, `Predicate`, `Assertion`, `Severity`, `ServiceType`, `Metadata`, `StandardsArtifact`, `RuleSource`.
- [ ] Schema file size is < 8KB (sanity check on ergonomics).

## Dependencies

- No runtime dependencies introduced by this spec. The schema is JSON; the types are pure TypeScript.
- Downstream consumers: SPEC-021-1-02 (loader), SPEC-021-1-03 (scanner output writer), SPEC-021-1-04 (CLI validator), and PLAN-021-2/021-3/020-1.

## Notes

- The schema deliberately commits to JSON Schema draft 2020-12 because it supports `$defs`, `unevaluatedProperties`, and `dependentRequired` — features the loader may need in v1.1 without a breaking schema change.
- The namespaced ID pattern `^[a-z0-9-]+:[a-z0-9-]+$` is intentionally restrictive (kebab-case, single colon). Documented in JSDoc with rationale per TDD-021 §5; v1.1 may relax to allow dots if needed.
- `evaluator` is a free-form string in v1; PLAN-021-2 ships an enum constraint in a follow-up schema patch (`standards-v1.1.json`) once the catalog stabilizes. v1 documents allowed values in the description.
- TypeScript discriminated unions on Predicate/Assertion variants were considered but rejected: the schema allows multiple predicate keys to AND together (e.g., `language=python` AND `service_type=api`), which a discriminated union cannot express ergonomically. Optional fields with documented semantics are clearer.
- The `RuleSource` type is included here (rather than in resolver.ts) because PLAN-021-3 author agents and PLAN-020-1 reviewers also need to read source attribution from the resolved set.

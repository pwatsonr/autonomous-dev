# SPEC-021-3-03: fix-recipe-v1.json Schema, FixRecipe Interface/Emitter, and Fixture Recipes

## Metadata
- **Parent Plan**: PLAN-021-3
- **Tasks Covered**: Task 8 (`fix-recipe-v1.json` schema), Task 9 (`FixRecipe` interface + `emitFixRecipe()` helper), Task 10 (fixture fix-recipes)
- **Estimated effort**: 5.5 hours
- **Future location**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-021-3-03-fix-recipe-schema-interface-and-fixtures.md`

## Description
Define the `fix-recipe-v1` artifact: a JSON Schema (TDD-021 §13) that governs the contract by which the `rule-set-enforcement-reviewer` (PLAN-020-1) emits machine-applicable fix instructions when a standards rule is violated. Ship the schema, the `FixRecipe` TypeScript interface mirroring it, an `emitFixRecipe(violation, stateDir)` helper that constructs and persists a recipe to disk, and three fixture recipes (one per `fix_type`) that serve as canonical examples both in the schema's `examples` field and as reusable test inputs for downstream consumers.

The fix-recipe is the contract that TDD-022 plugin chains will consume — the code-fixer plugin will read recipes from `<state-dir>/fix-recipes/<id>.json` and apply them. This spec ships the schema and emitter only; consumption is out-of-scope (TDD-022).

This spec does NOT modify the `rule-set-enforcement-reviewer` agent itself (that lives on `main` per PLAN-020-1). It only ships the schema/interface/emitter that PLAN-020-1's reviewer will call. It does NOT define the standards-meta-reviewer (SPEC-021-3-02) or the prompt renderer (SPEC-021-3-01). It does NOT include unit/integration tests (SPEC-021-3-04).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/schemas/fix-recipe-v1.json` | Create | JSON Schema Draft 2020-12, vendored, with three worked examples |
| `plugins/autonomous-dev/src/standards/fix-recipe.ts` | Create | `FixRecipe` interface, `Violation` input type, `emitFixRecipe()` helper |
| `plugins/autonomous-dev/tests/fixtures/fix-recipes/code-replacement-sql.json` | Create | SQL injection fix example |
| `plugins/autonomous-dev/tests/fixtures/fix-recipes/file-creation-health.json` | Create | Missing /health endpoint example |
| `plugins/autonomous-dev/tests/fixtures/fix-recipes/dependency-add-fastapi.json` | Create | Missing FastAPI dependency example |

## Implementation Details

### `schemas/fix-recipe-v1.json`

JSON Schema Draft 2020-12, vendored (no remote `$ref`):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/pwatsonr/autonomous-dev/plugins/autonomous-dev/schemas/fix-recipe-v1.json",
  "title": "Fix Recipe v1",
  "description": "Machine-applicable fix instruction emitted by the rule-set-enforcement-reviewer when a standards rule is violated. Consumed by TDD-022 code-fixer plugins.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "violation_id",
    "rule_id",
    "file",
    "line",
    "fix_type",
    "before",
    "after_template",
    "confidence"
  ],
  "properties": {
    "violation_id": {
      "type": "string",
      "pattern": "^VIO-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$",
      "description": "Globally unique violation identifier. Format: VIO-<UTC-timestamp>-<8-hex-hash>."
    },
    "rule_id": {
      "type": "string",
      "pattern": "^[a-z0-9-]+:[a-z0-9-]+$",
      "description": "Namespaced standards rule ID per PLAN-021-1 (<plugin>:<id>)."
    },
    "file": {
      "type": "string",
      "minLength": 1,
      "description": "Repo-relative path of the file the violation occurs in (or, for file-creation, the path the file SHOULD be created at)."
    },
    "line": {
      "type": "integer",
      "minimum": 0,
      "description": "1-based line number of the violation; 0 for file-creation recipes (no existing line)."
    },
    "fix_type": {
      "type": "string",
      "enum": ["code-replacement", "file-creation", "dependency-add"],
      "description": "Discriminator for the kind of fix. Determines how a downstream code-fixer interprets `before`/`after_template`."
    },
    "before": {
      "type": "string",
      "description": "The current state. For code-replacement: the offending text snippet. For file-creation: empty string. For dependency-add: the dependency name (used by the fixer to detect already-present)."
    },
    "after_template": {
      "type": "string",
      "minLength": 1,
      "description": "The desired state. For code-replacement: the replacement snippet. For file-creation: the full file body. For dependency-add: the dependency declaration (e.g., a package.json/requirements.txt fragment)."
    },
    "confidence": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "description": "Reviewer-asserted confidence the fix is correct without human review. 1.0 means fully automated; lower values warrant manual review."
    },
    "manual_review_required": {
      "type": "boolean",
      "description": "Optional explicit override. If true, downstream fixers MUST NOT auto-apply regardless of confidence."
    }
  },
  "examples": [
    /* see Fixture Recipes section: each fixture's body is duplicated here as an example */
  ]
}
```

The schema's `examples` field MUST contain the bodies of all three fixture recipes (verbatim) so the schema is self-documenting and a self-test can validate `examples[*]` against the schema itself. Implementation: after the three fixture files are authored, copy their JSON bodies into `examples`.

### `src/standards/fix-recipe.ts`

TypeScript module exposing:

```typescript
export type FixType = 'code-replacement' | 'file-creation' | 'dependency-add';

export interface FixRecipe {
  violation_id: string;
  rule_id: string;
  file: string;
  line: number;
  fix_type: FixType;
  before: string;
  after_template: string;
  confidence: number;
  manual_review_required?: boolean;
}

/** Input shape passed by the rule-set-enforcement-reviewer when emitting a finding. */
export interface Violation {
  rule_id: string;
  file: string;
  line: number;
  fix_type: FixType;
  before: string;
  after_template: string;
  confidence: number;
  manual_review_required?: boolean;
}

/**
 * Persist a Violation as a FixRecipe at <stateDir>/fix-recipes/<violation_id>.json.
 * Generates the violation_id deterministically from (timestamp, content-hash).
 * Validates against fix-recipe-v1.json before writing.
 *
 * @returns the generated violation_id (callers can correlate with their finding).
 * @throws if validation fails or the write fails.
 */
export async function emitFixRecipe(
  violation: Violation,
  stateDir: string,
): Promise<string>;
```

Algorithm for `emitFixRecipe()`:

1. Compute `timestamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z'` (yields `YYYYMMDDTHHmmssZ`).
2. Compute `hash = sha256(JSON.stringify(violation)).slice(0, 8)` for the 8-hex suffix.
3. `violation_id = "VIO-" + timestamp + "-" + hash`.
4. Build the recipe object: `{ violation_id, ...violation }`.
5. Validate the recipe against `schemas/fix-recipe-v1.json` using ajv (already a project dependency from PLAN-021-1's loader). If validation fails, throw `Error("invalid fix recipe: " + ajv.errorsText())`.
6. Compute target path: `<stateDir>/fix-recipes/<violation_id>.json`.
7. Ensure the directory exists: `fs.mkdir(path.dirname(target), { recursive: true })`. Mode `0700`.
8. Write the recipe atomically: write to `<target>.tmp`, then `fs.rename(<target>.tmp, <target>)`. File mode `0600`.
9. Return the `violation_id`.

Idempotency: if two violations with byte-identical content are emitted within the same second, they produce the same `violation_id` and the second write overwrites the first (acceptable: the recipe is identical). If they differ even by one byte, the SHA-256 differs and the IDs do not collide.

Error handling:
- Invalid input fields → schema validation throws before any file I/O.
- Unwritable `stateDir` → throws with the underlying `EACCES`/`ENOENT` preserved as the cause.
- Concurrent writes to the same path → atomic rename ensures the final file is one of the writers' content (last writer wins), never partial.

### Fixture Recipes

Each fixture is a standalone JSON file that validates against `fix-recipe-v1.json`. They serve as the canonical examples in the schema's `examples` field AND as reusable inputs for tests in SPEC-021-3-04 and downstream TDD-022 work.

#### `tests/fixtures/fix-recipes/code-replacement-sql.json`

```json
{
  "violation_id": "VIO-20251101T120000Z-a1b2c3d4",
  "rule_id": "security:no-sql-injection",
  "file": "src/db/users.ts",
  "line": 42,
  "fix_type": "code-replacement",
  "before": "db.query(`SELECT * FROM users WHERE id = ${userId}`)",
  "after_template": "db.query('SELECT * FROM users WHERE id = $1', [userId])",
  "confidence": 0.95
}
```

#### `tests/fixtures/fix-recipes/file-creation-health.json`

```json
{
  "violation_id": "VIO-20251101T120100Z-e5f6a7b8",
  "rule_id": "operability:exposes-health-endpoint",
  "file": "src/routes/health.ts",
  "line": 0,
  "fix_type": "file-creation",
  "before": "",
  "after_template": "import { Router } from 'express';\n\nconst router = Router();\n\nrouter.get('/health', (_req, res) => {\n  res.status(200).json({ status: 'ok' });\n});\n\nexport default router;\n",
  "confidence": 0.85,
  "manual_review_required": false
}
```

#### `tests/fixtures/fix-recipes/dependency-add-fastapi.json`

```json
{
  "violation_id": "VIO-20251101T120200Z-c9d0e1f2",
  "rule_id": "framework:python-fastapi",
  "file": "requirements.txt",
  "line": 0,
  "fix_type": "dependency-add",
  "before": "fastapi",
  "after_template": "fastapi>=0.110,<1.0\n",
  "confidence": 0.9
}
```

Each fixture demonstrates the typical `before`/`after_template` shape for its `fix_type`:
- **code-replacement**: `before` is the literal offending snippet found in the file; `after_template` is the substitution. The fixer searches for `before` at the indicated `line` and replaces it.
- **file-creation**: `before` is empty; `line` is 0; `after_template` is the entire new file body. The fixer creates the file at `file` if absent.
- **dependency-add**: `before` is the bare dependency name (used by the fixer to detect "already present"); `line` is 0; `after_template` is the declaration to insert. The fixer appends to `file` if `before` is not already present.

## Acceptance Criteria

- [ ] `schemas/fix-recipe-v1.json` exists, is valid JSON (parses with `python3 -m json.tool`), and declares `$schema: "https://json-schema.org/draft/2020-12/schema"` and `$id`.
- [ ] `additionalProperties: false` is set at the schema root.
- [ ] All eight required fields are declared with the documented type and constraint; `manual_review_required` is optional.
- [ ] `fix_type` accepts only `code-replacement`, `file-creation`, `dependency-add`; any other value fails validation.
- [ ] `confidence` rejects values < 0 or > 1; accepts 0, 0.5, 1.
- [ ] `violation_id` rejects values not matching `^VIO-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$`.
- [ ] `rule_id` rejects values lacking the `:` namespace separator (e.g., `no-namespace`).
- [ ] The schema's `examples` array contains all three fixture recipe bodies verbatim, and each example validates against the schema (self-test).
- [ ] All three fixture files exist at the documented paths and validate against `fix-recipe-v1.json` via `npx ajv-cli@8 validate -s schemas/fix-recipe-v1.json -d tests/fixtures/fix-recipes/<name>.json` exiting 0.
- [ ] `src/standards/fix-recipe.ts` compiles under TypeScript strict mode.
- [ ] `FixRecipe` interface declares all eight fields with types matching the schema.
- [ ] `emitFixRecipe()` writes a file at `<stateDir>/fix-recipes/<violation_id>.json` with mode `0600` and returns the generated `violation_id`.
- [ ] The directory `<stateDir>/fix-recipes/` is created with mode `0700` if absent.
- [ ] `emitFixRecipe()` validates the constructed recipe against the schema before writing; an invalid input (e.g., `confidence: 1.5`) causes the call to throw and no file is written.
- [ ] The `violation_id` format matches the pattern (verifiable by re-reading the written file and re-validating).
- [ ] Two `emitFixRecipe()` calls with byte-identical input produce the same `violation_id`; calls with even one differing byte produce different IDs.
- [ ] The write is atomic: a partial write (simulated by killing mid-write) leaves either the previous content or the full new content, never partial. (Verified by file presence + JSON parse-ability invariant.)

## Dependencies

- **PLAN-020-1** (existing on main): the `rule-set-enforcement-reviewer` agent will call `emitFixRecipe()` from this spec when emitting findings. This spec defines the contract; the reviewer is unchanged in this spec.
- **PLAN-021-1** (blocking): `rule_id` format follows the namespaced regex `^[a-z0-9-]+:[a-z0-9-]+$` per `standards-v1.json`. The schema mirrors this pattern.
- **ajv** (existing dependency from PLAN-021-1's loader): used by `emitFixRecipe()` to validate before writing.
- **Node `crypto`** (built-in): `sha256` for the hash component of `violation_id`.
- **Node `fs/promises` and `path`** (built-in): file I/O.
- **No new external libraries**.

## Notes

- The schema is the source-of-truth contract for TDD-022 plugin chains. Vendoring (no remote `$ref`) keeps CI hermetic and the schema reviewable on every change.
- The `examples` field doubles as living documentation — anyone reading the schema sees three concrete recipes inline. The self-test (validating examples against the schema in CI) prevents drift between the examples and the schema's actual constraints.
- `violation_id` deterministic generation (timestamp + content hash) means re-emitting the same violation produces the same file path; this is intentional so duplicate emissions are coalesced rather than producing N redundant files.
- Mode `0600` on recipe files protects them from being world-readable (`<state-dir>` may live on a shared host); mode `0700` on the directory matches the convention used elsewhere in `<state-dir>/` per PLAN-002-1.
- `manual_review_required: true` overrides any `confidence` value — even `confidence: 1.0` with `manual_review_required: true` MUST NOT be auto-applied. This guard exists so the reviewer can flag fixes that are technically correct but contextually risky (e.g., touch a security-sensitive path).
- The PLAN-021-3 risk-table mitigation about recipe accumulation (30-day retention with archive) is operational and lives in PRD-007's existing cleanup tooling. This spec does not implement retention; it relies on the existing daemon cleanup pass.
- Future schema evolution: when fields are added (e.g., a `confidence_breakdown` or `evidence` field), bump to `fix-recipe-v2.json` and ship a translator. This spec does not anticipate breaking changes within v1.

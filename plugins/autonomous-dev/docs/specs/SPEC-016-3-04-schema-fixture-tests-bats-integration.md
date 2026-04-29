# SPEC-016-3-04: Schema Fixture Tests + Bats Integration

## Metadata
- **Parent Plan**: PLAN-016-3
- **Tasks Covered**: PLAN-016-3 Testing Strategy "Schema unit tests" (`tests/ci/test_plugin_schema.bats` + four fixtures); supports task 7 smoke pass by giving the implementer a deterministic local pre-flight check
- **Estimated effort**: 3 hours

## Description

Author the bats test harness and four JSON fixtures that exercise `.github/schemas/plugin.schema.json` (SPEC-016-3-01). Each fixture has a known expected ajv-cli exit code; the bats suite runs ajv-cli against each and asserts the outcome. This is the **schema's regression test suite** — it catches schema-drift bugs (PLAN-016-3 Risks "vendored schema drifts") and is the local pre-flight check called out in PLAN-016-3 Testing Strategy.

The harness runs locally (`bats tests/ci/test_plugin_schema.bats`) and is invoked by `npm test` so it participates in the existing `test` matrix job authored by PLAN-016-1. No new CI job is required.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `tests/fixtures/plugins/valid.json` | Create | Reference manifest matching all schema constraints |
| `tests/fixtures/plugins/missing-required.json` | Create | Same as valid.json minus a required field |
| `tests/fixtures/plugins/extra-field.json` | Create | Same as valid.json plus an undocumented field |
| `tests/fixtures/plugins/bad-version.json` | Create | Same as valid.json with a non-semver version |
| `tests/ci/test_plugin_schema.bats` | Create | Bats harness running ajv-cli against each fixture |
| `plugins/autonomous-dev/package.json` | Modify | Add `bats` dev dependency and a `test:ci` script (or extend `test`) that runs the bats suite |

If `tests/ci/` does not yet exist as a directory, create it. Bats convention is one `.bats` file per harness; do not bundle other test categories into this file.

## Implementation Details

### Fixture: `tests/fixtures/plugins/valid.json`

A complete manifest exercising every required field plus a representative subset of optional ones:

```json
{
  "name": "fixture-valid",
  "version": "1.2.3",
  "description": "Reference fixture for the plugin schema unit tests; must satisfy all required and optional constraints.",
  "author": {
    "name": "Schema Test Author",
    "email": "schema-test@example.com"
  },
  "repository": "https://github.com/example/fixture-valid",
  "keywords": ["fixture", "test", "schema"],
  "license": "MIT"
}
```

Constraints exercised: kebab-case `name`, full semver `version`, 50-char `description`, `author.name` + `author.email`, optional `repository`, `keywords`, `license`.

### Fixture: `tests/fixtures/plugins/missing-required.json`

Identical to `valid.json` minus the `version` field:

```json
{
  "name": "fixture-missing-required",
  "description": "Fixture missing the required version field; ajv-cli MUST exit non-zero.",
  "author": { "name": "Schema Test Author" }
}
```

### Fixture: `tests/fixtures/plugins/extra-field.json`

Identical to `valid.json` plus an undocumented root field:

```json
{
  "name": "fixture-extra-field",
  "version": "1.2.3",
  "description": "Fixture with an undocumented root field; additionalProperties:false MUST reject this.",
  "author": { "name": "Schema Test Author" },
  "build": "make all"
}
```

### Fixture: `tests/fixtures/plugins/bad-version.json`

Identical to `valid.json` with a malformed version:

```json
{
  "name": "fixture-bad-version",
  "version": "1.0",
  "description": "Fixture with a non-semver version; the version pattern MUST reject this.",
  "author": { "name": "Schema Test Author" }
}
```

`"1.0"` is not full semver (missing patch). `"v1.0.0"` would also be rejected (leading `v`). Either choice satisfies the contract; this spec uses `"1.0"` for clarity.

### Bats Harness: `tests/ci/test_plugin_schema.bats`

```bash
#!/usr/bin/env bats

# tests/ci/test_plugin_schema.bats
# Validates `.github/schemas/plugin.schema.json` against curated fixtures.
# Each fixture has a deterministic expected ajv-cli exit code.

setup() {
  # Resolve repo root (the directory containing .github/).
  REPO_ROOT="$(git rev-parse --show-toplevel)"
  SCHEMA="${REPO_ROOT}/.github/schemas/plugin.schema.json"
  FIXTURES="${REPO_ROOT}/tests/fixtures/plugins"
  AJV="npx --yes ajv-cli@8 validate --spec=draft2020 --strict=true"
}

@test "schema file exists" {
  [ -f "${SCHEMA}" ]
}

@test "valid.json passes ajv-cli" {
  run ${AJV} -s "${SCHEMA}" -d "${FIXTURES}/valid.json"
  [ "$status" -eq 0 ]
}

@test "missing-required.json fails ajv-cli" {
  run ${AJV} -s "${SCHEMA}" -d "${FIXTURES}/missing-required.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"required"* ]]
}

@test "extra-field.json fails ajv-cli with additionalProperties error" {
  run ${AJV} -s "${SCHEMA}" -d "${FIXTURES}/extra-field.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"additionalProperties"* || "$output" == *"additional properties"* ]]
}

@test "bad-version.json fails ajv-cli with pattern error" {
  run ${AJV} -s "${SCHEMA}" -d "${FIXTURES}/bad-version.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"pattern"* ]]
}

@test "real autonomous-dev manifest passes ajv-cli" {
  run ${AJV} -s "${SCHEMA}" -d "${REPO_ROOT}/plugins/autonomous-dev/.claude-plugin/plugin.json"
  [ "$status" -eq 0 ]
}

@test "real autonomous-dev-assist manifest passes ajv-cli" {
  run ${AJV} -s "${SCHEMA}" -d "${REPO_ROOT}/plugins/autonomous-dev-assist/.claude-plugin/plugin.json"
  [ "$status" -eq 0 ]
}
```

Behavioral contract:

1. **Self-locating** — `git rev-parse --show-toplevel` makes the suite runnable from any directory inside the repo (and from inside the bats temp dir Bash spawns).
2. **Deterministic flags** — every ajv-cli invocation uses the same flags as the CI fallback (SPEC-016-3-03): `--spec=draft2020 --strict=true`, `ajv-cli@8`, `npx --yes`. Drift between local and CI flag sets would break the "local pre-flight check" promise.
3. **Substring assertions** — `[[ "$output" == *"required"* ]]` matches either ajv-cli's output phrasing (`"missing required property"` or `"required"`); the assertion is permissive enough to survive minor ajv-cli wording changes within the major.
4. **Real-manifest gates** — the last two tests pin the schema to the existing in-repo manifests so a future schema edit that breaks them is caught locally before push.

### `package.json` Wiring

In `plugins/autonomous-dev/package.json`, add:

- `devDependencies.bats`: `"^1.10.0"` (or pin the major locally available; if `bats` is provided by the runner image rather than npm, add a `peerDependenciesMeta` note and document the precondition).
- `scripts.test:ci-schema`: `"bats tests/ci/test_plugin_schema.bats"` — invokable directly.
- Ensure the existing `scripts.test` (or the equivalent run by PLAN-016-1's `test` job) includes `tests/ci/*.bats` execution. Concretely: extend `scripts.test` to `"... && bats tests/ci"` or add a `pretest`/`posttest` hook that runs `bats tests/ci`.

If `bats` is not yet present in the project, the implementer MUST verify it is available on the GitHub Actions runner (`bats --version` on `ubuntu-latest`) — it ships preinstalled. Local developers may need `brew install bats-core` or `apt-get install bats`; document this in the PR description.

## Acceptance Criteria

### Fixtures

- [ ] All four fixture files exist at the documented paths and parse as valid JSON.
- [ ] `valid.json` matches every constraint in SPEC-016-3-01 (required + at least three optional fields).
- [ ] `missing-required.json` is missing exactly one required field (`version`).
- [ ] `extra-field.json` adds exactly one undocumented root field (`build`).
- [ ] `bad-version.json` has a non-semver `version` value (`"1.0"`).

### Bats harness

- [ ] `tests/ci/test_plugin_schema.bats` exists, has a `#!/usr/bin/env bats` shebang, and is executable (`chmod +x`).
- [ ] Running `bats tests/ci/test_plugin_schema.bats` from the repo root (with `npm` and node available) produces 7 passing tests.
- [ ] `valid.json` test passes.
- [ ] `missing-required.json` test fails ajv-cli with `required` in the output.
- [ ] `extra-field.json` test fails ajv-cli with `additionalProperties` (or `additional properties`) in the output.
- [ ] `bad-version.json` test fails ajv-cli with `pattern` in the output.
- [ ] Both real manifest tests pass against the current in-repo manifests.
- [ ] Mutating any fixture to invert its expected outcome (e.g., add `version` back to `missing-required.json`) makes the corresponding bats test fail; reverting restores the pass.
- [ ] Renaming `.github/schemas/plugin.schema.json` causes the `schema file exists` test to fail.

### Wiring

- [ ] `bats` dev dependency or runner-precondition is documented and satisfied.
- [ ] `scripts.test:ci-schema` (or equivalent) exists in `plugins/autonomous-dev/package.json` and runs the bats harness.
- [ ] The PLAN-016-1 `test` job picks up the bats suite either via the existing `npm test` script or via a new `npm run test:ci-schema` step in the bats harness's working directory. Document the wiring choice in the PR description.

## Test Requirements

The four fixtures + the bats harness ARE the tests for this spec. Validation is self-referential: the bats suite passing constitutes acceptance.

For end-to-end verification (in addition to local `bats tests/ci/test_plugin_schema.bats`):

| Scenario | Expected |
|----------|----------|
| `npm test` in `plugins/autonomous-dev/` | Bats suite executes; 7/7 pass |
| Mutate `valid.json` to remove `description` | Bats `valid.json` test fails; CI red |
| Mutate `.github/schemas/plugin.schema.json` to remove `additionalProperties: false` | Bats `extra-field.json` test fails (now it would pass ajv-cli); CI red |
| Add a fifth fixture `tests/fixtures/plugins/long-description.json` (description > 200 chars) | Existing 7 tests still pass; future PR can add an 8th test for it |

## Dependencies

- **Consumes**:
  - SPEC-016-3-01: `.github/schemas/plugin.schema.json` is the schema under test.
  - PLAN-016-1's `test` job for CI execution wiring.
- **Exposes**:
  - `tests/fixtures/plugins/*.json` reusable by future tooling (pre-commit hooks, marketplace publish workflows) that needs known-bad inputs.
  - `tests/ci/test_plugin_schema.bats` as the canonical regression test for schema edits.
- **External**:
  - `ajv-cli@8.x` (same pin as SPEC-016-3-03).
  - `bats-core@1.x` (preinstalled on `ubuntu-latest`; documented as a local-dev precondition).

## Notes

- **Why bats and not Jest?** The schema validation is exercised via a CLI (`ajv-cli`) whose contract is exit-code + stderr text. Bats is the idiomatic harness for shell-level CLI assertions; mirroring those assertions in Jest would require shelling out anyway. Future schema-related testing that runs against a JS/TS API (e.g., a programmatic `validatePlugin()` helper) would justify Jest tests.
- **Why include the real manifests in the bats suite?** They are the lowest-cost regression check against schema-vs-reality drift (PLAN-016-3 Risks). If a future schema edit breaks the existing manifests, the bats suite catches it before CI even runs the workflow.
- **Why `npx --yes ajv-cli@8` instead of installing ajv-cli as a dev dependency?** Matches SPEC-016-3-03's CI invocation exactly. Adding it as a dev dep would diverge the local and CI tooling, defeating the "local pre-flight" promise.
- **Why fixtures live under `tests/fixtures/plugins/` and not `tests/ci/fixtures/`?** PLAN-016-3 Testing Strategy explicitly names the path `tests/fixtures/plugins/*.json` so future tooling (e.g., a TypeScript validator's unit tests) can share the same fixtures. Co-locating fixtures with bats would silo them.
- **Permissive substring matching** — bats assertions use `*"required"*` and `*"pattern"*` rather than full-output equality. The reasoning: ajv-cli's exact wording can shift within the v8 major (e.g., `"missing required property 'version'"` vs `"required must have property version"`); the substring matches survive those tweaks while still proving the validator caught the right failure mode.
- **First-test ordering** — `schema file exists` is intentionally first so a missing schema produces ONE clear failure rather than four ajv-cli "schema not found" errors that obscure the real cause.

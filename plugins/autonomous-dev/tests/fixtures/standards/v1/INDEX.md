# Standards v1 fixture index (SPEC-021-1-05)

Drives the loader test suite at `tests/standards/test-loader.test.ts`. The
parser at `tests/standards/parse-fixtures-index.ts` extracts the two tables
below and feeds them to `describe.each`. To extend coverage with a new
fixture, drop the file in `valid/` or `invalid/` and add a row here — no
test code changes required.

## Valid fixtures

| File | Description |
|------|-------------|
| valid/minimal.yaml | One rule, no immutable flag, simplest possible artifact. |
| valid/multi-rule.yaml | Three rules covering every severity. |
| valid/empty-rules.yaml | Empty `rules: []` (schema permits zero rules). |

## Invalid fixtures

| File | Expected error type | Reason |
|------|---------------------|--------|
| invalid/missing-version.yaml | schema_error | Top-level `version` is required. |
| invalid/wrong-version.yaml | schema_error | Schema constrains `version` to the literal "1". |
| invalid/bad-id.yaml | schema_error | Rule id violates the kebab-case + single-colon pattern. |
| invalid/empty-applies-to.yaml | schema_error | `applies_to` has zero properties. |
| invalid/multiple-errors.yaml | schema_error | Two violations — both must surface in errors[]. |
| invalid/python-object-tag.yaml | parse_error | `!!python/object` rejected by FAILSAFE_SCHEMA. |
| invalid/js-function-tag.yaml | parse_error | `!!js/function` rejected by FAILSAFE_SCHEMA. |

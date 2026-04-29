# PLAN-021-1: Standards Schema + Inheritance Resolver + Auto-Detection Scanner

## Metadata
- **Parent TDD**: TDD-021-standards-dsl-auto-detection
- **Estimated effort**: 4 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0

## Objective
Deliver the foundational standards artifact: the `standards.yaml` JSON Schema and DSL with `applies_to` predicates and `requires` assertions, the namespaced rule ID format (`<plugin>:<id>`), the inheritance resolver that merges defaults → org → repo → request with immutability enforcement, and the auto-detection scanner that infers rules from existing repo signals (eslint, prettier, jest, tsconfig, package.json, requirements.txt). This plan ships the standards substrate; PLAN-021-2 adds the evaluator catalog with sandbox/ReDoS protection, and PLAN-021-3 adds the standards-aware author agents and governance reviewer.

## Scope
### In Scope
- `schemas/standards-v1.json` per TDD §5: `version`, `metadata` (name/description/owner/last_updated), `rules[]` where each rule has `id` (namespaced regex `^[a-z0-9-]+:[a-z0-9-]+$`), `severity` (advisory|warn|blocking), optional `immutable: bool`, `description`, `applies_to: predicate`, `requires: assertion`, `evaluator` (string referencing the evaluator catalog from PLAN-021-2)
- DSL types: `Predicate` (language, service_type, framework, implements, path_pattern), `Assertion` (framework_match, exposes_endpoint, uses_pattern, excludes_pattern, dependency_present, custom_evaluator_args)
- TypeScript interfaces in `src/standards/types.ts` mirroring the schema
- `<repo>/.autonomous-dev/standards.yaml` location and `~/.claude/autonomous-dev/standards.yaml` org-level location
- `InheritanceResolver` class at `src/standards/resolver.ts` per TDD §8 with `resolveStandards(defaultRules, orgRules, repoRules, requestOverrides)` returning a `Map<string, Rule>` keyed by rule ID. Repo overrides org unless org rule is `immutable: true`. Per-request overrides require admin authorization.
- `Source` tracking in the resolver: per-rule `Map<string, "default" | "org" | "repo" | "request">` so observability can show where each rule came from
- `AutoDetectionScanner` at `src/standards/auto-detection.ts` per TDD §9: scans `package.json`, `requirements.txt`, `pyproject.toml`, `.eslintrc.json`, `.prettierrc`, `tsconfig.json`, `jest.config.js`, and emits `DetectedRule[]` with `confidence` (0-1) and `evidence[]` (file paths)
- Confidence rubric per TDD §9: explicit dep in package.json = 0.9, used in 80%+ files = 0.8, mentioned in README = 0.6, single example = 0.4
- Scanner output written to `<repo>/.autonomous-dev/standards.inferred.yaml` with confidence scores; operator promotes to `standards.yaml` after review
- CLI `autonomous-dev standards scan` runs the scanner and prints a diff against the existing `standards.yaml`
- CLI `autonomous-dev standards show [--rule <id>]` prints resolved standards (with source) and source-of-truth for each rule
- CLI `autonomous-dev standards validate <path>` schema-checks a standards.yaml file
- 50+ fixture standards.yaml files at `tests/fixtures/standards/` covering valid + invalid examples
- 20 known-repo fixtures at `tests/fixtures/repos/` with ground-truth expected detections
- Unit tests for: schema validation (valid + invalid fixtures), inheritance resolver (8 scenarios per TDD §14), auto-detection (per-signal-type precision check)
- Integration test: end-to-end load default + org + repo standards, run inheritance resolver, verify resolved set matches expected

### Out of Scope
- Built-in evaluator catalog (framework-detector, endpoint-scanner, sql-injection-detector, dependency-checker, pattern-grep) -- PLAN-021-2
- Custom evaluator subprocess sandbox (execFile, ro-fs, no-net, 30s/256MB) -- PLAN-021-2
- ReDoS defense via worker-thread sandbox -- PLAN-021-2
- Standards-aware author agent prompts (prd-author, tdd-author, code-executor) -- PLAN-021-3
- Standards-meta-reviewer governance agent -- PLAN-021-3
- Fix-recipe schema for plugin chains -- PLAN-021-3 (schema only); TDD-022 will own the actual chaining
- Plugin chaining (`produces`/`consumes`) -- TDD-022
- The rule-set-enforcement-reviewer that consumes standards -- PLAN-020-1

## Tasks

1. **Author `standards-v1.json` schema** -- Create the JSON Schema per TDD §5 with all required fields, the namespaced rule ID pattern, the predicate/assertion sub-schemas, and `additionalProperties: false` at every level. Schema includes a worked example.
   - Files to create: `plugins/autonomous-dev/schemas/standards-v1.json`
   - Acceptance criteria: Schema validates the TDD §5 example clean. A rule missing `evaluator` fails. A rule with `id: "no-namespace"` (missing colon) fails. A rule with `severity: "panic"` fails. The schema declares `$schema: "https://json-schema.org/draft/2020-12/schema"` and `$id`.
   - Estimated effort: 3h

2. **Author TypeScript types** -- Create `src/standards/types.ts` with `Rule`, `Predicate`, `Assertion`, `Severity`, `StandardsArtifact` interfaces matching the schema. Use discriminated unions where appropriate.
   - Files to create: `plugins/autonomous-dev/src/standards/types.ts`
   - Acceptance criteria: TypeScript strict mode compiles. Interfaces match the schema field-for-field. JSDoc cross-references TDD §5.
   - Estimated effort: 1.5h

3. **Implement `InheritanceResolver`** -- Create `src/standards/resolver.ts` per TDD §8 with the `resolveStandards()` function that takes four rule arrays (default, org, repo, request) and returns `{rules: Map<id, Rule>, source: Map<id, source>}`. Repo overrides org unless immutable. Per-request requires admin auth (`isAdminRequest()` helper to be implemented later; this plan uses a stub that always returns false unless explicitly mocked).
   - Files to create: `plugins/autonomous-dev/src/standards/resolver.ts`
   - Acceptance criteria: Default-only input produces a map with all defaults sourced from `default`. Org rule overrides default; repo rule overrides org unless org is immutable. Immutable org rule + non-admin repo override throws `ValidationError`. Per-request override without admin throws `AuthorizationError`. Per-request with admin succeeds.
   - Estimated effort: 4h

4. **Implement YAML loader** -- Add `loadStandardsFile(path)` at `src/standards/loader.ts` that reads YAML, parses to `StandardsArtifact`, validates against the JSON schema, returns `{artifact, errors[]}`. Uses `js-yaml` with safe-loading.
   - Files to create: `plugins/autonomous-dev/src/standards/loader.ts`
   - Acceptance criteria: Loading a valid YAML file produces an artifact and empty errors. Loading an invalid YAML (syntax error) produces `errors: [{type: 'parse_error', message: ...}]`. Loading a YAML that fails schema validation produces `errors: [{type: 'schema_error', path: ..., message: ...}]`. YAML with arbitrary code execution (e.g., `!!python/object`) is rejected (use safe-load).
   - Estimated effort: 2h

5. **Implement `AutoDetectionScanner`** -- Create `src/standards/auto-detection.ts` per TDD §9. Detection signals:
   - Framework deps: `pkg.dependencies.fastapi`, `flask`, `express`, `react`, `vue`, etc. → `auto:<framework>` rule with confidence 0.9
   - Linter configs: `.eslintrc.json` rules → `auto:eslint-<rule>` with confidence 0.9
   - Prettier config: `.prettierrc` → `auto:prettier-formatting` with confidence 0.9
   - tsconfig strict mode: `tsconfig.json` `compilerOptions.strict` → `auto:typescript-strict-mode` with confidence 0.85
   - Jest test patterns: `jest.config.js` `testMatch` → `auto:test-file-pattern` with confidence 0.7
   - README mention of a tool (e.g., "We use Black for Python formatting") → confidence 0.6
   - Files to create: `plugins/autonomous-dev/src/standards/auto-detection.ts`
   - Acceptance criteria: Scanner against a fixture FastAPI repo detects `auto:python-fastapi` with confidence 0.9 and evidence `["package.json"]` (or `requirements.txt`). Scanner against a no-config repo emits empty `[]` (or only generic rules with low confidence). Tests cover at least 6 distinct signals.
   - Estimated effort: 6h

6. **Author scanner output writer** -- Add `writeInferredStandards(repoPath, detected[])` that serializes detected rules to `<repo>/.autonomous-dev/standards.inferred.yaml` with a header comment explaining "this file is auto-generated; review and promote to standards.yaml after operator review". Confidence and evidence are included as YAML comments next to each rule.
   - Files to modify: `plugins/autonomous-dev/src/standards/auto-detection.ts`
   - Acceptance criteria: Output file is valid YAML and validates against `standards-v1.json` (after stripping the comments). Header comment is present. Each rule has its confidence and evidence in adjacent comments. Re-running the scanner on the same repo produces a deterministic output (same byte content if inputs unchanged).
   - Estimated effort: 2h

7. **Implement `standards scan` CLI subcommand** -- `autonomous-dev standards scan [--repo <path>] [--diff]` runs the scanner and prints results. With `--diff`, computes the difference vs existing `standards.yaml` and shows added/removed/changed rules. Without `--diff`, prints the inferred set.
   - Files to create: `plugins/autonomous-dev/src/cli/commands/standards-scan.ts`
   - Acceptance criteria: `standards scan` prints all detected rules with confidence. `--diff` against an existing `standards.yaml` shows additions only (since the scanner doesn't know what's in the existing file but confirmed). `--json` output mode emits structured results. Tests cover both modes.
   - Estimated effort: 2h

8. **Implement `standards show` and `standards validate` subcommands** -- `standards show [--rule <id>]` prints the resolved standards from inheritance with source attribution. `standards validate <path>` schema-checks a file.
   - Files to create: `plugins/autonomous-dev/src/cli/commands/standards-show.ts`, `standards-validate.ts`
   - Acceptance criteria: `standards show` prints all resolved rules in tabular form with columns `id`, `severity`, `source`, `description`. `--rule org:python-fastapi` prints only that rule with its full definition. `standards validate /tmp/test.yaml` exits 0 on valid, 1 on invalid with error pointing at the field.
   - Estimated effort: 2h

9. **Author 50+ fixture standards.yaml files** -- Create fixtures under `tests/fixtures/standards/`: valid examples (small, medium, large), invalid examples (missing fields, bad regex, schema violations), edge cases (empty rules array, unicode descriptions, very long IDs). At least 30 valid + 20 invalid.
   - Files to create: 50+ files under `plugins/autonomous-dev/tests/fixtures/standards/`
   - Acceptance criteria: All valid fixtures schema-validate clean. All invalid fixtures fail with the documented error type. Fixtures cover all severity levels, both immutable and mutable rules, all predicate combinations.
   - Estimated effort: 4h

10. **Author 20 known-repo fixtures with ground-truth detections** -- Create minimal repo fixtures under `tests/fixtures/repos/` (just `package.json`, `tsconfig.json`, etc. — not full source trees). Each has a JSON file `expected-detections.json` listing the rules the scanner should produce.
    - Files to create: 20 directories under `plugins/autonomous-dev/tests/fixtures/repos/`
    - Acceptance criteria: 20 repo fixtures spanning Python (FastAPI/Flask), Node (Express/React), TypeScript (strict + non-strict), Vue, Angular, vanilla. Each `expected-detections.json` matches what the scanner should produce per the confidence rubric.
    - Estimated effort: 4h

11. **Unit tests for resolver, loader, scanner** -- `tests/standards/test-resolver.test.ts`, `test-loader.test.ts`, `test-auto-detection.test.ts` covering all paths. Resolver tests cover the 8 scenarios from TDD §14. Auto-detection precision target ≥80% per signal type per TDD §14.
    - Files to create: three test files under `plugins/autonomous-dev/tests/standards/`
    - Acceptance criteria: All tests pass. Coverage ≥95% on `resolver.ts`, `loader.ts`, `auto-detection.ts`. Auto-detection precision computed across the 20 repo fixtures meets the ≥80% target per signal.
    - Estimated effort: 4h

12. **Integration test: end-to-end resolution** -- `tests/integration/test-standards-flow.test.ts` that loads default + org + repo standards files (from fixtures), runs the resolver, asserts the resolved map matches the expected ground truth. Includes the immutability enforcement scenario.
    - Files to create: `plugins/autonomous-dev/tests/integration/test-standards-flow.test.ts`
    - Acceptance criteria: Test passes deterministically. Resolver output matches expected. Immutability test attempts to override an immutable org rule from repo; assertion fires with the right error type.
    - Estimated effort: 2h

## Dependencies & Integration Points

**Exposes to other plans:**
- `standards-v1.json` schema and `Rule`/`Predicate`/`Assertion` types consumed by PLAN-021-2 (evaluator catalog), PLAN-021-3 (author agents), PLAN-020-1 (rule-set-enforcement-reviewer), and any future plan that consumes standards.
- `InheritanceResolver` reused by any future plan that needs hierarchical config resolution (e.g., the `extensions` config could adopt the same pattern).
- `AutoDetectionScanner` reused by future plans that scan repos for additional signals.
- Fixture corpus (50+ standards files, 20 repo fixtures) reused for testing across PLAN-021-2 / PLAN-021-3 / PLAN-020-1.
- `standards.inferred.yaml` location and format consumed by operators for review-and-promote workflow.

**Consumes from other plans:**
- TDD-007 / PLAN-007-X: existing config infrastructure for `~/.claude/autonomous-dev/standards.yaml` org-level location.
- PRD-009 / TDD-009: `isAdminRequest()` admin authorization helper (stubbed in this plan, fully implemented in the trust ladder plan that already exists on main).

## Testing Strategy

- **Unit tests (task 11):** Resolver scenarios, loader error paths, scanner per-signal precision. ≥95% coverage on new files.
- **Integration test (task 12):** End-to-end inheritance resolution with default + org + repo standards.
- **Schema validation:** All 50+ fixture standards files validate (or fail with documented errors) in CI.
- **Auto-detection precision:** Computed across the 20 repo fixtures; target ≥80% per signal. Reported as a CI metric.
- **Manual smoke:** Run `standards scan` against a real repo (e.g., the autonomous-dev plugin itself); verify the inferred output is sensible.
- **Negative tests:** YAML with `!!python/object` (RCE attempt) is rejected by safe-load. Schema with extra top-level field rejected by `additionalProperties: false`.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| YAML safe-loading misses an exotic exploitation vector (e.g., billion-laughs DoS) | Low | High -- DoS via malicious standards file | Use `js-yaml` with `FAILSAFE_SCHEMA` or `CORE_SCHEMA` (no custom tags). Limit input file size to 1MB. Test with adversarial fixtures (deeply nested objects, very large arrays, unicode bombs). |
| Inheritance resolver's immutability check has a bypass via per-request override | Low | Critical -- security control circumvented | Per-request override requires `isAdminRequest()` to return true. The check is in the resolver, not bypassable from the calling code. Tests include attempts to bypass via crafted contexts. |
| Auto-detection produces too many false positives, drowning operators in noise | High | Medium -- inferred file becomes useless | Confidence rubric (0.9 / 0.8 / 0.6 / 0.4) is conservative. Operators review and promote individually. Future enhancement: add `--min-confidence 0.8` flag to filter low-confidence detections. Documented in operator guide. |
| Auto-detection misses a critical convention (e.g., a team uses a custom linter) | Medium | Low -- operator manually adds the rule | The scanner is "best effort" — documented as such. Operators are the source of truth for `standards.yaml`. The scanner is a starting point, not a replacement. |
| Schema's namespaced rule ID format (`<plugin>:<id>`) is too restrictive (e.g., teams want hyphens or dots) | Low | Low -- pattern can be relaxed in v2 | Pattern `^[a-z0-9-]+:[a-z0-9-]+$` allows hyphens. Documented in the JSDoc with rationale (kebab-case is the project convention). Future v1.1 schema can extend to support dots if needed. |
| Performance: standards resolution slow on large org files (1000+ rules) | Low | Low -- one-time cost at request startup | Resolver uses Map for O(n) merge. Benchmark in task 11 with a 1000-rule fixture; target <500ms total. Cached per request lifetime (TDD §4 architecture). |

## Definition of Done

- [ ] `standards-v1.json` schema exists with namespaced ID regex, severity enum, predicate/assertion sub-schemas
- [ ] TypeScript types match the schema field-for-field
- [ ] `InheritanceResolver` correctly merges default → org → repo → request with immutability enforcement
- [ ] Per-request override requires admin authorization (stubbed for now; integration via PRD-009)
- [ ] YAML loader uses safe-load and rejects code-execution exploits
- [ ] `AutoDetectionScanner` covers at least 6 distinct signals (frameworks, linters, formatter, test patterns, tsconfig, README mentions)
- [ ] Confidence rubric (0.9 / 0.8 / 0.6 / 0.4) is applied per TDD §9
- [ ] Scanner output (`standards.inferred.yaml`) is valid YAML and includes confidence + evidence comments
- [ ] CLI subcommands (`standards scan`, `show`, `validate`) work with `--json` output mode
- [ ] 50+ fixture standards files exist (30+ valid, 20+ invalid)
- [ ] 20 known-repo fixtures with ground-truth detections exist
- [ ] Unit tests pass with ≥95% coverage on resolver, loader, auto-detection
- [ ] Auto-detection precision ≥80% per signal type across the 20 repo fixtures
- [ ] Integration test demonstrates end-to-end resolution with all four levels
- [ ] No regressions in existing config infrastructure

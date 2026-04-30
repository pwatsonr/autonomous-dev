# SPEC-021-3-04: Unit and Integration Tests for Standards-Aware Author Flow

## Metadata
- **Parent Plan**: PLAN-021-3
- **Tasks Covered**: Task 11 (unit tests for renderer, fix-recipe, meta-reviewer agent), Task 12 (integration test for end-to-end standards flow)
- **Estimated effort**: 6 hours
- **Future location**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-021-3-04-unit-and-integration-tests.md`

## Description
Author the test suite that exercises everything shipped by SPEC-021-3-01 (prompt renderer + author injection), SPEC-021-3-02 (standards-meta-reviewer + two-person approval), and SPEC-021-3-03 (fix-recipe schema + emitter). Three unit-test files cover the renderer, the fix-recipe schema/emitter, and the meta-reviewer agent file's static structure. One integration test simulates the full standards-aware flow end-to-end with mocked agent responses.

The unit tests target ≥95% line coverage on `src/standards/prompt-renderer.ts` and `src/standards/fix-recipe.ts` per PLAN-021-3 task 11. The meta-reviewer agent test validates the agent file's static frontmatter and prompt structure (read-only tools, four detection categories, two-person-approval directive) — the agent's actual output behavior is exercised by the integration test. The integration test mocks Claude responses to keep the suite deterministic and CI-friendly.

This spec does NOT introduce production code; it consumes the artifacts shipped by SPEC-021-3-01/02/03. If those specs are implemented incorrectly, this spec's tests are the safety net.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/standards/test-prompt-renderer.test.ts` | Create | Unit tests for `renderStandardsSection()` |
| `plugins/autonomous-dev/tests/standards/test-fix-recipe.test.ts` | Create | Unit tests for schema validation + `emitFixRecipe()` round-trip |
| `plugins/autonomous-dev/tests/standards/test-meta-reviewer-agent.test.ts` | Create | Static validation of `agents/standards-meta-reviewer.md` |
| `plugins/autonomous-dev/tests/integration/test-standards-author-flow.test.ts` | Create | End-to-end: meta-review trigger + session-spawn substitution + fix-recipe emission |

## Implementation Details

### Test Framework

Tests use the existing project test runner (Vitest, per the convention established by PLAN-021-1's tests). Each file uses `describe`/`it` blocks. Helpers are defined inline in each file unless reused across files; reusable helpers go under `tests/standards/_helpers/`.

### `tests/standards/test-prompt-renderer.test.ts`

Required test cases (each MUST pass):

1. **Empty resolver returns sentinel.** Build a `ResolvedStandards` with an empty rules map. Assert `renderStandardsSection(resolved) === "No standards apply."` (strict equality, no whitespace).
2. **Single blocking rule renders correctly.** One rule, severity `blocking`, id `security:no-sql`, description `"No string interpolation in SQL"`, assertion `excludes_pattern` with `pattern: "${.*}"`. Assert the output contains `### [blocking] security:no-sql`, the description verbatim, and the derived "Do this: do not introduce code matching `${.*}`."
3. **Multi-severity ordering.** Three blocking, two warn, one advisory. Assert the rendered output lists all three blocking blocks BEFORE the first warn block, all warn blocks BEFORE the advisory block. Verify by `indexOf` comparisons on the rendered string.
4. **Within-severity alpha sort.** Two blocking rules with ids `security:zzz` and `security:aaa`. Assert `security:aaa` appears before `security:zzz` in the output.
5. **Cap fallback drops advisory.** Construct 50 advisory rules whose combined rendered length exceeds 2048 bytes. Assert the output is ≤ 2048 bytes (or close to it; strictly: `Buffer.byteLength(result, 'utf8') <= 2048` for the body before the directive). Assert the output contains the substring `additional advisory rules apply; see standards.yaml for full list.`
6. **Cap does not drop blocking/warn.** Construct 100 blocking rules. Assert the rendered output contains all 100 (verified by counting `### [blocking]` occurrences) even though it exceeds the cap.
7. **Custom maxBytes override.** Render the same input with `maxBytes: 256` and `maxBytes: 8192`. Assert the 8192 output is longer (more advisory rules retained).
8. **UTF-8 byte counting.** Construct a rule with description `"使用 UTF-8 编码"` (CJK glyphs). Assert the output renders the description verbatim. Assert that the cap calculation uses byte-length (verified by passing a tight cap and observing the right number of rules survive given UTF-8 expansion).
9. **Unknown assertion kind fallback.** Construct a rule with `assertion.kind: "future_kind"`. Assert the rendered "Do this" line is `Do this: see standards.yaml rule <id> for the full requirement.`
10. **Each known assertion kind renders the right "Do this" line.** Parameterized test over `framework_match`, `exposes_endpoint`, `uses_pattern`, `excludes_pattern`, `dependency_present`, `custom_evaluator_args`. Assert the derived instruction text matches the spec's table for each.

Coverage assertion: after running, `npx vitest run --coverage tests/standards/test-prompt-renderer.test.ts` reports ≥95% line coverage on `src/standards/prompt-renderer.ts`.

### `tests/standards/test-fix-recipe.test.ts`

Required test cases:

1. **Schema validates each fixture.** For each of `code-replacement-sql.json`, `file-creation-health.json`, `dependency-add-fastapi.json`, load the JSON and assert ajv validation passes.
2. **Schema rejects missing `violation_id`.** Take a fixture, delete `violation_id`, assert validation fails with an error mentioning the missing required property.
3. **Schema rejects invalid `fix_type`.** Set `fix_type: "magic-fix"`, assert validation fails with an enum error.
4. **Schema rejects `confidence > 1`.** Set `confidence: 1.5`, assert validation fails.
5. **Schema rejects `confidence < 0`.** Set `confidence: -0.1`, assert validation fails.
6. **Schema rejects malformed `violation_id`.** Set `violation_id: "VIO-bad"`, assert validation fails with a pattern error.
7. **Schema rejects malformed `rule_id`.** Set `rule_id: "no-namespace"` (missing colon), assert validation fails.
8. **Schema rejects extra root field.** Add `extra_field: "x"`, assert validation fails (`additionalProperties` error).
9. **Schema's `examples` self-test.** Load `fix-recipe-v1.json`, iterate `schema.examples`, assert each example validates against the schema itself.
10. **`emitFixRecipe()` round-trip.** Create a temp `stateDir` (use `os.tmpdir()` + random suffix). Construct a `Violation` matching `code-replacement-sql.json` minus `violation_id`. Call `emitFixRecipe(violation, stateDir)`. Read the emitted file. Assert the file's contents validate against the schema and the parsed `violation_id` matches the value returned by the function.
11. **`emitFixRecipe()` validation failure.** Pass a `Violation` with `confidence: 1.5`. Assert the call throws and no file was created.
12. **`emitFixRecipe()` deterministic ID for identical input.** Call twice with byte-identical input within the same second. Assert both calls return the same `violation_id` (and the file content is identical).
13. **`emitFixRecipe()` distinct ID for differing input.** Call twice with one byte different (e.g., differing `confidence`). Assert the two `violation_id` values differ in the hash component.
14. **`emitFixRecipe()` creates directory with mode 0700.** Pass a non-existent `stateDir`. After the call, assert `<stateDir>/fix-recipes/` exists with mode `0700` (mask the mode bits to ignore umask noise).
15. **`emitFixRecipe()` writes file with mode 0600.** After the call, assert the recipe file mode is `0600`.

Coverage assertion: ≥95% line coverage on `src/standards/fix-recipe.ts`.

### `tests/standards/test-meta-reviewer-agent.test.ts`

Static validation of `agents/standards-meta-reviewer.md`. No agent execution; this is a structure check.

Required test cases:

1. **Frontmatter parses as YAML.** Load the file, extract the frontmatter block (between the two `---` lines), parse via `js-yaml.safeLoad`. Assert no error.
2. **Frontmatter has the right name.** Assert `frontmatter.name === "standards-meta-reviewer"`.
3. **Frontmatter has the right model.** Assert `frontmatter.model === "claude-sonnet-4-6"`.
4. **Frontmatter declares exactly the read-only tools.** Assert `frontmatter.tools` is an array with exactly the elements `Read`, `Glob`, `Grep` (set equality, no duplicates, no extras).
5. **Frontmatter does NOT declare any mutating tools.** Explicitly assert that `Write`, `Edit`, `Bash`, `MultiEdit`, `NotebookEdit` are NOT present in `frontmatter.tools`.
6. **Prompt body contains the four detection sections.** Assert the body (text after the closing `---`) contains the substrings (case-insensitive, allowing minor heading variation): `"detect rule conflicts"`, `"detect unworkability"`, `"detect impact"`, `"detect overly broad predicates"`.
7. **Prompt body contains the two-person-approval directive.** Assert the body contains `"requires_two_person_approval"` and the three trigger conditions: `"immutable: true"` (or close variant), `"framework_match"` (or `"framework requirement"`), and language about ADD/REMOVE.
8. **Prompt body contains the false-positive guard.** Assert the body contains `"single change"` AND `"NOT a delete-then-add"` (or close phrasing about update vs delete+add).
9. **Prompt body contains the impact-scan cap.** Assert the body contains the substring `"50 commits"` (or `"--max-count=50"`).
10. **Prompt body references the output schema.** Assert the body contains `"reviewer-finding-v1.json"` (or path-equivalent).

Coverage assertion: not applicable (this test file exercises a static asset, not TS code).

### `tests/integration/test-standards-author-flow.test.ts`

End-to-end test, mocked Claude responses, deterministic.

Setup (`beforeAll`):
- Create a temp repo directory with: `package.json` declaring `fastapi` (to make the resolver produce at least one rule), `.autonomous-dev/standards.yaml` containing two rules (one blocking, one advisory).
- Mock the Claude SDK: subsequent agent invocations return canned JSON responses defined per-test.

Required test scenarios:

1. **Meta-reviewer trigger fires on `standards.yaml` change.**
   - Simulate a PR diff that includes `<repo>/.autonomous-dev/standards.yaml` (the change adds an `immutable: true` rule).
   - Invoke the chain resolver + scheduler from PLAN-020-2. Assert the scheduler queues the `standards-meta-reviewer` agent.
   - Mock the agent's response to be a valid `reviewer-finding-v1.json` JSON object with `requires_two_person_approval: true`.
   - Run the aggregator. Assert the aggregator's verdict is `BLOCKED` (because no human approvers exist in the mocked PR context).
2. **Meta-reviewer trigger does NOT fire when `standards.yaml` is unchanged.**
   - Simulate a PR diff containing only `src/foo.ts`. Invoke the scheduler. Assert the meta-reviewer is NOT queued.
3. **Session spawn substitutes the standards section.**
   - Invoke the session-spawn helper from SPEC-021-3-01 with the temp repo and a request ID.
   - Capture the agent prompt that would be sent to Claude (intercept at the spawner's "send prompt" boundary).
   - Assert the prompt does NOT contain the literal token `{{STANDARDS_SECTION}}`.
   - Assert the prompt contains the rendered standards markdown including the heading `## Standards in Effect for This Task` AND at least one `### [blocking]` block matching the fixture rule.
4. **Cache hit on second spawn within same request.**
   - Invoke the session-spawn helper twice for the same request ID. Spy on the resolver/render-cli invocation. Assert it ran exactly once across the two spawns.
5. **Fix-recipe emission and validation.**
   - Simulate a violation: construct a `Violation` matching the SPEC-021-3-03 `code-replacement-sql` shape, but pointing at a real file path inside the temp repo.
   - Call `emitFixRecipe(violation, tempStateDir)`.
   - Assert the resulting file exists at `<tempStateDir>/fix-recipes/<violation_id>.json`.
   - Re-read the file and validate it against `fix-recipe-v1.json`. Assert validation passes.
   - Assert the rendered agent prompt (from scenario 3) is independent of the fix-recipe (no leak between flows).
6. **Two-person approval gate releases on second approver.**
   - Continuing from scenario 1, simulate two distinct human approvers on the PR (mock the GitHub API). Re-run the aggregator. Assert the verdict is no longer `BLOCKED` (passes scoring rules per the existing aggregator logic).
7. **Bot approver does not count.**
   - Continuing from scenario 1, simulate one human approver and one `dependabot[bot]` approver. Re-run the aggregator. Assert the verdict is still `BLOCKED` (only one distinct human approver).

Cleanup (`afterAll`):
- Remove the temp repo and temp state dir.
- Reset the Claude SDK mock.

### Test-Helper Reuse

Common helpers under `tests/standards/_helpers/`:

- `buildResolved(rules: Rule[]): ResolvedStandards` — convenience builder for renderer tests.
- `mockClaudeResponse(agent: string, response: object): void` — registers a canned response for a given agent name; used by the integration test.
- `mockGhApprovers(prContext: PrContext, approvers: string[]): void` — registers a canned GitHub reviews response.

These helpers are minimal and inline in `_helpers/index.ts`; no production code depends on them.

## Acceptance Criteria

- [ ] All four test files exist at the documented paths and run via `npx vitest run tests/standards tests/integration` exiting 0.
- [ ] `tests/standards/test-prompt-renderer.test.ts` contains at least the 10 required cases above; all pass.
- [ ] `tests/standards/test-fix-recipe.test.ts` contains at least the 15 required cases above; all pass.
- [ ] `tests/standards/test-meta-reviewer-agent.test.ts` contains at least the 10 required cases above; all pass.
- [ ] `tests/integration/test-standards-author-flow.test.ts` contains at least the 7 required scenarios above; all pass deterministically.
- [ ] `npx vitest run --coverage tests/standards/test-prompt-renderer.test.ts` reports ≥95% line coverage on `src/standards/prompt-renderer.ts`.
- [ ] `npx vitest run --coverage tests/standards/test-fix-recipe.test.ts` reports ≥95% line coverage on `src/standards/fix-recipe.ts`.
- [ ] No test calls a real Claude API or a real GitHub API; all external calls are mocked.
- [ ] No test pollutes the working directory: temp directories are created and cleaned up.
- [ ] The integration test runs in under 10 seconds on a typical CI runner (no real LLM calls).
- [ ] Tests are order-independent: running them in any order produces the same outcome.
- [ ] The agent-meta-reviewer (PLAN-017-2) is invoked manually pre-merge against `agents/standards-meta-reviewer.md` and passes the read-only-tools check; documented as a manual step in this spec's Notes.

## Dependencies

- **SPEC-021-3-01** (blocking): the `prompt-renderer.ts` and session-spawn changes must exist for renderer + integration tests.
- **SPEC-021-3-02** (blocking): the `standards-meta-reviewer.md` agent file, `reviewer-chains.json` trigger, and aggregator changes must exist for the meta-reviewer-agent unit test and integration scenarios 1, 2, 6, 7.
- **SPEC-021-3-03** (blocking): the `fix-recipe-v1.json` schema, `FixRecipe` interface, `emitFixRecipe()`, and three fixture recipes must exist for the fix-recipe unit test and integration scenario 5.
- **PLAN-021-1** (blocking, on main): `Rule`, `ResolvedStandards`, `loadStandardsFile()` consumed by the integration test setup.
- **PLAN-020-1** (existing on main): `reviewer-finding-v1.json` schema referenced in the meta-reviewer-agent test.
- **PLAN-020-2** (existing on main): chain resolver, scheduler, aggregator. Integration scenarios 1, 2, 6, 7 invoke these.
- **PLAN-017-2** (existing on main): `agent-meta-reviewer` invoked manually pre-merge against the new agent file (process gate, not a code dependency).
- **vitest** and **ajv** (existing dependencies): test runner and schema validation.
- **No new external libraries**.

## Notes

- The split between unit tests (renderer, fix-recipe, agent file) and the single integration test is deliberate: unit tests are fast and pinpoint regressions; the integration test demonstrates the three concerns wire together correctly. Splitting further would force more mocking; combining further would dilute regression diagnostics.
- The integration test uses mocked Claude responses (not a live model) for two reasons: (1) determinism in CI; (2) cost/latency. The real-world end-to-end smoke test (operator manually triggers a PR touching `standards.yaml`) is documented in PLAN-021-3's Testing Strategy as a manual gate before the plan's PR merges.
- Coverage threshold of 95% is enforced via vitest's `--coverage` reporter. Files not covered (CLI glue in `render-cli.ts`, the small bash extension in `spawn-session.sh`) are exercised indirectly via the integration test; their absence from coverage is acceptable per PLAN-021-3 task 11's scope.
- The agent-meta-reviewer (PLAN-017-2) check on `standards-meta-reviewer.md` is a manual gate (not part of this test suite) because it requires running another agent against the file. Documented here so the implementer remembers to run it before opening the PR.
- Future test additions: as PLAN-021-2's evaluator catalog lands, the integration test can be extended to exercise an actual rule evaluation. Out of scope for this spec; tracked separately.
- Test-helper reuse is intentionally narrow (single `_helpers/index.ts`) to avoid the helper directory growing into a parallel module structure. If shared helpers exceed ~100 lines, refactor.

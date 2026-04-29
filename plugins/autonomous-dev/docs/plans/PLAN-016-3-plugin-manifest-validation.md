# PLAN-016-3: Plugin Manifest Validation

## Metadata
- **Parent TDD**: TDD-016-baseline-ci-plugin-validation
- **Estimated effort**: 2 days
- **Dependencies**: []
- **Blocked by**: [PLAN-016-1]
- **Priority**: P1

## Objective
Deliver the `plugin-validate` job in the baseline CI workflow that validates every `plugins/*/.claude-plugin/plugin.json` manifest. The primary validation path uses `claude plugin validate` (the official Claude CLI command) so the plugin contract stays anchored to upstream tooling. A robust JSON-schema fallback (via `ajv-cli`) runs whenever Claude CLI bootstrap fails, so CI never silently skips validation. The plan also adds a release-branch-only "version monotonicity" check that prevents accidental version regressions on the path to a tagged release.

## Scope
### In Scope
- `plugin-validate` job in `.github/workflows/ci.yml` (added by PLAN-016-1's skeleton; this plan fills it in)
- Bootstrap step that installs Claude CLI at the version pinned in `env.CLAUDE_CLI_VERSION` with `continue-on-error: true` so bootstrap failure flows into the fallback path rather than failing the build
- Primary validation: `claude plugin validate` against each `plugins/*/.claude-plugin/plugin.json` per TDD Section 4 lines 311-314
- Fallback validation: `npx ajv-cli validate -s .github/schemas/plugin.schema.json -d "plugins/*/.claude-plugin/plugin.json"` when bootstrap output flag indicates failure
- `.github/schemas/plugin.schema.json` JSON Schema vendored from the autonomous-dev plugin contract (required fields: `name`, `version`, `description`, `author`; optional: `dependencies`, `repository`, `entrypoint`, `homepage`, `keywords`)
- Version monotonicity check active only when ref starts with `refs/heads/release/` or `refs/tags/v` per TDD Section 4 lines 322-347; uses `semver.gt(current, last_tag)` to prevent regressions
- Plugin discovery: `plugins/autonomous-dev/.claude-plugin/plugin.json` AND `plugins/autonomous-dev-assist/.claude-plugin/plugin.json` (and any future plugin in `plugins/*/`)
- Status check name `plugin-validate` matching the job key for stable branch protection
- Job gating via `if: needs.paths-filter.outputs.plugins == 'true'` so PRs that don't touch a plugin manifest skip the job

### Out of Scope
- `paths-filter` job and the `plugins` filter pattern -- delivered by PLAN-016-1
- Shellcheck / lychee / actionlint validation -- PLAN-016-2
- Security scanning (gitleaks, trufflehog) -- PLAN-016-4
- Authoring or modifying any actual `plugin.json` files -- this plan validates them, doesn't change them
- Plugin marketplace publishing automation -- separate concern, not in TDD-016
- Cross-plugin dependency validation -- the schema validates each plugin in isolation

## Tasks

1. **Author `.github/schemas/plugin.schema.json`** -- Vendor a JSON Schema (Draft 2020-12) describing the plugin manifest contract. Required fields: `name` (string, kebab-case), `version` (semver string), `description` (string, 10-200 chars), `author` (object with `name` required, `email` optional). Optional fields per Claude plugin docs: `dependencies` (object), `repository` (string URL), `entrypoint` (string path), `homepage` (string URL), `keywords` (array of strings). Use `additionalProperties: false` so unknown fields are rejected.
   - Files to create: `.github/schemas/plugin.schema.json`
   - Acceptance criteria: Running `npx ajv-cli validate -s .github/schemas/plugin.schema.json -d plugins/autonomous-dev/.claude-plugin/plugin.json` exits 0 against the existing manifest. Mutating any required field (e.g., remove `version`) makes it exit non-zero. Schema declares `$schema: "https://json-schema.org/draft/2020-12/schema"` and `$id` pointing at the plugin contract.
   - Estimated effort: 2h

2. **Add `plugin-validate` job skeleton** -- Insert the job in `.github/workflows/ci.yml` (after the jobs added by PLAN-016-1) with `needs: paths-filter`, `if: needs.paths-filter.outputs.plugins == 'true'`, `runs-on: ubuntu-latest`, and `timeout-minutes: 5`. Steps: checkout, setup-node@v4 with Node 20.
   - Files to modify: `.github/workflows/ci.yml`
   - Acceptance criteria: Job appears in `actionlint` output without warnings. Job is correctly gated by the `plugins` filter (verified: PR touching only `src/index.ts` skips the job; PR touching a `plugin.json` triggers it). Status check name is exactly `plugin-validate`.
   - Estimated effort: 1h

3. **Implement Claude CLI bootstrap step** -- Add a step `id: claude-bootstrap` with `continue-on-error: true` that runs `npm install -g "@anthropic-ai/claude-code@${{ env.CLAUDE_CLI_VERSION }}"`, then `claude --version`, then writes `bootstrap-success=true` to `$GITHUB_OUTPUT` only on success. The continue-on-error ensures CLI install failures don't fail the job — they flow into the fallback path.
   - Files to modify: `.github/workflows/ci.yml`
   - Acceptance criteria: When the CLI installs cleanly, `steps.claude-bootstrap.outputs.bootstrap-success == 'true'`. When `npm install` fails (simulated by pinning a non-existent version), the step fails but the job continues. Log output makes it clear which path was taken.
   - Estimated effort: 1.5h

4. **Implement primary `claude plugin validate` step** -- Add a step `if: steps.claude-bootstrap.outputs.bootstrap-success == 'true'` that runs `claude plugin validate` against each plugin manifest. Use a `for plugin in plugins/*/; do claude plugin validate "${plugin}.claude-plugin/plugin.json"; done` loop so adding a third plugin requires no workflow change.
   - Files to modify: `.github/workflows/ci.yml`
   - Acceptance criteria: With the CLI installed, the step validates both `plugins/autonomous-dev/` and `plugins/autonomous-dev-assist/` manifests. A deliberate manifest error (e.g., missing `version`) fails the step. A new plugin added under `plugins/foo/` is automatically validated without workflow edits.
   - Estimated effort: 2h

5. **Implement JSON schema fallback step** -- Add a step `if: steps.claude-bootstrap.outputs.bootstrap-success != 'true'` that runs `npx ajv-cli validate -s .github/schemas/plugin.schema.json -d "plugins/*/.claude-plugin/plugin.json"`. Echo a warning that the fallback is in use so the operator knows to investigate the CLI bootstrap failure.
   - Files to modify: `.github/workflows/ci.yml`
   - Acceptance criteria: Forcing bootstrap failure (pin bad CLI version) triggers the fallback. Fallback validates all plugin manifests using the vendored schema. Warning text appears in the job log: `"Claude CLI bootstrap failed, falling back to JSON schema validation"`. A manifest error fails the step with a clear ajv-cli error message.
   - Estimated effort: 1.5h

6. **Implement version monotonicity check** -- Add a step gated on `if: startsWith(github.ref, 'refs/heads/release/') || startsWith(github.ref, 'refs/tags/v')` that extracts current versions from each plugin manifest, queries the last release tag via `git describe --tags --abbrev=0 --match="v*"`, and uses Node + `semver.gt()` to verify the current version is strictly greater. Fail with a clear error message if any plugin's version is not greater than the last tag.
   - Files to modify: `.github/workflows/ci.yml`
   - Acceptance criteria: On a `release/*` branch where the manifest version equals the last tag, the step fails. On the same branch with a manifest version one patch ahead, the step passes. On a regular feature branch, the step is skipped (verified: `if:` evaluates false). The step's Node script handles the case where no tag exists yet (defaults `LAST_VERSION` to `0.0.0`).
   - Estimated effort: 2h

7. **Smoke test against existing plugins** -- Open a draft PR that introduces a deliberate manifest error in `plugins/autonomous-dev/.claude-plugin/plugin.json` (e.g., remove `description`). Verify the `plugin-validate` job fails. Revert. Re-run, verify pass. Then test the fallback path by overriding `env.CLAUDE_CLI_VERSION` to a non-existent version in the workflow file (revert before merging the smoke test).
   - Files to modify: None (test-only)
   - Acceptance criteria: Three positive runs (valid manifests across both plugins) and three negative runs (one per validation path: primary CLI failure, fallback ajv failure, version monotonicity failure on a release branch). All six runs behave as expected.
   - Estimated effort: 2h

## Dependencies & Integration Points

**Exposes to other plans:**
- `.github/schemas/plugin.schema.json` reused by any future tooling that validates plugin manifests (e.g., a pre-commit hook in PRD-001 hooks plan, or the marketplace publish workflow).
- Stable status check name `plugin-validate` for branch protection configuration.
- `env.CLAUDE_CLI_VERSION` precedent for any future job that needs the Claude CLI.

**Consumes from other plans:**
- **PLAN-016-1** (blocking): `paths-filter` job with the `plugins` output, `env.CLAUDE_CLI_VERSION` declaration in the workflow header, and the `.github/workflows/ci.yml` skeleton. Without these, this plan's job has nothing to attach to.

## Testing Strategy

- **Local pre-flight:** Run `npx ajv-cli validate -s .github/schemas/plugin.schema.json -d plugins/*/.claude-plugin/plugin.json` locally before pushing to verify the schema is correctly authored.
- **Smoke tests in CI (task 7):** Six runs covering primary success, primary failure (manifest error), fallback success, fallback failure (manifest error), monotonicity success on release branch, monotonicity failure on release branch.
- **Schema unit tests:** `tests/ci/test_plugin_schema.bats` (or similar) that runs ajv-cli against fixtures: `tests/fixtures/plugins/valid.json`, `missing-required.json`, `bad-version.json`, `extra-field.json`. Each fixture has a deterministic expected exit code.
- **No Claude CLI mocking:** The bootstrap step's `continue-on-error: true` already isolates us from upstream CLI changes. The fallback path is what we control.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Claude CLI's `plugin validate` command changes its exit-code or stdout contract between versions | Medium | Medium -- false-positive failures on PRs | Pin `CLAUDE_CLI_VERSION` to a specific patch in `env`; add a Dependabot policy for CLI updates. The fallback ajv path is the contract guarantor — even if the CLI breaks, the schema is the source of truth. |
| Vendored schema drifts from the actual Claude plugin contract over time | High | Medium -- valid manifests fail fallback; invalid ones may pass | Schema is reviewed annually in conjunction with Claude plugin docs. A `tests/ci/test_plugin_schema.bats` smoke test against a known-good upstream example catches drift early. Schema's `$id` documents the contract version. |
| `npm install -g` of Claude CLI fails on macOS legs but succeeds on ubuntu-latest | Low | Low -- job runs on ubuntu-latest only per task 2 | Job is `runs-on: ubuntu-latest` (not the matrix). If we ever extend to macOS, treat each OS leg's bootstrap independently. |
| Version monotonicity check fails on the very first release because no tags exist yet | Medium | Low -- self-resolves once `v0.1.0` is tagged | Node script defaults `LAST_VERSION` to `0.0.0` when `git describe` returns nothing, so any first release with version > `0.0.0` passes. |
| `ajv-cli` major version drift breaks the fallback path | Low | Medium -- silent fallback unreliability | Pin via `npx ajv-cli@8.x` to lock the major. CI smoke test exercises the fallback at least once per quarter. |

## Definition of Done

- [ ] `.github/schemas/plugin.schema.json` exists, declares JSON Schema 2020-12, includes `$id`, and validates the existing plugin manifests
- [ ] `plugin-validate` job is in `.github/workflows/ci.yml` with `needs: paths-filter` and `if: plugins == 'true'`
- [ ] Bootstrap step uses `continue-on-error: true` and writes `bootstrap-success` output
- [ ] Primary `claude plugin validate` step runs across all `plugins/*/.claude-plugin/plugin.json` files
- [ ] Fallback `ajv-cli` step runs only when bootstrap fails and validates against the vendored schema
- [ ] Version monotonicity step runs only on `release/*` branches and `v*` tags
- [ ] Status check name is exactly `plugin-validate` and stable across runs
- [ ] All six smoke-test scenarios from task 7 pass
- [ ] No `actionlint` warnings on the workflow file
- [ ] All third-party actions (setup-node, ajv-cli) pinned to a major version

# SPEC-016-3-03: ajv-cli Fallback Step + Version Monotonicity Check

## Metadata
- **Parent Plan**: PLAN-016-3
- **Tasks Covered**: Task 5 (JSON schema fallback step), Task 6 (version monotonicity check on release branches and version tags)
- **Estimated effort**: 3.5 hours

## Description

Append two more steps to the `plugin-validate` job authored by SPEC-016-3-02:

1. **Fallback validation step** — runs `ajv-cli` against `.github/schemas/plugin.schema.json` (authored by SPEC-016-3-01) when the Claude CLI bootstrap fails, ensuring CI never silently skips manifest validation.
2. **Version monotonicity step** — runs only when the workflow ref starts with `refs/heads/release/` or `refs/tags/v` and verifies that every plugin's manifest version is strictly greater than the most recent matching `v*` git tag, using `semver.gt()` from the `semver` npm package.

Together these two steps complete the `plugin-validate` job. SPEC-016-3-04 covers fixture tests against the schema and the bats integration harness.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/workflows/ci.yml` | Modify | Append two steps to the `plugin-validate` job authored by SPEC-016-3-02; do NOT touch other jobs |

## Implementation Details

### Preconditions

- SPEC-016-3-02 has landed: the `plugin-validate` job exists, the bootstrap step writes `steps.claude-bootstrap.outputs.bootstrap-success`, and `actions/checkout@v4` runs with `fetch-depth: 0`.
- SPEC-016-3-01 has landed: `.github/schemas/plugin.schema.json` exists.

### Fallback Validation Step (Task 5)

Append immediately after the primary validation step in `.github/workflows/ci.yml`:

```yaml
    - name: Validate plugin manifests (ajv-cli fallback)
      if: steps.claude-bootstrap.outputs.bootstrap-success != 'true'
      run: |
        set -euo pipefail
        echo "::warning::Claude CLI bootstrap failed, falling back to JSON schema validation"
        shopt -s nullglob
        manifests=(plugins/*/.claude-plugin/plugin.json)
        if [ ${#manifests[@]} -eq 0 ]; then
          echo "::error::No plugin manifests found at plugins/*/.claude-plugin/plugin.json"
          exit 1
        fi
        npx --yes ajv-cli@8 validate \
          --spec=draft2020 \
          --strict=true \
          -s .github/schemas/plugin.schema.json \
          -d "plugins/*/.claude-plugin/plugin.json"
```

Behavioral contract:

1. **Gating** — `if: steps.claude-bootstrap.outputs.bootstrap-success != 'true'` runs the step whenever the bootstrap output is missing OR explicitly any value other than the literal string `"true"`. This is the **inverse** of SPEC-016-3-02's primary-step `if:`; exactly one of the two steps runs per job execution.
2. **Operator visibility** — the `::warning::` line guarantees the GitHub Actions UI surfaces a yellow annotation; the literal text MUST be `"Claude CLI bootstrap failed, falling back to JSON schema validation"` per PLAN-016-3 task 5 acceptance criterion.
3. **Pinned major** — `ajv-cli@8` locks the major to mitigate the "ajv-cli major version drift" risk in PLAN-016-3 Risks. `npx --yes` accepts the install prompt non-interactively.
4. **`--spec=draft2020`** — explicitly selects JSON Schema Draft 2020-12 so the schema's `$schema` keyword is honored without surprise.
5. **`--strict=true`** — turns ajv-cli's strict mode on so unknown schema keywords surface as authoring errors rather than silent passes (defense-in-depth for schema drift).
6. **Glob expansion is left to ajv-cli** — `-d "plugins/*/.claude-plugin/plugin.json"` (quoted on the shell, unquoted to ajv-cli) lets ajv-cli expand and validate each match. The Bash-side guard above only checks that at least one match exists.
7. **Non-zero exit** — any manifest failing validation makes ajv-cli exit non-zero, failing the step.

### Version Monotonicity Step (Task 6)

Append immediately after the fallback step:

```yaml
    - name: Verify plugin version monotonicity (release/tag refs only)
      if: startsWith(github.ref, 'refs/heads/release/') || startsWith(github.ref, 'refs/tags/v')
      run: |
        set -euo pipefail
        npm install --no-save --no-audit --no-fund semver@7
        node -e '
          const fs = require("fs");
          const path = require("path");
          const cp = require("child_process");
          const semver = require("semver");
          let lastTag = "";
          try {
            lastTag = cp.execSync(
              "git describe --tags --abbrev=0 --match=v*",
              { stdio: ["ignore", "pipe", "ignore"] }
            ).toString().trim();
          } catch (_) { lastTag = ""; }
          const lastVersion = lastTag ? lastTag.replace(/^v/, "") : "0.0.0";
          if (!semver.valid(lastVersion)) {
            console.error(`::error::Last tag "${lastTag}" is not valid semver`);
            process.exit(1);
          }
          const manifests = fs.readdirSync("plugins", { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => path.join("plugins", d.name, ".claude-plugin", "plugin.json"))
            .filter((p) => fs.existsSync(p));
          if (manifests.length === 0) {
            console.error("::error::No plugin manifests found");
            process.exit(1);
          }
          let failed = false;
          for (const file of manifests) {
            const m = JSON.parse(fs.readFileSync(file, "utf8"));
            const v = m.version;
            if (!semver.valid(v)) {
              console.error(`::error file=${file}::Manifest version "${v}" is not valid semver`);
              failed = true;
              continue;
            }
            if (!semver.gt(v, lastVersion)) {
              console.error(
                `::error file=${file}::Plugin "${m.name}" version ${v} is not strictly greater than last tag ${lastVersion}`
              );
              failed = true;
              continue;
            }
            console.log(`OK: ${m.name} ${v} > ${lastVersion}`);
          }
          if (failed) process.exit(1);
        '
```

Behavioral contract:

1. **Gating** — `startsWith(github.ref, 'refs/heads/release/') || startsWith(github.ref, 'refs/tags/v')` matches release branches (e.g., `release/0.2`) and version tags (e.g., `v0.2.0`). Feature branches and pushes to `main` skip the step.
2. **No-tag-yet defaulting** — `git describe` with no matching tag throws; the catch block sets `lastVersion = "0.0.0"` so the first release ever (e.g., `v0.1.0`) passes (PLAN-016-3 task 6 acceptance + PLAN-016-3 Risks "first release" mitigation).
3. **Strict greater-than** — `semver.gt(current, lastVersion)`. Equality fails: a release branch where the manifest version equals the last tag is a regression scenario per PLAN-016-3 task 6 acceptance.
4. **Per-manifest reporting** — every plugin is checked and ALL violations are reported in one run (not first-failure-aborts) so an operator fixing a bumped release branch sees all monotonicity errors at once. The `failed` flag and final `process.exit(1)` enforce overall failure.
5. **Annotated errors** — `::error file=...::` produces inline file annotations in the GitHub PR diff UI.
6. **Manifest discovery** — `fs.readdirSync("plugins")` walks every direct subdirectory and only considers those that contain a `.claude-plugin/plugin.json`. This is the same set as the glob in earlier steps.
7. **Tag pattern** — `--match=v*` MUST match SPEC-016-3-02's `fetch-depth: 0` checkout; if the checkout omits tags, `git describe` returns nothing and `lastVersion` defaults to `0.0.0`, which silently masks regressions. SPEC-016-3-02 already specifies `fetch-depth: 0`.

## Acceptance Criteria

### Fallback step (Task 5)

- [ ] Fallback step exists in `.github/workflows/ci.yml` immediately after the primary validation step authored by SPEC-016-3-02.
- [ ] Fallback step's `if:` is exactly `steps.claude-bootstrap.outputs.bootstrap-success != 'true'`.
- [ ] When `env.CLAUDE_CLI_VERSION` is forced to a non-existent version, the fallback step runs and the primary step is skipped.
- [ ] When the fallback runs and all manifests are valid, the step exits 0 and the `::warning::` annotation is visible in the Actions UI with the literal text `"Claude CLI bootstrap failed, falling back to JSON schema validation"`.
- [ ] When the fallback runs and a manifest is invalid (e.g., `version` removed), ajv-cli exits non-zero with an error mentioning the missing required property and the step fails.
- [ ] `ajv-cli` is invoked as `ajv-cli@8` (pinned major) via `npx --yes`.
- [ ] The fallback step uses `--spec=draft2020` and `--strict=true`.
- [ ] `actionlint` reports zero errors/warnings after this step is added.

### Version monotonicity step (Task 6)

- [ ] Monotonicity step exists immediately after the fallback step.
- [ ] Step's `if:` is exactly `startsWith(github.ref, 'refs/heads/release/') || startsWith(github.ref, 'refs/tags/v')`.
- [ ] On a regular feature branch (e.g., `main` or a branch not matching the pattern), the step is skipped (visible in Actions UI).
- [ ] On a `release/*` branch where the manifest version equals the last `v*` tag, the step fails with a clear error referencing the plugin name and both versions.
- [ ] On the same branch with the manifest version one patch ahead, the step passes.
- [ ] When no `v*` tag exists in the repo (`git describe` returns nothing), `lastVersion` defaults to `0.0.0` and any manifest version > `0.0.0` passes.
- [ ] When a manifest's `version` is not valid semver (e.g., `"draft"`), the step fails with a clear semver-invalid error annotated to the manifest file.
- [ ] All plugins in `plugins/*` are checked in a single run; multiple violations are all reported before exit.
- [ ] The step uses `semver@7` (pinned major) installed via `npm install --no-save`.
- [ ] `actionlint` reports zero errors/warnings after this step is added.

## Test Requirements

This spec is workflow-only; functional verification is via PLAN-016-3 task 7 smoke runs. The smoke matrix relevant to this spec:

| Scenario | Trigger | Expected outcome |
|----------|---------|------------------|
| Fallback success | Force bootstrap failure (bad CLI version pin); valid manifests | Warning annotation present; ajv-cli passes; job passes |
| Fallback failure | Force bootstrap failure; introduce manifest error (e.g., remove `version`) | Warning annotation present; ajv-cli exits non-zero; job fails |
| Monotonicity success | Push to `release/0.2` with manifest version `0.2.0` ahead of last tag `v0.1.0` | Step runs; logs `OK: <name> 0.2.0 > 0.1.0`; job passes |
| Monotonicity failure | Push to `release/0.2` with manifest version `0.1.0` (equals last tag) | Step runs; emits annotated error; job fails |
| Monotonicity skipped | Push to a feature branch | Step `if:` evaluates false; step skipped |
| First release ever | No `v*` tag exists; manifest version `0.1.0`; ref `refs/tags/v0.1.0` | `lastVersion=0.0.0`; step passes |

`actionlint` MUST be run locally on the workflow file before each commit that touches it.

## Dependencies

- **Consumes**:
  - SPEC-016-3-01: `.github/schemas/plugin.schema.json` referenced by ajv-cli `-s` flag.
  - SPEC-016-3-02: `plugin-validate` job, `steps.claude-bootstrap.outputs.bootstrap-success`, `fetch-depth: 0` checkout.
- **Exposes**:
  - The completed `plugin-validate` job (no further steps to add for PLAN-016-3 except smoke testing in task 7).
  - Establishes `semver@7` as the canonical semver tooling for any future workflow-level version checks.
- **External**:
  - `ajv-cli@8.x` from npm (pinned major).
  - `semver@7.x` from npm (pinned major).
  - `git describe` from the runner's preinstalled Git.

## Notes

- **Why `npx --yes ajv-cli@8`?** Avoids the interactive "Need to install" prompt that would hang in CI; the `@8` pin guards against the major-version-drift risk in PLAN-016-3 Risks.
- **Why `--spec=draft2020 --strict=true`?** ajv-cli defaults to a permissive draft selection; explicit Draft 2020-12 matches the schema's `$schema` and `--strict=true` makes unknown schema keywords surface as errors at validation time rather than silently passing.
- **Why a Node inline script for monotonicity instead of a separate `.mjs` file?** Keeps the entire workflow self-describing in `ci.yml`. The script is small (~30 lines) and the alternative — a separate `scripts/check-version-monotonicity.mjs` — adds a sibling-file maintenance cost for one CI step. If the script grows past 50 lines, future work should extract it.
- **Why `--match=v*` and not `v[0-9]*`?** The `v*` glob matches the convention adopted by PLAN-016-3 (release tags `v0.1.0`, `v0.2.0`, etc.). A stricter `v[0-9]*` is reasonable but would miss `v0.1.0-rc.1`-style RC tags; we permit those because semver pre-release tags are still ordered correctly by `semver.gt`.
- **Why fail-on-first-violation rejected?** Operators want to see ALL plugins that need version bumps in one run, not bisect through one-error-at-a-time CI runs. The `failed` flag pattern collects all errors and exits 1 once at the end.
- **First-release defaulting** — the `0.0.0` default is intentionally permissive: it's only relevant when no `v*` tag exists yet, and any valid plugin version is strictly greater. The first time a `v*` tag lands, this default is no longer reachable.

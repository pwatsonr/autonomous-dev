# SPEC-016-3-02: plugin-validate Job — Claude CLI Bootstrap + Primary Validation

## Metadata
- **Parent Plan**: PLAN-016-3
- **Tasks Covered**: Task 2 (job skeleton), Task 3 (Claude CLI bootstrap step), Task 4 (primary `claude plugin validate` step)
- **Estimated effort**: 4.5 hours

## Description

Add the `plugin-validate` job to `.github/workflows/ci.yml` and wire its first two steps: a **bootstrap step** that installs the pinned Claude CLI with `continue-on-error: true`, and a **primary validation step** that invokes `claude plugin validate` against every `plugins/*/.claude-plugin/plugin.json`. The bootstrap's `continue-on-error` is intentional — if the install fails, the bootstrap-success output is empty/false and the fallback step (SPEC-016-3-03) handles validation instead.

This spec creates the job skeleton and the **primary path** only. The fallback path (SPEC-016-3-03) and version monotonicity check (also SPEC-016-3-03) attach to this same job; SPEC-016-3-04 covers fixture tests.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/workflows/ci.yml` | Modify | Append the `plugin-validate` job; do NOT touch `paths-filter`, `typecheck`, `lint`, `test`, or `concurrency` blocks owned by PLAN-016-1 |

## Implementation Details

### Preconditions Provided by PLAN-016-1

- `paths-filter` job exists and exposes a `plugins` boolean output.
- `env.CLAUDE_CLI_VERSION` is declared in the workflow header (e.g., `"@anthropic-ai/claude-code@0.x.y"` — exact value owned by PLAN-016-1).
- Workflow already triggers on `push: main` and `pull_request: [opened, synchronize, ready_for_review]`.

If any precondition is missing, this spec's implementer MUST surface it back to the PLAN-016-1 owner rather than redefine here.

### Job Skeleton (Task 2)

Insert the following job after the existing jobs in `.github/workflows/ci.yml`:

```yaml
plugin-validate:
  name: plugin-validate
  needs: paths-filter
  if: needs.paths-filter.outputs.plugins == 'true'
  runs-on: ubuntu-latest
  timeout-minutes: 5
  steps:
    - name: Checkout
      uses: actions/checkout@v4
      with:
        fetch-depth: 0   # required for version-monotonicity step in SPEC-016-3-03
    - name: Setup Node
      uses: actions/setup-node@v4
      with:
        node-version: '20'
```

Key invariants:

- Job key (and `name:`) MUST be exactly `plugin-validate` so branch protection rules can pin a stable status check.
- `needs: paths-filter` and the `if:` guard ensure the job is skipped on PRs that don't touch `plugins/**/.claude-plugin/plugin.json` (filter pattern owned by PLAN-016-1).
- `fetch-depth: 0` is required so SPEC-016-3-03's version-monotonicity step can run `git describe --tags`.
- `timeout-minutes: 5` matches the budget for a hermetic `npm install -g` + two manifest validations on ubuntu-latest.

### Claude CLI Bootstrap Step (Task 3)

Append immediately after `Setup Node`:

```yaml
    - name: Bootstrap Claude CLI
      id: claude-bootstrap
      continue-on-error: true
      run: |
        set -e
        npm install -g "${{ env.CLAUDE_CLI_VERSION }}"
        claude --version
        echo "bootstrap-success=true" >> "$GITHUB_OUTPUT"
```

Behavioral contract:

1. **`continue-on-error: true`** — install or `claude --version` failure does NOT fail the job; the empty `bootstrap-success` output flows downstream and the fallback step (SPEC-016-3-03) takes over.
2. The `bootstrap-success=true` write happens **only** after both `npm install -g` AND `claude --version` succeed (the `set -e` ensures the script aborts on the first failing command).
3. `${{ env.CLAUDE_CLI_VERSION }}` is the full npm install spec including the package name and version (e.g., `"@anthropic-ai/claude-code@1.2.3"`); this spec does NOT decide that string — PLAN-016-1 owns it.
4. The step's stdout/stderr is captured by GitHub Actions; no extra log redirection.

If `bootstrap-success` is unset, downstream `if:` expressions evaluate it as the empty string, which is falsy — this is the intended behavior.

### Primary Validation Step (Task 4)

Append immediately after the bootstrap step:

```yaml
    - name: Validate plugin manifests (Claude CLI)
      if: steps.claude-bootstrap.outputs.bootstrap-success == 'true'
      run: |
        set -euo pipefail
        shopt -s nullglob
        manifests=(plugins/*/.claude-plugin/plugin.json)
        if [ ${#manifests[@]} -eq 0 ]; then
          echo "::error::No plugin manifests found at plugins/*/.claude-plugin/plugin.json"
          exit 1
        fi
        echo "Validating ${#manifests[@]} manifest(s) with Claude CLI..."
        for manifest in "${manifests[@]}"; do
          echo "::group::claude plugin validate ${manifest}"
          claude plugin validate "${manifest}"
          echo "::endgroup::"
        done
```

Behavioral contract:

1. **Discovery via glob** — `plugins/*/.claude-plugin/plugin.json` so a third plugin under `plugins/foo/` is automatically validated without workflow edits (PLAN-016-3 task 4 acceptance).
2. **Empty-result guard** — the `nullglob` + length check prevents a silent pass when the glob expands to nothing (e.g., misnamed directory). This is a defense against a refactor that accidentally moves all plugins.
3. **`set -euo pipefail`** — any non-zero exit from `claude plugin validate` aborts the loop and fails the step.
4. **`::group::` / `::endgroup::`** — collapses CLI output per manifest in the GitHub Actions log so a 10-plugin repo is still reviewable.
5. **Step is gated on bootstrap success** — if the Claude CLI did not install, this step is skipped (`if:` evaluates false) and the fallback step in SPEC-016-3-03 takes responsibility.

## Acceptance Criteria

- [ ] `plugin-validate` job exists in `.github/workflows/ci.yml` with key, `name:`, and resulting status check name all equal to `plugin-validate`.
- [ ] Job declares `needs: paths-filter` and `if: needs.paths-filter.outputs.plugins == 'true'`.
- [ ] Job declares `runs-on: ubuntu-latest` and `timeout-minutes: 5`.
- [ ] Checkout step uses `fetch-depth: 0`.
- [ ] `actionlint` reports zero errors and zero warnings on `.github/workflows/ci.yml`.
- [ ] A PR that touches only `plugins/autonomous-dev/.claude-plugin/plugin.json` triggers the job (visible in Actions UI).
- [ ] A PR that touches only `plugins/autonomous-dev/src/index.ts` (no manifest change) skips the job (paths-filter `plugins=false`).
- [ ] When `npm install -g "${{ env.CLAUDE_CLI_VERSION }}"` succeeds and `claude --version` exits 0, the bootstrap step writes `bootstrap-success=true` to `$GITHUB_OUTPUT` and the job log shows the version output.
- [ ] When `env.CLAUDE_CLI_VERSION` is overridden to a non-existent version (e.g., `@anthropic-ai/claude-code@99.99.99`), the bootstrap step fails but the job continues (PLAN-016-3 task 3 acceptance), and `steps.claude-bootstrap.outputs.bootstrap-success` is the empty string.
- [ ] When bootstrap succeeds, the primary validation step runs and validates BOTH `plugins/autonomous-dev/.claude-plugin/plugin.json` and `plugins/autonomous-dev-assist/.claude-plugin/plugin.json` (visible in `::group::` blocks in the log).
- [ ] When bootstrap fails, the primary validation step is skipped (verified by the `if:` evaluating false in the Actions UI).
- [ ] Removing `version` from `plugins/autonomous-dev/.claude-plugin/plugin.json` (in a draft PR) causes `claude plugin validate` to exit non-zero and fails the step (PLAN-016-3 task 4 acceptance).
- [ ] Adding a third plugin at `plugins/foo/.claude-plugin/plugin.json` causes the loop to validate it without any workflow edit.

## Test Requirements

This spec is workflow-only; functional verification is via PLAN-016-3 task 7 smoke runs (six runs covering primary success, primary failure, fallback success, fallback failure, monotonicity success, monotonicity failure). The smoke matrix relevant to this spec:

| Scenario | This-spec behavior |
|----------|--------------------|
| Valid manifests, CLI installs cleanly | Bootstrap writes `bootstrap-success=true`; primary step validates both manifests; job passes |
| Manifest error (e.g., remove `description`), CLI installs cleanly | Bootstrap succeeds; primary step exits non-zero on the bad manifest; job fails |
| `CLAUDE_CLI_VERSION` pinned to a non-existent version | Bootstrap fails; primary step is skipped via `if:`; fallback (SPEC-016-3-03) takes over |

`actionlint` MUST be run locally (`actionlint .github/workflows/ci.yml`) before opening the PR.

## Dependencies

- **Consumes**:
  - PLAN-016-1's `paths-filter` job and `plugins` output.
  - PLAN-016-1's `env.CLAUDE_CLI_VERSION` declaration.
  - PLAN-016-1's `.github/workflows/ci.yml` skeleton.
- **Exposes**:
  - `plugin-validate` job key (stable status check name).
  - `steps.claude-bootstrap.outputs.bootstrap-success` (consumed by SPEC-016-3-03's fallback step).
  - `fetch-depth: 0` checkout (consumed by SPEC-016-3-03's monotonicity step).
- **External**: `actions/checkout@v4`, `actions/setup-node@v4`, `npm install -g` against the public npm registry.

## Notes

- **Why `continue-on-error: true` on bootstrap?** PLAN-016-3 explicitly designs the validation as primary-with-fallback so an upstream Claude CLI publish issue doesn't break our PR pipeline. The fallback path (ajv-cli + vendored schema) is the contract guarantor; the CLI is anchored to upstream tooling but not load-bearing for the build.
- **Why a Bash glob loop instead of `claude plugin validate plugins/*/...`?** The CLI's argument-handling for multiple paths is undocumented; iterating per-manifest gives deterministic exit-on-first-failure semantics and easier-to-read logs (one `::group::` per plugin).
- **Why `fetch-depth: 0`?** SPEC-016-3-03's monotonicity step needs full tag history for `git describe --tags --abbrev=0 --match="v*"`. Pulling it once at job start (rather than re-fetching tags later) keeps the workflow simple.
- **Why no caching of the global npm install?** The Claude CLI is small and rarely re-pulled; the cost of a cache key collision (stale CLI bypassing pinned version) outweighs the ~10s install cost. If wall-time becomes a problem, future work can add a `~/.npm` cache keyed strictly on `env.CLAUDE_CLI_VERSION`.
- **`actionlint` warnings to expect** — none; if any appear, they should be fixed in this spec, not deferred. PLAN-016-3 Definition of Done requires zero warnings.

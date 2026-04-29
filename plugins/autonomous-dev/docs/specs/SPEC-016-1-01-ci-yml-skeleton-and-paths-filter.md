# SPEC-016-1-01: ci.yml Skeleton, Triggers, Concurrency, and paths-filter Job

## Metadata
- **Parent Plan**: PLAN-016-1
- **Tasks Covered**: Task 1 (ci.yml skeleton with triggers and concurrency), Task 2 (paths-filter job)
- **Estimated effort**: 5 hours

## Description

Create the foundational `.github/workflows/ci.yml` skeleton that powers the TypeScript validation pipeline. This spec covers the workflow header (name, triggers, concurrency, env block) and the `paths-filter` job that gates every downstream job by classifying the changed files in a pull request. The five filter outputs (`typescript`, `shell`, `markdown`, `workflows`, `plugins`) are exposed at the job level so PLAN-016-2/3/4 can read them without redefinition.

This spec produces a workflow that parses, runs, and emits filter outputs but does not yet validate any code. Sibling specs (SPEC-016-1-02, -03, -04) extend it with `typecheck`, `lint`, `test`, and the ESLint/Prettier configs.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Create | `.github/workflows/ci.yml` | Workflow header, triggers, concurrency group, env block, and paths-filter job |

## Implementation Details

### Workflow Header

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, ready_for_review]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

env:
  NODE_VERSION_MATRIX: "[18, 20]"
  CLAUDE_CLI_VERSION: "latest"

jobs:
  paths-filter:
    name: Detect changed paths
    runs-on: ubuntu-latest
    outputs:
      typescript: ${{ steps.filter.outputs.typescript }}
      shell: ${{ steps.filter.outputs.shell }}
      markdown: ${{ steps.filter.outputs.markdown }}
      workflows: ${{ steps.filter.outputs.workflows }}
      plugins: ${{ steps.filter.outputs.plugins }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            typescript:
              - 'plugins/autonomous-dev/src/**/*.ts'
              - 'plugins/autonomous-dev/tests/**/*.ts'
              - 'plugins/autonomous-dev/tsconfig*.json'
              - 'plugins/autonomous-dev/package.json'
              - 'plugins/autonomous-dev/package-lock.json'
              - 'plugins/autonomous-dev/.eslintrc.js'
              - 'plugins/autonomous-dev/.prettierrc'
            shell:
              - '**/*.sh'
              - '**/*.bash'
              - 'plugins/autonomous-dev/bin/**'
              - 'plugins/autonomous-dev/lib/**/*.sh'
            markdown:
              - '**/*.md'
              - '**/*.markdown'
            workflows:
              - '.github/workflows/**'
              - '.github/actions/**'
            plugins:
              - 'plugins/**/.claude-plugin/plugin.json'
              - 'plugins/**/agents/**'
              - 'plugins/**/commands/**'
              - 'plugins/**/hooks/**'
```

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| `concurrency.group: ci-${{ github.ref }}` | Cancels superseded runs on the same branch ref so a fast follow-up commit terminates the in-flight build. |
| `cancel-in-progress: true` | Required to satisfy NFR-1001 (CI feedback under 8 minutes p95) by avoiding queue buildup. |
| Trigger types `opened, synchronize, ready_for_review` | Skips draft PR pushes by default; `ready_for_review` re-runs CI when a draft is promoted. |
| Push trigger limited to `main` | Feature branches use the `pull_request` trigger; pushing to `main` should be rare (after merge) and warrants a full run. |
| `dorny/paths-filter@v3` (tag) | Accept the convenience of tag pinning for now. PLAN-016-1 risk register notes a future move to SHA pinning. |
| Filter outputs declared at job level | Downstream sibling jobs in PLAN-016-2/3/4 reference `needs.paths-filter.outputs.*` -- declaring them once here prevents drift. |
| Five filter groups | Matches TDD-016 Section 4 exactly. Even though this plan only consumes `typescript`, the other four outputs are emitted now to keep filter definitions co-located. |
| `env.NODE_VERSION_MATRIX` and `env.CLAUDE_CLI_VERSION` | Workflow-level constants documented now; consumed by sibling specs. Declaring them here prevents future jobs from hardcoding versions. |

### Filter Pattern Notes

- `typescript` filter intentionally includes `package-lock.json` because a lockfile change implies dependency changes that affect typecheck and test outcomes.
- `shell` filter spans both `.sh` and `.bash` extensions plus `plugins/autonomous-dev/bin/` (which holds extensionless executables) and `plugins/autonomous-dev/lib/**/*.sh`.
- `plugins` filter is intentionally narrow. It omits `src/` and `tests/` (those land in `typescript`) and targets only the manifest, agent prompts, command definitions, and hook scripts that the plugin-validate job (PLAN-016-3) inspects.
- Globs use `**` (recursive) where directories nest several levels (e.g., `plugins/**/agents/**`) and single-level patterns where the path is fixed.

### Validation Notes

- The file must parse as YAML and pass `actionlint` with zero errors.
- `dorny/paths-filter@v3` requires `actions/checkout@v4` to run first (the action diffs the working tree against the merge base).
- The `outputs` block is evaluated even when the job is skipped, so consumers must guard with both `needs: paths-filter` and an `if:` expression on the relevant filter output (handled by sibling specs).
- An empty pull request (e.g., a no-op merge commit) produces all-false outputs; downstream jobs are correctly skipped.

### Edge Cases

- **Force-push to a PR branch**: `paths-filter` runs against the new commit's diff to the base branch. False negatives on force-push are mitigated by the workflow rerunning on `synchronize` events.
- **Renamed files**: `dorny/paths-filter@v3` reports renamed files under their new path. The `typescript` filter catches a `.ts` rename anywhere in `src/` or `tests/`.
- **Branch with no shared history with `main`**: paths-filter falls back to listing all files as changed (action default). Downstream matrix jobs run in full -- correct, but slow. No mitigation required.

## Acceptance Criteria

1. [ ] `.github/workflows/ci.yml` exists at the repository root.
2. [ ] File parses as valid YAML (verified by `yamllint` or `actionlint`).
3. [ ] `actionlint` reports zero errors and zero warnings against the file.
4. [ ] Workflow `name` is `CI`.
5. [ ] `on.push.branches` contains exactly `[main]`.
6. [ ] `on.pull_request.types` contains exactly `[opened, synchronize, ready_for_review]`.
7. [ ] Top-level `concurrency.group` is `ci-${{ github.ref }}`.
8. [ ] Top-level `concurrency.cancel-in-progress` is `true`.
9. [ ] `env.NODE_VERSION_MATRIX` and `env.CLAUDE_CLI_VERSION` are declared.
10. [ ] `paths-filter` job uses `actions/checkout@v4` and `dorny/paths-filter@v3`.
11. [ ] `paths-filter` job exposes the five outputs `typescript`, `shell`, `markdown`, `workflows`, `plugins` at the job level.
12. [ ] Filter patterns match TDD-016 Section 4 verbatim (including the seven `typescript` globs and the `plugins` narrow scoping).
13. [ ] Pushing two consecutive commits to a PR branch within 30 seconds cancels the first run (verified via the GitHub Actions UI).

## Test Cases

1. **test_workflow_file_exists** -- Assert `.github/workflows/ci.yml` exists.
2. **test_workflow_parses_yaml** -- `yq eval '.' ci.yml` succeeds with zero errors.
3. **test_actionlint_clean** -- `actionlint .github/workflows/ci.yml` exits 0.
4. **test_workflow_name** -- `yq '.name'` returns `CI`.
5. **test_push_trigger_main_only** -- `yq '.on.push.branches'` returns `["main"]`.
6. **test_pr_trigger_types** -- `yq '.on.pull_request.types'` returns `["opened", "synchronize", "ready_for_review"]`.
7. **test_concurrency_group** -- `yq '.concurrency.group'` returns `ci-${{ github.ref }}`.
8. **test_concurrency_cancel** -- `yq '.concurrency."cancel-in-progress"'` returns `true`.
9. **test_env_node_matrix_present** -- `yq '.env.NODE_VERSION_MATRIX'` returns a non-empty string.
10. **test_env_claude_cli_version_present** -- `yq '.env.CLAUDE_CLI_VERSION'` returns a non-empty string.
11. **test_paths_filter_uses_v3** -- `yq '.jobs."paths-filter".steps[1].uses'` contains `dorny/paths-filter@v3`.
12. **test_paths_filter_outputs_five_keys** -- `yq '.jobs."paths-filter".outputs | keys'` returns exactly the five names.
13. **test_typescript_filter_includes_lockfile** -- The rendered filter YAML for `typescript` contains `package-lock.json`.
14. **test_plugins_filter_excludes_src** -- The `plugins` filter does not match `plugins/autonomous-dev/src/**`.
15. **test_concurrency_cancel_e2e** (manual) -- Push two commits 5 seconds apart to a draft PR; observe the first run's status as `cancelled` in the GitHub UI.

## Dependencies

- **Blocked by**: None. This is the entry-point spec for PLAN-016-1.
- **Blocks**: SPEC-016-1-02 (typecheck job depends on `paths-filter.outputs.typescript`), SPEC-016-1-03 (lint and test jobs depend on the same output), SPEC-016-1-04 (smoke test PR exercises the full workflow including paths-filter).
- **External**: Repository must have a `main` branch. `actionlint` must be available locally for pre-merge validation (CI does not yet run actionlint -- that lands in PLAN-016-2).

## Notes

- Filter patterns are duplicated verbatim from TDD-016 Section 4 to keep the spec self-contained. If TDD-016 changes, this spec must be updated.
- `dorny/paths-filter@v3` is preferred over `tj-actions/changed-files` because it produces named outputs without requiring a base ref calculation step.
- The `env.CLAUDE_CLI_VERSION` value of `"latest"` is intentional for now; PLAN-016-3 may pin to a SHA once the Claude CLI bootstrap step is implemented.
- The `paths-filter` job runs on every PR, even when no relevant files change. Its runtime is sub-30s and fits well within the NFR-1001 budget.
- Sibling specs MUST NOT modify the `paths-filter`, `concurrency`, or `env` blocks owned by this spec.

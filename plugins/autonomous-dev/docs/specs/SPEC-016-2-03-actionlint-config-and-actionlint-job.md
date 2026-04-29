# SPEC-016-2-03: .actionlint.yaml Config and `actionlint` Self-Validation Job

## Metadata
- **Parent Plan**: PLAN-016-2
- **Tasks Covered**: Task 3 (Author `.github/actionlint.yaml`), Task 6 (Add `actionlint` job to ci.yml)
- **Estimated effort**: 1.5 hours

## Description

Land `.github/actionlint.yaml` (the canonical actionlint config location) and add an `actionlint` job to `.github/workflows/ci.yml` that runs `rhysd/actionlint@v1` against `.github/workflows/*.yml`. The job is gated by the `paths-filter` output `workflows` (delivered by PLAN-016-1) so it only runs when a PR touches a workflow file. The actionlint config disables the embedded shellcheck integration so the dedicated `shell` job (SPEC-016-2-01) is the single source of truth for shell linting; it also declares an empty `self-hosted-runner.labels` list because the project does not use self-hosted runners. The job key is exactly `actionlint`.

Critically, this job is self-validating: it lints `ci.yml` itself, including the `actionlint` job definition. A misconfiguration in any other job (shell, markdown, or future jobs) will be caught here.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/actionlint.yaml` | Create | actionlint discovers this path automatically |
| `.github/workflows/ci.yml` | Modify | Insert `actionlint` job after the `markdown` job |

## Implementation Details

### `.github/actionlint.yaml`

Verbatim content (YAML, single trailing newline):

```yaml
# actionlint configuration for autonomous-dev workflows.
# Discovered automatically by actionlint at .github/actionlint.yaml.

# Project does not use self-hosted runners. Empty list silences the
# "label is not a known runner label" warning that fires when
# actionlint cannot infer a self-hosted set.
self-hosted-runner:
  labels: []

# Disable embedded shellcheck. The `shell` job in ci.yml runs full
# shellcheck against bin/*.sh and installers/*.sh; running it again
# inside `run:` blocks is duplicative and produces conflicting noise.
# Setting the path to "" disables the integration entirely.
shellcheck: ""
```

Two configuration keys are mandatory: `self-hosted-runner.labels: []` and `shellcheck: ""`. The empty string for `shellcheck` is the actionlint convention for "do not invoke shellcheck."

### `actionlint` job (`.github/workflows/ci.yml`)

Inserted as a top-level job. Must use the literal job key `actionlint`.

```yaml
actionlint:
  name: actionlint
  needs: paths-filter
  if: needs.paths-filter.outputs.workflows == 'true'
  runs-on: ubuntu-latest
  steps:
    - name: Checkout
      uses: actions/checkout@v4

    - name: Lint workflows
      uses: rhysd/actionlint@v1
      with:
        fail-on-error: true
```

Notes:
- `rhysd/actionlint@v1` auto-discovers `.github/actionlint.yaml`. No `args:` are needed for config-loading.
- The action defaults to scanning `.github/workflows/*.yml` and `.github/workflows/*.yaml`. Both extensions are covered.
- `fail-on-error: true` is set explicitly to lock the contract. The default is `true` on v1, but we do not rely on defaults for required status checks.
- No checkout `fetch-depth` override is needed; actionlint operates on the workflow files alone.
- The job runs on `ubuntu-latest`. The runner image ships actionlint via `rhysd/actionlint@v1`'s prebuilt binary; no separate setup-go step is required.

## Acceptance Criteria

### Functional Requirements

- **FR-1**: `.github/actionlint.yaml` exists with `self-hosted-runner.labels: []` and `shellcheck: ""`.
  - **Given** the repo HEAD **When** I run `actionlint -config .github/actionlint.yaml -verbose .github/workflows/ci.yml` **Then** the verbose output reports the config file was loaded AND no shellcheck step appears in the lint plan.
- **FR-2**: `.github/workflows/ci.yml` contains a job whose key is `actionlint` with `name: actionlint`, `needs: paths-filter`, `if: needs.paths-filter.outputs.workflows == 'true'`, `runs-on: ubuntu-latest`.
  - **Given** the merged ci.yml **When** I parse it with `yq '.jobs.actionlint'` **Then** all four conditions hold.
- **FR-3**: The `actionlint` job uses `rhysd/actionlint@v1` with `fail-on-error: true`.
  - **Given** the merged ci.yml **When** I inspect `jobs.actionlint.steps[].with.fail-on-error` **Then** it equals `true`.
- **FR-4**: A workflow file containing a syntax error (e.g., misspelled key `step:` instead of `steps:`) fails the `actionlint` job.
  - **Given** a PR that introduces `step:` (singular) into `.github/workflows/ci.yml` **When** the `actionlint` job runs **Then** the job exits non-zero and the log identifies the line number and the error code.
- **FR-5**: A workflow file referencing an undefined output (e.g., `${{ needs.paths-filter.outputs.shellscripts }}` when only `.shell` exists) fails the `actionlint` job.
  - **Given** a PR that adds the bogus reference **When** the `actionlint` job runs **Then** the job exits non-zero with an "undefined output" diagnostic.
- **FR-6**: A valid workflow with only known runners and existing actions passes.
  - **Given** the ci.yml at HEAD with the four jobs (`paths-filter`, `shell`, `markdown`, `actionlint`) all well-formed **When** the `actionlint` job runs **Then** the job exits 0.
- **FR-7**: A PR that touches only shell or markdown files does not run the `actionlint` job.
  - **Given** a PR modifying only `README.md` **When** CI dispatches **Then** the `actionlint` job appears in the run as `Skipped`.
- **FR-8**: actionlint does NOT emit shellcheck diagnostics for `run:` blocks.
  - **Given** a `run: echo $undef_var` block in any workflow **When** the `actionlint` job runs **Then** no SC* diagnostic appears in the output (the dedicated `shell` job covers shellcheck against `*.sh` files only; inline `run:` blocks are intentionally not shellcheck'd at this stage).
- **FR-9**: actionlint DOES emit warnings for unknown self-hosted runner labels (i.e., the empty allowlist is enforced).
  - **Given** a PR that adds `runs-on: my-self-hosted-runner` to a job **When** the `actionlint` job runs **Then** the job exits non-zero with a "label is not in self-hosted-runner.labels" diagnostic.

### Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| `actionlint` job wall-clock | < 30s on a typical PR | GitHub Actions run summary |
| Status check name stability | Exactly `actionlint` (case-sensitive) | Branch-protection UI shows the check |

## Dependencies

- **PLAN-016-1**: provides `paths-filter` job with output `workflows` (boolean string).
- **`rhysd/actionlint@v1`**: GitHub Action; ships a prebuilt actionlint binary.
- **SPEC-016-2-01**: dedicates the `shell` job to shellcheck so this job can disable embedded shellcheck cleanly.
- **TDD-016 Section 6/7**: documents the rationale for splitting shell linting away from actionlint.

## Notes

- The actionlint config is intentionally minimal. Adding rule overrides should be a deliberate follow-up — every override hides a class of real bugs.
- This job is the safety net that catches misconfigurations in SPEC-016-2-01 (`shell` job), SPEC-016-2-02 (`markdown` job), and itself. The primary risk during integration is that a syntax slip in any sibling spec breaks ci.yml entirely; running `actionlint .github/workflows/ci.yml` locally before pushing the integration commit is the documented mitigation in PLAN-016-2 § Risks.
- If a future plan introduces self-hosted runners, populate `self-hosted-runner.labels` with the actual label set. Do not change `shellcheck: ""` without a coordinated decision to retire SPEC-016-2-01's `shell` job.
- `rhysd/actionlint@v1` is pinned to the major-version tag, not a SHA, matching the convention used elsewhere in ci.yml. If the project tightens supply-chain controls (e.g., PLAN-016-4 introduces SHA pinning), this pin migrates with the others.

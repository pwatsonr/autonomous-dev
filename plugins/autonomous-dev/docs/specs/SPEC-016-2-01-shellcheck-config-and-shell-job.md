# SPEC-016-2-01: .shellcheckrc Config and `shell` CI Job

## Metadata
- **Parent Plan**: PLAN-016-2
- **Tasks Covered**: Task 1 (Author `.shellcheckrc`), Task 4 (Add `shell` job to ci.yml)
- **Estimated effort**: 2 hours

## Description

Land the repository-root `.shellcheckrc` rule set and wire a `shell` job into `.github/workflows/ci.yml` that runs `shellcheck` against the daemon supervisor scripts and installer scripts. The job is gated by the `paths-filter` output `shell` (delivered by PLAN-016-1) so it only runs when a PR touches a shell file. The job name is exactly `shell` so branch-protection rules can target it as a stable required status check. Shellcheck is invoked via `find ... -exec shellcheck {} \;` so a failure on one file does not mask warnings on later files.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.shellcheckrc` | Create | Repository-root config; rule set from TDD-016 §6 |
| `.github/workflows/ci.yml` | Modify | Insert `shell` job after the existing `paths-filter` job (PLAN-016-1) |

## Implementation Details

### `.shellcheckrc` (repo root)

Verbatim content (no leading whitespace, single trailing newline):

```bash
# Shellcheck configuration for autonomous-dev daemon and installer scripts.
# Mirrors TDD-016 Section 6 baseline.

# Optional checks we explicitly enable
enable=add-default-case
enable=avoid-nullary-conditions
enable=check-extra-masked-returns
enable=check-set-e-suppressed
enable=deprecate-which
enable=quote-safe-variables
enable=require-double-brackets

# Disabled checks (justified)
disable=SC2034  # Unused variables (many are configuration defaults)
disable=SC2207  # Prefer mapfile (not portable across all bash versions)
disable=SC2155  # Declare-and-assign separately (intentional in some helpers)

# Shell dialect and source resolution
shell=bash
source-path=SCRIPTDIR
```

Three `disable=` lines and `shell=bash` are mandatory. Comments after `#` are advisory and preserved verbatim.

### `shell` job (`.github/workflows/ci.yml`)

Inserted as a top-level job. Appears after the `paths-filter` job from PLAN-016-1. Must use the literal job key `shell` (this is the GitHub status-check name).

```yaml
shell:
  name: shell
  needs: paths-filter
  if: needs.paths-filter.outputs.shell == 'true'
  runs-on: ubuntu-latest
  steps:
    - name: Checkout
      uses: actions/checkout@v4

    - name: Run shellcheck against bin/*.sh
      run: |
        set -euo pipefail
        find plugins/autonomous-dev/bin -maxdepth 1 -type f -name '*.sh' \
          -exec shellcheck {} \;

    - name: Run shellcheck against installers/*.sh
      run: |
        set -euo pipefail
        find plugins/autonomous-dev/installers -maxdepth 1 -type f -name '*.sh' \
          -exec shellcheck {} \;
```

Notes:
- `find ... -exec shellcheck {} \;` runs shellcheck once per file. With `set -euo pipefail` the step exits non-zero if ANY file fails, but every file is still scanned (we want all warnings surfaced in one CI run).
- `-maxdepth 1` keeps the scan limited to the documented script directories. Nested helpers (if any are added later) need an explicit follow-up.
- No `shellcheck-action` wrapper is used; the runner image ships shellcheck preinstalled.
- The `name:` key is set explicitly to lock the status-check name to `shell` even if a future re-org changes the job key.

## Acceptance Criteria

### Functional Requirements

- **FR-1**: A repository-root file `.shellcheckrc` exists with `shell=bash`, all three `disable=` directives (`SC2034`, `SC2207`, `SC2155`), and at least the seven documented `enable=` directives.
  - **Given** a checkout at HEAD **When** I run `shellcheck -V` from the repo root **Then** the output references the repo-root `.shellcheckrc`.
  - **Given** the `.shellcheckrc` **When** I run `shellcheck plugins/autonomous-dev/bin/*.sh` from the repo root **Then** SC2034/SC2207/SC2155 are not reported even if present.
- **FR-2**: `.github/workflows/ci.yml` contains a job whose key is `shell` with `name: shell`, `needs: paths-filter`, `if: needs.paths-filter.outputs.shell == 'true'`, `runs-on: ubuntu-latest`.
  - **Given** the merged ci.yml **When** I parse it with `yq '.jobs.shell'` **Then** all four conditions hold.
- **FR-3**: The `shell` job runs shellcheck against every `*.sh` file in `plugins/autonomous-dev/bin/` and `plugins/autonomous-dev/installers/`.
  - **Given** a fresh PR that adds a new file `plugins/autonomous-dev/bin/foo.sh` containing `echo $undef` **When** the `shell` job runs **Then** the run fails with shellcheck warning SC2154.
- **FR-4**: A PR that touches only markdown files does not run the `shell` job.
  - **Given** a PR that modifies only `README.md` **When** CI dispatches **Then** the `shell` job appears in the run as `Skipped`.
- **FR-5**: A PR that touches only files under `plugins/autonomous-dev/bin/` runs the `shell` job AND succeeds when no shellcheck violations are present.
  - **Given** a PR modifying only `plugins/autonomous-dev/bin/supervisor-loop.sh` with no shellcheck warnings **When** CI dispatches **Then** the `shell` job runs and the `shell` status check is green.
- **FR-6**: A failure in one shell file does not prevent shellcheck from scanning subsequent files within the same `find -exec` invocation.
  - **Given** two shell files with warnings under `plugins/autonomous-dev/bin/` **When** the `shell` job runs **Then** both files' warnings appear in the job log.

### Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| `shell` job wall-clock | < 60s on a typical PR | GitHub Actions run summary |
| Status check name stability | Exactly `shell` (case-sensitive) | Branch-protection UI shows the check |

## Dependencies

- **PLAN-016-1**: provides `paths-filter` job with output `shell` (boolean string).
- **shellcheck**: preinstalled on `ubuntu-latest` runner image (`shellcheck --version` returns ≥ 0.7.0).
- **TDD-016 Section 6**: source of truth for the rule set.

## Notes

- If a future PR adds nested shell helpers (e.g., `plugins/autonomous-dev/bin/lib/*.sh`), bump `-maxdepth` accordingly in a follow-up; deferring keeps this spec scope-stable.
- `shfmt` formatting validation is explicitly out of scope (PLAN-016-2 § Out of Scope) — daemon scripts are not yet shfmt-clean.
- The job name is locked by the explicit `name:` key. Do not let a refactor that renames the job key (`shell` → `shellcheck`) silently break branch-protection wiring.
- Risk: existing daemon scripts may surface shellcheck warnings on first integration. The mitigation in PLAN-016-2 § Risks is to clean them up in a follow-up rather than disable rules globally.

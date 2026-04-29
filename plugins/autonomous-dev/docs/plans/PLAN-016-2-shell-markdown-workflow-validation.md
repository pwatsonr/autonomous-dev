# PLAN-016-2: Shell, Markdown, and Workflow Validation

## Metadata
- **Parent TDD**: TDD-016-baseline-ci-plugin-validation
- **Estimated effort**: 2 days
- **Dependencies**: []
- **Blocked by**: [PLAN-016-1]
- **Priority**: P1

## Objective
Deliver three lightweight validation jobs in `.github/workflows/ci.yml` that enforce baseline quality on bash daemon scripts, markdown documentation, and the workflow YAML itself. This plan ships the configuration files (`.shellcheckrc`, `lychee.toml`, `.actionlint.yaml`) and integrates `shellcheck`, `lycheeverse/lychee-action`, and `rhysd/actionlint` as conditional jobs gated by the `paths-filter` outputs produced in PLAN-016-1. The result: every PR that touches a `.sh`, `.md`, or `.yml` file gets fast, focused validation without slowing down unrelated changes.

## Scope
### In Scope
- `.shellcheckrc` at repository root with the rule set from TDD Section 6 (enable `add-default-case`, `quote-safe-variables`, `require-double-brackets`; disable `SC2034`, `SC2207`, `SC2155`)
- `lychee.toml` at repository root with cache settings, accepted status codes, exclusion patterns, and timeout per TDD Section 7
- `.actionlint.yaml` at `.github/actionlint.yaml` with self-hosted runner labels and shellcheck integration disabled (delegated to the `shell` job)
- `shell` job in ci.yml: runs `shellcheck` against `plugins/autonomous-dev/bin/*.sh` and `plugins/autonomous-dev/installers/*.sh`, gated on `needs.paths-filter.outputs.shell == 'true'`
- `markdown` job in ci.yml: runs `lycheeverse/lychee-action@v1` against `plugins/**/docs/**/*.md` and `README.md`, gated on `needs.paths-filter.outputs.markdown == 'true'`. Uses `GITHUB_TOKEN` for rate-limit-friendly link checks.
- `actionlint` job in ci.yml: runs `rhysd/actionlint@v1` with `fail-on-error: true` against `.github/workflows/*.yml`, gated on `needs.paths-filter.outputs.workflows == 'true'`
- All three jobs declared with `needs: paths-filter` so they receive filter outputs and run in parallel after the filter step
- Stable status check names (`shell`, `markdown`, `actionlint`) so branch protection rules can target them

### Out of Scope
- `paths-filter` job definition and the `dorny/paths-filter@v3` configuration -- delivered in PLAN-016-1
- `shfmt` formatting validation -- deferred (TDD Section 6 mentions it but the daemon scripts are not yet shfmt-clean; tracked as a follow-up)
- `markdownlint-cli2` rule enforcement -- deferred (TDD Section 7 includes `.markdownlint.yaml` but rule enforcement requires a doc cleanup pass first)
- TypeScript lint/build/test jobs -- PLAN-016-1
- Plugin manifest validation (`plugin-validate` job) -- PLAN-016-3
- Security scanning workflow -- PLAN-016-4
- Branch protection rule configuration -- handled out-of-band by the repo admin
- Self-hosted runner provisioning -- not needed; all three jobs run on `ubuntu-latest`

## Tasks

1. **Author `.shellcheckrc`** -- Create the repository-root `.shellcheckrc` with the enabled checks, disabled checks, shell dialect, and source path from TDD Section 6.
   - Files to create: `.shellcheckrc`
   - Acceptance criteria: File exists at repo root. Running `shellcheck plugins/autonomous-dev/bin/supervisor-loop.sh` from the repo root picks up the config (verifiable via `shellcheck -V` showing the rc file path). All three `disable=` lines are present. `shell=bash` is set.
   - Estimated effort: 0.5h

2. **Author `lychee.toml`** -- Create the repository-root `lychee.toml` with cache, accepted status codes, exclusions for localhost/private/placeholder URLs, timeout, user agent, and base directory per TDD Section 7.
   - Files to create: `lychee.toml`
   - Acceptance criteria: File exists at repo root. `lychee --config lychee.toml README.md` runs locally without parse errors. `cache = true`, `max_cache_age = "1d"`, `accept` includes 200/201/204/301/302/307/308/403/429, `exclude` includes localhost and example.com patterns.
   - Estimated effort: 0.5h

3. **Author `.github/actionlint.yaml`** -- Create the actionlint config with `self-hosted-runner.labels: []` (no self-hosted runners), and disable the embedded shellcheck integration since the `shell` job already runs full shellcheck.
   - Files to create: `.github/actionlint.yaml`
   - Acceptance criteria: File exists. Running `actionlint -config .github/actionlint.yaml .github/workflows/ci.yml` produces no errors against the workflow added in task 6. Embedded shellcheck check is set to `shellcheck: ""` (empty) so actionlint does not duplicate the `shell` job.
   - Estimated effort: 0.5h

4. **Add `shell` job to ci.yml** -- Insert the job under the existing `paths-filter` job (from PLAN-016-1). Steps: checkout, run shellcheck against `plugins/autonomous-dev/bin/*.sh` and `plugins/autonomous-dev/installers/*.sh`. Use `find ... -exec shellcheck {} \;` so a single failure does not mask others. Job uses `ubuntu-latest`.
   - Files to modify: `.github/workflows/ci.yml`
   - Acceptance criteria: Job has `needs: paths-filter` and `if: needs.paths-filter.outputs.shell == 'true'`. Job name is exactly `shell` (for branch protection). Shellcheck runs against both `bin/*.sh` and `installers/*.sh` directories. PR with a shell-only change triggers the job; PR with a markdown-only change skips it (verifiable in Actions tab).
   - Estimated effort: 1.5h

5. **Add `markdown` job to ci.yml** -- Insert the markdown job. Steps: checkout, then `lycheeverse/lychee-action@v1` with args `--verbose --cache --max-cache-age 1d --config lychee.toml "plugins/**/docs/**/*.md" "README.md"`. Pass `GITHUB_TOKEN` via `env:`. Job uses `ubuntu-latest`.
   - Files to modify: `.github/workflows/ci.yml`
   - Acceptance criteria: Job has `needs: paths-filter` and `if: needs.paths-filter.outputs.markdown == 'true'`. Job name is exactly `markdown`. Lychee picks up `lychee.toml` (verifiable in job logs showing config loaded). Broken link in a doc fails the job; valid links pass.
   - Estimated effort: 1.5h

6. **Add `actionlint` job to ci.yml** -- Insert the actionlint job. Steps: checkout, then `rhysd/actionlint@v1` with `fail-on-error: true`. Action auto-discovers `.github/actionlint.yaml`. Job uses `ubuntu-latest`.
   - Files to modify: `.github/workflows/ci.yml`
   - Acceptance criteria: Job has `needs: paths-filter` and `if: needs.paths-filter.outputs.workflows == 'true'`. Job name is exactly `actionlint`. Introducing a syntax error in a workflow file (e.g., wrong key name) fails the job. Valid workflows pass. Job loads `.github/actionlint.yaml` (visible in logs).
   - Estimated effort: 1h

7. **Manual integration smoke test** -- Open a draft PR with three commits: (a) edits a daemon script, (b) edits a doc with a known-good link, (c) edits a workflow file. Verify each filter output triggers exactly its corresponding job and the other two are skipped. Then introduce a deliberate failure (shellcheck error, broken link, workflow typo) on a separate branch and verify each job fails with a clear annotation.
   - Files to modify: None (test-only; revert the failure commits)
   - Acceptance criteria: Three positive runs (one per job, isolated paths) and three negative runs (one per job with deliberate failure). All six runs behave as expected. Status checks named `shell`, `markdown`, `actionlint` appear on the PR.
   - Estimated effort: 1.5h

## Dependencies & Integration Points

**Exposes to other plans:**
- `.shellcheckrc` rule set used by any future shell scripts (installers, future daemon helpers)
- `lychee.toml` link-check policy reused by any future doc-linting workflow (e.g., scheduled link audit)
- `.github/actionlint.yaml` reused by any future workflow file added to `.github/workflows/`
- Three stable status check names (`shell`, `markdown`, `actionlint`) for branch protection configuration

**Consumes from other plans:**
- **PLAN-016-1** (blocking): the `paths-filter` job and its outputs `shell`, `markdown`, `workflows`. Without these outputs the conditional gates in tasks 4-6 cannot evaluate.

## Testing Strategy

- **Configuration validation:** Run `shellcheck --version`, `lychee --config lychee.toml --dump-inputs README.md`, and `actionlint -config .github/actionlint.yaml -verbose .github/workflows/ci.yml` locally before pushing. Each must complete without parse errors against its config.
- **Integration smoke test (task 7):** A draft PR demonstrating that path filters correctly gate each job. Six runs total: three positive (job triggers and passes), three negative (job triggers and fails on injected error).
- **No unit tests:** These jobs are thin wrappers around upstream actions; the underlying tools have their own test suites. Our coverage is contractual (job exists, gate is correct, status check name is stable).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `lycheeverse/lychee-action` rate-limits against GitHub URLs in PR descriptions | Medium | Medium -- transient red builds on PRs touching docs | Pass `GITHUB_TOKEN` via `env:` to lychee; enable `cache` in `lychee.toml` so repeat runs reuse results within 1d |
| Existing daemon scripts have shellcheck warnings that fail the job on first integration | High | Medium -- task 7 fails until scripts are fixed | Run shellcheck locally against `bin/*.sh` and `installers/*.sh` before opening the integration PR; if warnings exist, file a follow-up task to clean them up rather than disabling the rule globally |
| `actionlint` rejects the existing `ci.yml` due to a syntax issue introduced in PLAN-016-1 | Low | High -- whole CI workflow blocks merge | Run `actionlint .github/workflows/ci.yml` locally before pushing; if PLAN-016-1's output has issues, file a regression against that plan rather than working around in this one |
| `paths-filter` outputs from PLAN-016-1 use different output names than expected (e.g., `shellscripts` vs `shell`) | Low | Medium -- conditional gates never evaluate true | Coordinate with PLAN-016-1 author on exact output names before task 4; verify outputs in a draft PR before final merge |

## Definition of Done

- [ ] `.shellcheckrc` exists at repo root with rules from TDD Section 6
- [ ] `lychee.toml` exists at repo root with cache, accepts, excludes, timeout per TDD Section 7
- [ ] `.github/actionlint.yaml` exists with `shellcheck: ""` and empty `self-hosted-runner.labels`
- [ ] `.github/workflows/ci.yml` has `shell`, `markdown`, and `actionlint` jobs, each with `needs: paths-filter` and the correct `if:` gate
- [ ] Each of the three jobs has a stable name matching its job key (`shell`, `markdown`, `actionlint`)
- [ ] Draft PR demonstrates correct gating: shell-only change triggers `shell` only; markdown-only change triggers `markdown` only; workflow-only change triggers `actionlint` only
- [ ] Each job fails as expected when a deliberate error is introduced (shellcheck warning, broken link, workflow typo)
- [ ] No regressions in the `paths-filter` job from PLAN-016-1
- [ ] All three jobs complete in under 2 minutes each on a typical PR

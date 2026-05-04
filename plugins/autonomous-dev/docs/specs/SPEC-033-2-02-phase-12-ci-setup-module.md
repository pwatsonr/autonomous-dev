# SPEC-033-2-02: Phase 12 Module — CI Workflows + Repo Secrets + Branch Protection

## Metadata
- **Parent Plan**: PLAN-033-2
- **Parent TDD**: TDD-033 §6.3
- **Parent PRD**: AMENDMENT-002 §4.3, AC-05
- **Tasks Covered**: PLAN-033-2 Task 2
- **Estimated effort**: 1.5 days
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-02

## 1. Summary

Author the phase 12 module that scaffolds CI workflow files into the
operator's repo, configures branch protection on `main`, sets repo
secrets via `gh secret set`, and verifies the entire stack via a
**probe-PR**: a throwaway PR on a uniquely-timestamped branch that is
unconditionally cleaned up via `trap`. Phase 12 is the first phase to
handle a GitHub PAT and is the most sensitive operator-facing module
shipped to date. The module **links** to PRD-015 / TDD-025 for chain-level
guidance and MUST NOT inline any chain content (AMENDMENT-002 AC-05).

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                            | Task |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | A markdown file at `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-12-ci-setup.md` MUST exist with a YAML front-matter block conforming to `_phase-contract.md` (SPEC-033-1-01). | T2   |
| FR-2  | The front-matter MUST set `phase: 12`, `title: "CI workflows + repo secrets + branch protection"`, `amendment_001_phase: 12`, `tdd_anchors: [TDD-016, TDD-017]`, `prd_links: [PRD-015]`, `required_inputs.phases_complete: [1,2,3,4,5,6,7]`. | T2   |
| FR-3  | The front-matter MUST set `skip_predicate: "skip-predicates.sh is_github_origin && return 1 || return 0"` so that **non-GitHub origin → skip**. (Inversion: `is_github_origin` returns 0 when github → run; 1 when not → skip.) | T2   |
| FR-4  | `skip_consequence` MUST contain the verbatim text "GitHub-only support; daemon will run but workflow validation must be done manually." per TDD-033 §6.3. | T2   |
| FR-5  | The front-matter MUST set `idempotency_probe: "idempotency-checks.sh phase-12-probe"` (wrapper documented in §4). | T2   |
| FR-6  | The front-matter MUST set `output_state.config_keys_written: ["ci.github_pat_env", "ci.workflow_paths", "ci.branch_protection_enabled", "ci.required_status_checks"]` and `output_state.files_created: [".github/workflows/autonomous-dev-ci.yml", ".github/workflows/autonomous-dev-cd.yml", ".github/workflows/observe.yml.example"]`. | T2   |
| FR-7  | A PRD-015 cross-reference banner MUST be emitted BEFORE the chain-related steps (scaffold, secrets, branch-protection, probe-PR). The banner MUST contain the phrase "See PRD-015 for chain-level guidance" and a literal markdown link to `docs/prds/PRD-015-...md` (relative path). | T2   |
| FR-8  | The module MUST NOT inline any sentence longer than 40 characters that appears verbatim in PRD-015's chain section. (AMENDMENT-002 AC-05; enforced by eval `linked-prd-no-duplication.md` in SPEC-033-2-03.) | T2   |
| FR-9  | The module MUST collect a GitHub PAT via `read -s` (no echo). The PAT MUST require `repo` AND `workflow` scopes; the module emits a banner listing the required scopes BEFORE prompting. | T2   |
| FR-10 | After collection, the module MUST verify scopes BEFORE any write: invoke `gh_token_has_admin_scope GH_TOKEN <repo-slug>` (SPEC-033-2-01). On exit 1 (admin=false), abort with diagnostic "your token needs `repo` + `workflow` scopes; current token does not have admin permissions on this repo" and write nothing. | T2   |
| FR-11 | The PAT MUST be passed to `gh` exclusively via the `GH_TOKEN` env var (subshell-scoped). It MUST NEVER appear on argv, in `.bash_history`, in any file other than `secrets.env` (mode 0600), or in `wizard.log`. | T2   |
| FR-12 | The PAT MUST be written to `secrets.env` via `cred_proxy_write_env GH_TOKEN`. Config keys MUST hold env-var-name pointers (`ci.github_pat_env = "GH_TOKEN"`), NEVER the literal token. | T2   |
| FR-13 | The module MUST scaffold three workflow files from `plugins/autonomous-dev/templates/workflows/` into the operator's repo at `.github/workflows/`: `autonomous-dev-ci.yml`, `autonomous-dev-cd.yml`, `observe.yml.example` (per PRD-017 FR-1711–1714). Each scaffolded file's content MUST be byte-identical to the template (no operator-specific substitutions at this stage). | T2   |
| FR-14 | The module MUST set the repo secret `AUTONOMOUS_DEV_TOKEN` via `gh secret set AUTONOMOUS_DEV_TOKEN` reading the value from stdin (heredoc); the value MUST come from `secrets.env`'s designated secret, NEVER from argv. | T2   |
| FR-15 | The module MUST configure branch protection on `main` via `gh api -X PUT repos/<slug>/branches/main/protection` with `required_status_checks.contexts` derived from the actual filenames of the scaffolded workflow YAMLs (e.g., `["autonomous-dev-ci","autonomous-dev-cd"]`), NOT hard-coded. | T2   |
| FR-16 | The probe-PR step MUST: (a) create a uniquely-named branch `autonomous-dev-wizard-probe-<unix-timestamp>`, (b) commit a single no-op file (`.autonomous-dev/wizard-probe-<timestamp>.md`) on that branch, (c) push and `gh pr create`, (d) poll `gh run list` for the resulting workflow runs up to 5 minutes (TDD-033 §10.3), (e) on success or failure, **close** (do NOT merge) the PR and **delete** the branch via an unconditional `trap '...' EXIT INT TERM`. | T2   |
| FR-17 | The probe-PR cleanup `trap` MUST run even on `EXIT 0` (success path); it MUST be installed BEFORE the `gh pr create` invocation; it MUST be removed only after successful close+delete. The cleanup commands MUST be: `gh pr close <num> 2>/dev/null; git push origin --delete <branch> 2>/dev/null; git branch -D <branch> 2>/dev/null`. | T2   |
| FR-18 | If the wizard is killed by `kill -9` (which `trap` cannot intercept), the next phase 12 invocation MUST detect prior probe branches by name pattern `autonomous-dev-wizard-probe-*` and offer the operator to clean them up (delete branches + close associated PRs) before proceeding. | T2   |
| FR-19 | The probe-PR step MUST gate phase completion on the workflow runs satisfying branch protection (i.e., the required_status_checks contexts all return success). If any fails within the 5-minute window, the trap still cleans up but the phase exits as `failed`. | T2   |
| FR-20 | The module MUST be idempotent against re-runs: (a) workflow files matching `workflow_template_hash_matches` (SPEC-033-2-01) skip rescaffold; (b) `gh_branch_protection_configured` returning `already-complete` skips the protection write; (c) `gh secret list` containing `AUTONOMOUS_DEV_TOKEN` skips the secret-set if the operator confirms reuse; (d) every probe-PR run uses a fresh timestamp branch, so re-runs never collide. | T2   |
| FR-21 | On non-GitHub origin (skip-predicate true), the orchestrator emits the FR-4 verbatim consequence text and marks phase 12 status="skipped"; no writes occur. | T2   |
| FR-22 | The module MUST detect GHES origins (`*.github.*` non-`github.com`) and emit a documented diagnostic: "GHES origin detected; phase 12 supports github.com only at this time. See TDD-033 §16 for GHES roadmap." Phase exits status="failed" with a non-fatal exit code so the orchestrator continues. | T2   |

## 3. Non-Functional Requirements

| Requirement                       | Target                                                                  | Measurement Method                                                |
|-----------------------------------|-------------------------------------------------------------------------|-------------------------------------------------------------------|
| Eval pass rate                    | ≥ 90% per TDD-033 §9.3 / AMENDMENT-002 AC-03                             | eval framework score (covered in SPEC-033-2-03)                   |
| GitHub PAT leak (`ghp_*`)         | 0 occurrences in stdout, stderr, wizard.log, eval transcript            | regex sweep `ghp_[A-Za-z0-9]{36}` on captured streams              |
| Probe-PR poll cap                 | ≤ 5 minutes wall clock                                                  | poll-loop timer in module body                                    |
| Probe-PR cleanup success rate     | 100% under controlled kills (`SIGTERM`); detect-and-offer for `SIGKILL`  | eval kill-mid-phase test                                           |
| Workflow scaffold byte-identity   | sha256(scaffolded) == sha256(template) for all three files              | bats post-write hash check                                         |
| PRD-015 verbatim duplication      | 0 sentences ≥ 40 chars match PRD-015 chain section                      | duplication-scanner eval (SPEC-033-2-03)                          |
| `gh api` call count               | ≤ 5 per probe per TDD-033 §10.3                                         | counter via `gh` shim during eval                                  |
| Phase total runtime (happy)       | < 8 min wall clock (5 min probe-PR + setup overhead)                    | eval framework duration                                            |

## 4. Technical Approach

**File: `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-12-ci-setup.md`**

```yaml
---
phase: 12
title: "CI workflows + repo secrets + branch protection"
amendment_001_phase: 12
tdd_anchors: [TDD-016, TDD-017]
prd_links: [PRD-015]
required_inputs:
  phases_complete: [1,2,3,4,5,6,7]
  config_keys: []
optional_inputs:
  existing_workflows: true
  existing_branch_protection: true
skip_predicate: "skip-predicates.sh phase_12_skip_predicate"
skip_consequence: |
  GitHub-only support; daemon will run but workflow validation must be done manually.
idempotency_probe: "idempotency-checks.sh phase-12-probe"
output_state:
  config_keys_written:
    - ci.github_pat_env
    - ci.workflow_paths
    - ci.branch_protection_enabled
    - ci.required_status_checks
  files_created:
    - ".github/workflows/autonomous-dev-ci.yml"
    - ".github/workflows/autonomous-dev-cd.yml"
    - ".github/workflows/observe.yml.example"
  external_resources_created:
    - "github.repo.secret.AUTONOMOUS_DEV_TOKEN"
    - "github.repo.branch_protection.main"
verification:
  - "Workflow files present at expected paths with template-matching hashes"
  - "Repo secret AUTONOMOUS_DEV_TOKEN is set (gh secret list contains it)"
  - "Branch protection on main has required_status_checks containing each scaffolded workflow context"
  - "Probe-PR triggered workflows passed within 5 minutes"
  - "Probe-PR closed and probe branch deleted"
eval_set: "evals/test-cases/setup-wizard/phase-12-ci-setup/"
---
```

**Skip-predicate wrapper** (`skip-predicates.sh phase_12_skip_predicate`):
```bash
phase_12_skip_predicate() {
  if is_github_origin; then return 1; else return 0; fi
}
```

**Idempotency probe** (`idempotency-checks.sh phase-12-probe`):
```
1. workflow_template_hash_matches each of the three scaffolded files
   - if all → already-complete-workflows = true
   - else → resume-from:scaffold
2. gh secret list | grep -q AUTONOMOUS_DEV_TOKEN
   - if missing → resume-from:set-secret
3. gh_branch_protection_configured <slug> "<csv-of-workflow-basenames>"
   - if start-fresh / resume-from:partial → resume-from:protect
4. If steps 1-3 all already-complete → already-complete (skip probe-PR; pre-existing protection plus matching workflows is sufficient)
5. Otherwise emit the lowest-numbered resume-from step
```

**Module body steps:**

| Step name                  | Behavior                                                                                                                                  |
|----------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| `intro`                    | Banner; sensitive phase warning; PAT scope requirements (`repo` + `workflow` + admin permission on repo); PRD-015 link banner.            |
| `detect-origin`            | `git remote get-url origin`. If GHES → emit FR-22 diagnostic and exit failed. If non-GitHub → skip predicate already aborted.             |
| `collect-pat`              | `read -s` PAT; trim whitespace; `unset` echo of input. Length sanity check (40-100 chars).                                                |
| `verify-scopes`            | `gh_token_has_admin_scope GH_TOKEN <slug>`. On exit 1: diagnostic + abort no-write. On exit 2: gh-cli-or-token-missing diagnostic.        |
| `write-secret-env`         | `cred_proxy_write_env GH_TOKEN "$pat"`; `unset pat`.                                                                                       |
| `scaffold-workflows`       | For each of the three template files: probe `workflow_template_hash_matches`. On `start-fresh` → copy. On `resume-from:rescaffold` → diff-prompt operator (overwrite/skip). On `already-complete` → skip. |
| `set-repo-secret`          | `gh_secret_set_via_stdin AUTONOMOUS_DEV_TOKEN` reading from `secrets.env` heredoc; never argv.                                            |
| `configure-protection`     | `gh_branch_protection_configured` → if not `already-complete`, build `required_status_checks.contexts` from scaffolded workflow basenames; PUT protection.                                                                                                  |
| `probe-pr-prepare`         | Generate timestamp `T=$(date +%s)`; branch=`autonomous-dev-wizard-probe-$T`; install `trap` (FR-17).                                       |
| `probe-pr-create`          | `git checkout -b $branch`; create probe file; commit; push; `gh pr create --base main --head $branch --title "wizard probe $T" --body "..."`.                                                                                                                |
| `probe-pr-poll`            | Loop ≤ 5 min: `gh run list --branch $branch --json conclusion,status` until all required contexts complete. Exit early on first failure.   |
| `probe-pr-verify-protection` | Assert that the PR cannot merge unless required_status_checks pass (test by attempting `gh pr merge --auto`; expect refusal until checks pass). |
| `cleanup-probe`            | `gh pr close $num`; `git push origin --delete $branch`; `git branch -D $branch`. Remove `trap`.                                          |
| `write-config`             | Write the four config keys per FR-6.                                                                                                       |
| `summary`                  | Print verification line per TDD-033 §10.5: `{"phase":12,"step":"verify","status":"completed"}`.                                            |

**Cleanup `trap` shape (FR-17):**
```bash
_phase12_cleanup() {
  local pr="$1" branch="$2"
  [[ -n "$pr" ]] && gh pr close "$pr" --comment "wizard probe cleanup" 2>/dev/null || true
  [[ -n "$branch" ]] && git push origin --delete "$branch" 2>/dev/null || true
  [[ -n "$branch" ]] && git branch -D "$branch" 2>/dev/null || true
}
trap '_phase12_cleanup "$PR_NUM" "$BRANCH"' EXIT INT TERM
```

**Stale probe-branch detection (FR-18):**
On phase entry, list `git branch -r --list 'origin/autonomous-dev-wizard-probe-*'`. If any matches, prompt: "Found N stale probe branches; clean up before proceeding? [Y/n]". On Y, iterate cleanup; on n, abort with diagnostic.

**PRD-015 cross-link banner (FR-7):**

```
================================================================
PRD-015 / TDD-025 govern CI chain orchestration end-to-end.
This wizard phase configures the *infrastructure* (workflows,
secrets, branch protection, probe-PR). For chain-level guidance
on workflow contents, retry policies, and rollout gating, see:

    docs/prds/PRD-015-ci-cd-pipeline-and-chain-orchestration.md
    docs/tdd/TDD-025-ci-chain-runtime.md

This phase intentionally does not duplicate chain content; if you
need to change chain behavior, edit the templates referenced from
PRD-015, then re-run this phase.
================================================================
```

This banner is the canonical source; the eval `linked-prd-no-duplication.md` (SPEC-033-2-03) regex-scans the rendered phase output against PRD-015 chain content for ≥ 40-char duplication.

## 5. Interfaces and Dependencies

**Consumed:**
- SPEC-033-1-01: `lib/skip-predicates.sh::is_github_origin` (and the new `phase_12_skip_predicate` wrapper added here, ≤ 10 LOC).
- SPEC-033-2-01: `lib/skip-predicates.sh::gh_token_has_admin_scope`, `lib/idempotency-checks.sh::gh_branch_protection_configured`, `lib/idempotency-checks.sh::workflow_template_hash_matches`.
- SPEC-033-1-02: `lib/cred-proxy-bridge.sh::cred_proxy_write_env`.
- SPEC-033-1-03: orchestrator state + snapshot + log infrastructure; feature flag.
- TDD-016 / TDD-017: workflow templates + branch-protection guidance.
- PRD-015 / TDD-025: chain-level guidance (LINKED, not inlined).
- PRD-017 FR-1711–1714: workflow templates including `observe.yml.example`.
- `plugins/autonomous-dev/templates/workflows/{autonomous-dev-ci.yml,autonomous-dev-cd.yml,observe.yml.example}` — ASSUMED to exist; if missing this SPEC documents it as a build-time prerequisite.

**Produced:**
- `phases/phase-12-ci-setup.md`.
- `phase_12_skip_predicate` helper (small).
- `phase-12-probe` idempotency wrapper (≤ 50 LOC).
- New helper `gh_secret_set_via_stdin` in `lib/cred-proxy-bridge.sh` (or a new `lib/gh-helpers.sh` if scope grows).

## 6. Acceptance Criteria

### Front-matter contract (FR-1–FR-6)

```
Given phases/phase-12-ci-setup.md
When the front-matter is parsed by yq
Then phase=12 and prd_links == ["PRD-015"]
And tdd_anchors == ["TDD-016","TDD-017"]
And output_state.config_keys_written contains exactly ["ci.github_pat_env","ci.workflow_paths","ci.branch_protection_enabled","ci.required_status_checks"]
And output_state.files_created contains the three workflow paths
And external_resources_created lists the repo-secret and branch-protection resources
```

### PRD-015 link banner (FR-7, FR-8)

```
Given the module body is rendered for an operator
When the rendered output is captured before the chain-related steps
Then a banner containing "PRD-015" and "docs/prds/PRD-015-" appears
And the banner appears BEFORE the scaffold-workflows / set-repo-secret / configure-protection / probe-pr steps
And no sentence ≥ 40 chars in the rendered output appears verbatim in PRD-015's chain section (enforced by SPEC-033-2-03 eval)
```

### Skip on non-GitHub origin (FR-3, FR-4, FR-21)

```
Given origin remote = "https://gitlab.com/x/y.git"
When phase 12 enters
Then phase_12_skip_predicate exits 0
And the verbatim FR-4 consequence text is emitted
And phases.12.status == "skipped"
And no .github/workflows/ files are written
And no gh api calls occur
```

### GHES detection (FR-22)

```
Given origin remote = "git@github.example-corp.com:x/y.git"
When phase 12 runs
Then is_github_origin returns 0 (proceeds past skip)
And the detect-origin step emits the FR-22 diagnostic
And phases.12.status == "failed" with non-fatal exit
And the orchestrator continues to phase 13
```

### PAT scope verification before any write (FR-9, FR-10)

```
Given a PAT lacking admin permission on the repo
When verify-scopes runs
Then gh_token_has_admin_scope exits 1
And the wizard emits the diagnostic from FR-10
And no .github/workflows/ files are written
And no gh secret set occurs
And no branch-protection PUT occurs
```

### PAT no-leak (FR-11, NFR PAT leak)

```
Given the operator enters PAT "ghp_FAKETESTTOKEN0123456789012345678901234"
When the phase completes (any path: success, error, skip)
Then `ps -eo args` snooped during the phase shows no "ghp_" prefix
And grep "ghp_FAKETESTTOKEN" against stdout, stderr, wizard.log, transcript returns 0 matches
And secrets.env contains the line "GH_TOKEN=ghp_FAKETESTTOKEN0123456789012345678901234"
And config.json's ci.github_pat_env equals "GH_TOKEN" (the env-var-name pointer, not the literal token)
```

### Workflow scaffold byte-identity (FR-13, NFR scaffold byte-identity)

```
Given the three template files exist under plugins/autonomous-dev/templates/workflows/
When scaffold-workflows runs
Then sha256 of each scaffolded .github/workflows/*.yml equals sha256 of the corresponding template
```

### Branch protection contexts derived from scaffolded files (FR-15)

```
Given scaffold-workflows wrote autonomous-dev-ci.yml and autonomous-dev-cd.yml
When configure-protection runs
Then the gh api PUT body's required_status_checks.contexts equals ["autonomous-dev-ci","autonomous-dev-cd"]
And the contexts are NOT hard-coded constants (verifiable by replacing the templates and observing the contexts change)
```

### Probe-PR lifecycle + trap cleanup (FR-16, FR-17, NFR cleanup success)

```
Given the probe-pr-create step has installed the trap and created PR #N on branch B
When the wizard exits (any cause: SIGTERM, normal exit, ERR)
Then the trap fires
And gh pr close N is invoked
And git push origin --delete B is invoked
And git branch -D B is invoked
And after the trap, no probe branch matching autonomous-dev-wizard-probe-* remains locally or on origin
```

### Stale probe-branch detection (FR-18)

```
Given a prior `kill -9` left autonomous-dev-wizard-probe-1234567890 on origin
When phase 12 re-enters
Then the wizard lists the stale branch
And prompts the operator for cleanup
And on Y, deletes the branch and closes any associated open PR before proceeding
```

### Idempotency: full re-run is no-op (FR-20)

```
Given workflows match templates AND repo secret AUTONOMOUS_DEV_TOKEN is set
AND branch protection is configured with the matching contexts
When phase-12-probe runs
Then it emits "already-complete"
And the orchestrator marks phases.12.status=complete with no body execution
```

### Probe-PR poll cap + run satisfaction (FR-19, NFR poll cap)

```
Given the probe-pr-poll step is running
When 5 minutes elapse without all required contexts succeeding
Then the poll exits with timeout
And cleanup-probe still runs (via trap)
And phases.12.status == "failed" with diagnostic listing the unsatisfied contexts

Given all required contexts succeed within the window
Then poll exits early
And probe-pr-verify-protection asserts the PR was protected from merge until checks passed
```

## 7. Test Requirements

**Eval cases** are owned by SPEC-033-2-03 (five cases). This SPEC focuses on unit / contract tests of the module file itself.

**bats — `tests/setup-wizard/phase-12.bats`:**

| Test ID | Scenario                              | Assert                                                       |
|---------|---------------------------------------|--------------------------------------------------------------|
| P12-101 | Front-matter parse                    | yq returns expected values for all 12 keys                   |
| P12-201 | Skip on gitlab origin                 | predicate aborts; consequence text emitted                   |
| P12-202 | GHES diagnostic                       | failed status; orchestrator continues                        |
| P12-301 | Scope check fails before write        | no fs writes; no gh api PUT calls observed                   |
| P12-401 | PAT no-leak ps-snoop                  | regex sweep + ps -eo args sampling: 0 matches                |
| P12-501 | Workflow scaffold byte-identity       | sha256 of scaffolded == template for all three               |
| P12-601 | Contexts derived from filenames       | gh api PUT body contexts list matches scaffolded basenames   |
| P12-701 | Trap cleanup on SIGTERM               | branch + PR cleaned up                                       |
| P12-702 | Stale-branch detection                | re-entry detects + offers cleanup                            |
| P12-801 | Full-state already-complete           | probe emits already-complete; no body execution              |
| P12-901 | Poll-cap timeout                      | poll exits at 5 min; cleanup runs; status=failed             |

**Mocking:**
- `gh` shimmed via fixture-driven script (canned responses for `repos/<slug>`, `branches/main/protection`, `secret list/set`, `pr create/close`, `run list`).
- `git push/delete` shimmed against a local bare repo.
- A clock fixture allows the poll-cap test to advance simulated time without 5-minute real waits.

## 8. Implementation Notes

- The `gh secret set` invocation reads stdin via heredoc: `gh secret set NAME --body - <<<"$value"` is wrong (echoes via process substitution); use `printf '%s' "$value" | gh secret set NAME --body -` with explicit `unset value` after.
- The probe-PR commit message must be deterministic but timestamp-suffixed so re-runs produce distinct commits and don't get rejected as "no changes".
- The `observe.yml.example` template is intentionally `.example` — operators rename to `.yml` to activate. Phase 12 does NOT auto-activate it (PRD-017 leaves it opt-in); the verification step does NOT include `observe` as a required context.
- If `gh pr merge --auto` is unavailable (older `gh`), fallback is to inspect the PR's `mergeable_state` field for "blocked" while checks are pending.
- Branch deletion `git push origin --delete` may fail if the branch is the default; defensive check: refuse to operate if `branch == "main"`.
- The `trap` MUST capture both `PR_NUM` and `BRANCH` by value (not nameref) so that the cleanup runs correctly even if the variables are unset by the time `EXIT` fires.

## 9. Rollout Considerations

- Feature flag `wizard.phase_12_module_enabled` ships as `true` (per PLAN-033-2 Task 6 / SPEC-033-2-05) but is gated behind Stage 3 canary criteria documented in `STAGE-3-CANARY.md` (SPEC-033-2-05).
- Rollback: `autonomous-dev wizard rollback --phase 12` (SPEC-033-4-05) reverts the four config keys, `gh api -X PUT .../protection` with `required_status_checks=null`, and `gh secret delete AUTONOMOUS_DEV_TOKEN`. Workflow files are LEFT in place (operator may want to keep them); rollback prints "workflow files preserved at .github/workflows/".

## 10. Effort Estimate

| Activity                                      | Estimate |
|-----------------------------------------------|----------|
| Front-matter + module body                    | 0.75 day |
| Skip-predicate wrapper + idempotency wrapper  | 0.25 day |
| Trap cleanup + stale-branch detection         | 0.25 day |
| Unit tests (bats)                             | 0.25 day |
| **Total**                                     | **1.5 day** |

# SPEC-033-2-01: Phase 12 Helper Extensions (skip-predicates + idempotency-checks)

## Metadata
- **Parent Plan**: PLAN-033-2
- **Parent TDD**: TDD-033 §6.3, §10.3
- **Parent PRD**: AMENDMENT-002 §4.3
- **Tasks Covered**: PLAN-033-2 Task 1
- **Estimated effort**: 0.5 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-02

## 1. Summary

Extend the bash helper libraries shipped in SPEC-033-1-01 / SPEC-033-1-02
with phase-12-specific helpers needed by the CI-setup phase module:
`is_github_origin`, `gh_token_has_admin_scope`,
`gh_branch_protection_configured`, and
`workflow_template_hash_matches`. All helpers are read-only, bounded
by ≤ 5 `gh api` calls per probe (TDD-033 §10.3), and tested via bats
on bash 4 + bash 5.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                       | Task |
|-------|----------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | `lib/skip-predicates.sh` MUST gain function `is_github_origin` that exits 0 if `git remote get-url origin` matches `^(https?://|git@)([a-zA-Z0-9.-]+)?github\.([a-z.-]+)` (covering `github.com`, `*.github.com`, GHES per TDD-033 §16). Otherwise exit 1. | T1   |
| FR-2  | `lib/skip-predicates.sh` MUST gain function `gh_token_has_admin_scope <token-env-var-name> <repo-slug>` that calls `GH_TOKEN=$<env-var> gh api repos/<owner>/<repo>` and asserts the JSON response field `permissions.admin == true`. Exit 0 if admin true, exit 1 otherwise. The token MUST be passed via env var, NEVER on the command line (per TDD-033 §9.4 / §6.3 token-leak risk). | T1   |
| FR-3  | `lib/idempotency-checks.sh` MUST gain function `gh_branch_protection_configured <repo-slug>` that calls `gh api repos/<owner>/<repo>/branches/main/protection` and emits one of: `start-fresh` (404 / no protection), `resume-from:partial` (200 but `required_status_checks` is null or missing expected workflow contexts), `already-complete` (200 with required_status_checks containing every context in `output_state.required_workflow_contexts`). | T1   |
| FR-4  | `lib/idempotency-checks.sh` MUST gain function `workflow_template_hash_matches <path> <expected-sha256>` that emits `already-complete` when `sha256sum <path>` matches `<expected-sha256>`, `resume-from:rescaffold` when the file exists with a different hash, `start-fresh` when the file is absent. | T1   |
| FR-5  | Each new helper function MUST cap at 5 `gh api` calls per invocation, with exponential backoff on 5xx (1 s, 2 s, 4 s, 8 s, 16 s) per TDD-033 §10.3. | T1   |
| FR-6  | Each new helper function MUST be read-only (no writes to filesystem, no `gh api -X POST/PUT/DELETE`). A bats fs-snapshot test MUST assert pre-call and post-call `find ~/.autonomous-dev -type f -newer <marker>` returns 0 results. | T1   |
| FR-7  | Each new helper function MUST have a docstring (`# usage:`, `# returns:`, `# example:`) and a bats truth-table test covering at minimum: missing-state, partial-state, complete-state. | T1   |
| FR-8  | `tests/setup-wizard/skip-predicates.bats` and `tests/setup-wizard/idempotency-checks.bats` (existing files from PLAN-033-1) MUST gain new test groups for the four functions. The full bats suite MUST pass on bash 4 (Linux GitHub Actions runner) and bash 5 (macOS Homebrew). | T1   |
| FR-9  | When `gh` CLI is not installed or `GH_TOKEN` env var is unset for `gh_token_has_admin_scope`, the function MUST exit 2 (distinct from "predicate false") and emit a single line to stderr: `gh-cli-or-token-missing`. The orchestrator treats exit 2 as an abort condition (not skip-phase). | T1   |
| FR-10 | `gh_branch_protection_configured` MUST accept an optional second arg listing required workflow contexts (e.g. `gh_branch_protection_configured pwatsonr/foo "autonomous-dev-ci,autonomous-dev-cd"`). When omitted, it falls back to checking only that `required_status_checks` is non-null. | T1   |

## 3. Non-Functional Requirements

| Requirement                  | Target                                                                | Measurement Method                                                |
|------------------------------|-----------------------------------------------------------------------|-------------------------------------------------------------------|
| `gh api` call cap per probe  | ≤ 5 calls (per TDD-033 §10.3)                                          | bats test counts `gh api` invocations via shim                    |
| Probe latency (cached path)  | < 1 s p95 for already-complete branch                                  | bats test wall-clock around invocation                            |
| Probe latency (live API)     | < 10 s p95 for non-cached path with healthy network                    | smoke test against a real test repo (manual / nightly CI)         |
| Read-only invariant          | 0 fs writes inside `~/.autonomous-dev` during any helper call          | fs-snapshot diff bats test                                        |
| Token leak (CLI args)        | 0 occurrences of `ghp_*` token in any captured `ps` output            | bats test snoops `ps -o args` while helper runs                   |
| bash compatibility           | Pass on bash 4 (Linux) AND bash 5 (macOS)                              | CI matrix runs bats on both runners                               |

## 4. Technical Approach

**Files modified:**
- `plugins/autonomous-dev-assist/skills/setup-wizard/lib/skip-predicates.sh` — append `is_github_origin`, `gh_token_has_admin_scope`.
- `plugins/autonomous-dev-assist/skills/setup-wizard/lib/idempotency-checks.sh` — append `gh_branch_protection_configured`, `workflow_template_hash_matches`.
- `plugins/autonomous-dev-assist/tests/setup-wizard/skip-predicates.bats` — append predicates test group.
- `plugins/autonomous-dev-assist/tests/setup-wizard/idempotency-checks.bats` — append idempotency test group.

**Function signatures + outlines:**

```bash
# is_github_origin
# usage: is_github_origin
# returns: exit 0 if origin remote is any github host (github.com, *.github.com, GHES), else 1
# example: if is_github_origin; then echo "github"; fi
is_github_origin() {
  local url
  url="$(git remote get-url origin 2>/dev/null)" || return 1
  [[ "$url" =~ ^(https?://|git@)([a-zA-Z0-9.-]+\.)?github\.([a-z.-]+) ]]
}

# gh_token_has_admin_scope <token-env-var-name> <repo-slug>
# usage: gh_token_has_admin_scope GH_TOKEN pwatsonr/autonomous-dev
# returns: exit 0 admin true; exit 1 admin false; exit 2 gh/token missing
gh_token_has_admin_scope() {
  local env_var_name="$1" repo_slug="$2"
  command -v gh >/dev/null 2>&1 || { echo "gh-cli-or-token-missing" >&2; return 2; }
  [[ -n "${!env_var_name:-}" ]] || { echo "gh-cli-or-token-missing" >&2; return 2; }
  local resp
  resp="$(GH_TOKEN="${!env_var_name}" _gh_with_backoff api "repos/${repo_slug}")" || return 1
  [[ "$(echo "$resp" | jq -r '.permissions.admin // false')" == "true" ]]
}

# _gh_with_backoff: internal helper, ≤5 attempts, exponential 1/2/4/8/16s on 5xx
_gh_with_backoff() {
  local attempt=0 max=5 delay=1
  while (( attempt < max )); do
    if out="$(gh "$@" 2>/dev/null)"; then echo "$out"; return 0; fi
    rc=$?
    # 5xx → retry; 4xx / not-found → bail
    case "$rc" in
      4|22|3) return $rc ;;
    esac
    sleep "$delay"
    delay=$(( delay * 2 ))
    attempt=$(( attempt + 1 ))
  done
  return 1
}

# gh_branch_protection_configured <repo-slug> [required-contexts-csv]
# returns stdout: start-fresh | resume-from:partial | already-complete
gh_branch_protection_configured() {
  local repo_slug="$1" req_contexts_csv="${2:-}"
  local resp
  if ! resp="$(_gh_with_backoff api "repos/${repo_slug}/branches/main/protection" 2>/dev/null)"; then
    echo "start-fresh"; return 0
  fi
  local rsc
  rsc="$(echo "$resp" | jq -r '.required_status_checks.contexts[]?' 2>/dev/null || true)"
  if [[ -z "$rsc" ]]; then echo "resume-from:partial"; return 0; fi
  if [[ -z "$req_contexts_csv" ]]; then echo "already-complete"; return 0; fi
  local missing=0
  IFS=, read -ra needed <<< "$req_contexts_csv"
  for ctx in "${needed[@]}"; do
    grep -qx "$ctx" <<< "$rsc" || { missing=1; break; }
  done
  if (( missing == 0 )); then echo "already-complete"; else echo "resume-from:partial"; fi
}

# workflow_template_hash_matches <path> <expected-sha256>
# returns stdout: already-complete | resume-from:rescaffold | start-fresh
workflow_template_hash_matches() {
  local path="$1" expected="$2"
  [[ -f "$path" ]] || { echo "start-fresh"; return 0; }
  local actual
  actual="$(sha256sum "$path" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] && echo "already-complete" || echo "resume-from:rescaffold"
}
```

**Backoff cap proof:** `_gh_with_backoff` loops at most 5 times with delays `1+2+4+8+16=31s`; total worst-case wall clock ≈ 31 s plus 5 API calls. Bounded per FR-5 / NFR.

**Token leak prevention:** `gh_token_has_admin_scope` exports `GH_TOKEN` for the duration of the `gh` invocation only (subshell scoping); the token never appears in argv, so `ps -o args` snooping returns no match. The bats test asserts this with a backgrounded `ps` poll while the helper runs.

**bash 4 vs 5 compat:**
- `${!env_var_name}` indirect expansion — supported in both.
- `[[ ... =~ ... ]]` — both.
- `mapfile`/`readarray` — bash 4+; not used here.
- `read -ra` — both.
- Arrays + `IFS` splitting — both.

## 5. Interfaces and Dependencies

**Consumed:**
- SPEC-033-1-01: existing `lib/skip-predicates.sh` skeleton.
- SPEC-033-1-02: existing `lib/idempotency-checks.sh` skeleton.
- `gh` CLI (operator-installed; documented prerequisite).
- `jq` (Linux/macOS; documented prerequisite).
- `git` (origin remote read).
- `sha256sum` (Linux) / `shasum -a 256` (macOS) — provide a wrapper.

**Produced:**
- Four new bash helpers as documented above.
- Test groups in two existing bats files.

## 6. Acceptance Criteria

### `is_github_origin` truth table (FR-1)

```
Given origin remote = "git@github.com:pwatsonr/foo.git"
When is_github_origin runs
Then exit code is 0

Given origin remote = "https://gitlab.com/x/y.git"
When is_github_origin runs
Then exit code is 1

Given origin remote = "git@github.example-corp.com:x/y.git" (GHES style)
When is_github_origin runs
Then exit code is 0

Given no origin remote configured
When is_github_origin runs
Then exit code is 1
```

### `gh_token_has_admin_scope` (FR-2, FR-9)

```
Given env var FAKE_TOKEN holds a token whose gh api response has permissions.admin=true
When gh_token_has_admin_scope FAKE_TOKEN pwatsonr/foo runs
Then exit code is 0
And `ps -o args` snooped during the call shows no "ghp_*" string

Given env var FAKE_TOKEN holds a token with permissions.admin=false
Then exit code is 1

Given gh CLI is not on PATH
Then exit code is 2 and stderr contains "gh-cli-or-token-missing"

Given env var FAKE_TOKEN is unset
Then exit code is 2 and stderr contains "gh-cli-or-token-missing"
```

### `gh_branch_protection_configured` (FR-3, FR-10)

```
Given the repo has no branch protection on main (404 response)
When gh_branch_protection_configured pwatsonr/foo runs
Then stdout is "start-fresh"

Given the repo has protection but required_status_checks is null
Then stdout is "resume-from:partial"

Given protection exists with contexts ["autonomous-dev-ci","autonomous-dev-cd"]
And the call passes second arg "autonomous-dev-ci,autonomous-dev-cd"
Then stdout is "already-complete"

Given protection exists with contexts ["autonomous-dev-ci"] only
And the call passes second arg "autonomous-dev-ci,autonomous-dev-cd"
Then stdout is "resume-from:partial"
```

### `workflow_template_hash_matches` (FR-4)

```
Given file does not exist at path
Then stdout is "start-fresh"

Given file exists with sha256 == expected
Then stdout is "already-complete"

Given file exists with different sha256
Then stdout is "resume-from:rescaffold"
```

### Backoff cap (FR-5, NFR call cap)

```
Given a gh api endpoint that returns 503 always
When _gh_with_backoff runs
Then it makes exactly 5 attempts
And total wall clock is between 31s and 35s (delays 1+2+4+8+16)
And final exit code is 1
```

### Read-only invariant (FR-6, NFR read-only)

```
Given a snapshot of ~/.autonomous-dev taken before invocation
When any of the four helpers run (mocked or live)
Then a post-invocation snapshot diff returns 0 changed/created files
```

### Token-leak ps-snoop (FR-2, NFR token leak)

```
Given gh_token_has_admin_scope is invoked in a subshell
When `ps -eo args` is sampled every 100ms during the call
Then no sample contains the literal token characters
```

## 7. Test Requirements

**bats — `tests/setup-wizard/skip-predicates.bats` (extended):**

| Test ID | Scenario                                  | Assert                                                  |
|---------|-------------------------------------------|---------------------------------------------------------|
| SP-201  | is_github_origin: github.com SSH          | exit 0                                                  |
| SP-202  | is_github_origin: github.com HTTPS        | exit 0                                                  |
| SP-203  | is_github_origin: gitlab.com              | exit 1                                                  |
| SP-204  | is_github_origin: GHES `*.github.example` | exit 0                                                  |
| SP-205  | is_github_origin: no remote               | exit 1                                                  |
| SP-301  | gh_token_has_admin_scope: admin=true      | exit 0                                                  |
| SP-302  | gh_token_has_admin_scope: admin=false     | exit 1                                                  |
| SP-303  | gh_token_has_admin_scope: missing gh      | exit 2; stderr contains marker                          |
| SP-304  | gh_token_has_admin_scope: unset env var   | exit 2; stderr contains marker                          |
| SP-305  | Token-leak ps-snoop                       | no sample contains token chars                          |

**bats — `tests/setup-wizard/idempotency-checks.bats` (extended):**

| Test ID | Scenario                                    | Assert                                  |
|---------|---------------------------------------------|-----------------------------------------|
| IC-301  | branch-protection 404                       | stdout `start-fresh`                    |
| IC-302  | branch-protection partial                   | stdout `resume-from:partial`            |
| IC-303  | branch-protection complete (no req args)    | stdout `already-complete`               |
| IC-304  | branch-protection contexts match            | stdout `already-complete`               |
| IC-305  | branch-protection contexts missing one      | stdout `resume-from:partial`            |
| IC-401  | workflow-hash file missing                  | stdout `start-fresh`                    |
| IC-402  | workflow-hash matches                       | stdout `already-complete`               |
| IC-403  | workflow-hash differs                       | stdout `resume-from:rescaffold`         |
| IC-501  | Backoff: 5 attempts, 31s wall clock         | attempt-counter == 5; duration in range |
| IC-601  | Read-only invariant                         | fs-snapshot diff empty                  |

**Mocking:**
- `gh` CLI shimmed via a bats fixture that reads canned responses from `tests/setup-wizard/fixtures/gh-responses/`.
- `git remote get-url origin` shimmed via a temp git repo with a configured origin.

## 8. Implementation Notes

- macOS does not ship `sha256sum`; provide a one-line wrapper `_sha256() { command -v sha256sum >/dev/null && sha256sum || shasum -a 256; }` and use `_sha256` inside `workflow_template_hash_matches`.
- `gh api` returns non-zero on 404 with rc=1 (gh-cli convention). The wrapper distinguishes 404 (treat as `start-fresh`) from 5xx (retry).
- The GHES regex deliberately matches any `*.github.*` host. Per TDD-033 §16 open question 2 we treat all GitHub-flavored hosts as origins; if downstream auth flow differs, phase 12 emits a documented diagnostic (covered in SPEC-033-2-02).
- Helpers MUST NOT cache results to disk. The orchestrator's snapshot mechanism (SPEC-033-1-03) handles persistence; helpers stay pure.
- The `_gh_with_backoff` helper is internal to this file (underscore prefix). It MUST NOT be re-exported for general use; it lacks input sanitization for arbitrary callers.

## 9. Rollout Considerations

- These helpers ship behind no feature flag (they are infrastructure). They are inert until phase 12 calls them.
- `gh` CLI version pin: tests run against `gh ≥ 2.40`. Older versions are documented as unsupported in `_phase-contract.md`.

## 10. Effort Estimate

| Activity                                      | Estimate |
|-----------------------------------------------|----------|
| Helper implementations                        | 0.25 day |
| bats tests (10+ cases)                        | 0.25 day |
| **Total**                                     | **0.5 day** |

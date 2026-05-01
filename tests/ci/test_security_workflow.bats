#!/usr/bin/env bats

# tests/ci/test_security_workflow.bats
# Smoke tests for PLAN-016-4 security workflow integrity.
#
# Validates that .github/workflows/security-review.yml and
# .github/security/gitleaks.toml hold the contract documented in
# SPECs 016-4-01..04. Runs in the repo's existing lint workflow so
# silent drift in the security configuration is caught at PR time.
#
# Tools assumed available:
#   - bats-core (already vendored per repo CI; required)
#   - actionlint (optional; tests that need it `skip` if missing)
#   - gitleaks v8 (optional; tests that need it `skip` if missing)
# Tests that depend on optional tooling skip with a clear reason rather
# than failing locally so contributors without the tool can still run
# the rest of the suite.

setup() {
  REPO_ROOT="$(git rev-parse --show-toplevel)"
  WORKFLOW="${REPO_ROOT}/.github/workflows/security-review.yml"
  CONFIG="${REPO_ROOT}/.github/security/gitleaks.toml"
  FIXTURE="${REPO_ROOT}/tests/fixtures/security/leaked-aws-key.txt"
  export REPO_ROOT WORKFLOW CONFIG FIXTURE
}

@test "gitleaks config parses cleanly" {
  command -v gitleaks >/dev/null 2>&1 || skip "gitleaks binary not installed"
  empty_dir="$(mktemp -d)"
  run gitleaks detect --config "${CONFIG}" --no-git --source "${empty_dir}"
  [ "${status}" -eq 0 ]
}

@test "gitleaks config contains all five custom rules" {
  for rule in "anthropic-api-key" "slack-bot-token" "discord-bot-token" "github-pat" "aws-access-key"; do
    run grep -F "id = \"${rule}\"" "${CONFIG}"
    if [ "${status}" -ne 0 ]; then
      echo "Missing rule: ${rule}" >&2
      return 1
    fi
  done
}

@test "workflow file passes actionlint" {
  command -v actionlint >/dev/null 2>&1 || skip "actionlint not installed"
  run actionlint "${WORKFLOW}"
  [ "${status}" -eq 0 ]
}

@test "all actions in workflow are pinned (no @latest, @main, @master)" {
  # No @latest, no @main, no bare branch refs -- grep finds NOTHING.
  run grep -E '^\s*uses:\s+[^@]+@(latest|main|master)\b' "${WORKFLOW}"
  [ "${status}" -ne 0 ]
}

@test "all actions in workflow use pinned semver" {
  # Every `uses:` line MUST end in @vN, @vN.N, or @vN.N.N
  while IFS= read -r line; do
    if ! [[ "${line}" =~ uses:[[:space:]]+[^@]+@v[0-9]+(\.[0-9]+){0,2} ]]; then
      echo "Unpinned action: ${line}" >&2
      return 1
    fi
  done < <(grep -E '^\s*uses:\s+' "${WORKFLOW}")
}

@test "SARIF upload categories are unique" {
  run grep -E '^\s+category:\s+' "${WORKFLOW}"
  [ "${status}" -eq 0 ]
  unique_count=$(grep -E '^\s+category:\s+' "${WORKFLOW}" | sort -u | wc -l | tr -d ' ')
  total_count=$(grep -cE '^\s+category:\s+' "${WORKFLOW}")
  [ "${unique_count}" -eq "${total_count}" ]
}

@test "trufflehog job is gated to schedule + workflow_dispatch only" {
  run grep -F "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'" "${WORKFLOW}"
  [ "${status}" -eq 0 ]
}

@test "trufflehog uses --only-verified" {
  run grep -F -- "--only-verified" "${WORKFLOW}"
  [ "${status}" -eq 0 ]
}

@test "smoke fixture exists" {
  [ -f "${FIXTURE}" ]
}

@test "smoke fixture is silenced by gitleaks allowlist" {
  command -v gitleaks >/dev/null 2>&1 || skip "gitleaks binary not installed"
  run gitleaks detect --config "${CONFIG}" --no-git --source "$(dirname "${FIXTURE}")"
  [ "${status}" -eq 0 ]
}

@test "smoke fixture is detected when allowlist is bypassed" {
  command -v gitleaks >/dev/null 2>&1 || skip "gitleaks binary not installed"
  run gitleaks detect --config "${CONFIG}" --no-git --no-allowlist --source "$(dirname "${FIXTURE}")"
  [ "${status}" -ne 0 ]
  echo "${output}" | grep -F "aws-access-key"
}

@test "aggregate job is named security-baseline" {
  run grep -F "name: security-baseline" "${WORKFLOW}"
  [ "${status}" -eq 0 ]
}

@test "aggregate job needs gitleaks and uses if: always()" {
  run grep -A 4 "name: security-baseline" "${WORKFLOW}"
  [ "${status}" -eq 0 ]
  echo "${output}" | grep -F "needs: [gitleaks]"
  echo "${output}" | grep -F "if: always()"
}

@test "allowlist commit exemptions stay below soft cap" {
  # Soft cap: <=5 entries before SECURITY.md exemption-log review tightens.
  count=$(grep -cE '^\s+"[a-f0-9]{7,40}"' "${CONFIG}" || true)
  if [ "${count}" -gt 5 ]; then
    echo "Commit exemption count ${count} exceeds soft cap of 5" >&2
    return 1
  fi
}

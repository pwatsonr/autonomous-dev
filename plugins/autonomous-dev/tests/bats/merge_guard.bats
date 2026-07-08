#!/usr/bin/env bats
# #653 — merge-guard PreToolUse hook: agents may create PRs but never merge
# or push to main. Exit 2 => the tool call is denied.

HOOK="${BATS_TEST_DIRNAME}/../../hooks/merge-guard.sh"

run_hook() { # $1 = command string the agent tried to run
  printf '{"tool_input":{"command":%s}}' "$(jq -Rn --arg c "$1" '$c')" | "$HOOK"
}

# ── must BLOCK (exit 2) ──
@test "MG-01 blocks gh pr merge" { run run_hook 'gh pr merge 651 --squash'; [ "$status" -eq 2 ]; }
@test "MG-02 blocks gh pr merge --auto" { run run_hook 'gh pr merge --auto 12'; [ "$status" -eq 2 ]; }
@test "MG-03 blocks gh pr review --approve" { run run_hook 'gh pr review 5 --approve'; [ "$status" -eq 2 ]; }
@test "MG-04 blocks gh api merge" { run run_hook 'gh api repos/o/r/pulls/5/merge -X PUT'; [ "$status" -eq 2 ]; }
@test "MG-05 blocks git push origin main" { run run_hook 'git push origin main'; [ "$status" -eq 2 ]; }
@test "MG-06 blocks git push HEAD:main" { run run_hook 'git push origin HEAD:main --force'; [ "$status" -eq 2 ]; }
@test "MG-07 blocks merge even when chained" { run run_hook 'cd /r && gh pr merge 9 && echo done'; [ "$status" -eq 2 ]; }

# ── must ALLOW (exit 0) ──
@test "MG-10 allows gh pr create" { run run_hook 'gh pr create --base main --title x --body y'; [ "$status" -eq 0 ]; }
@test "MG-11 allows push to a feature branch" { run run_hook 'git push origin autonomous/REQ-000070'; [ "$status" -eq 0 ]; }
@test "MG-12 allows git commit" { run run_hook 'git commit -m "feat: fix"'; [ "$status" -eq 0 ]; }
@test "MG-13 allows gh pr view" { run run_hook 'gh pr view 5 --json state'; [ "$status" -eq 0 ]; }
@test "MG-14 allows test runner" { run run_hook 'npm test'; [ "$status" -eq 0 ]; }
@test "MG-15 empty command is a no-op" { run run_hook ''; [ "$status" -eq 0 ]; }

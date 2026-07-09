#!/usr/bin/env bash
# merge-guard.sh — PreToolUse (Bash) hook. Blocks any daemon-spawned agent
# session from merging a PR or pushing to main. Merging is the EXCLUSIVE job
# of the daemon's merge_decision (in supervisor-loop.sh, a bash function — not
# a spawned session), which enforces the green-required policy, the infra-gate
# allowlist, the order-aware rebase gate, and the human gate. Agents may create
# PRs (gh pr create) but never merge them.
#
# Guards #653: a code-executor self-merged an off-task PR to main via
# `gh pr merge`, bypassing every gate. Exit 2 => PreToolUse denies the tool call.
set -euo pipefail

input="$(cat 2>/dev/null || true)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")"
[ -z "$cmd" ] && exit 0

# Collapse newlines/whitespace so multi-line or padded commands still match.
norm="$(printf '%s' "$cmd" | tr '\n\t' '  ' | tr -s ' ')"

deny() {
  echo "BLOCKED by merge-guard (#653): agent sessions may NOT $1. Merging/main-push is the daemon merge_decision's exclusive job; you may 'gh pr create' but never merge or push to main." >&2
  exit 2
}

# gh pr merge (the observed bypass vector)
printf '%s' "$norm" | grep -qiE '(^|[^[:alnum:]_-])gh +pr +merge([^[:alnum:]-]|$)'            && deny "merge PRs (gh pr merge)"
# self-approve a PR review
printf '%s' "$norm" | grep -qiE '(^|[^[:alnum:]_-])gh +pr +review\b.*--approve'                && deny "approve PR reviews (gh pr review --approve)"
# merge via the REST API
printf '%s' "$norm" | grep -qiE '(^|[^[:alnum:]_-])gh +api\b.*(/merge\b|/merges\b|:merge\b)'    && deny "merge via gh api"
# direct push to main (any of: origin main, HEAD:main, :main, refs/heads/main)
printf '%s' "$norm" | grep -qiE '(^|[^[:alnum:]_-])git +push\b.*(\bmain\b|:main\b|/main\b)'      && deny "push to main (git push … main)"
# #678: filing/editing GitHub issues. A confabulating executor spammed the
# tracker (#655-676) inventing a roadmap. The pipeline files issues through its
# own channels (issue_filer.ts on failure); an agent session must not.
printf '%s' "$norm" | grep -qiE '(^|[^[:alnum:]_-])gh +issue +(create|edit|develop|transfer|pin|delete)\b' && deny "create/edit GitHub issues (gh issue ...)"

exit 0

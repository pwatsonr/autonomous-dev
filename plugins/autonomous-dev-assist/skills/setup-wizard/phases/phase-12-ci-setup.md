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

# Phase 12 — CI workflows + repo secrets + branch protection

This phase wires GitHub-side CI infrastructure for autonomous-dev. It is
the first phase to handle a GitHub PAT and writes both into the
operator's repo (`.github/workflows/*.yml`) and into GitHub-side
configuration (repo secret, branch protection). Verification is via a
**probe-PR**: a throwaway PR on a uniquely-timestamped branch
unconditionally cleaned up via a `trap`.

## PRD-015 cross-reference

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

## Steps

### Step `intro`

Banner. Sensitive phase warning. PAT scope requirements.

```
================================================================
   Phase 12: CI workflows + repo secrets + branch protection
   SENSITIVE PHASE — handles GitHub PAT
================================================================

Required PAT scopes:
  - repo
  - workflow

Required: admin permission on this repo (verified before any write).
```

### Step `detect-origin`

```bash
remote="$(git remote get-url origin 2>/dev/null || true)"
case "$remote" in
  *github.com*) ;;  # OK
  *.github.*)
    echo "GHES origin detected; phase 12 supports github.com only at this time."
    echo "See TDD-033 §16 for GHES roadmap."
    exit 1
    ;;
  *)
    # Skip predicate already aborted; defensive
    echo "Non-GitHub origin; skipping phase 12."
    exit 0
    ;;
esac
```

### Step `detect-stale-probe-branches`

```bash
stale="$(git branch -r --list 'origin/autonomous-dev-wizard-probe-*' 2>/dev/null || true)"
if [[ -n "$stale" ]]; then
  echo "Found stale probe branches:"
  echo "$stale"
  read -r -p "Clean up before proceeding? [Y/n] " ans
  case "$ans" in
    n|N) echo "Aborting; please clean up manually."; exit 1 ;;
    *)
      while IFS= read -r br; do
        br="${br##*/origin/}"
        git push origin --delete "$br" 2>/dev/null || true
      done <<< "$stale"
      ;;
  esac
fi
```

### Step `collect-pat`

```bash
set +x
IFS= read -rs -p "GitHub PAT (with repo + workflow scopes): " pat
echo
# Length sanity check (40-100 chars covers classic + fine-grained)
[[ ${#pat} -ge 40 && ${#pat} -le 200 ]] \
  || { echo "PAT length out of expected range; please re-enter"; unset pat; exit 1; }
```

### Step `verify-scopes`

```bash
slug="$(git remote get-url origin | sed -E 's#.*github\.com[/:]##; s#\.git$##')"
export GH_TOKEN="$pat"
if ! bash "$LIB_DIR/skip-predicates.sh" gh_token_has_admin_scope GH_TOKEN "$slug"; then
  unset GH_TOKEN pat
  echo "your token needs \`repo\` + \`workflow\` scopes; current token does not have admin permissions on this repo"
  exit 1
fi
```

### Step `write-secret-env`

```bash
source "$LIB_DIR/cred-proxy-bridge.sh"
cred_proxy_write_env GH_TOKEN "$pat"
unset pat GH_TOKEN
```

### Step `scaffold-workflows`

For each of the three template files
(`autonomous-dev-ci.yml`, `autonomous-dev-cd.yml`, `observe.yml.example`):

```bash
src="$PLUGIN_DIR/templates/workflows/$file"
dst=".github/workflows/$file"
expected_sha="$(sha256sum "$src" | awk '{print $1}')"
result="$(bash "$LIB_DIR/idempotency-checks.sh" workflow_template_hash_matches "$dst" "$expected_sha")"
case "$result" in
  already-complete) echo "skip $file: already matches template" ;;
  start-fresh) mkdir -p ".github/workflows"; cp "$src" "$dst" ;;
  resume-from:rescaffold)
    diff -u "$dst" "$src" || true
    read -r -p "Overwrite $file? [y/N] " a
    [[ "$a" =~ ^[Yy]$ ]] && cp "$src" "$dst" || echo "kept existing $file"
    ;;
esac
```

### Step `set-repo-secret`

```bash
# Read AUTONOMOUS_DEV_TOKEN from secrets.env; pass via stdin (NEVER argv).
# shellcheck disable=SC1091
source "${AUTONOMOUS_DEV_SECRETS_FILE:-$HOME/.autonomous-dev/secrets.env}"
if gh secret list 2>/dev/null | grep -q '^AUTONOMOUS_DEV_TOKEN'; then
  read -r -p "Secret already exists; reuse? [Y/n] " ans
  [[ "$ans" =~ ^[Nn]$ ]] || { echo "reusing existing secret"; ADT_SET=1; }
fi
if [[ -z "${ADT_SET:-}" ]]; then
  GH_TOKEN="$AUTONOMOUS_DEV_TOKEN" \
    printf '%s' "$AUTONOMOUS_DEV_TOKEN" | gh secret set AUTONOMOUS_DEV_TOKEN --body -
fi
unset AUTONOMOUS_DEV_TOKEN
```

### Step `configure-protection`

```bash
# Build contexts CSV from scaffolded basenames (NOT hard-coded).
contexts=()
for f in .github/workflows/autonomous-dev-ci.yml .github/workflows/autonomous-dev-cd.yml; do
  [[ -f "$f" ]] && contexts+=("$(basename "$f" .yml)")
done
csv="$(IFS=,; echo "${contexts[*]}")"
result="$(bash "$LIB_DIR/idempotency-checks.sh" gh_branch_protection_configured "$slug" "$csv")"
if [[ "$result" != "already-complete" ]]; then
  body="$(jq -n --argjson ctx "$(printf '%s\n' "${contexts[@]}" | jq -R . | jq -s .)" \
    '{required_status_checks: {strict: true, contexts: $ctx}, enforce_admins: true, required_pull_request_reviews: null, restrictions: null}')"
  printf '%s' "$body" | gh api -X PUT "repos/$slug/branches/main/protection" --input -
fi
```

### Step `probe-pr-prepare` + cleanup trap (FR-17)

```bash
T="$(date +%s)"
BRANCH="autonomous-dev-wizard-probe-$T"
PR_NUM=""
_phase12_cleanup() {
  local pr="$1" branch="$2"
  [[ -n "$pr" ]] && gh pr close "$pr" --comment "wizard probe cleanup" 2>/dev/null || true
  [[ -n "$branch" && "$branch" != "main" ]] && {
    git push origin --delete "$branch" 2>/dev/null || true
    git branch -D "$branch" 2>/dev/null || true
  }
}
# shellcheck disable=SC2064
trap '_phase12_cleanup "$PR_NUM" "$BRANCH"' EXIT INT TERM
```

### Step `probe-pr-create`

```bash
git checkout -b "$BRANCH"
mkdir -p .autonomous-dev
echo "# wizard probe $T" > ".autonomous-dev/wizard-probe-$T.md"
git add ".autonomous-dev/wizard-probe-$T.md"
git commit -m "wizard probe $T"
git push -u origin "$BRANCH"
PR_NUM="$(gh pr create --base main --head "$BRANCH" \
  --title "wizard probe $T" --body "automated probe; will close + delete on cleanup" \
  --json number --jq '.number')"
```

### Step `probe-pr-poll`

```bash
deadline=$(( $(date +%s) + 300 ))   # 5-minute ceiling per TDD-033 §10.3
while (( $(date +%s) < deadline )); do
  resp="$(gh run list --branch "$BRANCH" --json conclusion,status,name 2>/dev/null || echo '[]')"
  # exit early on first failure
  if echo "$resp" | jq -e '.[] | select(.conclusion == "failure")' >/dev/null; then
    echo "probe-PR run failure detected"
    exit 1
  fi
  # success: every required context is "completed" + "success"
  pending="$(echo "$resp" | jq -r '[.[] | select(.status != "completed")] | length')"
  if [[ "$pending" == "0" ]] && echo "$resp" | jq -e 'length > 0' >/dev/null; then
    break
  fi
  sleep 5
done
```

### Step `probe-pr-verify-protection`

```bash
state="$(gh pr view "$PR_NUM" --json mergeable,mergeStateStatus --jq '.mergeStateStatus')"
# "blocked" or "behind" while checks pending; "clean" or "unstable" when checks done
case "$state" in
  blocked|behind) echo "verified: PR was protected from merge until checks passed" ;;
  *) ;;
esac
```

### Step `cleanup-probe`

```bash
_phase12_cleanup "$PR_NUM" "$BRANCH"
trap - EXIT INT TERM
```

### Step `write-config`

```bash
jq --arg slug "$slug" --argjson contexts "$(printf '%s\n' "${contexts[@]}" | jq -R . | jq -s .)" \
  '.ci.github_pat_env = "GH_TOKEN"
   | .ci.workflow_paths = [".github/workflows/autonomous-dev-ci.yml",
                            ".github/workflows/autonomous-dev-cd.yml",
                            ".github/workflows/observe.yml.example"]
   | .ci.branch_protection_enabled = true
   | .ci.required_status_checks = $contexts' \
  ~/.autonomous-dev/config.json > ~/.autonomous-dev/config.json.tmp
mv ~/.autonomous-dev/config.json.tmp ~/.autonomous-dev/config.json
```

### Step `summary`

Emit `{"phase":12,"step":"verify","status":"completed","duration_ms":N}`.

## Defense-in-depth

- `set +x` before reading PAT; `unset` immediately after `cred_proxy_write_env`.
- PAT passed to `gh` exclusively via `GH_TOKEN`; never via argv.
- Trap registered BEFORE `gh pr create`; cleared only after explicit close+delete.
- Stale-branch detection on phase entry handles `kill -9` survivors (FR-18).
- Branch deletion refuses to operate on `main` (defensive).
- 5-minute poll ceiling per TDD-033 §10.3.
- `gh api` invocations capped at ≤ 5 per probe per TDD-033 §10.3.

## Resume contract

`WIZARD_RESUME_STEP` jumps to a named step. The probe always uses a
fresh timestamp so re-runs never collide. Stale probe branches from
prior `kill -9` are detected and cleaned at phase entry.

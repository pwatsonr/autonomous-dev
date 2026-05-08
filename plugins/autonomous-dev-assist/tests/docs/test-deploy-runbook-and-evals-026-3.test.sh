#!/usr/bin/env bash
# test-deploy-runbook-and-evals-026-3.test.sh
#
# SPEC-026-3-05 doc-smoke: gate the structural and safety-string invariants
# delivered by SPEC-026-3-01 / -02 / -03 / -04. Asserts:
#   - instructions/deploy-runbook.md has all eight ## H2 sections
#   - safety strings present (regardless of trust level >=3,
#     do NOT edit by hand >=2, do NOT rm the ledger >=1,
#     deploy ledger reset >=3)
#   - deploy negative bag absent in deploy-runbook.md (modulo
#     edit.*ledger\.json which is permitted only on do-NOT lines)
#   - instructions/runbook.md ends with ## See also + 4 bulleted links
#   - evals/test-cases/chains-eval.yaml has >=20 cases
#   - evals/test-cases/deploy-eval.yaml has >=30 cases
#   - SHA pinning absent across all touched files
#   - markdown-link-check passes (cred-proxy / firewall XFAIL)
#   - markdownlint passes on the two runbook files
#   - yamllint passes on the two new eval YAMLs

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
ASSIST_DIR="${REPO_ROOT}/plugins/autonomous-dev-assist"
DEPLOY_RB="${ASSIST_DIR}/instructions/deploy-runbook.md"
RUNBOOK="${ASSIST_DIR}/instructions/runbook.md"
CHAINS_EVAL="${ASSIST_DIR}/evals/test-cases/chains-eval.yaml"
DEPLOY_EVAL="${ASSIST_DIR}/evals/test-cases/deploy-eval.yaml"

FAIL=0
ok()   { echo "[OK]   $*"; }
fail() { echo "[FAIL] $*"; FAIL=$((FAIL+1)); }
skip() { echo "[SKIP] $*"; }

# ── FR-12: deploy-runbook eight H2 sections ───────────────────────────
if [[ -f "$DEPLOY_RB" ]]; then
    ok "deploy-runbook.md exists"
else
    fail "deploy-runbook.md missing"
fi

HEADERS=(
    '^## 1\. Bootstrap$'
    '^## 2\. The approval state machine$'
    '^## 3\. Cost-cap trip recovery$'
    '^## 4\. Ledger inspection$'
    '^## 5\. HealthMonitor \+ SLA tracker$'
    '^## 6\. Rollback$'
    '^## 7\. Common errors$'
    '^## 8\. See also$'
)
for hdr in "${HEADERS[@]}"; do
    if grep -qE "$hdr" "$DEPLOY_RB"; then
        ok "deploy-runbook: $hdr"
    else
        fail "deploy-runbook: missing $hdr"
    fi
done

# ── FR-13: safety strings ──────────────────────────────────────────────
rotl=$(grep -c 'regardless of trust level' "$DEPLOY_RB" || true)
if (( rotl >= 3 )); then
    ok "deploy-runbook: 'regardless of trust level' x$rotl"
else
    fail "deploy-runbook: 'regardless of trust level' = $rotl (need >=3)"
fi

dnh=$(grep -c 'do NOT edit by hand' "$DEPLOY_RB" || true)
if (( dnh >= 2 )); then
    ok "deploy-runbook: 'do NOT edit by hand' x$dnh"
else
    fail "deploy-runbook: 'do NOT edit by hand' = $dnh (need >=2)"
fi

dnr=$(grep -c 'do NOT rm the ledger' "$DEPLOY_RB" || true)
if (( dnr >= 1 )); then
    ok "deploy-runbook: 'do NOT rm the ledger' x$dnr"
else
    fail "deploy-runbook: 'do NOT rm the ledger' = $dnr (need >=1)"
fi

dlr=$(grep -c 'deploy ledger reset' "$DEPLOY_RB" || true)
if (( dlr >= 3 )); then
    ok "deploy-runbook: 'deploy ledger reset' x$dlr"
else
    fail "deploy-runbook: 'deploy ledger reset' = $dlr (need >=3)"
fi

# ── FR-14: deploy negative-bag absence ────────────────────────────────
neg=$(grep -cE 'deploy force-approve|deploy auto-prod|deploy.*--no-approval|cost cap.*ignore' "$DEPLOY_RB" || true)
if (( neg == 0 )); then
    ok "deploy-runbook: deploy negative-bag absent"
else
    fail "deploy-runbook: $neg negative-bag match(es)"
fi

# edit.*ledger\.json only inside do-NOT context
bad=$(grep -E 'edit.*ledger\.json' "$DEPLOY_RB" | grep -vc 'do NOT' || true)
if (( bad == 0 )); then
    ok "deploy-runbook: 'edit.*ledger.json' only in do-NOT context"
else
    fail "deploy-runbook: $bad line(s) mention edit-ledger outside do-NOT"
fi

# ── FR-15: runbook.md tail = ## See also + 4 bullets ──────────────────
last_h2=$(grep -n '^## ' "$RUNBOOK" | tail -1 | cut -d: -f2-)
if [[ "$last_h2" == "## See also" ]]; then
    ok "runbook.md tail H2 == '## See also'"
else
    fail "runbook.md tail H2 = '$last_h2' (expected '## See also')"
fi

for target in 'chains-runbook.md' 'deploy-runbook.md' 'cred-proxy-runbook.md' 'firewall-runbook.md'; do
    if awk '/^## See also/{f=1} f' "$RUNBOOK" | grep -q "$target"; then
        ok "runbook.md See-also: $target link present"
    else
        fail "runbook.md See-also: missing link to $target"
    fi
done

xfail_count=$(awk '/^## See also/{f=1} f' "$RUNBOOK" | grep -c 'XFAIL: TDD-025 ships this runbook' || true)
if (( xfail_count == 2 )); then
    ok "runbook.md See-also: 2 XFAIL comments (cred-proxy + firewall)"
else
    fail "runbook.md See-also: $xfail_count XFAIL comment(s) (expected 2)"
fi

# ── FR-16 / FR-17: eval YAML existence + case counts ──────────────────
if [[ -f "$CHAINS_EVAL" ]]; then
    ok "chains-eval.yaml exists"
else
    fail "chains-eval.yaml missing"
fi

if [[ -f "$DEPLOY_EVAL" ]]; then
    ok "deploy-eval.yaml exists"
else
    fail "deploy-eval.yaml missing"
fi

count_cases() {
    # Count cases via python3 (PyYAML); fall back to grep on '- id:' lines
    local f="$1"
    if command -v python3 >/dev/null 2>&1 && python3 -c 'import yaml' 2>/dev/null; then
        python3 -c "
import yaml, sys
with open('$f') as fh:
    d = yaml.safe_load(fh)
print(len(d.get('cases') or []))
" 2>/dev/null
    else
        grep -cE '^[[:space:]]+-[[:space:]]+id:[[:space:]]+' "$f"
    fi
}

cn=$(count_cases "$CHAINS_EVAL")
if (( cn >= 20 )); then
    ok "chains-eval: $cn cases"
else
    fail "chains-eval: $cn cases (need >=20)"
fi

dn=$(count_cases "$DEPLOY_EVAL")
if (( dn >= 30 )); then
    ok "deploy-eval: $dn cases"
else
    fail "deploy-eval: $dn cases (need >=30)"
fi

# ── FR-18: SHA-pin scan across all four touched files ─────────────────
SHA_RE='(commit[[:space:]]+[a-f0-9]{7,40}|as of [a-f0-9]{7,40}|fixed in [a-f0-9]{7,40})'
for f in "$DEPLOY_RB" "$RUNBOOK" "$CHAINS_EVAL" "$DEPLOY_EVAL"; do
    c=$(grep -cE "$SHA_RE" "$f" || true)
    if (( c == 0 )); then
        ok "no SHA pin in $(basename "$f")"
    else
        fail "SHA pin in $(basename "$f"): $c match(es)"
    fi
done

# ── FR-19: markdown-link-check (cred-proxy / firewall XFAIL) ──────────
# XFAIL: TDD-025 ships these runbooks; remove this whitelist when those runbooks land
if command -v markdown-link-check >/dev/null 2>&1; then
    out=$(markdown-link-check --quiet "$RUNBOOK" 2>&1 || true)
    filtered=$(echo "$out" | grep -E '^\s*\[✖\]' | grep -vE 'cred-proxy-runbook\.md|firewall-runbook\.md' || true)
    if [[ -z "$filtered" ]]; then
        ok "link-check runbook.md (cred-proxy/firewall XFAIL whitelisted)"
    else
        fail "link-check runbook.md: unexpected dead links: $filtered"
    fi

    if markdown-link-check --quiet "$DEPLOY_RB" >/dev/null 2>&1; then
        ok "link-check deploy-runbook.md"
    else
        fail "link-check deploy-runbook.md"
    fi
else
    skip "markdown-link-check not installed; install via 'npm i -g markdown-link-check'"
fi

# ── FR-20: yamllint on the two eval YAMLs ──────────────────────────────
if command -v yamllint >/dev/null 2>&1; then
    if yamllint "$CHAINS_EVAL" >/dev/null 2>&1; then
        ok "yamllint chains-eval.yaml"
    else
        fail "yamllint chains-eval.yaml"
    fi
    if yamllint "$DEPLOY_EVAL" >/dev/null 2>&1; then
        ok "yamllint deploy-eval.yaml"
    else
        fail "yamllint deploy-eval.yaml"
    fi
else
    skip "yamllint not installed; install via 'pip install yamllint'"
fi

# ── FR-29: markdownlint on the two runbook files ──────────────────────
if command -v markdownlint >/dev/null 2>&1; then
    if markdownlint "$DEPLOY_RB" >/dev/null 2>&1; then
        ok "markdownlint deploy-runbook.md"
    else
        fail "markdownlint deploy-runbook.md"
    fi
    if markdownlint "$RUNBOOK" >/dev/null 2>&1; then
        ok "markdownlint runbook.md"
    else
        fail "markdownlint runbook.md"
    fi
else
    skip "markdownlint not installed; install via 'npm i -g markdownlint-cli'"
fi

if (( FAIL > 0 )); then
    echo ""
    echo "FAILED: $FAIL subtest(s)"
    exit 1
fi
echo ""
echo "PASSED: PLAN-026-3 invariants hold"
exit 0

#!/usr/bin/env bash
# test-classifier-and-chains-runbook-026-2.test.sh
#
# SPEC-026-2-04 doc-smoke: gate the structural and safety-string invariants
# delivered by SPEC-026-2-01 / -02 / -03. Asserts:
#   - commands/assist.md lists exactly six classifier categories
#   - the nine new Glob: patterns from SPEC-026-2-01 are present
#   - commands/quickstart.md documents --with-cloud + the bridge line
#   - instructions/chains-runbook.md has all eight ## H2 sections
#   - safety strings present (do NOT delete the audit log >=2,
#     do NOT rotate the HMAC key >=1)
#   - SHA pinning absent across the three files
#   - chains negative bag absent in the runbook
#   - manifest-v1 only inside "do NOT" context in the runbook
#   - markdown-link-check passes (best-effort; XFAIL whitelist for
#     the deploy-runbook §8 cross-link until PLAN-026-3 lands the target)

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
ASSIST_MD="${REPO_ROOT}/plugins/autonomous-dev-assist/commands/assist.md"
QUICKSTART_MD="${REPO_ROOT}/plugins/autonomous-dev-assist/commands/quickstart.md"
RUNBOOK_MD="${REPO_ROOT}/plugins/autonomous-dev-assist/instructions/chains-runbook.md"

FAIL=0
ok()   { echo "[OK]   $*"; }
fail() { echo "[FAIL] $*"; FAIL=$((FAIL+1)); }
skip() { echo "[SKIP] $*"; }

# FR-17: six classifier categories within Step 1
classifier=$(awk '/^## Step 1/,/^## Step 2/' "$ASSIST_MD" | grep -cE '^- \*\*[a-z]+\*\* --' || true)
if [[ "$classifier" -eq 6 ]]; then
    ok "assist: 6 classifier categories"
else
    fail "assist: classifier count = $classifier (expected 6)"
fi

# FR-18: nine new globs
GLOBS=(
    "plugins/autonomous-dev/intake/chains/*"
    "plugins/autonomous-dev/intake/deploy/*"
    "plugins/autonomous-dev/intake/cred-proxy/*"
    "plugins/autonomous-dev/intake/firewall/*"
    "plugins/autonomous-dev-deploy-gcp/**"
    "plugins/autonomous-dev-deploy-aws/**"
    "plugins/autonomous-dev-deploy-azure/**"
    "plugins/autonomous-dev-deploy-k8s/**"
    "plugins/autonomous-dev-assist/instructions/*-runbook.md"
)
for g in "${GLOBS[@]}"; do
    if grep -qF "Glob: ${g}" "$ASSIST_MD"; then
        ok "assist: glob present: ${g}"
    else
        fail "assist: glob missing: ${g}"
    fi
done

# FR-19: quickstart --with-cloud + bridge line
if grep -q -- '--with-cloud' "$QUICKSTART_MD"; then
    ok "quickstart: --with-cloud documented"
else
    fail "quickstart: --with-cloud not documented"
fi

if grep -qF "For cloud deploy onboarding, run /autonomous-dev-assist:setup-wizard --with-cloud" "$QUICKSTART_MD"; then
    ok "quickstart: bridge line present"
else
    fail "quickstart: bridge line missing"
fi

# FR-20: chains-runbook structure + safety strings
if [[ -f "$RUNBOOK_MD" ]]; then
    ok "chains-runbook.md exists"
else
    fail "chains-runbook.md missing"
fi

HEADERS=(
    '^## 1\. Bootstrap$'
    '^## 2\. Dependency-graph troubleshooting$'
    '^## 3\. Audit verification$'
    '^## 4\. Manifest-v2 migration$'
    '^## 5\. Approval flow$'
    '^## 6\. Common errors$'
    '^## 7\. Escalation$'
    '^## 8\. See also$'
)
for hdr in "${HEADERS[@]}"; do
    if grep -qE "$hdr" "$RUNBOOK_MD"; then
        ok "runbook: $hdr"
    else
        fail "runbook: missing $hdr"
    fi
done

dnd=$(grep -c 'do NOT delete the audit log' "$RUNBOOK_MD" || true)
if (( dnd >= 2 )); then
    ok "runbook: 'do NOT delete the audit log' x$dnd"
else
    fail "runbook: 'do NOT delete the audit log' = $dnd (need >=2)"
fi

dnr=$(grep -c 'do NOT rotate the HMAC key' "$RUNBOOK_MD" || true)
if (( dnr >= 1 )); then
    ok "runbook: 'do NOT rotate the HMAC key' x$dnr"
else
    fail "runbook: 'do NOT rotate the HMAC key' = $dnr (need >=1)"
fi

# SHA pinning absent
SHA_RE='(commit[[:space:]]+[a-f0-9]{7,40}|as of [a-f0-9]{7,40}|fixed in [a-f0-9]{7,40})'
for f in "$ASSIST_MD" "$QUICKSTART_MD" "$RUNBOOK_MD"; do
    c=$(grep -cE "$SHA_RE" "$f" || true)
    if (( c == 0 )); then
        ok "no SHA pin in $(basename "$f")"
    else
        fail "SHA pin in $(basename "$f"): $c match(es)"
    fi
done

# negative chains bag in the runbook
for neg in 'chains rotate-key' 'audit\.json'; do
    c=$(grep -cE "$neg" "$RUNBOOK_MD" || true)
    if (( c == 0 )); then
        ok "runbook: no '$neg'"
    else
        fail "runbook: '$neg' appears $c time(s)"
    fi
done

# manifest-v1 only in 'do NOT' context
bad=$(grep -n 'manifest-v1' "$RUNBOOK_MD" | grep -vc 'do NOT' || true)
if (( bad == 0 )); then
    ok "runbook: manifest-v1 only in do-NOT context"
else
    fail "runbook: $bad 'manifest-v1' line(s) outside do-NOT context"
fi

# FR-21: markdown-link-check with deploy-runbook XFAIL
# XFAIL: PLAN-026-3 lands the deploy-runbook target; remove this whitelist in SPEC-026-3-04
if command -v markdown-link-check >/dev/null 2>&1; then
    out=$(markdown-link-check --quiet "$RUNBOOK_MD" 2>&1 || true)
    filtered=$(echo "$out" | grep -E '^\s*\[✖\]' | grep -v 'deploy-runbook\.md' || true)
    if [[ -z "$filtered" ]]; then
        ok "link-check chains-runbook.md (deploy-runbook XFAIL whitelisted)"
    else
        fail "link-check chains-runbook.md: unexpected dead links: $filtered"
    fi
    for f in "$ASSIST_MD" "$QUICKSTART_MD"; do
        if markdown-link-check --quiet "$f" >/dev/null 2>&1; then
            ok "link-check $(basename "$f")"
        else
            fail "link-check $(basename "$f")"
        fi
    done
else
    skip "markdown-link-check not installed; install via 'npm i -g markdown-link-check'"
fi

if (( FAIL > 0 )); then
    echo ""
    echo "FAILED: $FAIL subtest(s)"
    exit 1
fi
echo ""
echo "PASSED: PLAN-026-2 invariants hold"
exit 0

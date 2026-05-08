#!/usr/bin/env bash
# test-skill-sections-026-1.test.sh
#
# SPEC-026-1-04 doc-smoke: gate the structural and safety-string invariants
# delivered by SPEC-026-1-01 / -02 / -03. Asserts:
#   - help/SKILL.md has ## Plugin Chains and ## Deploy Framework H2s
#   - config-guide/SKILL.md has ## Section 19: chains and ## Section 20: deploy
#   - *Topic:* markers exist for chains and deploy in both files
#   - safety strings present (do NOT delete, do NOT edit by hand, regardless of trust level)
#   - SHA pinning absent in both files
#   - chains and deploy negative bags absent
#   - manifest-v1 only inside "do NOT" context
#   - config-guide section numbering contiguous from 1..N (N >= 22)
#   - markdown-link-check passes (best-effort; SKIP if not installed)

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HELP="${REPO_ROOT}/plugins/autonomous-dev-assist/skills/help/SKILL.md"
CFG="${REPO_ROOT}/plugins/autonomous-dev-assist/skills/config-guide/SKILL.md"

FAIL_COUNT=0

ok()    { echo "[OK]   $*"; }
fail()  { echo "[FAIL] $*"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
skip()  { echo "[SKIP] $*"; }

assert_count_eq() {
    local label="$1" expected="$2" actual="$3"
    if [[ "$actual" == "$expected" ]]; then
        ok "$label"
    else
        fail "$label: expected $expected got $actual"
    fi
}

assert_count_ge() {
    local label="$1" min="$2" actual="$3"
    if (( actual >= min )); then
        ok "$label"
    else
        fail "$label: expected >=$min got $actual"
    fi
}

# FR-4 / FR-5
assert_count_eq "help: exactly one '## Plugin Chains'"    1 "$(grep -c '^## Plugin Chains$'    "$HELP" || true)"
assert_count_eq "help: exactly one '## Deploy Framework'" 1 "$(grep -c '^## Deploy Framework$' "$HELP" || true)"

# FR-6 / FR-7
assert_count_eq "config: exactly one '## Section 19: chains'" 1 "$(grep -c '^## Section 19: chains$' "$CFG" || true)"
assert_count_eq "config: exactly one '## Section 20: deploy'" 1 "$(grep -c '^## Section 20: deploy$' "$CFG" || true)"

# FR-8 / FR-9 *Topic:* markers
assert_count_ge "help: *Topic:* chains present"   1 "$(grep -c '^\*Topic:\* chains$'  "$HELP" || true)"
assert_count_ge "help: *Topic:* deploy present"   1 "$(grep -c '^\*Topic:\* deploy$'  "$HELP" || true)"
assert_count_ge "config: *Topic:* chains present" 1 "$(grep -c '^\*Topic:\* chains$'  "$CFG"  || true)"
assert_count_ge "config: *Topic:* deploy present" 1 "$(grep -c '^\*Topic:\* deploy$'  "$CFG"  || true)"

# FR-10 .. FR-12 safety strings
assert_count_ge "help: 'do NOT delete the audit log'" 1 "$(grep -c 'do NOT delete the audit log' "$HELP" || true)"
assert_count_ge "help: 'do NOT edit by hand'"          1 "$(grep -c 'do NOT edit by hand'        "$HELP" || true)"
assert_count_ge "help: 'regardless of trust level'"    1 "$(grep -c 'regardless of trust level'  "$HELP" || true)"

# FR-13 SHA-pin regex (POSIX [[:space:]]+ for portable BSD/GNU grep)
SHA_RE='(commit[[:space:]]+[a-f0-9]{7,40}|as of [a-f0-9]{7,40}|fixed in [a-f0-9]{7,40})'
for f in "$HELP" "$CFG"; do
    c=$(grep -cE "$SHA_RE" "$f" || true)
    assert_count_eq "no SHA pinning in $(basename "$(dirname "$f")")/SKILL.md" 0 "$c"
done

# FR-14 / FR-15 negative bags
NEG_CHAINS='(chains rotate-key|rm[^[:space:]]*audit\.log|chains delete|audit\.json)'
NEG_DEPLOY='(deploy force-approve|deploy auto-prod|cost cap[^[:space:]]*ignore|deploy[^[:space:]]*--no-approval)'
for f in "$HELP" "$CFG"; do
    cc=$(grep -cE "$NEG_CHAINS" "$f" || true)
    cd=$(grep -cE "$NEG_DEPLOY" "$f" || true)
    assert_count_eq "no chains negatives in $(basename "$(dirname "$f")")"  0 "$cc"
    assert_count_eq "no deploy negatives in $(basename "$(dirname "$f")")"  0 "$cd"
done

# FR-16 manifest-v1 only inside "do NOT" context
for f in "$HELP" "$CFG"; do
    bad=$(grep -n 'manifest-v1' "$f" | grep -v 'do NOT' | wc -l | tr -d ' ' || true)
    assert_count_eq "manifest-v1 only in do-NOT context ($(basename "$(dirname "$f")"))" 0 "$bad"
done

# FR-17 contiguous section numbering 1..N (N >= 22) in config-guide
nums=$(grep -oE '^## Section [0-9]+' "$CFG" | grep -oE '[0-9]+' | sort -n | uniq)
expected_max=$(echo "$nums" | tail -1)
expected_seq=$(seq 1 "$expected_max")
if [[ "$nums" == "$expected_seq" ]] && (( expected_max >= 22 )); then
    ok "config: contiguous Section numbering 1..$expected_max"
else
    fail "config: section numbering not contiguous or N<22 (got: $(echo "$nums" | paste -sd, -))"
fi

# FR-18 / FR-19 markdown-link-check
if command -v markdown-link-check >/dev/null 2>&1; then
    for f in "$HELP" "$CFG"; do
        if markdown-link-check --quiet "$f" >/dev/null 2>&1; then
            ok "markdown-link-check $(basename "$(dirname "$f")")/SKILL.md"
        else
            fail "markdown-link-check $(basename "$(dirname "$f")")/SKILL.md returned non-zero"
        fi
    done
else
    skip "markdown-link-check not installed; install via 'npm i -g markdown-link-check'"
fi

if (( FAIL_COUNT > 0 )); then
    echo ""
    echo "FAILED: $FAIL_COUNT subtest(s)"
    exit 1
fi
echo ""
echo "PASSED: all SKILL-content invariants hold"
exit 0

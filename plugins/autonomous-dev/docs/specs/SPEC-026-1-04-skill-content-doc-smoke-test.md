# SPEC-026-1-04: SKILL Content Doc-Smoke Test

## Metadata
- **Parent Plan**: PLAN-026-1
- **Parent TDD**: TDD-026
- **Tasks Covered**: PLAN-026-1 Task 7 (doc-only smoke + anchor-convention scan)
- **Estimated effort**: 2 hours
- **Status**: Draft
- **Author**: Specification Author (TDD-026 cascade)
- **Date**: 2026-05-02
- **Depends on**: SPEC-026-1-01, SPEC-026-1-02, SPEC-026-1-03

## Summary
Author a bash test script `tests/docs/test-skill-sections-026-1.test.sh` that asserts the structural and safety-string invariants delivered by SPEC-026-1-01 through SPEC-026-1-03. The script gates merge of any future change that would silently strip the verbatim safety strings, drop the `*Topic:*` markers, regress the section ordering, or introduce SHA-pinned cross-references in the assist plugin's two SKILL files. It also runs `markdown-link-check` over both files.

## Functional Requirements

| ID    | Requirement                                                                                                                                                                                                                              |
|-------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1  | A new bash script MUST be created at `plugins/autonomous-dev-assist/tests/docs/test-skill-sections-026-1.test.sh` and made executable (`chmod +x`).                                                                                       |
| FR-2  | The script MUST start with `#!/usr/bin/env bash` and `set -euo pipefail`.                                                                                                                                                                |
| FR-3  | The script MUST resolve the repo root via `git rev-parse --show-toplevel` and use absolute paths to both SKILL files.                                                                                                                    |
| FR-4  | The script MUST assert: `help/SKILL.md` contains exactly one `^## Plugin Chains$` heading.                                                                                                                                                |
| FR-5  | The script MUST assert: `help/SKILL.md` contains exactly one `^## Deploy Framework$` heading.                                                                                                                                              |
| FR-6  | The script MUST assert: `config-guide/SKILL.md` contains exactly one `^## Section 19: chains$` heading.                                                                                                                                   |
| FR-7  | The script MUST assert: `config-guide/SKILL.md` contains exactly one `^## Section 20: deploy$` heading.                                                                                                                                   |
| FR-8  | The script MUST assert: `*Topic:* chains` appears at least once in EACH of the two SKILL files.                                                                                                                                            |
| FR-9  | The script MUST assert: `*Topic:* deploy` appears at least once in EACH of the two SKILL files.                                                                                                                                            |
| FR-10 | The script MUST assert: the literal string `do NOT delete the audit log` appears at least once in `help/SKILL.md`.                                                                                                                         |
| FR-11 | The script MUST assert: the literal string `do NOT edit by hand` appears at least once in `help/SKILL.md`.                                                                                                                                 |
| FR-12 | The script MUST assert: the literal string `regardless of trust level` appears at least once in `help/SKILL.md`.                                                                                                                            |
| FR-13 | The script MUST assert: the SHA-pin regex `(commit\s+[a-f0-9]{7,40}\|as of [a-f0-9]{7,40}\|fixed in [a-f0-9]{7,40})` returns ZERO matches in BOTH SKILL files.                                                                              |
| FR-14 | The script MUST assert: the negative chains strings `chains rotate-key`, `rm.*audit\.log`, `chains delete`, `audit\.json` return ZERO matches in BOTH SKILL files.                                                                          |
| FR-15 | The script MUST assert: the negative deploy strings `deploy force-approve`, `deploy auto-prod`, `cost cap.*ignore`, `deploy.*--no-approval` return ZERO matches in BOTH SKILL files.                                                        |
| FR-16 | The script MUST assert: any line in either SKILL file containing `manifest-v1` ALSO contains `do NOT` (i.e., manifest-v1 only appears inside negative-guidance sentences).                                                                  |
| FR-17 | The script MUST assert: in `config-guide/SKILL.md` the H2 numbering sequence (extracted via `grep -oE "^## Section [0-9]+:"` then numeric-sorted unique) forms a contiguous run from 1 to N (no gaps, no duplicates) with N ≥ 22.            |
| FR-18 | The script MUST run `markdown-link-check --quiet` against each SKILL file and require exit 0.                                                                                                                                              |
| FR-19 | If `markdown-link-check` is not on `$PATH`, the script MUST emit a clear `[SKIP] markdown-link-check not installed` warning and continue (return success on that subtest only).                                                              |
| FR-20 | The script MUST emit `[OK] <check name>` on success and `[FAIL] <check name>: <details>` on failure for each subtest, accumulate failures, and `exit 1` if any subtest failed (exit 0 otherwise).                                            |
| FR-21 | The script MUST be wired into the existing assist test runner: add an entry under `plugins/autonomous-dev-assist/tests/run-all-tests.sh` (or the equivalent existing dispatcher; locate via `find plugins/autonomous-dev-assist -name "run*tests*" -type f`). |

## Non-Functional Requirements

| Requirement                  | Target            | Measurement                                                          |
|------------------------------|--------------------|----------------------------------------------------------------------|
| Script runtime               | < 5 seconds       | `time bash tests/docs/test-skill-sections-026-1.test.sh`             |
| Zero false positives         | 0 over 5 runs     | Run 5x against the post-spec tree; all 5 exit 0                      |
| shellcheck pass              | 0 errors          | `shellcheck tests/docs/test-skill-sections-026-1.test.sh`            |
| Idempotent                   | identical output  | Two consecutive runs produce identical stdout                        |

## Technical Approach

### File created
- `plugins/autonomous-dev-assist/tests/docs/test-skill-sections-026-1.test.sh`

### File modified (wiring)
- `plugins/autonomous-dev-assist/tests/run-all-tests.sh` (or equivalent — see FR-21)

### Script structure (illustrative)

```bash
#!/usr/bin/env bash
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
  if [[ "$actual" == "$expected" ]]; then ok "$label"; else fail "$label: expected $expected got $actual"; fi
}

assert_count_ge() {
  local label="$1" min="$2" actual="$3"
  if (( actual >= min )); then ok "$label"; else fail "$label: expected ≥$min got $actual"; fi
}

# FR-4 FR-5
assert_count_eq "help: exactly one '## Plugin Chains'"   1 "$(grep -c '^## Plugin Chains$' "$HELP")"
assert_count_eq "help: exactly one '## Deploy Framework'" 1 "$(grep -c '^## Deploy Framework$' "$HELP")"

# FR-6 FR-7
assert_count_eq "config: exactly one '## Section 19: chains'" 1 "$(grep -c '^## Section 19: chains$' "$CFG")"
assert_count_eq "config: exactly one '## Section 20: deploy'" 1 "$(grep -c '^## Section 20: deploy$' "$CFG")"

# FR-8 FR-9
assert_count_ge "help: *Topic:* chains present"   1 "$(grep -c '^\*Topic:\* chains$'  "$HELP" || true)"
assert_count_ge "help: *Topic:* deploy present"   1 "$(grep -c '^\*Topic:\* deploy$'  "$HELP" || true)"
assert_count_ge "config: *Topic:* chains present" 1 "$(grep -c '^\*Topic:\* chains$'  "$CFG"  || true)"
assert_count_ge "config: *Topic:* deploy present" 1 "$(grep -c '^\*Topic:\* deploy$'  "$CFG"  || true)"

# FR-10..12
assert_count_ge "help: 'do NOT delete the audit log'" 1 "$(grep -c 'do NOT delete the audit log' "$HELP" || true)"
assert_count_ge "help: 'do NOT edit by hand'"          1 "$(grep -c 'do NOT edit by hand'        "$HELP" || true)"
assert_count_ge "help: 'regardless of trust level'"    1 "$(grep -c 'regardless of trust level'  "$HELP" || true)"

# FR-13 SHA-pin regex
SHA_RE='(commit[[:space:]]+[a-f0-9]{7,40}|as of [a-f0-9]{7,40}|fixed in [a-f0-9]{7,40})'
for f in "$HELP" "$CFG"; do
  c=$(grep -cE "$SHA_RE" "$f" || true)
  assert_count_eq "no SHA pinning in $(basename "$(dirname "$f")")/SKILL.md" 0 "$c"
done

# FR-14 FR-15 negative bags
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
  bad=$(grep -n 'manifest-v1' "$f" | grep -v 'do NOT' | wc -l | tr -d ' ')
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

# FR-18 FR-19 markdown-link-check
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
```

### Wiring into the runner
Locate the existing test dispatcher (likely `plugins/autonomous-dev-assist/tests/run-all-tests.sh` or a top-level Makefile target). Add a single source-or-invoke line that runs the new script and propagates the exit code:

```bash
bash "${REPO_ROOT}/plugins/autonomous-dev-assist/tests/docs/test-skill-sections-026-1.test.sh"
```

If no dispatcher exists, document the manual invocation in `plugins/autonomous-dev-assist/tests/README.md` (or create one) — but PREFER wiring into an existing dispatcher.

## Interfaces and Dependencies
- **Consumes**: SPEC-026-1-01 / -02 / -03 outputs (the SKILL file content). Tests assert their structural invariants.
- **Tools**: `bash`, `grep`, `awk`, `git`, optional `markdown-link-check`.
- **No external service dependencies.**

## Acceptance Criteria

### Script existence and executability
```
Given the repo
When the file plugins/autonomous-dev-assist/tests/docs/test-skill-sections-026-1.test.sh is checked
Then it exists
And it is executable (mode includes x bit for owner)
And it begins with "#!/usr/bin/env bash"
And it includes "set -euo pipefail"
```

### Pass on the post-spec tree
```
Given SPEC-026-1-01, -02, -03 have all merged
When the new script is invoked
Then exit code is 0
And stdout contains "PASSED: all SKILL-content invariants hold"
```

### Detects missing Plugin Chains H2
```
Given the SKILL.md content with "## Plugin Chains" temporarily removed (test fixture or git stash)
When the script is invoked
Then exit code is 1
And stdout contains "[FAIL] help: exactly one '## Plugin Chains'"
```

### Detects missing safety string
```
Given help/SKILL.md with "do NOT delete the audit log" replaced by "delete the audit log"
When the script is invoked
Then exit code is 1
And stdout contains "[FAIL] help: 'do NOT delete the audit log'"
```

### Detects SHA pinning
```
Given help/SKILL.md with the line "as of c1884eb the audit log..." inserted
When the script is invoked
Then exit code is 1
And stdout contains a [FAIL] line referencing "no SHA pinning"
```

### Detects renumbering gap
```
Given config-guide/SKILL.md with "## Section 19: chains" renamed to "## Section 23: chains"
When the script is invoked
Then exit code is 1
And stdout contains "[FAIL] config: section numbering not contiguous"
```

### Detects negative-bag string
```
Given help/SKILL.md with "Try chains rotate-key to fix" inserted
When the script is invoked
Then exit code is 1
And stdout contains "[FAIL]" referencing chains negatives
```

### Wiring
```
Given the existing test dispatcher (run-all-tests.sh or equivalent)
When it is invoked
Then it transitively invokes test-skill-sections-026-1.test.sh
And on dispatcher failure the SKILL-content failure surfaces in stdout
```

### shellcheck clean
```
Given the new script
When shellcheck is run with default settings
Then exit code is 0
```

### Runtime budget
```
Given the new script
When invoked 5 consecutive times
Then every run exits 0 in < 5 seconds
And stdout is byte-identical between runs (idempotent)
```

## Test Requirements
- **Self-test**: Run the script against the post-spec tree → exit 0.
- **Mutation tests**: For each FAIL acceptance criterion above, temporarily mutate the source file, run the script, confirm exit 1 with the expected `[FAIL]` line, then revert. Document this in the PR description as the "negative-mutation matrix".
- **shellcheck**: Run it during implementation; resolve all errors and warnings (use `# shellcheck disable=...` only with justification).

## Implementation Notes
- Use `|| true` around `grep -c` calls inside `assert_count_eq` so a zero-count match (`grep` exits 1 on no match) does not trip `set -e`.
- The SHA-pin regex must use `[[:space:]]+` (POSIX) instead of `\s+` for portable BRE/ERE in `grep -E` on macOS BSD grep.
- Locate the existing dispatcher by `find plugins/autonomous-dev-assist/tests -maxdepth 2 -name "run*"` first; do not create a new one if one exists.
- The mutation tests are author-time validation, NOT part of the committed script. Document the matrix in the PR body.

## Rollout Considerations
- Pure test code; no runtime impact.
- Rollback: revert the test file. The SKILL content remains valid.
- CI integration: existing CI that runs `run-all-tests.sh` will pick this up automatically once wired (FR-21).

## Effort Estimate
- Script authoring: 1 hour
- Wiring + shellcheck cleanup: 0.5 hours
- Mutation matrix validation: 0.5 hours
- **Total: 2 hours**

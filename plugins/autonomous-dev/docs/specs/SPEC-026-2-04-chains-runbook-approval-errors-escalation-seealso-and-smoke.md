# SPEC-026-2-04: chains-runbook §5–§8 + Doc-Smoke Test

## Metadata
- **Parent Plan**: PLAN-026-2
- **Parent TDD**: TDD-026
- **Tasks Covered**: PLAN-026-2 Task 8 (§5 Approval flow, §6 Common errors, §7 Escalation, §8 See also), Task 9 (doc-smoke + anchor scan)
- **Estimated effort**: 6 hours
- **Status**: Draft
- **Author**: Specification Author (TDD-026 cascade)
- **Date**: 2026-05-02
- **Depends on**: SPEC-026-2-01 (classifier/Glob/quickstart), SPEC-026-2-02 (--with-cloud), SPEC-026-2-03 (chains-runbook §1–§4)

## Summary
Append the remaining four sections of `instructions/chains-runbook.md`: §5 Approval flow (~30 lines), §6 Common errors with six error-message-to-action mappings (~40 lines), §7 Escalation (~20 lines), §8 See also (~10 lines). Authoring §8 introduces a cross-link to `deploy-runbook.md` (does not exist until PLAN-026-3). This spec also creates the bash smoke script `tests/docs/test-classifier-and-chains-runbook-026-2.test.sh` that gates merge of all PLAN-026-2 outputs (classifier extension, Glob expansion, quickstart flag, chains-runbook structure) and includes an XFAIL whitelist for the deploy-runbook cross-link until PLAN-026-3 removes it.

## Functional Requirements

### §5 Approval flow (~30 lines)

| ID   | Requirement                                                                                                                                                                                                                  |
|------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1 | An H2 `## 5. Approval flow` MUST be appended to `chains-runbook.md` immediately after §4 Manifest-v2 migration (which was authored by SPEC-026-2-03).                                                                         |
| FR-2 | §5 MUST document `chains approve REQ-NNNNNN` and `chains reject REQ-NNNNNN`, including the REQ-NNNNNN format and what causes the gate (the `chains.approval.required_for_prod_egress: true` config plus an egress hit on a prod host). |
| FR-3 | §5 MUST cite TDD-022 (the section that documents the approval state machine) using section-anchor form.                                                                                                                       |
| FR-4 | §5 line count MUST be between 25 and 40.                                                                                                                                                                                      |

### §6 Common errors (~40 lines, exactly 6 mappings)

| ID    | Requirement                                                                                                                                                                                                                   |
|-------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-5  | An H2 `## 6. Common errors` MUST be appended after §5.                                                                                                                                                                          |
| FR-6  | §6 MUST contain EXACTLY SIX error-message-to-action mappings (a Markdown table with 6 data rows OR 6 H3-or-bullet items). The HMAC mappings already in §3 are NOT counted here — these are the OTHER six.                       |
| FR-7  | The six mappings MUST cover (in any order): (a) cycle detected, (b) manifest-v2 schema error, (c) missing produces declaration, (d) missing consumes declaration, (e) approval-gate timeout, (f) unknown plugin in `chains list`. |
| FR-8  | Each mapping MUST contain: an exact error string (matchable with `Grep`), a one-line description of cause, and the recovery procedure or next step.                                                                              |
| FR-9  | §6 line count MUST be between 35 and 55.                                                                                                                                                                                       |

### §7 Escalation (~20 lines)

| ID    | Requirement                                                                                                                                                                                                                  |
|-------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-10 | An H2 `## 7. Escalation` MUST be appended after §6.                                                                                                                                                                            |
| FR-11 | §7 MUST distinguish: (a) when to file a TDD-022 issue (HMAC bug, schema bug, executor bug — bugs in shipped behavior), (b) when to recover locally (missing declaration, cycle, approval timeout — operator-fixable conditions). |
| FR-12 | §7 line count MUST be between 15 and 30.                                                                                                                                                                                       |

### §8 See also (~10 lines)

| ID    | Requirement                                                                                                                                                                                          |
|-------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-13 | An H2 `## 8. See also` MUST be appended after §7.                                                                                                                                                    |
| FR-14 | §8 MUST contain at least four Markdown links: (a) `../instructions/deploy-runbook.md` (DEAD until PLAN-026-3 lands — see XFAIL below), (b) `TDD-022 §5`, (c) `TDD-022 §13`, (d) `../skills/help/SKILL.md#plugin-chains`. |
| FR-15 | The §8 deploy-runbook link MUST be flagged in the smoke test (FR-21) as XFAIL with a code comment referencing PLAN-026-3.                                                                            |

### Doc-smoke test (Task 9)

| ID    | Requirement                                                                                                                                                                                                                                                |
|-------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-16 | A new bash script MUST be created at `plugins/autonomous-dev-assist/tests/docs/test-classifier-and-chains-runbook-026-2.test.sh`, executable, `set -euo pipefail`.                                                                                          |
| FR-17 | The script MUST assert: `commands/assist.md` lists exactly six classifier categories (count of `^- \*\*[a-z]+\*\* --` within Step-1).                                                                                                                       |
| FR-18 | The script MUST assert: the nine new `Glob:` patterns from SPEC-026-2-01 are present in `commands/assist.md`.                                                                                                                                              |
| FR-19 | The script MUST assert: `commands/quickstart.md` documents `--with-cloud` AND contains the literal "For cloud deploy onboarding, run /autonomous-dev-assist:setup-wizard --with-cloud".                                                                    |
| FR-20 | The script MUST assert: `instructions/chains-runbook.md` exists with all eight `## ` H2 sections at expected line counts; safety strings "do NOT delete the audit log" (≥2) and "do NOT rotate the HMAC key" (≥1) appear; SHA-pin regex finds zero hits; negative chains strings (`chains rotate-key`, `audit\.json`) appear zero times; the literal `manifest-v1` appears only in lines that ALSO contain `do NOT`. |
| FR-21 | The script MUST run `markdown-link-check` on each modified file and treat the deploy-runbook §8 link as XFAIL: if `markdown-link-check` reports the deploy-runbook.md link as dead BUT no other links are dead, the test PASSES; the XFAIL block MUST contain a comment `# XFAIL: PLAN-026-3 lands the deploy-runbook target; remove this whitelist in SPEC-026-3-04`. |
| FR-22 | If `markdown-link-check` is unavailable, the script SKIPS that subtest with a clear `[SKIP]` message and continues.                                                                                                                                        |
| FR-23 | The script MUST emit `[OK]` / `[FAIL]` / `[SKIP]` lines per subtest and exit 1 if any subtest failed.                                                                                                                                                       |
| FR-24 | The script MUST be wired into the existing assist test dispatcher (same dispatcher targeted by SPEC-026-1-04).                                                                                                                                              |

## Non-Functional Requirements

| Requirement                          | Target                | Measurement                                                                |
|--------------------------------------|------------------------|----------------------------------------------------------------------------|
| §5–§8 combined line count            | 80–135                | `awk '/^## 5\./, EOF' chains-runbook.md \| wc -l`                          |
| Total chains-runbook.md size         | 280–360 lines         | `wc -l`                                                                    |
| Smoke script runtime                 | < 8 seconds          | `time bash test-classifier-and-chains-runbook-026-2.test.sh`               |
| shellcheck pass on smoke script      | 0 errors              | `shellcheck ...026-2.test.sh`                                              |
| markdownlint pass on runbook        | 0 errors              | `markdownlint instructions/chains-runbook.md`                              |
| Idempotency                          | Identical 5x output   | 5 consecutive runs produce same stdout                                     |

## Technical Approach

### Files modified
- `plugins/autonomous-dev-assist/instructions/chains-runbook.md` (append §5–§8)

### Files created
- `plugins/autonomous-dev-assist/tests/docs/test-classifier-and-chains-runbook-026-2.test.sh`

### Procedure
1. **Read** the chains-runbook.md baseline (after SPEC-026-2-03 has merged). Confirm §1–§4 exist and the placeholder TOC entries for §5–§8 are present.
2. **Append** §5 → §8 sequentially using `Edit` calls. Use the closing line of the previous section + a unique anchor for each `old_string`.
3. **Update TOC** (if it has placeholder lines) to point to actual anchor IDs.
4. **Author** the smoke test script.
5. **Wire** the script into the existing test dispatcher.
6. **Run** the smoke test; iterate until all subtests pass.

### §6 Common-errors template (illustrative — exactly 6 mappings)

```markdown
## 6. Common errors

The HMAC-mismatch and audit-key errors are covered in §3. The remaining six
common errors:

| Error                                          | Cause                                                       | Action                                                                                                            |
|------------------------------------------------|-------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------|
| `cycle detected: A -> B -> A`                  | Two plugins consume each other's outputs                    | Run `chains graph`; remove or split the offending plugin pair                                                      |
| `manifest schema error: missing 'produces'`    | A plugin upgraded without declaring produces                | Edit the plugin's `.claude-plugin/plugin.json`; see §4                                                             |
| `manifest schema error: missing 'consumes'`    | A plugin upgraded without declaring consumes                | Edit the plugin's `.claude-plugin/plugin.json`; see §4                                                             |
| `manifest schema error: invalid version`       | A plugin still on manifest v1                               | Migrate the plugin to manifest-v2; see §4 (do NOT regress to v1 — the executor rejects v1)                        |
| `approval-gate timeout: REQ-NNNNNN`            | Pending approval expired before operator acted              | Re-trigger the request; ensure on-call coverage; the audit log shows the timeout entry                            |
| `unknown plugin in chains list`                | A registered plugin's manifest is missing or unreadable      | Re-install the plugin; check filesystem perms on `.claude-plugin/plugin.json`                                     |
```

### §7 Escalation template

```markdown
## 7. Escalation

**File a TDD-022 issue** when the failure is in shipped behavior:
- HMAC-verification false positive (the log was not tampered)
- Manifest schema validator rejects a valid v2 manifest
- The chain executor enters an inconsistent state (e.g., a plugin reports as
  both running and completed)

**Recover locally** without filing an issue when the failure is operator-fixable:
- Missing `produces` or `consumes` declaration: edit the manifest (§4)
- Cycle detected: remove or split a plugin
- Approval-gate timeout: re-trigger the request
```

### §8 See-also template

```markdown
## 8. See also

- [deploy-runbook.md](./deploy-runbook.md) — the parallel deploy framework runbook (PLAN-026-3 ships this file)
- [TDD-022 §5 Plugin Manifest Extensions](../../autonomous-dev/docs/tdd/TDD-022-plugin-chaining-engine.md#5-plugin-manifest-extensions)
- [TDD-022 §13 Audit Log](../../autonomous-dev/docs/tdd/TDD-022-plugin-chaining-engine.md#13-audit-log)
- [help/SKILL.md Plugin Chains](../skills/help/SKILL.md#plugin-chains)
```

### Smoke script structure (illustrative)

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
ASSIST_MD="${REPO_ROOT}/plugins/autonomous-dev-assist/commands/assist.md"
QUICKSTART_MD="${REPO_ROOT}/plugins/autonomous-dev-assist/commands/quickstart.md"
RUNBOOK_MD="${REPO_ROOT}/plugins/autonomous-dev-assist/instructions/chains-runbook.md"

FAIL=0
ok()   { echo "[OK]   $*"; }
fail() { echo "[FAIL] $*"; FAIL=$((FAIL+1)); }
skip() { echo "[SKIP] $*"; }

# FR-17 six classifier categories
classifier=$(awk '/\*\*Step 1/,/\*\*Step 2/' "$ASSIST_MD" | grep -cE '^- \*\*[a-z]+\*\* --' || true)
[[ "$classifier" -eq 6 ]] && ok "assist: 6 classifier categories" \
                          || fail "assist: classifier count = $classifier (expected 6)"

# FR-18 nine new globs (verify each)
for g in \
  "plugins/autonomous-dev/intake/chains/\*" \
  "plugins/autonomous-dev/intake/deploy/\*" \
  "plugins/autonomous-dev/intake/cred-proxy/\*" \
  "plugins/autonomous-dev/intake/firewall/\*" \
  "plugins/autonomous-dev-deploy-gcp/\*\*" \
  "plugins/autonomous-dev-deploy-aws/\*\*" \
  "plugins/autonomous-dev-deploy-azure/\*\*" \
  "plugins/autonomous-dev-deploy-k8s/\*\*" \
  "plugins/autonomous-dev-assist/instructions/\*-runbook.md"; do
  if grep -q "^Glob: ${g//\\/}$" "$ASSIST_MD"; then
    ok "assist: glob present: ${g//\\/}"
  else
    fail "assist: glob missing: ${g//\\/}"
  fi
done

# FR-19 quickstart --with-cloud
grep -q '\-\-with-cloud' "$QUICKSTART_MD"   && ok "quickstart: --with-cloud documented" \
                                            || fail "quickstart: --with-cloud not documented"
grep -qF "For cloud deploy onboarding, run /autonomous-dev-assist:setup-wizard --with-cloud" "$QUICKSTART_MD" \
   && ok "quickstart: bridge line present" \
   || fail "quickstart: bridge line missing"

# FR-20 chains-runbook structure + safety strings
[[ -f "$RUNBOOK_MD" ]] && ok "chains-runbook.md exists" || fail "chains-runbook.md missing"

for hdr in '^## 1\. Bootstrap' '^## 2\. Dependency-graph troubleshooting' \
           '^## 3\. Audit verification' '^## 4\. Manifest-v2 migration' \
           '^## 5\. Approval flow' '^## 6\. Common errors' \
           '^## 7\. Escalation' '^## 8\. See also'; do
  grep -qE "$hdr" "$RUNBOOK_MD" && ok "runbook: $hdr" || fail "runbook: missing $hdr"
done

dnd=$(grep -c 'do NOT delete the audit log' "$RUNBOOK_MD" || true)
(( dnd >= 2 )) && ok "runbook: 'do NOT delete the audit log' x$dnd" \
              || fail "runbook: 'do NOT delete the audit log' = $dnd (need ≥2)"

dnr=$(grep -c 'do NOT rotate the HMAC key' "$RUNBOOK_MD" || true)
(( dnr >= 1 )) && ok "runbook: 'do NOT rotate the HMAC key' x$dnr" \
              || fail "runbook: 'do NOT rotate the HMAC key' = $dnr (need ≥1)"

SHA_RE='(commit[[:space:]]+[a-f0-9]{7,40}|as of [a-f0-9]{7,40}|fixed in [a-f0-9]{7,40})'
for f in "$ASSIST_MD" "$QUICKSTART_MD" "$RUNBOOK_MD"; do
  c=$(grep -cE "$SHA_RE" "$f" || true)
  (( c == 0 )) && ok "no SHA pin in $(basename "$f")" \
              || fail "SHA pin in $(basename "$f"): $c match(es)"
done

# negative chains bag
for neg in 'chains rotate-key' 'audit\.json'; do
  c=$(grep -cE "$neg" "$RUNBOOK_MD" || true)
  (( c == 0 )) && ok "runbook: no '$neg'" || fail "runbook: '$neg' appears $c times"
done

# manifest-v1 only in 'do NOT' context
bad=$(grep -n 'manifest-v1' "$RUNBOOK_MD" | grep -v 'do NOT' | wc -l | tr -d ' ')
(( bad == 0 )) && ok "runbook: manifest-v1 only in do-NOT context" \
              || fail "runbook: $bad 'manifest-v1' lines outside do-NOT context"

# FR-21 markdown-link-check with deploy-runbook XFAIL
# XFAIL: PLAN-026-3 lands the deploy-runbook target; remove this whitelist in SPEC-026-3-04
if command -v markdown-link-check >/dev/null 2>&1; then
  out=$(markdown-link-check --quiet "$RUNBOOK_MD" 2>&1 || true)
  # Allowed dead link: deploy-runbook.md (PLAN-026-3 target)
  filtered=$(echo "$out" | grep -E '^\s*\[✖\]' | grep -v 'deploy-runbook\.md' || true)
  if [[ -z "$filtered" ]]; then
    ok "link-check chains-runbook.md (deploy-runbook XFAIL whitelisted)"
  else
    fail "link-check chains-runbook.md: unexpected dead links: $filtered"
  fi
  for f in "$ASSIST_MD" "$QUICKSTART_MD"; do
    markdown-link-check --quiet "$f" >/dev/null 2>&1 \
      && ok "link-check $(basename "$f")" \
      || fail "link-check $(basename "$f")"
  done
else
  skip "markdown-link-check not installed"
fi

(( FAIL > 0 )) && { echo ""; echo "FAILED: $FAIL subtest(s)"; exit 1; }
echo ""
echo "PASSED: PLAN-026-2 invariants hold"
exit 0
```

## Interfaces and Dependencies
- **Consumes**: outputs of SPEC-026-2-01, -02, -03 (the modified/created files).
- **Produces**: the smoke script that gates regression of PLAN-026-2 outputs.
- **XFAIL contract**: SPEC-026-3-04 removes the deploy-runbook XFAIL whitelist after PLAN-026-3 creates the target file.

## Acceptance Criteria

### §5 presence and content
```
Given chains-runbook.md
When grep -E "^## 5\. Approval flow$" is run
Then 1 match
And the section body contains "chains approve REQ-" and "chains reject REQ-"
And §5 line count is in [25, 40]
```

### §6 exactly six error mappings
```
Given the §6 section
When the table data rows OR H3 items are counted
Then count = 6
And the labels include all six required topics:
  cycle detected, manifest-v2 schema error, missing produces,
  missing consumes, approval-gate timeout, unknown plugin
```

### §7 escalation distinction
```
Given §7
When the section is parsed
Then it contains both "TDD-022 issue" (or equivalent escalation language) and "recover locally" (or equivalent)
```

### §8 See-also four links
```
Given §8
When all Markdown links are extracted
Then ≥ 4 links exist
And one targets deploy-runbook.md (XFAIL)
And ≥ 2 target TDD-022 anchors with §
And one targets help/SKILL.md anchor "#plugin-chains"
```

### Smoke script existence
```
Given the repo
When ls plugins/autonomous-dev-assist/tests/docs/test-classifier-and-chains-runbook-026-2.test.sh is run
Then the file exists, is executable, starts with "#!/usr/bin/env bash"
```

### Smoke script passes on the post-spec tree
```
Given all PLAN-026-2 specs have merged
When the smoke script is invoked
Then exit 0
And stdout contains "PASSED: PLAN-026-2 invariants hold"
```

### Smoke script detects regressions (mutation matrix — author-time validation)
```
Given the smoke script
When the chains-runbook.md is mutated to remove "do NOT delete the audit log"
Then the script exits 1
And the FAIL line references "do NOT delete the audit log"

Given the smoke script
When the §6 mapping count is reduced to 5
Then the script exits 1

Given the smoke script
When commands/assist.md has a 7th classifier bullet added
Then the script exits 1

Given the smoke script
When a SHA pin "as of c1884eb" is inserted in any of the three files
Then the script exits 1

Given the smoke script
When the deploy-runbook §8 link is removed
Then the script PASSES (the XFAIL is for a missing target, not a missing link)
```

### XFAIL marker is correctly placed
```
Given the smoke script
When grep -F "XFAIL: PLAN-026-3 lands the deploy-runbook target" is run
Then ≥ 1 match
And SPEC-026-3-04 will remove this comment block (tracked in PLAN-026-3 DoD)
```

### Wiring
```
Given the existing test dispatcher
When invoked
Then it transitively runs test-classifier-and-chains-runbook-026-2.test.sh
And on failure, the dispatcher exit code is non-zero
```

### shellcheck and markdownlint
```
Given the smoke script
When shellcheck is run
Then exit 0

Given chains-runbook.md
When markdownlint is run
Then exit 0
```

## Test Requirements
- Run the smoke script against the post-spec tree → exit 0.
- Run the mutation matrix (5 mutations listed above) → 4 yield exit 1, 1 (XFAIL link removal) yields exit 0.
- shellcheck on the smoke script → 0 errors.
- markdownlint on chains-runbook.md → 0 errors.
- Manual: render the runbook in a Markdown viewer and confirm the §6 table renders correctly with 6 rows.

## Implementation Notes
- The §6 table format vs. H3+bullet format: pick whichever style matches the existing `instructions/runbook.md`. Read the existing file's "Common errors" section (if present) to extract the convention. If `runbook.md` uses tables, use a table here. Consistency aids operator scanning.
- The XFAIL-tolerance pattern in the smoke script is `markdown-link-check --quiet | grep dead-link-marker | grep -v deploy-runbook.md`. If `markdown-link-check` output format changes, adapt the filter. A test for the smoke script itself (FR-21 mutation case) is documented above.
- Wire the smoke script into the SAME dispatcher targeted by SPEC-026-1-04. Both scripts run as part of one invocation.
- The XFAIL removal in SPEC-026-3-04 is a contract: SPEC-026-3-04's DoD includes editing this script file to remove the whitelist. Do NOT defend against PLAN-026-3 not landing — the cascading PR plan ensures sequential merge.

## Rollout Considerations
- Pure documentation + tests. No runtime impact.
- Rollback: `git revert`. The chains-runbook reverts to §1–§4 only; smoke script disappears.

## Effort Estimate
- §5: 1 hour
- §6 (six mappings, careful authoring): 1.5 hours
- §7: 0.5 hours
- §8: 0.5 hours
- Smoke script authoring + wiring + shellcheck: 2 hours
- Mutation matrix validation: 0.5 hours
- **Total: 6 hours**

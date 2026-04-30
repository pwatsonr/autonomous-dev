# SPEC-017-2-02: Verdict Parsing, Sticky Comment Update, and Commit Status Setting

## Metadata
- **Parent Plan**: PLAN-017-2
- **Tasks Covered**: Task 3 (verdict parsing), Task 4 (sticky comment update), Task 5 (commit status setting)
- **Estimated effort**: 6.5 hours
- **Future location**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-017-2-02-verdict-parsing-sticky-comment-status.md`

## Description
Layer three report-back steps onto the `document-review` composite scaffolded by SPEC-017-2-01: (1) parse the verdict and severity tags from Claude's response, (2) idempotently update a sticky PR comment keyed by a hidden marker, and (3) set a commit status with a stable context name. After this spec lands, the composite is functionally complete for the numeric verdict mode used by the PRD/TDD/Plan/Spec workflows in SPEC-017-2-03 and SPEC-017-2-04. The checklist verdict mode for `agent-meta-review` is a follow-on parser branch added by SPEC-017-2-05.

This spec defines the canonical Claude response format that the parser consumes (`VERDICT: APPROVE|CONCERNS|REQUEST_CHANGES` plus zero or more `**[LOW|MEDIUM|HIGH|CRITICAL]**` severity tags), the failure mode when the response is malformed (loud step failure, never silent success), and the mapping from verdict + severity to commit-status state per TDD-017 §5.2 (CONCERNS does not block merge; REQUEST_CHANGES or any CRITICAL finding does).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/actions/document-review/action.yml` | Modify | Add three steps: `parse-verdict`, `sticky-comment`, `commit-status`. Wire to existing `claude-response` output. |
| `.github/actions/document-review/README.md` | Modify | Add "Verdict Format" and "Status-State Mapping" sections. |
| `tests/ci/test_document_review_action.bats` | Modify | Add 8 verdict-parser tests covering happy paths, severity mixes, malformed input. |
| `.github/actions/document-review/lib/parse-verdict.sh` | Create | Standalone bash script invoked by the parse step; testable in isolation via bats. |

## Implementation Details

### Verdict Format Contract

The reviewer agents (existing in `plugins/autonomous-dev/agents/`) emit a Markdown response. The parser depends on these conventions:

- **Verdict line** — Exactly one line matching the case-insensitive regex `^VERDICT:\s*(APPROVE|CONCERNS|REQUEST_CHANGES)\s*$`. The first match wins.
- **Severity tags** — Zero or more occurrences of `**[LOW]**`, `**[MEDIUM]**`, `**[HIGH]**`, or `**[CRITICAL]**` anywhere in the body. Case-insensitive.
- **Score line** (optional, numeric mode) — Optional line matching `^SCORE:\s*([0-9]{1,3})\s*$`. If absent, `score=` is empty.

A response missing the `VERDICT:` line is malformed and the parser fails the step with `::error::Could not parse verdict from Claude response`. This is intentional per the TDD-017 risk register: false-success on a parsing failure would let bad documents merge.

### `lib/parse-verdict.sh`

Extracted into a standalone script so it is unit-testable via bats without spinning up GitHub Actions:

```bash
#!/usr/bin/env bash
# Usage: parse-verdict.sh <response-file> <mode>
#   mode = numeric | checklist
# Writes: verdict=..., score=..., has-critical=true|false to $GITHUB_OUTPUT
# Exit 1 with ::error::... if response is malformed.

set -euo pipefail

response_file="${1:?response file required}"
mode="${2:-numeric}"

if [[ ! -r "$response_file" ]]; then
  echo "::error::Response file not readable: $response_file" >&2
  exit 1
fi

body="$(cat "$response_file")"

# Numeric mode (this spec). Checklist mode is added by SPEC-017-2-05.
if [[ "$mode" == "numeric" ]]; then
  verdict="$(printf '%s\n' "$body" | grep -iE '^VERDICT:[[:space:]]*(APPROVE|CONCERNS|REQUEST_CHANGES)' | head -n1 | sed -E 's/^[Vv][Ee][Rr][Dd][Ii][Cc][Tt]:[[:space:]]*([A-Za-z_]+).*/\1/' | tr '[:lower:]' '[:upper:]' || true)"
  if [[ -z "$verdict" ]]; then
    echo "::error::Could not parse verdict from Claude response" >&2
    exit 1
  fi
  score="$(printf '%s\n' "$body" | grep -iE '^SCORE:[[:space:]]*[0-9]+' | head -n1 | sed -E 's/^[Ss][Cc][Oo][Rr][Ee]:[[:space:]]*([0-9]+).*/\1/' || true)"
  if printf '%s' "$body" | grep -qiE '\*\*\[CRITICAL\]\*\*'; then
    has_critical="true"
  else
    has_critical="false"
  fi
  {
    echo "verdict=${verdict}"
    echo "score=${score}"
    echo "has-critical=${has_critical}"
  } >> "${GITHUB_OUTPUT:-/dev/stdout}"
fi

# Checklist mode placeholder — SPEC-017-2-05 implements.
if [[ "$mode" == "checklist" ]]; then
  echo "::error::checklist mode not implemented in SPEC-017-2-02; see SPEC-017-2-05" >&2
  exit 1
fi
```

### Composite Wiring

Insert the following steps into `action.yml` after the existing Claude invocation step from SPEC-017-2-01, all guarded by `if: steps.fork-check.outputs.is-fork != 'true'`:

```yaml
- name: Parse verdict
  id: parse-verdict
  if: steps.fork-check.outputs.is-fork != 'true'
  shell: bash
  env:
    CLAUDE_RESPONSE: ${{ steps.claude-invoke.outputs.claude-response }}
  run: |
    printf '%s' "$CLAUDE_RESPONSE" > /tmp/claude-response.md
    "${{ github.action_path }}/lib/parse-verdict.sh" /tmp/claude-response.md numeric

- name: Update sticky comment
  if: steps.fork-check.outputs.is-fork != 'true'
  uses: actions/github-script@v7  # PIN-BY-SHA in actual YAML
  with:
    script: |
      const marker = `<!-- ${{ inputs.document-type }}-review-comment -->`;
      const verdict = `${{ steps.parse-verdict.outputs.verdict }}`;
      const score = `${{ steps.parse-verdict.outputs.score }}`;
      const hasCritical = `${{ steps.parse-verdict.outputs.has-critical }}` === 'true';
      const response = process.env.CLAUDE_RESPONSE;
      const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
      const body = [
        marker,
        `## ${{ inputs.document-type }} Review — ${verdict}${score ? ` (score: ${score})` : ''}${hasCritical ? ' ⚠️ CRITICAL findings' : ''}`,
        '',
        response,
        '',
        '---',
        `_Posted by [docs/${{ inputs.document-type }}-review run](${runUrl})._`,
      ].join('\n');
      const { data: comments } = await github.rest.issues.listComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
      });
      const existing = comments.find(c => c.body && c.body.includes(marker));
      if (existing) {
        await github.rest.issues.updateComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          comment_id: existing.id,
          body,
        });
      } else {
        await github.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: context.issue.number,
          body,
        });
      }
  env:
    CLAUDE_RESPONSE: ${{ steps.claude-invoke.outputs.claude-response }}

- name: Set commit status
  if: steps.fork-check.outputs.is-fork != 'true'
  uses: actions/github-script@v7  # PIN-BY-SHA in actual YAML
  with:
    script: |
      const verdict = `${{ steps.parse-verdict.outputs.verdict }}`;
      const hasCritical = `${{ steps.parse-verdict.outputs.has-critical }}` === 'true';
      const isFailure = verdict === 'REQUEST_CHANGES' || hasCritical;
      const state = isFailure ? 'failure' : 'success';
      let description;
      if (isFailure) {
        description = hasCritical ? 'Critical findings present' : 'Reviewer requested changes';
      } else if (verdict === 'CONCERNS') {
        description = 'passed with minor concerns';
      } else {
        description = 'approved';
      }
      await github.rest.repos.createCommitStatus({
        owner: context.repo.owner,
        repo: context.repo.repo,
        sha: context.payload.pull_request.head.sha,
        state,
        context: `docs/${{ inputs.document-type }}-review`,
        description: description.slice(0, 140),
        target_url: `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
      });
```

### Status-State Mapping

| Verdict | has-critical | Commit Status | Description |
|---------|--------------|---------------|-------------|
| APPROVE | false | `success` | "approved" |
| APPROVE | true | `failure` | "Critical findings present" |
| CONCERNS | false | `success` | "passed with minor concerns" |
| CONCERNS | true | `failure` | "Critical findings present" |
| REQUEST_CHANGES | false | `failure` | "Reviewer requested changes" |
| REQUEST_CHANGES | true | `failure` | "Critical findings present" |

The CONCERNS-passes-without-critical row matches TDD-017 §5.2 explicitly: minor concerns are surfaced in the PR comment but do not block merge; only REQUEST_CHANGES or a CRITICAL finding does.

### Bats Test Cases (added to existing file)

```bash
@test "parser: VERDICT: APPROVE, no severity tags => verdict=APPROVE, has-critical=false" {
  echo "VERDICT: APPROVE" > /tmp/r.md
  GITHUB_OUTPUT=/tmp/out run bash lib/parse-verdict.sh /tmp/r.md numeric
  [ "$status" -eq 0 ]
  grep -q "verdict=APPROVE" /tmp/out
  grep -q "has-critical=false" /tmp/out
}

@test "parser: VERDICT: REQUEST_CHANGES with **[CRITICAL]** => has-critical=true" {
  printf 'VERDICT: REQUEST_CHANGES\n\nFinding **[CRITICAL]**: bad thing\n' > /tmp/r.md
  GITHUB_OUTPUT=/tmp/out run bash lib/parse-verdict.sh /tmp/r.md numeric
  [ "$status" -eq 0 ]
  grep -q "verdict=REQUEST_CHANGES" /tmp/out
  grep -q "has-critical=true" /tmp/out
}

@test "parser: case-insensitive verdict line accepted" {
  echo "verdict: concerns" > /tmp/r.md
  GITHUB_OUTPUT=/tmp/out run bash lib/parse-verdict.sh /tmp/r.md numeric
  [ "$status" -eq 0 ]
  grep -q "verdict=CONCERNS" /tmp/out
}

@test "parser: SCORE: 92 captured" {
  printf 'VERDICT: APPROVE\nSCORE: 92\n' > /tmp/r.md
  GITHUB_OUTPUT=/tmp/out run bash lib/parse-verdict.sh /tmp/r.md numeric
  [ "$status" -eq 0 ]
  grep -q "score=92" /tmp/out
}

@test "parser: missing VERDICT line fails with ::error::" {
  echo "no verdict here" > /tmp/r.md
  GITHUB_OUTPUT=/tmp/out run bash lib/parse-verdict.sh /tmp/r.md numeric
  [ "$status" -ne 0 ]
  [[ "$output" == *"::error::"* ]]
}

@test "parser: severity tag with HIGH but no CRITICAL => has-critical=false" {
  printf 'VERDICT: CONCERNS\n**[HIGH]** finding\n' > /tmp/r.md
  GITHUB_OUTPUT=/tmp/out run bash lib/parse-verdict.sh /tmp/r.md numeric
  [ "$status" -eq 0 ]
  grep -q "has-critical=false" /tmp/out
}

@test "parser: multiple verdict lines, first wins" {
  printf 'VERDICT: APPROVE\nVERDICT: REQUEST_CHANGES\n' > /tmp/r.md
  GITHUB_OUTPUT=/tmp/out run bash lib/parse-verdict.sh /tmp/r.md numeric
  [ "$status" -eq 0 ]
  grep -q "verdict=APPROVE" /tmp/out
}

@test "parser: empty response file fails" {
  : > /tmp/r.md
  GITHUB_OUTPUT=/tmp/out run bash lib/parse-verdict.sh /tmp/r.md numeric
  [ "$status" -ne 0 ]
}
```

## Acceptance Criteria

- [ ] `.github/actions/document-review/lib/parse-verdict.sh` exists, is executable (`chmod +x`), and uses `set -euo pipefail`.
- [ ] Parser script accepts response file path + mode argument and writes `verdict=`, `score=`, `has-critical=` to `$GITHUB_OUTPUT`.
- [ ] Parser uses case-insensitive regex `^VERDICT:\s*(APPROVE|CONCERNS|REQUEST_CHANGES)` and emits the verdict in uppercase.
- [ ] Parser fails (exit 1) with `::error::Could not parse verdict from Claude response` when the verdict line is absent or malformed.
- [ ] `has-critical=true` if and only if response body contains `**[CRITICAL]**` (case-insensitive); `**[HIGH]**` etc. do not set the flag.
- [ ] All 8 bats tests above pass when run via `bats tests/ci/test_document_review_action.bats`.
- [ ] Composite's `parse-verdict` step invokes `lib/parse-verdict.sh` (does not duplicate parser logic inline).
- [ ] `update-sticky-comment` step uses `actions/github-script@v7` (pinned by SHA), finds existing comment by hidden marker `<!-- {document-type}-review-comment -->`, and updates it; creates a new one if not found.
- [ ] After two consecutive review runs on the same PR, `gh api repos/{owner}/{repo}/issues/{n}/comments | jq '[.[] | select(.body | contains("<!-- prd-review-comment -->"))] | length'` returns 1 (single comment, updated in place).
- [ ] `set-commit-status` step calls `repos.createCommitStatus` with `context: docs/{document-type}-review` exactly (no prefix, no suffix variation).
- [ ] State mapping table above is implemented as written: APPROVE+no-critical=success, CONCERNS+no-critical=success, REQUEST_CHANGES=failure, any-critical=failure.
- [ ] Description text is truncated to ≤140 chars (commit status API limit).
- [ ] All three new steps guard on `if: steps.fork-check.outputs.is-fork != 'true'` so fork PRs continue to short-circuit per SPEC-017-2-01.
- [ ] `actionlint` passes on the modified composite.
- [ ] README's "Verdict Format" section documents the regex, severity tags, and the malformed-response failure mode.
- [ ] README's "Status-State Mapping" section reproduces the table above.

## Dependencies

- **SPEC-017-2-01** (blocking): The composite skeleton, fork-check step, and Claude invocation step must already exist; this spec inserts steps after them and consumes `steps.claude-invoke.outputs.claude-response`.
- **GitHub Actions runtime**: `actions/github-script@v7` for the comment and status steps.
- **Bats**: `bats-core` available in CI for running `tests/ci/test_document_review_action.bats`.
- **Reviewer agent prompt format**: Agents must emit `VERDICT:` lines and `**[SEVERITY]**` tags as documented. This spec does not author or modify agent prompts; it specifies the contract those agents must satisfy. If agents drift from this format, the parser fails loudly (acceptance criterion #4).

## Notes

- The decision to extract the parser into a standalone bash script (vs. inline `run:` block) is deliberate: it enables fast unit testing via bats without GitHub Actions runtime, and it keeps the composite YAML concise. This is the same pattern PLAN-017-1 uses for the trust-gate's check script.
- Commit status descriptions are bounded to 140 chars per the GitHub API limit. The mapping table values are well under that, but truncation guards against future drift.
- The sticky-comment search uses `listComments` (paginated, defaulting to 30 per page). For PRs with >30 comments, this could miss the existing sticky and create a duplicate. PLAN-017-2's smoke test (task 11, covered by SPEC-017-2-05) does not exercise the >30-comment case; if it surfaces post-launch, the fix is to use `paginate.iterator()`. Documented as a known limitation in the README.
- CONCERNS-passes is a TDD-017 §5.2 explicit decision: it surfaces concerns to humans without auto-blocking the PR. Reviewers may still hold the PR; the bot does not.
- This spec leaves `verdict-mode` (numeric vs checklist) hardcoded to `numeric`. SPEC-017-2-05 introduces the input and the checklist branch in `parse-verdict.sh`. Splitting the work this way means SPEC-017-2-03 and SPEC-017-2-04 (the four numeric workflows) can ship without waiting on the checklist branch.

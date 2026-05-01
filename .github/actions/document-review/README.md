# document-review (composite action)

## Purpose

Reusable composite action that performs an automated reviewer-agent pass over
a set of documentation files changed in a pull request. It is invoked by the
per-document-type workflows in `.github/workflows/` (`prd-review`,
`tdd-review`, `plan-review`, `spec-review`, `agent-meta-review`) so that all
document reviewers share a single hardened invocation surface for the Claude
Code action.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `document-type` | yes | -- | Slug used in the status-check name (e.g. `prd`, `tdd`, `plan`, `spec`, `agent-meta`). |
| `agent-name` | yes | -- | Reviewer agent file basename (e.g. `prd-reviewer`). Loaded from `plugins/*/agents/`. |
| `path-glob` | yes | -- | Glob the workflow already filtered on; used to enumerate changed files for `--attach`. |
| `threshold` | no | `"0"` | Numeric rubric pass threshold (e.g. `"85"`). Ignored in checklist mode (SPEC-017-2-05). |
| `prompt-template-path` | yes | -- | Path to the reviewer agent `.md` file under `plugins/*/agents/`. |

## Outputs

| Output | Description |
|--------|-------------|
| `verdict` | Parsed verdict (populated by SPEC-017-2-02 step). Empty for fork-PR neutral-pass runs. |
| `score` | Numeric score parsed from response (populated by SPEC-017-2-02). Empty if not in numeric mode. |
| `has-critical` | `"true"` if any finding tagged `[CRITICAL]` (populated by SPEC-017-2-02). |
| `is-fork` | `"true"` if the PR `head.repo` differs from `base.repo`; the rest of the flow short-circuits. |

## Trust Model

This composite assumes the upstream `claude-trust-gate` composite action
(SPEC-017-1) ran in a prior job and emitted `is-trusted=true`. **Consumers
MUST wire this dependency explicitly:**

```yaml
jobs:
  trust-gate:
    runs-on: ubuntu-latest
    outputs:
      allowed: ${{ steps.gate.outputs.is-trusted }}
    steps:
      - uses: actions/checkout@v4
      - id: gate
        uses: ./.github/actions/claude-trust-gate
        with:
          author-association: ${{ github.event.pull_request.author_association }}

  review:
    needs: trust-gate
    if: needs.trust-gate.outputs.allowed == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/document-review
        with:
          document-type: prd
          agent-name: prd-reviewer
          path-glob: 'docs/prd/**'
          threshold: '85'
          prompt-template-path: plugins/autonomous-dev/agents/prd-reviewer.md
```

Failing to wire the trust gate exposes the Claude API key to anyone who can
open a pull request. Do not skip it.

## Attach-Only Contract

The Claude invocation step uses `claude_args: "--attach /tmp/review_files
--max-turns 3"` exactly. The reviewer prompt is loaded from
`prompt-template-path` and passed as the literal `prompt` input -- it never
contains interpolated file content.

This is the prompt-injection defense documented in TDD-017 §5.3: file bodies
under review may contain adversarial text designed to manipulate the model.
By attaching them as discrete inputs (rather than concatenating into the
prompt string), the model treats them as data to review, not instructions
to follow.

**Do not modify this composite to inline file content into the prompt
string.** If a future requirement appears to need it, escalate to a security
review first.

## Fork-PR Behavior

Pull requests whose `head.repo.full_name` differs from `base.repo.full_name`
originate from forks. GitHub does not expose secrets (including
`ANTHROPIC_API_KEY`) to fork builds, so the reviewer cannot run.

For fork PRs the composite:
1. Emits a commit status `docs/{document-type}-review` with `state: success`
   and a description that begins `Fork PR -- secrets withheld...`
   (GitHub's commit-status API has no native `neutral` state; we use
   `success` so the PR is not blocked, and rely on the description text to
   make the reason unambiguous).
2. Posts (or updates) a single sticky comment on the PR with the hidden
   marker `<!-- {document-type}-review-comment -->` explaining the
   situation and pointing the author at the maintainer-assisted workflow.
3. Sets `verdict=`, `score=`, `has-critical=false`, `is-fork=true` outputs
   so downstream steps can branch cleanly.

No further steps run; in particular the Claude invocation is never reached
on a fork PR.

## Verdict Format

The reviewer agents emit a Markdown response. The parser (`lib/parse-verdict.sh`)
expects the following conventions:

- **Verdict line** (required): exactly one line matching the case-insensitive
  regex `^VERDICT:\s*(APPROVE|CONCERNS|REQUEST_CHANGES)\s*$`. The first match
  wins. The verdict is normalized to uppercase in the output.
- **Severity tags** (optional, zero or more): occurrences of `**[LOW]**`,
  `**[MEDIUM]**`, `**[HIGH]**`, or `**[CRITICAL]**` anywhere in the body.
  Case-insensitive. Only `**[CRITICAL]**` sets `has-critical=true`.
- **Score line** (optional): `^SCORE:\s*([0-9]{1,3})\s*$`. If absent, the
  `score` output is empty.

A response missing the `VERDICT:` line is malformed; the parser fails the
step with `::error::Could not parse verdict from Claude response`. False
success on a parsing failure would let bad documents merge silently, which
the TDD-017 risk register explicitly forbids.

## Status-State Mapping

| Verdict | has-critical | Commit Status | Description |
|---------|--------------|---------------|-------------|
| `APPROVE` | false | `success` | "approved" |
| `APPROVE` | true | `failure` | "Critical findings present" |
| `CONCERNS` | false | `success` | "passed with minor concerns" |
| `CONCERNS` | true | `failure` | "Critical findings present" |
| `REQUEST_CHANGES` | false | `failure` | "Reviewer requested changes" |
| `REQUEST_CHANGES` | true | `failure` | "Critical findings present" |

`CONCERNS` without a critical finding passes by design (TDD-017 §5.2):
minor concerns are surfaced in the PR comment but do not block merge. Only
`REQUEST_CHANGES` or any `**[CRITICAL]**` tag blocks.

Description text is truncated to 140 characters (the GitHub commit-status
API limit).

## Known Limitations

- The sticky-comment search calls `issues.listComments` with the default
  pagination (30 per page). On a PR with more than 30 comments preceding the
  sticky one, the search may miss the existing sticky and create a duplicate.
  If this surfaces in practice, switch to `paginate.iterator()`.

## Extension Points

- **`verdict-mode` input** (SPEC-017-2-05) will add a `numeric|checklist`
  switch that selects between rubric-score parsing and checklist parsing.
  The default will remain `numeric` so existing callers do not need to
  change.
- **Spend-artifact emission** for budget tracking is layered in by
  PLAN-017-4; this composite does not own that wiring.
- New document types (RFCs, ADRs, ...) can call this composite directly
  with their own `document-type` and `path-glob` -- no composite changes
  required.

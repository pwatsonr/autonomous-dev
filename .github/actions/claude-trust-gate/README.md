# claude-trust-gate

A composite GitHub Action that gates Claude-powered workflows on the
`author_association` of the triggering comment/event.

## Purpose

This action is the security primitive every Claude-powered workflow in
autonomous-dev consumes. It evaluates the GitHub `author_association`
value against a fixed allow-list (`OWNER`, `MEMBER`, `COLLABORATOR`) and
emits a single boolean (`is-trusted=true|false`). Downstream workflows
gate their privileged steps on this output via
`needs.<job>.outputs.is-trusted == 'true'`.

## Contract

| Direction | Name | Type | Required | Notes |
|-----------|------|------|----------|-------|
| Input | `author-association` | string | yes | Pass `${{ github.event.comment.author_association }}` (or equivalent). |
| Output | `is-trusted` | string | -- | Literal `"true"` when input is OWNER/MEMBER/COLLABORATOR, otherwise `"false"`. |

Trusted allow-list (case-sensitive, exhaustive): `OWNER`, `MEMBER`,
`COLLABORATOR`. Every other value (including `CONTRIBUTOR`,
`FIRST_TIMER`, `NONE`, `MANNEQUIN`, the empty string, and the literal
string `null`) emits `is-trusted=false`.

## Usage

```yaml
jobs:
  trust-check:
    runs-on: ubuntu-latest
    outputs:
      is-trusted: ${{ steps.gate.outputs.is-trusted }}
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - id: gate
        uses: ./.github/actions/claude-trust-gate
        with:
          author-association: ${{ github.event.comment.author_association }}

  respond:
    needs: trust-check
    if: needs.trust-check.outputs.is-trusted == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: echo "trusted; safe to proceed"
```

## Common pitfalls

- **Never interpolate file paths or arbitrary comment content into
  prompts.** Pass file content via the Claude action's `--attach`
  mechanism only. Shell-style interpolation is a prompt-injection sink.
- **Do not weaken the allow-list.** Adding `CONTRIBUTOR`, `FIRST_TIMER`,
  or `NONE` requires a documented threat-model review; it is not a
  routine change.
- **Untrusted comments must silent-skip.** Never reply to an untrusted
  author and never surface a visible error in the Actions UI: the
  attacker must learn nothing about the trust boundary.
- **Composite step set -euo pipefail is mandatory.** A malformed input
  hard-fails (observable) rather than silently emitting a default.
- **The composite never echoes the input value.** Job summaries must
  not leak commenter handles via this action.

## Testing

Run the bats suite locally from the repo root:

```bash
bats tests/ci/test_claude_trust_gate.bats
```

The suite covers all eight enum/edge cases and completes in under ten
seconds. The harness at `tests/ci/helpers/trust_gate_harness.sh`
mirrors the composite's case block; if you change `action.yml`, update
the harness in the same commit.

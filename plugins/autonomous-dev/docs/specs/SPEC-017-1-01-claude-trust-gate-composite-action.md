# SPEC-017-1-01: Claude Trust Gate Composite Action & Bats Unit Tests

## Metadata
- **Parent Plan**: PLAN-017-1
- **Tasks Covered**: Task 1 (author claude-trust-gate composite action), Task 8 (author composite action bats tests)
- **Estimated effort**: 4 hours

## Description
Create the foundational `claude-trust-gate` composite action that every Claude-powered workflow in the autonomous-dev plugin uses to enforce the `author_association` trust boundary. The composite takes a single string input (`author-association`) and emits a single string output (`is-trusted`) set to `"true"` when the input is one of the trusted GitHub association levels (`OWNER`, `MEMBER`, `COLLABORATOR`) and `"false"` otherwise. This is the security primitive that downstream workflows (`claude-assistant.yml` in SPEC-017-1-02, the document-review workflows in PLAN-017-2, and `release.yml` in PLAN-017-3) all consume via `uses: ./.github/actions/claude-trust-gate`.

This spec is purely declarative shell logic — no API calls, no external dependencies. The composite is small enough that 100% branch coverage is achievable with eight bats test cases covering the full GitHub `author_association` enum plus empty/null inputs. The companion bats suite simulates `$GITHUB_OUTPUT` via a temp file so the composite can be exercised without `nektos/act`.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/.github/actions/claude-trust-gate/action.yml` | Create | Composite action manifest with single bash step |
| `plugins/autonomous-dev/.github/actions/claude-trust-gate/README.md` | Create | Operator/integrator docs: contract, examples, common pitfalls |
| `plugins/autonomous-dev/tests/ci/test_claude_trust_gate.bats` | Create | Eight-case bats suite covering trusted, untrusted, empty, and null inputs |
| `plugins/autonomous-dev/tests/ci/helpers/trust_gate_harness.sh` | Create | Bash harness that exports `$GITHUB_OUTPUT` to a temp file and invokes the composite's logic |

## Implementation Details

### `action.yml` Composite

The action declares one input and one output, then runs a single bash step. Pin shell to `bash` for predictable behavior on both `ubuntu-latest` and self-hosted runners.

```yaml
name: 'Claude Trust Gate'
description: >
  Evaluate a GitHub author_association value against the autonomous-dev
  trusted-author allow-list (OWNER, MEMBER, COLLABORATOR). Emits
  is-trusted=true|false. Used by every Claude-powered workflow.
author: 'autonomous-dev contributors'
inputs:
  author-association:
    description: >
      The github.event.comment.author_association value (or equivalent for
      issue/PR events). Case-sensitive; GitHub always emits uppercase.
    required: true
runs:
  using: 'composite'
  steps:
    - name: Evaluate trust
      id: evaluate
      shell: bash
      run: |
        set -euo pipefail
        association="${{ inputs.author-association }}"
        case "$association" in
          OWNER|MEMBER|COLLABORATOR)
            echo "is-trusted=true" >> "$GITHUB_OUTPUT"
            ;;
          *)
            echo "is-trusted=false" >> "$GITHUB_OUTPUT"
            ;;
        esac
outputs:
  is-trusted:
    description: '"true" when association is OWNER/MEMBER/COLLABORATOR, else "false".'
    value: ${{ steps.evaluate.outputs.is-trusted }}
```

Notes:
- The `case` block is the entire trust-decision surface area; everything else is plumbing.
- `set -euo pipefail` is mandatory — silent failures here would default-deny by emitting nothing to `$GITHUB_OUTPUT`, breaking the consuming workflow's `needs.trust-check.outputs.is-trusted == 'true'` check (which is the desired safe behavior, but we also want a hard error in tests).
- The composite never logs the input value to stdout; only the `is-trusted` boolean is observable. This avoids leaking author handles into job summaries.

### `README.md` Structure

Required sections, in order:

1. **Purpose** — One paragraph explaining the trust boundary and where it is consumed.
2. **Contract** — Inputs (`author-association`, required, string) and outputs (`is-trusted`, `"true"`|`"false"`). Explicit allow-list: `OWNER`, `MEMBER`, `COLLABORATOR`.
3. **Usage** — A copy-pasteable job snippet showing `uses: ./.github/actions/claude-trust-gate` with the `author-association` input and a downstream `needs.<job>.outputs.is-trusted == 'true'` gate.
4. **Common pitfalls** — At minimum:
   - Never interpolate file paths or arbitrary comment content into prompts; pass file content via `--attach` only.
   - Do not weaken the allow-list (e.g. adding `CONTRIBUTOR`) without security review.
   - Untrusted comments must silent-skip — never reply, never error visibly.
5. **Testing** — How to run `tests/ci/test_claude_trust_gate.bats` locally (`bats tests/ci/test_claude_trust_gate.bats`).

The README must be ≤ 80 lines, operator reference style.

### `tests/ci/helpers/trust_gate_harness.sh`

Reusable harness so the bats suite can invoke the composite's logic without GitHub Actions. The harness:

1. Creates a temp file and exports it as `$GITHUB_OUTPUT`.
2. Sources the case block from `action.yml` (or replicates it inline; replication is acceptable since the logic is small and reviewers verify both stay aligned).
3. Echoes the resulting `is-trusted` value to stdout for the bats assertion.

```bash
#!/usr/bin/env bash
set -euo pipefail

evaluate_trust() {
  local association="${1-}"
  local output_file
  output_file="$(mktemp)"
  GITHUB_OUTPUT="$output_file" bash -c '
    set -euo pipefail
    association="$1"
    case "$association" in
      OWNER|MEMBER|COLLABORATOR)
        echo "is-trusted=true" >> "$GITHUB_OUTPUT"
        ;;
      *)
        echo "is-trusted=false" >> "$GITHUB_OUTPUT"
        ;;
    esac
  ' _ "$association"
  grep -E '^is-trusted=' "$output_file" | cut -d= -f2
  rm -f "$output_file"
}
```

### `tests/ci/test_claude_trust_gate.bats`

One `@test` per case. All eight tests must pass and the suite must complete in < 10 seconds.

```bash
#!/usr/bin/env bats

setup() {
  HARNESS_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/helpers" && pwd)"
  source "$HARNESS_DIR/trust_gate_harness.sh"
}

@test "OWNER -> is-trusted=true" {
  result="$(evaluate_trust OWNER)"
  [ "$result" = "true" ]
}

@test "MEMBER -> is-trusted=true" {
  result="$(evaluate_trust MEMBER)"
  [ "$result" = "true" ]
}

@test "COLLABORATOR -> is-trusted=true" {
  result="$(evaluate_trust COLLABORATOR)"
  [ "$result" = "true" ]
}

@test "CONTRIBUTOR -> is-trusted=false" {
  result="$(evaluate_trust CONTRIBUTOR)"
  [ "$result" = "false" ]
}

@test "FIRST_TIMER -> is-trusted=false" {
  result="$(evaluate_trust FIRST_TIMER)"
  [ "$result" = "false" ]
}

@test "NONE -> is-trusted=false" {
  result="$(evaluate_trust NONE)"
  [ "$result" = "false" ]
}

@test "empty string -> is-trusted=false" {
  result="$(evaluate_trust '')"
  [ "$result" = "false" ]
}

@test "null literal -> is-trusted=false" {
  result="$(evaluate_trust 'null')"
  [ "$result" = "false" ]
}
```

## Acceptance Criteria

- [ ] `plugins/autonomous-dev/.github/actions/claude-trust-gate/action.yml` exists and passes `actionlint` with zero warnings.
- [ ] `action.yml` declares exactly one input (`author-association`, `required: true`) and exactly one output (`is-trusted`).
- [ ] Inputs `OWNER`, `MEMBER`, `COLLABORATOR` produce `is-trusted=true` (verified by bats).
- [ ] Inputs `CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, `""` (empty), `null` (literal string) produce `is-trusted=false` (verified by bats).
- [ ] `set -euo pipefail` is present in the bash step; pipeline failures hard-fail the action.
- [ ] The composite never echoes the input value to stdout/stderr (verified by reading the source; no `echo "$association"` lines).
- [ ] `tests/ci/test_claude_trust_gate.bats` exists with exactly 8 `@test` blocks; all pass when run via `bats tests/ci/test_claude_trust_gate.bats`.
- [ ] The full bats suite completes in < 10 seconds on a clean macOS or Linux runner.
- [ ] `tests/ci/helpers/trust_gate_harness.sh` is sourced (not executed) by the bats setup.
- [ ] `README.md` exists, is ≤ 80 lines, and contains all five documented sections (Purpose, Contract, Usage, Common pitfalls, Testing).
- [ ] README's "Common pitfalls" section explicitly states the `--attach` rule and the no-weakening-allow-list rule.
- [ ] No third-party actions referenced in `action.yml` (it is pure bash; no `uses:` anywhere).

## Dependencies

- `bats-core` >= 1.5 must be available on the test runner (already a dev dependency of autonomous-dev).
- GitHub Actions composite action support — Claude Code marketplace runs on GitHub-hosted runners; this contract is stable.
- No new npm/Bun/Python packages.

## Notes

- This spec is intentionally split from the `claude-assistant.yml` workflow (SPEC-017-1-02) so the trust-gate primitive can be reviewed and tested in isolation. Five other downstream workflows (PLAN-017-2 and PLAN-017-3) consume this composite, so getting the contract right here is more important than any single consumer.
- The `set -euo pipefail` choice is deliberately conservative: a malformed input (e.g. shell metacharacters smuggled via a future caller that doesn't quote properly) hard-fails rather than silently emitting `is-trusted=false` and continuing. The hard-fail is observable in the workflow run; the silent-false would be invisible.
- The harness's logic-replication pattern (rather than parsing `action.yml`) is a maintainability trade-off: any change to the case block in `action.yml` must be mirrored in `helpers/trust_gate_harness.sh` and reviewers must verify the mirror. The bats suite enforces correctness; mismatched logic surfaces as a failing test.
- This spec lives at `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-017-1-01-claude-trust-gate-composite-action.md` once promoted from staging.
- GitHub's `author_association` enum also includes `MANNEQUIN` (rare, mostly historical); it is intentionally treated as untrusted by the catch-all `*)` arm. If a future requirement surfaces it, add an explicit case and a bats test in the same change.

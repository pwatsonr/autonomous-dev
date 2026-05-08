---
phase: 16
case_type: linked-prd-no-duplication
expected_outcome: complete
fixture_repo: tests/fixtures/setup-wizard/repos/ts-greenfield
mocks:
  - autonomous-dev plugin install (success)
  - autonomous-dev cred-proxy provision/validate (success)
  - autonomous-dev firewall apply (applied)
  - autonomous-dev deploy --dry-run (ok)
operator_inputs:
  env_dev_backend: local
  env_staging_backend: local
  env_prod_backend: local
assertions:
  - id: A-1
    description: PRD-cross-reference banner emitted exactly once
    type: regex-match-count
    target: rendered-phase-output
    pattern: 'NOTE: This phase configures deployment backends'
    expected_count: 1
  - id: A-2
    description: Zero ≥40-char verbatim sentence matches against PRD-015 content
    type: prd-duplication-scan
    rendered: rendered-phase-output
    prd_files:
      - docs/prds/PRD-015-ci-cd-pipeline-and-chain-orchestration.md
    min_sentence_length: 40
    expected_match_count: 0
  - id: A-3
    description: Zero ≥40-char verbatim sentence matches against PRD-017 content
    type: prd-duplication-scan
    rendered: rendered-phase-output
    prd_files:
      - docs/prds/PRD-017-cost-cap-enforcer.md
    min_sentence_length: 40
    expected_match_count: 0
---

# Phase 16 linked-prd-no-duplication eval (FR-23, AC-05)

Renders phase 16 output (banner + prompts + verification line). Splits
into sentences (delimiters `.` and `\n\n`). For each sentence ≥ 40 chars,
greps for verbatim presence in PRD-015 and PRD-017 content. Asserts
zero matches.

The PRD cross-reference banner sentences are intentionally short or are
file paths / config key names; they do not run afoul of the ≥40-char
threshold against PRD content sentences.

YAML and code-fence blocks are skipped by the tokenizer (technical
content; allowing verbatim file paths and config key names that are short).

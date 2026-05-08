---
phase: 12
case_type: linked-prd-no-duplication
expected_outcome: scanner-clean
fixture_inputs:
  rendered_phase_md: plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-12-ci-setup.md
  prd_chain_md: plugins/autonomous-dev/docs/prds/PRD-015-ci-cd-pipeline-and-chain-orchestration.md
assertions:
  - id: SCAN-1
    description: zero >=40-char verbatim duplications between rendered phase and PRD-015 chain section
    type: scanner-clean
    expected: 0 matches
---

# Setup
Render phase 12 module body and PRD-015's chain section.

# Run

```
plugins/autonomous-dev-assist/evals/scanners/prd-duplication-scanner.sh \
  --rendered plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-12-ci-setup.md \
  --prd      plugins/autonomous-dev/docs/prds/PRD-015-ci-cd-pipeline-and-chain-orchestration.md \
  --section  "chain" \
  --min-len  40
```

# Expected
- Exit 0 (no duplication detected).
- On any match, exit 1; the offending sentence is printed to stderr; the
  entire suite is marked auto-failed (TDD-033 §15 risk "coordination drift").

---
phase: 13
case_type: error-recovery
expected_outcome: failed-or-recovered
sub_cases:
  - id: A
    description: handler script not executable (chmod 644) → hooks add fails
    fixture_handler: tests/fixtures/setup-wizard/handlers/policy-check-non-exec.sh
    operator_confirmation: "yes"
    expected:
      - hooks_add_returns: non-zero
      - stderr_contains: "handler not executable"
      - re_entry_offered: true
      - on_decline_phase: failed
      - hooks_keys_written: 0
  - id: B
    description: handler at non-allowlisted path → wizard prompts allowlist add
    fixture_handler: /tmp/random-script.sh
    operator_inputs:
      allowlist_confirm: "yes"
    expected:
      - cli_invocation: succeeds
      - hook_registered: true
  - id: C
    description: catalog file missing → phase exits with diagnostic + troubleshoot pointer
    setup: rename plugins/autonomous-dev/config/request-types.json to .bak
    expected:
      - exit_step: read-catalog
      - stderr_contains: "request-types catalog missing"
      - stderr_contains: "/autonomous-dev-assist:troubleshoot"
      - phases_status: failed
      - per_type_prompts_shown: 0
---

# Setup
- Sub-A: copy fixture handler with `chmod 644` (read-only, not exec).
- Sub-B: place a fresh handler at `/tmp/random-script.sh` (outside any
  declared allowlist).
- Sub-C: rename the catalog file before the phase enters
  `read-catalog`.

# Run
- `autonomous-dev wizard --phase 13` for each sub-case.

# Expected
- Sub-A: `autonomous-dev hooks add` exits non-zero (TDD-019 enforces
  handler-must-be-executable). Wizard surfaces stderr; offers re-entry
  up to 3 times; on operator decline, phase exits `failed` with no
  `hooks.*` keys written.
- Sub-B: wizard prompts allowlist add; on operator typing literal
  "yes", CLI invocation proceeds; hook registered.
- Sub-C: phase exits at `read-catalog` step with diagnostic referencing
  the troubleshoot skill; `phases.13.status="failed"`; no per-type
  prompts shown.

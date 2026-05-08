#!/usr/bin/env bats
# tests/setup-wizard/orchestrator-loop.bats
# Verifies SKILL.md orchestrator block insertion + registry per SPEC-033-1-03.

SKILL="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/SKILL.md"
DEFAULTS="${BATS_TEST_DIRNAME}/../../config_defaults.json"

@test "O-001 orchestrator anchors present once" {
  [ "$(grep -c '<!-- BEGIN: phase-module orchestrator (TDD-033) -->' "$SKILL")" = "1" ]
  [ "$(grep -c '<!-- END: phase-module orchestrator -->' "$SKILL")" = "1" ]
}

@test "O-002 deferral notice anchors present once" {
  [ "$(grep -c '<!-- BEGIN-PHASE-17-19-DEFERRAL -->' "$SKILL")" = "1" ]
  [ "$(grep -c '<!-- END-PHASE-17-19-DEFERRAL -->' "$SKILL")" = "1" ]
}

@test "O-003 phase registry literal in fixed order" {
  grep -q 'PHASE_REGISTRY=(08 11 12 13 14 15 16)' "$SKILL"
}

@test "O-004 orchestrator block sits between phase 7 and phase 9" {
  begin_line="$(grep -n '<!-- BEGIN: phase-module orchestrator' "$SKILL" | cut -d: -f1)"
  phase_9_line="$(grep -n '^# Phase 9:' "$SKILL" | head -1 | cut -d: -f1)"
  phase_7_marker="$(grep -n '^# Phase 7:' "$SKILL" | head -1 | cut -d: -f1)"
  [ "$begin_line" -gt "$phase_7_marker" ]
  [ "$begin_line" -lt "$phase_9_line" ]
}

@test "O-005 inline phases 1-7, 9, 10 still present" {
  grep -q '^# Phase 1: Prerequisites Check' "$SKILL"
  grep -q '^# Phase 2: Plugin Installation' "$SKILL"
  grep -q '^# Phase 3: Configuration' "$SKILL"
  grep -q '^# Phase 4: Trust Level Selection' "$SKILL"
  grep -q '^# Phase 5: Cost Budget Setup' "$SKILL"
  grep -q '^# Phase 6: Daemon Installation and Start' "$SKILL"
  grep -q '^# Phase 7: First Request' "$SKILL"
  grep -q '^# Phase 9: Production Intelligence Setup' "$SKILL"
  grep -q '^# Phase 10: Verification and Next Steps' "$SKILL"
}

@test "O-006 migration banner present" {
  grep -q "AMENDMENT-002 phase modules" "$SKILL"
}

@test "O-007 deferral notice mentions homelab repo" {
  grep -q "autonomous-dev-homelab" "$SKILL"
}

@test "FF-001 config_defaults.json has phase 8 / 11 flags" {
  command -v jq
  [ "$(jq -r '.wizard.phase_08_module_enabled' "$DEFAULTS")" = "true" ]
  [ "$(jq -r '.wizard.phase_11_module_enabled' "$DEFAULTS")" = "true" ]
}

@test "FF-002 config_defaults.json validates as JSON" {
  command -v jq
  jq -e . "$DEFAULTS" >/dev/null
}

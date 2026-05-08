#!/usr/bin/env bats
# tests/setup-wizard/deferral-notice.bats
# SPEC-033-4-03 §6 deferral-notice acceptance criteria (FR-1, FR-2, FR-3, FR-20).

SKILL="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/SKILL.md"

@test "DN-001 BEGIN/END deferral anchors present exactly once at line-start" {
  # Match the anchor at the start of a line (rendered Markdown comment),
  # not the same string when it appears inside a fenced bash code block.
  [ "$(grep -cE '^<!-- BEGIN-PHASE-17-19-DEFERRAL -->$' "$SKILL")" = "1" ]
  [ "$(grep -cE '^<!-- END-PHASE-17-19-DEFERRAL -->$' "$SKILL")" = "1" ]
}

@test "DN-002 deferral block contains banner of equals signs" {
  awk '
    /<!-- BEGIN-PHASE-17-19-DEFERRAL -->/ { p=1; next }
    /<!-- END-PHASE-17-19-DEFERRAL -->/   { p=0 }
    p
  ' "$SKILL" | grep -qE '^=+$'
}

@test "DN-003 deferral block contains the title sentence verbatim" {
  awk '
    /<!-- BEGIN-PHASE-17-19-DEFERRAL -->/ { p=1; next }
    /<!-- END-PHASE-17-19-DEFERRAL -->/   { p=0 }
    p
  ' "$SKILL" | grep -qF 'Phases 17-19 are deferred to the autonomous-dev-homelab repository.'
}

@test "DN-004 deferral block enumerates the 3 deferred phases" {
  local block
  block="$(awk '
    /<!-- BEGIN-PHASE-17-19-DEFERRAL -->/ { p=1; next }
    /<!-- END-PHASE-17-19-DEFERRAL -->/   { p=0 }
    p
  ' "$SKILL")"
  echo "$block" | grep -qF 'Phase 17'
  echo "$block" | grep -qF 'Phase 18'
  echo "$block" | grep -qF 'Phase 19'
  echo "$block" | grep -qF 'auth/identity'
  echo "$block" | grep -qF 'observability'
  echo "$block" | grep -qF 'internal portal advanced provisioning'
}

@test "DN-005 deferral block links to autonomous-dev-homelab repo" {
  awk '
    /<!-- BEGIN-PHASE-17-19-DEFERRAL -->/ { p=1; next }
    /<!-- END-PHASE-17-19-DEFERRAL -->/   { p=0 }
    p
  ' "$SKILL" | grep -qF 'https://github.com/pwatsonr/autonomous-dev-homelab'
}

@test "DN-006 deferral notice sits between orchestrator and phase 9" {
  local begin end p9
  begin="$(grep -nE '^<!-- BEGIN-PHASE-17-19-DEFERRAL -->$' "$SKILL" | head -1 | cut -d: -f1)"
  end="$(grep -nE '^<!-- END-PHASE-17-19-DEFERRAL -->$' "$SKILL" | head -1 | cut -d: -f1)"
  p9="$(grep -n '^# Phase 9:' "$SKILL" | head -1 | cut -d: -f1)"
  [ "$begin" -lt "$end" ]
  [ "$end" -lt "$p9" ]
}

@test "DN-007 deferral block is NOT a phase module (no front-matter)" {
  # The deferral block must not begin with --- nor declare a `phase:` key.
  awk '
    /<!-- BEGIN-PHASE-17-19-DEFERRAL -->/ { p=1; next }
    /<!-- END-PHASE-17-19-DEFERRAL -->/   { p=0 }
    p
  ' "$SKILL" | grep -qE '^phase:[[:space:]]' && return 1
  return 0
}

@test "DN-008 emit-once flag handler is referenced in orchestrator block" {
  # Verify _wizard_emit_deferral_once helper is present (FR-20 mechanism).
  grep -q '_wizard_emit_deferral_once' "$SKILL"
  grep -q 'deferral_notice_emitted' "$SKILL"
}

@test "DN-009 emit-once persists via tmp+rename atomic write" {
  # Verify the persistence pattern in SKILL.md uses tmp+rename.
  awk '
    /_wizard_emit_deferral_once/ { p=1 }
    p && /^}$/                    { p=0; print; exit }
    p
  ' "$SKILL" | grep -qE 'mv[[:space:]]+"\$tmp"[[:space:]]+"\$state_file"'
}

#!/usr/bin/env bats
# tests/setup-wizard/phase-20-summary.bats
# SPEC-033-4-03 §6 phase-20 summary table (FR-4..FR-7) + flock NFR.

SKILL="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/SKILL.md"

setup() {
  TMPDIR_BATS="$(mktemp -d)"
  export HOME="$TMPDIR_BATS"
  mkdir -p "$HOME/.autonomous-dev"
  PLUGIN_DIR="${BATS_TEST_DIRNAME}/../.."
  export PLUGIN_DIR
}

teardown() {
  rm -rf "$TMPDIR_BATS"
}

# --- FR-4 / FR-7 anchors ----------------------------------------------------

@test "P20-001 phase-20-summary anchors present exactly once" {
  [ "$(grep -c '<!-- BEGIN-PHASE-20-SUMMARY' "$SKILL")" = "1" ]
  [ "$(grep -c '<!-- END-PHASE-20-SUMMARY -->' "$SKILL")" = "1" ]
}

@test "P20-002 summary subheading present" {
  grep -qF '### Per-phase module summary (AMENDMENT-002 phases)' "$SKILL"
}

@test "P20-003 summary sits AFTER existing inline phase 10 content" {
  # FR-7: existing content preserved, new section additive.
  local p10 begin
  p10="$(grep -n '^# Phase 10: Verification and Next Steps' "$SKILL" | head -1 | cut -d: -f1)"
  begin="$(grep -n '<!-- BEGIN-PHASE-20-SUMMARY' "$SKILL" | cut -d: -f1)"
  [ "$begin" -gt "$p10" ]
  # Existing Step 10.4 content still present BEFORE the new summary.
  local step104
  step104="$(grep -n '^## Step 10.4: Suggest first real request' "$SKILL" | head -1 | cut -d: -f1)"
  [ "$step104" -lt "$begin" ]
  [ -n "$step104" ]
}

@test "P20-004 summary table column header is 'phase | title | status | hint'" {
  awk '
    /<!-- BEGIN-PHASE-20-SUMMARY/ { p=1; next }
    /<!-- END-PHASE-20-SUMMARY/   { p=0 }
    p
  ' "$SKILL" | grep -qE 'phase[[:space:]]*\|[[:space:]]*title[[:space:]]*\|[[:space:]]*status[[:space:]]*\|[[:space:]]*hint'
}

@test "P20-005 summary iterates 7 phase numbers in order 08 11 12 13 14 15 16" {
  awk '
    /<!-- BEGIN-PHASE-20-SUMMARY/ { p=1; next }
    /<!-- END-PHASE-20-SUMMARY/   { p=0 }
    p
  ' "$SKILL" | grep -qE 'for nn in 08 11 12 13 14 15 16'
}

# --- FR-5 hint mapping ------------------------------------------------------

@test "P20-006 hint helper maps not-run -> wizard --phase NN" {
  awk '
    /_render_hint\(\)/ { p=1 }
    p && /^}$/         { p=0 }
    p
  ' "$SKILL" | grep -qF 'autonomous-dev wizard --phase'
}

@test "P20-007 hint helper maps unavailable -> feature flag message" {
  awk '
    /_render_hint\(\)/ { p=1 }
    p && /^}$/         { p=0 }
    p
  ' "$SKILL" | grep -qF 'wizard.phase_${nn}_module_enabled is false'
}

@test "P20-008 hint helper maps failed -> wizard rollback --phase NN" {
  awk '
    /_render_hint\(\)/ { p=1 }
    p && /^}$/         { p=0 }
    p
  ' "$SKILL" | grep -qF 'autonomous-dev wizard rollback --phase'
}

@test "P20-009 hint helper maps complete and skipped to empty hint" {
  awk '
    /_render_hint\(\)/ { p=1 }
    p && /^}$/         { p=0 }
    p
  ' "$SKILL" | grep -qE 'complete\|skipped\)[[:space:]]*echo[[:space:]]*""'
}

# --- FR-6 file lock ---------------------------------------------------------

@test "P20-010 phase 20 acquires flock on wizard-state.json before reading" {
  awk '
    /<!-- BEGIN-PHASE-20-SUMMARY/ { p=1; next }
    /<!-- END-PHASE-20-SUMMARY/   { p=0 }
    p
  ' "$SKILL" | grep -qE 'flock 9'
}

@test "P20-011 phase 20 releases flock after rendering" {
  awk '
    /<!-- BEGIN-PHASE-20-SUMMARY/ { p=1; next }
    /<!-- END-PHASE-20-SUMMARY/   { p=0 }
    p
  ' "$SKILL" | grep -qE 'flock -u 9'
}

# --- FR-4 status enumeration -----------------------------------------------

@test "P20-012 _render_hint maps blocked status to a hint string" {
  awk '
    /_render_hint\(\)/ { p=1 }
    p && /^}$/         { p=0 }
    p
  ' "$SKILL" | grep -qE 'blocked\)'
}

# --- live-render smoke (extracts the snippet and runs it) ------------------

@test "P20-013 extracted summary snippet renders 7 rows for an empty state" {
  echo '{}' > "$HOME/.autonomous-dev/wizard-state.json"
  # Extract the bash code block from the SUMMARY section.
  local snippet
  snippet="$(awk '
    /<!-- BEGIN-PHASE-20-SUMMARY/ { p=1; next }
    /<!-- END-PHASE-20-SUMMARY/   { p=0 }
    p && /^```bash$/              { c=1; next }
    p && /^```$/                  { c=0 }
    p && c
  ' "$SKILL")"
  [ -n "$snippet" ]
  # Run the snippet in a subshell with our HOME and PLUGIN_DIR.
  run bash -c "$snippet"
  [ "$status" -eq 0 ]
  # 7 phase rows + header + separator
  local rowcount
  rowcount="$(echo "$output" | grep -cE '^\| (08|11|12|13|14|15|16) \|')"
  [ "$rowcount" = "7" ]
}

@test "P20-014 extracted summary snippet renders status=complete for phase 8 when state says so" {
  cat > "$HOME/.autonomous-dev/wizard-state.json" <<'JSON'
{"phases":{"08":{"status":"complete"},"11":{"status":"skipped"},"13":{"status":"failed"},"14":{"status":"not-run"},"16":{"status":"unavailable"}}}
JSON
  local snippet
  snippet="$(awk '
    /<!-- BEGIN-PHASE-20-SUMMARY/ { p=1; next }
    /<!-- END-PHASE-20-SUMMARY/   { p=0 }
    p && /^```bash$/              { c=1; next }
    p && /^```$/                  { c=0 }
    p && c
  ' "$SKILL")"
  run bash -c "$snippet"
  [ "$status" -eq 0 ]
  echo "$output" | grep -qE '^\| 08 \|.*\| complete \|'
  echo "$output" | grep -qE '^\| 11 \|.*\| skipped \|'
  echo "$output" | grep -qE '^\| 13 \|.*\| failed \|.*wizard rollback --phase 13'
  echo "$output" | grep -qE '^\| 14 \|.*\| not-run \|.*wizard --phase 14'
  echo "$output" | grep -qE '^\| 16 \|.*\| unavailable \|.*wizard.phase_16_module_enabled'
}

@test "P20-015 hint column for complete and skipped is empty" {
  cat > "$HOME/.autonomous-dev/wizard-state.json" <<'JSON'
{"phases":{"08":{"status":"complete"},"11":{"status":"skipped"}}}
JSON
  local snippet
  snippet="$(awk '
    /<!-- BEGIN-PHASE-20-SUMMARY/ { p=1; next }
    /<!-- END-PHASE-20-SUMMARY/   { p=0 }
    p && /^```bash$/              { c=1; next }
    p && /^```$/                  { c=0 }
    p && c
  ' "$SKILL")"
  run bash -c "$snippet"
  [ "$status" -eq 0 ]
  # Phase 08 row: hint column should be empty (just whitespace before final |)
  echo "$output" | grep -qE '^\| 08 \| [^|]+ \| complete \|  \|$'
  echo "$output" | grep -qE '^\| 11 \| [^|]+ \| skipped \|  \|$'
}

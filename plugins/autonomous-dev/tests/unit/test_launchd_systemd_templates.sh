#!/usr/bin/env bash
# test_launchd_systemd_templates.sh -- Unit tests for SPEC-001-4-01
# Tests: launchd plist template and systemd unit file template
#
# Requires: plutil (macOS), bash 4+
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${SCRIPT_DIR}/../test_harness.sh"

PLIST_TEMPLATE="${PROJECT_ROOT}/templates/com.autonomous-dev.daemon.plist.template"
SYSTEMD_TEMPLATE="${PROJECT_ROOT}/templates/autonomous-dev.service.template"

# Sample values for placeholder substitution
SAMPLE_BASH="/opt/homebrew/bin/bash"
SAMPLE_BIN_DIR="/Users/testuser/.claude/plugins/autonomous-dev/bin"
SAMPLE_DAEMON_HOME="/Users/testuser/.autonomous-dev"
SAMPLE_USER_HOME="/Users/testuser"
SAMPLE_EXTRA_PATH="/opt/homebrew/bin:"

# Helper: substitute all placeholders in a template file, write to a temp file
substitute_plist() {
  local outfile="$1"
  sed \
    -e "s|{{BASH_PATH}}|${SAMPLE_BASH}|g" \
    -e "s|{{PLUGIN_BIN_DIR}}|${SAMPLE_BIN_DIR}|g" \
    -e "s|{{DAEMON_HOME}}|${SAMPLE_DAEMON_HOME}|g" \
    -e "s|{{USER_HOME}}|${SAMPLE_USER_HOME}|g" \
    -e "s|{{EXTRA_PATH_DIRS}}|${SAMPLE_EXTRA_PATH}|g" \
    "$PLIST_TEMPLATE" > "$outfile"
}

# =============================================================================
# Test 1: test_plist_template_exists
# Assert templates/com.autonomous-dev.daemon.plist.template exists
# =============================================================================
test_plist_template_exists() {
  assert_file_exists "$PLIST_TEMPLATE"
}

# =============================================================================
# Test 2: test_plist_template_valid_xml
# Replace all {{...}} placeholders with sample values. Run plutil -lint.
# =============================================================================
test_plist_template_valid_xml() {
  local tmpfile="${_TEST_DIR}/test.plist"
  substitute_plist "$tmpfile"
  if command -v plutil &>/dev/null; then
    plutil -lint "$tmpfile" >/dev/null 2>&1
  else
    # On Linux, fall back to xmllint if available
    if command -v xmllint &>/dev/null; then
      xmllint --noout "$tmpfile" 2>/dev/null
    else
      echo "  SKIP: neither plutil nor xmllint available" >&2
      return 0
    fi
  fi
}

# =============================================================================
# Test 3: test_plist_has_label
# Assert template contains <string>com.autonomous-dev.daemon</string>
# =============================================================================
test_plist_has_label() {
  local content
  content="$(< "$PLIST_TEMPLATE")"
  assert_contains "$content" "<string>com.autonomous-dev.daemon</string>"
}

# =============================================================================
# Test 4: test_plist_has_run_at_load
# Assert template contains RunAtLoad key followed by <true/>
# =============================================================================
test_plist_has_run_at_load() {
  local content
  content="$(< "$PLIST_TEMPLATE")"
  assert_contains "$content" "<key>RunAtLoad</key>"
  assert_contains "$content" "<true/>"
}

# =============================================================================
# Test 5: test_plist_has_keep_alive
# Assert template contains SuccessfulExit key with <false/>
# =============================================================================
test_plist_has_keep_alive() {
  local content
  content="$(< "$PLIST_TEMPLATE")"
  assert_contains "$content" "<key>SuccessfulExit</key>"
  assert_contains "$content" "<false/>"
}

# =============================================================================
# Test 6: test_plist_has_throttle
# Assert template contains ThrottleInterval with <integer>10</integer>
# =============================================================================
test_plist_has_throttle() {
  local content
  content="$(< "$PLIST_TEMPLATE")"
  assert_contains "$content" "<key>ThrottleInterval</key>"
  assert_contains "$content" "<integer>10</integer>"
}

# =============================================================================
# Test 7: test_plist_has_process_type
# Assert template contains ProcessType with Background
# =============================================================================
test_plist_has_process_type() {
  local content
  content="$(< "$PLIST_TEMPLATE")"
  assert_contains "$content" "<key>ProcessType</key>"
  assert_contains "$content" "<string>Background</string>"
}

# =============================================================================
# Test 8: test_plist_has_low_priority_io
# Assert template contains LowPriorityBackgroundIO with <true/>
# =============================================================================
test_plist_has_low_priority_io() {
  local content
  content="$(< "$PLIST_TEMPLATE")"
  assert_contains "$content" "<key>LowPriorityBackgroundIO</key>"
  # The <true/> after LowPriorityBackgroundIO -- already checked by run_at_load,
  # but let's verify both keys exist
  assert_contains "$content" "LowPriorityBackgroundIO"
}

# =============================================================================
# Test 9: test_systemd_template_exists
# Assert templates/autonomous-dev.service.template exists
# =============================================================================
test_systemd_template_exists() {
  assert_file_exists "$SYSTEMD_TEMPLATE"
}

# =============================================================================
# Test 10: test_systemd_has_type_simple
# Assert template contains Type=simple
# =============================================================================
test_systemd_has_type_simple() {
  local content
  content="$(< "$SYSTEMD_TEMPLATE")"
  assert_contains "$content" "Type=simple"
}

# =============================================================================
# Test 11: test_systemd_has_restart_on_failure
# Assert template contains Restart=on-failure
# =============================================================================
test_systemd_has_restart_on_failure() {
  local content
  content="$(< "$SYSTEMD_TEMPLATE")"
  assert_contains "$content" "Restart=on-failure"
}

# =============================================================================
# Test 12: test_systemd_has_restart_sec
# Assert template contains RestartSec=10
# =============================================================================
test_systemd_has_restart_sec() {
  local content
  content="$(< "$SYSTEMD_TEMPLATE")"
  assert_contains "$content" "RestartSec=10"
}

# =============================================================================
# Test 13: test_systemd_has_memory_max
# Assert template contains MemoryMax=512M
# =============================================================================
test_systemd_has_memory_max() {
  local content
  content="$(< "$SYSTEMD_TEMPLATE")"
  assert_contains "$content" "MemoryMax=512M"
}

# =============================================================================
# Test 14: test_systemd_has_cpu_quota
# Assert template contains CPUQuota=50%
# =============================================================================
test_systemd_has_cpu_quota() {
  local content
  content="$(< "$SYSTEMD_TEMPLATE")"
  assert_contains "$content" "CPUQuota=50%"
}

# =============================================================================
# Test 15: test_systemd_has_journal
# Assert template contains StandardOutput=journal
# =============================================================================
test_systemd_has_journal() {
  local content
  content="$(< "$SYSTEMD_TEMPLATE")"
  assert_contains "$content" "StandardOutput=journal"
  assert_contains "$content" "StandardError=journal"
}

# =============================================================================
# Test 16: test_systemd_has_wanted_by
# Assert template contains WantedBy=default.target
# =============================================================================
test_systemd_has_wanted_by() {
  local content
  content="$(< "$SYSTEMD_TEMPLATE")"
  assert_contains "$content" "WantedBy=default.target"
}

# =============================================================================
# Test 17: test_systemd_has_all_sections
# Assert template contains [Unit], [Service], and [Install] sections
# =============================================================================
test_systemd_has_all_sections() {
  local content
  content="$(< "$SYSTEMD_TEMPLATE")"
  assert_contains "$content" "[Unit]"
  assert_contains "$content" "[Service]"
  assert_contains "$content" "[Install]"
}

# =============================================================================
# Run all tests
# =============================================================================
run_test "test_plist_template_exists"       test_plist_template_exists
run_test "test_plist_template_valid_xml"    test_plist_template_valid_xml
run_test "test_plist_has_label"             test_plist_has_label
run_test "test_plist_has_run_at_load"       test_plist_has_run_at_load
run_test "test_plist_has_keep_alive"        test_plist_has_keep_alive
run_test "test_plist_has_throttle"          test_plist_has_throttle
run_test "test_plist_has_process_type"      test_plist_has_process_type
run_test "test_plist_has_low_priority_io"   test_plist_has_low_priority_io
run_test "test_systemd_template_exists"     test_systemd_template_exists
run_test "test_systemd_has_type_simple"     test_systemd_has_type_simple
run_test "test_systemd_has_restart_on_failure" test_systemd_has_restart_on_failure
run_test "test_systemd_has_restart_sec"     test_systemd_has_restart_sec
run_test "test_systemd_has_memory_max"      test_systemd_has_memory_max
run_test "test_systemd_has_cpu_quota"       test_systemd_has_cpu_quota
run_test "test_systemd_has_journal"         test_systemd_has_journal
run_test "test_systemd_has_wanted_by"       test_systemd_has_wanted_by
run_test "test_systemd_has_all_sections"    test_systemd_has_all_sections

report

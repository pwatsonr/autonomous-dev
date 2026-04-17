#!/usr/bin/env bash
# test_harness.sh -- Shared test utilities sourced by all test scripts
# Part of TDD-002: State Machine & Request Lifecycle
set -euo pipefail

_TESTS_RUN=0
_TESTS_PASSED=0
_TESTS_FAILED=0
_TEST_DIR=""

setup() {
  _TEST_DIR="$(mktemp -d)"
  chmod 0700 "$_TEST_DIR"
}

teardown() {
  [[ -n "$_TEST_DIR" && -d "$_TEST_DIR" ]] && rm -rf "$_TEST_DIR"
}

assert_eq() {
  local expected="$1" actual="$2" msg="${3:-}"
  if [[ "$expected" == "$actual" ]]; then return 0; fi
  echo "  ASSERT_EQ FAILED: expected='${expected}' actual='${actual}' ${msg}" >&2
  return 1
}

assert_contains() {
  local haystack="$1" needle="$2" msg="${3:-}"
  if [[ "$haystack" == *"$needle"* ]]; then return 0; fi
  echo "  ASSERT_CONTAINS FAILED: '${needle}' not found in output ${msg}" >&2
  return 1
}

assert_file_exists() {
  local path="$1"
  if [[ -f "$path" ]]; then return 0; fi
  echo "  ASSERT_FILE_EXISTS FAILED: ${path}" >&2
  return 1
}

assert_dir_exists() {
  local path="$1"
  if [[ -d "$path" ]]; then return 0; fi
  echo "  ASSERT_DIR_EXISTS FAILED: ${path}" >&2
  return 1
}

assert_file_not_exists() {
  local path="$1"
  if [[ ! -f "$path" ]]; then return 0; fi
  echo "  ASSERT_FILE_NOT_EXISTS FAILED: ${path} exists" >&2
  return 1
}

assert_dir_not_exists() {
  local path="$1"
  if [[ ! -d "$path" ]]; then return 0; fi
  echo "  ASSERT_DIR_NOT_EXISTS FAILED: ${path} exists" >&2
  return 1
}

assert_permissions() {
  local path="$1" expected="$2"
  local actual
  if [[ "$(uname)" == "Darwin" ]]; then
    actual="$(stat -f '%Lp' "$path" 2>/dev/null)" || true
  else
    actual="$(stat -c '%a' "$path" 2>/dev/null)" || true
  fi
  if [[ "$actual" == "$expected" ]]; then return 0; fi
  echo "  ASSERT_PERMISSIONS FAILED: ${path} has ${actual}, expected ${expected}" >&2
  return 1
}

assert_exit_code() {
  local expected="$1"
  shift
  local actual_exit=0
  "$@" > /dev/null 2>&1 || actual_exit=$?
  if [[ "$actual_exit" -eq "$expected" ]]; then
    return 0
  else
    echo "  ASSERT_EXIT_CODE FAILED: expected exit ${expected}, got ${actual_exit}" >&2
    return 1
  fi
}

run_test() {
  local test_name="$1"
  local test_func="$2"
  (( _TESTS_RUN++ )) || true
  setup
  # Run test in subshell so set -e in the test function
  # doesn't kill the harness when testing error paths
  local _rc=0
  ( set +e; "$test_func" ) || _rc=$?
  if [[ $_rc -eq 0 ]]; then
    echo "PASS: ${test_name}"
    (( _TESTS_PASSED++ )) || true
  else
    echo "FAIL: ${test_name}"
    (( _TESTS_FAILED++ )) || true
  fi
  teardown
}

report() {
  echo ""
  echo "Results: ${_TESTS_PASSED}/${_TESTS_RUN} passed, ${_TESTS_FAILED} failed"
  [[ $_TESTS_FAILED -gt 0 ]] && exit 1
  exit 0
}

#!/usr/bin/env bats

# tests/ci/test_plugin_schema.bats
# Validates `.github/schemas/plugin.schema.json` against curated fixtures.
# Each fixture has a deterministic expected exit code from the validator
# script at `.github/schemas/validate-plugin.mjs`.
#
# Local pre-flight check for SPEC-016-3-01..04. Mirrors the validator
# invocation used by the CI fallback step in `.github/workflows/ci.yml`
# so local and CI behavior cannot drift.
#
# Deviation from SPEC-016-3-04: the spec references `npx --yes ajv-cli@8`
# directly. ajv-cli@8 is not published to npm (latest is 5.0.0), and
# ajv-cli@5 lacks `--spec=draft2020` and does not auto-register the
# `email`/`uri` formats used by the schema. To preserve the spec's
# intent (validate manifests against the vendored Draft 2020-12 schema
# from a reproducible CLI invocation), we wrap Ajv 8 + the 2020-12
# vocabulary in `.github/schemas/validate-plugin.mjs` and invoke that.

setup_file() {
  REPO_ROOT="$(git rev-parse --show-toplevel)"
  export REPO_ROOT
  # Install Ajv + ajv-formats into a per-checkout cache directory so the
  # bats suite is self-contained and does not mutate the source tree.
  CACHE_DIR="${TMPDIR:-/tmp}/autonomous-dev-ajv-cache"
  export CACHE_DIR
  if [ ! -d "${CACHE_DIR}/node_modules/ajv" ] || [ ! -d "${CACHE_DIR}/node_modules/ajv-formats" ]; then
    mkdir -p "${CACHE_DIR}"
    (cd "${CACHE_DIR}" && npm init -y >/dev/null 2>&1 && \
      npm install --no-audit --no-fund --silent ajv@8 ajv-formats@2 >/dev/null 2>&1)
  fi
}

setup() {
  REPO_ROOT="$(git rev-parse --show-toplevel)"
  SCHEMA="${REPO_ROOT}/.github/schemas/plugin.schema.json"
  VALIDATOR="${REPO_ROOT}/.github/schemas/validate-plugin.mjs"
  FIXTURES="${REPO_ROOT}/tests/fixtures/plugins"
  CACHE_DIR="${TMPDIR:-/tmp}/autonomous-dev-ajv-cache"
}

# Helper: run the validator from inside the ajv cache directory so that
# Node's CommonJS resolver (used by the validator's createRequire) finds
# ajv and ajv-formats in the cache's node_modules.
run_validator() {
  cd "${CACHE_DIR}" && node "${VALIDATOR}" "$@"
}

@test "schema file exists" {
  [ -f "${SCHEMA}" ]
}

@test "validator script exists and is executable" {
  [ -x "${VALIDATOR}" ]
}

@test "valid.json passes validator" {
  run run_validator "${FIXTURES}/valid.json"
  [ "$status" -eq 0 ]
}

@test "missing-required.json fails validator with required error" {
  run run_validator "${FIXTURES}/missing-required.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"required"* ]]
}

@test "extra-field.json fails validator with additionalProperties error" {
  run run_validator "${FIXTURES}/extra-field.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"additionalProperties"* || "$output" == *"additional properties"* ]]
}

@test "bad-version.json fails validator with pattern error" {
  run run_validator "${FIXTURES}/bad-version.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"pattern"* ]]
}

@test "real autonomous-dev manifest passes validator" {
  run run_validator "${REPO_ROOT}/plugins/autonomous-dev/.claude-plugin/plugin.json"
  [ "$status" -eq 0 ]
}

@test "real autonomous-dev-assist manifest passes validator" {
  run run_validator "${REPO_ROOT}/plugins/autonomous-dev-assist/.claude-plugin/plugin.json"
  [ "$status" -eq 0 ]
}

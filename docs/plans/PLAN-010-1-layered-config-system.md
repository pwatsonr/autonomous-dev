# PLAN-010-1: Layered Configuration System & Validation

## Metadata
- **Parent TDD**: TDD-010-config-governance
- **Estimated effort**: 5 days
- **Dependencies**: None (foundational -- all other PLAN-010-* plans depend on this)
- **Blocked by**: None
- **Priority**: P0

## Objective

Implement the layered configuration loading, deep-merge, CLI override parsing, schema validation, and hot-reload mechanism described in TDD-010 Sections 3.1 and 3.2. This plan delivers the `ConfigLoader` component, the `config_defaults.json` file containing the complete schema from Section 4.1, the full 20-rule validation pipeline, and the `autonomous-dev config` CLI subcommands. Every other governance component reads configuration through the interface built here.

## Scope

### In Scope
- `config_defaults.json` containing all fields and defaults from TDD-010 Section 4.1
- `config_loader.sh` implementing four-layer precedence: CLI > project > global > defaults
- Deep-merge using `jq` `*` operator with array-replace semantics
- CLI override parsing via dot-notation (`--config.key.subkey=value`)
- Validation pipeline: JSON parse, schema type/range checks, cross-field rules (V-001 through V-020), path validation, security permission checks
- Validation severity handling (Error = refuse to start, Warning = log and continue)
- Structured validation error output to stderr and `~/.autonomous-dev/logs/config-validation.log`
- Immutable field enforcement (`trust.promotion.require_human_approval`, `emergency.restart_requires_human`)
- `autonomous-dev config init --global` and `--project` commands
- `autonomous-dev config show` with source annotations and webhook URL redaction
- `autonomous-dev config validate` command for on-demand validation
- Hot-reload behavior: config re-read at each supervisor-loop iteration start
- Unit tests for merge, parse, validation, and CLI override logic
- Test fixtures: `config-valid-full.json`, `config-valid-minimal.json`, `config-invalid-*.json` (one per rule)

### Out of Scope
- Cost tracking and budget enforcement (PLAN-010-2)
- Resource monitoring, disk checks, rate-limit backoff (PLAN-010-3)
- Cleanup engine and retention policies (PLAN-010-4)
- Plugin hook wiring (deferred to the plans that own each hook's logic)
- Repository override merging at the per-repo precedence layer (repo overrides are parsed here but enforcement at session spawn is in PLAN-010-3)

## Tasks

1. **Create `config_defaults.json`** -- Transcribe the complete configuration schema from TDD-010 Section 4.1 into a concrete JSON file with all default values populated. This is the built-in defaults layer (lowest precedence).
   - Files to create: `config_defaults.json` (plugin root)
   - Acceptance criteria: Every field from Section 4.1 is present with its documented default. The file passes `jq .` without error. No field is omitted.
   - Estimated effort: 4 hours

2. **Implement `config_loader.sh` -- layer reading and deep merge** -- Read global config (`~/.claude/autonomous-dev.json`), project config (`{repo}/.claude/autonomous-dev.json`), and defaults. Apply the `jq` `*` recursive merge with array-replace semantics. Return the merged JSON object.
   - Files to create: `lib/config_loader.sh`
   - Acceptance criteria: Four-layer merge produces correct output when layers are present, absent, or empty. Array fields from higher-precedence layers fully replace lower-precedence arrays. Missing layers are silently skipped with a log warning.
   - Estimated effort: 6 hours

3. **Implement CLI override parsing** -- Parse `--config.dotted.path=value` arguments into nested JSON objects using `jq`. Auto-detect value types: numbers, booleans (`true`/`false`), strings. Merge CLI overrides as the highest-precedence layer.
   - Files to modify: `lib/config_loader.sh`
   - Acceptance criteria: `--config.governance.daily_cost_cap_usd=50` produces `{"governance":{"daily_cost_cap_usd":50}}` (number, not string). Boolean and string values handled correctly. Multiple CLI overrides merge correctly.
   - Estimated effort: 3 hours

4. **Implement validation pipeline** -- Build the five-step validation pipeline: (1) JSON parse check, (2) schema type/range validation for all fields, (3) cross-field rules (V-003, V-004, V-019, V-020), (4) path existence checks for allowlist entries, (5) security permission checks for config files containing webhook URLs.
   - Files to create: `lib/config_validator.sh`
   - Acceptance criteria: All 20 validation rules (V-001 through V-020) are implemented. Each Error-severity violation causes the function to return non-zero. Warning-severity violations are logged but do not block. Immutable fields (`require_human_approval`, `restart_requires_human`) reject `false` values.
   - Estimated effort: 8 hours

5. **Implement structured validation error output** -- Validation errors are written as JSON objects (matching Section 4.4 schema) to both stderr and `~/.autonomous-dev/logs/config-validation.log`. All errors are reported (not just the first).
   - Files to modify: `lib/config_validator.sh`
   - Acceptance criteria: Each error includes timestamp, level, rule ID, field path, invalid value, constraint description, source file path, and human-readable message. Log file is created if it does not exist. Log file is appended, not overwritten.
   - Estimated effort: 2 hours

6. **Implement `autonomous-dev config init`** -- Generate a default configuration file at the global or project path. Include a companion `.commented` file with field documentation. Do not overwrite existing files without `--force`.
   - Files to create: `commands/config_init.sh`
   - Acceptance criteria: `--global` writes to `~/.claude/autonomous-dev.json`. `--project` writes to `.claude/autonomous-dev.json` in the current repo root. Existing file is not overwritten unless `--force` is passed. Companion `.commented` file includes description of each field.
   - Estimated effort: 3 hours

7. **Implement `autonomous-dev config show`** -- Display the effective (merged) configuration with source annotations showing which layer each value came from. Redact webhook URLs to show only the domain.
   - Files to create: `commands/config_show.sh`
   - Acceptance criteria: Output shows the complete effective config. Each field is annotated with its source (default, global, project, cli). Webhook URLs display `https://hooks.slack.com/***` style redaction. Output is valid JSON (annotations in a parallel structure or as comments).
   - Estimated effort: 3 hours

8. **Implement `autonomous-dev config validate`** -- Run the validation pipeline on-demand against the current effective config and print results.
   - Files to create: `commands/config_validate.sh`
   - Acceptance criteria: Exits 0 if validation passes (no errors). Exits 1 if any Error-severity rule fails. Prints all errors and warnings to stdout in a human-readable format. Works without the daemon running.
   - Estimated effort: 2 hours

9. **Unit tests for config loading and merge** -- Test deep-merge with overlapping keys, missing layers, empty objects, array replacement, and nested structures. Test CLI override parsing for numbers, booleans, strings, and deeply nested paths.
   - Files to create: `test/unit/test_config_loader.sh`
   - Acceptance criteria: Tests cover: merge of two objects with overlapping keys, array replacement (not concatenation), three-layer merge, CLI override type detection, defaults-only load, missing global file, missing project file.
   - Estimated effort: 4 hours

10. **Unit tests for validation rules** -- One positive test (valid value passes) and one negative test (invalid value produces expected error) per rule (V-001 through V-020). Test immutable field enforcement. Test cross-field validation.
    - Files to create: `test/unit/test_config_validator.sh`
    - Acceptance criteria: 40+ test cases (2 per rule minimum). Each test is independent. Test runner reports pass/fail per case. All 20 rules are covered.
    - Estimated effort: 5 hours

11. **Create test fixtures** -- Build the fixture files specified in TDD-010 Section 7.4 that are relevant to configuration.
    - Files to create: `test/fixtures/config-valid-full.json`, `test/fixtures/config-valid-minimal.json`, `test/fixtures/config-invalid-v001.json` through `config-invalid-v020.json`
    - Acceptance criteria: `config-valid-full.json` sets every field to a non-default but valid value. `config-valid-minimal.json` is `{}`. Each `config-invalid-*` file contains exactly one invalid field targeting the named rule.
    - Estimated effort: 3 hours

12. **Integration test: full config load with all layers** -- End-to-end test that creates global, project, and CLI layers, loads them, validates the merged result, and confirms precedence is correct.
    - Files to create: `test/integration/test_config_integration.sh`
    - Acceptance criteria: Test creates temporary global and project config files with known values. Invokes config_loader with CLI overrides. Asserts the merged output matches expected values at every layer. Cleans up temp files.
    - Estimated effort: 3 hours

## Dependencies & Integration Points

- **Downstream consumers**: Every other PLAN-010-* plan calls `config_loader.sh` to obtain the effective configuration. The interface is: `source lib/config_loader.sh; load_config [--config.key=value ...]` returning the merged JSON on stdout or in a variable.
- **Supervisor loop**: The supervisor loop (from TDD-001) will call `config_loader.load()` at the start of each iteration. This plan provides the function; the supervisor loop integration is in TDD-001's implementation.
- **Plugin hooks**: The `SessionStart` hook will invoke config validation. The hook wiring itself is done by whichever plan implements hook integration, but the validation function is provided here.
- **`jq` dependency**: All merge and validation logic depends on `jq` being available. The config loader should verify `jq` is installed before proceeding.

## Testing Strategy

- **Unit tests**: Pure-function tests for `merge_configs()`, `parse_cli_override()`, and each validation rule. These use no external state -- they take JSON input and assert JSON output or exit codes.
- **Integration tests**: Full layer-load test with filesystem-backed config files in a temp directory. Verifies precedence, hot-reload (modify file between two loads), and error handling for missing/corrupt files.
- **Property-based tests**: Deep-merge associativity (per TDD-010 Section 7.3). Validation catches all out-of-range values for every numeric field. Defaults-only load produces zero validation errors.
- **Manual smoke test**: Run `autonomous-dev config init --global`, edit a field, run `autonomous-dev config validate`, confirm error reporting.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `jq` `*` operator handles `null` values by removing keys, which could surprise operators (TDD-010 OQ-5) | Medium | Medium | Document this behavior. Add a validation warning when `null` values appear in config files. Consider pre-filtering nulls. |
| Large config schema (100+ fields) makes test fixture maintenance burdensome | Medium | Low | Generate fixture files programmatically from the schema where possible. |
| CLI override parsing cannot distinguish between string `"50"` and number `50` for all cases | Low | Low | Use `jq`'s `try tonumber` approach as specified in TDD. Document edge cases. |
| Config file permissions check is OS-specific (Linux vs macOS `stat` flags differ) | Medium | Low | Use portable `stat` invocation or `ls -l` parsing for permission checks. |

## Definition of Done

- [ ] `config_defaults.json` contains all fields from TDD-010 Section 4.1 with correct defaults
- [ ] `config_loader.sh` implements four-layer merge with correct precedence
- [ ] CLI override parsing handles numbers, booleans, and strings correctly
- [ ] All 20 validation rules (V-001 through V-020) are implemented and tested
- [ ] Immutable fields reject `false` values
- [ ] Validation errors are structured JSON written to both stderr and log file
- [ ] `autonomous-dev config init` creates global and project config files
- [ ] `autonomous-dev config show` displays effective config with source annotations and redacted webhooks
- [ ] `autonomous-dev config validate` runs on-demand validation
- [ ] Unit tests pass for all merge, parse, and validation logic (40+ test cases for validation alone)
- [ ] Integration test confirms correct layer precedence end-to-end
- [ ] Test fixtures created for all validation rules
- [ ] Defaults-only config passes full validation with zero errors

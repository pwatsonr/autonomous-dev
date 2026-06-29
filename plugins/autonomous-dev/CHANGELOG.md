# Changelog

All notable changes to the autonomous-dev plugin are documented here.

## [Unreleased] — REQ-000050 (2026-06-29)

### Fixed

- **#615 — Configurable reviewer timeouts**: Replaced the hardcoded `REVIEWER_TIMEOUT_MS = 300_000` (5 min) constant with a per-reviewer/per-gate configurable timeout resolved via a four-level precedence chain: `entry.timeout_ms` → `gate_defaults[gate].timeout_ms` → `defaults.timeout_ms` → `REVIEWER_TIMEOUT_MS` env var → built-in default 900_000 (15 min). For `code_review` and `spec_review` gates the bundled defaults now use 1_200_000 ms (20 min). A timed-out built-in reviewer now counts toward the escalation cap so a single-reviewer gate (e.g., `spec_review`) cannot loop forever.

- **#618 — Tolerant verdict parser**: `extractJsonVerdict` replaced by `parseReviewerOutput` which accepts four output shapes in precedence order: (1) verdict-JSON `{score, verdict, findings}`, (2) phase-result envelope `{status, phase, feedback?, findings?}`, (3) markdown-fenced JSON, (4) `VERDICT: APPROVE|REQUEST_CHANGES|BLOCK` marker line. Envelope outputs are normalised to `{score, verdict}` via `normaliseVerdict`. Parse failures now capture raw stdout (truncated to 8192 chars) in `ReviewerResult.raw_output` for debugging.

### Added

- `ReviewerTimeoutError` — thrown when subprocess exits with code 124; carries `reviewer_name` and `timeout_ms`.
- `ReviewerParseError` — thrown on parse failure; carries `reviewer_name`, `reason`, and `raw_output`.
- `parseReviewerOutput(stdout)` — pure exported parser function; four strategies in precedence order.
- `resolveReviewerTimeoutMs(entry, envValue?)` — pure timeout resolver clamped to `[30_000, 3_600_000]`.
- `ChainDefaults`, `GateDefaults` types in `types.ts`.
- `timeout_ms` field on `ReviewerEntry` and `ReviewerResult`.
- `gate_defaults` and `defaults` keys in chain config schema (`reviewer-chains-v1.json`).
- Bundled `config_defaults/reviewer-chains.json` updated with `defaults.timeout_ms: 900000` and `gate_defaults.{code_review,spec_review}.timeout_ms: 1200000` for all five request types.
- Telemetry events: `reviewer.timeout`, `reviewer.parse_failure`, `reviewer.timeout_clamped`.
- Refined aggregator reason strings for single-blocking-built-in timeout/parse-error paths.

### PR notes

- **`additionalProperties` prior state**: the schema previously had `additionalProperties: false` at both the top level and inside `RequestType`. The top-level now also allows the new `defaults` key. Inside `RequestType`, the patternProperties pattern was tightened to `^(?!gate_defaults$)[a-z_]+$` (negative lookahead, supported by Ajv 8+) so `gate_defaults` is handled by an explicit `properties` entry rather than falling through to the array-item schema.
- **Shell consumer grep**: grepped `bin/` and `lib/` for `"no built-in reviewer completed"` — no shell consumers found; the string is only matched/tested in TypeScript code.
- **Schema validation**: `config_defaults/reviewer-chains.json` validates against `schemas/reviewer-chains-v1.json` using Ajv 2020 (verified inline).

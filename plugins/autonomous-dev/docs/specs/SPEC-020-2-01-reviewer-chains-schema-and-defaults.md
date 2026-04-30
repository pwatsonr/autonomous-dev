# SPEC-020-2-01: Reviewer-Chains v1 Schema + Default Chain Config

## Metadata
- **Parent Plan**: PLAN-020-2
- **Tasks Covered**: Task 1 (author `reviewer-chains-v1.json` schema), Task 2 (ship default chain config)
- **Estimated effort**: 4 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-020-2-01-reviewer-chains-schema-and-defaults.md`

## Description
Land the declarative foundation for the reviewer-suite wiring: a JSON Schema (`reviewer-chains-v1.json`) describing the per-request-type / per-gate / per-reviewer chain structure from TDD-020 §6, and a default `reviewer-chains.json` config shipped with the plugin so any repo without its own override gets the canonical chain. This spec is purely declarative — no TypeScript, no runtime code, no CLI. Subsequent specs (SPEC-020-2-02 through -05) consume these artifacts.

The schema enumerates allowed `type` values (`built-in`, `specialist`), allowed `trigger` values (currently `frontend` only), bounds the `threshold` to `[0, 100]`, and requires `name`/`type`/`blocking`/`threshold` on every reviewer entry. The default config covers all five request types (`feature`, `bug`, `infra`, `refactor`, `hotfix`) with the chain structure mandated by TDD-020 §6, including the special cases: `feature` has the full 6-reviewer chain, `infra` raises `security-reviewer` threshold to 95, `hotfix` ships built-ins only.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/schemas/reviewer-chains-v1.json` | Create | JSON Schema (Draft 2020-12) for chain config files |
| `plugins/autonomous-dev/config_defaults/reviewer-chains.json` | Create | Canonical default chain for all 5 request types |
| `plugins/autonomous-dev/schemas/examples/reviewer-chains-feature.json` | Create | Worked example referenced by the schema's `examples` field |

## Implementation Details

### Schema (`reviewer-chains-v1.json`)

The schema is JSON Schema Draft 2020-12. Top-level structure:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://autonomous-dev/schemas/reviewer-chains-v1.json",
  "title": "Reviewer Chains v1",
  "type": "object",
  "required": ["version", "request_types"],
  "properties": {
    "version": { "const": 1 },
    "request_types": {
      "type": "object",
      "patternProperties": {
        "^(feature|bug|infra|refactor|hotfix)$": { "$ref": "#/$defs/RequestType" }
      },
      "additionalProperties": false
    }
  },
  "$defs": {
    "RequestType": {
      "type": "object",
      "patternProperties": {
        "^[a-z_]+$": {
          "type": "array",
          "items": { "$ref": "#/$defs/ReviewerEntry" }
        }
      }
    },
    "ReviewerEntry": {
      "type": "object",
      "required": ["name", "type", "blocking", "threshold"],
      "properties": {
        "name": { "type": "string", "minLength": 1 },
        "type": { "enum": ["built-in", "specialist"] },
        "blocking": { "type": "boolean" },
        "threshold": { "type": "integer", "minimum": 0, "maximum": 100 },
        "trigger": { "enum": ["frontend"] },
        "enabled": { "type": "boolean", "default": true }
      },
      "additionalProperties": false
    }
  }
}
```

Notes:
- `version: 1` is a literal; future schema revisions bump the file name.
- `request_types` keys are bounded to the five canonical types via `patternProperties` (validators reject unknown types).
- Per-gate keys (`code_review`, `pre_merge`, etc.) inside a request type are open (`^[a-z_]+$`) so future gates do not require a schema change.
- `trigger` enum currently has one value (`frontend`); leaving it as an enum (not a free string) ensures typos fail validation.

### Default Config (`reviewer-chains.json`)

Structure mandated by TDD-020 §6. Skeleton:

```json
{
  "version": 1,
  "request_types": {
    "feature": {
      "code_review": [
        { "name": "code-reviewer",            "type": "built-in",   "blocking": true,  "threshold": 80 },
        { "name": "security-reviewer",        "type": "built-in",   "blocking": true,  "threshold": 85 },
        { "name": "qa-edge-case-reviewer",    "type": "specialist", "blocking": true,  "threshold": 80 },
        { "name": "ux-ui-reviewer",           "type": "specialist", "blocking": false, "threshold": 75, "trigger": "frontend" },
        { "name": "accessibility-reviewer",   "type": "specialist", "blocking": false, "threshold": 75, "trigger": "frontend" },
        { "name": "rule-set-enforcement-reviewer", "type": "specialist", "blocking": true, "threshold": 90 }
      ]
    },
    "bug": {
      "code_review": [
        { "name": "code-reviewer",         "type": "built-in",   "blocking": true,  "threshold": 80 },
        { "name": "qa-edge-case-reviewer", "type": "specialist", "blocking": true,  "threshold": 85 },
        { "name": "rule-set-enforcement-reviewer", "type": "specialist", "blocking": true, "threshold": 90 }
      ]
    },
    "infra": {
      "code_review": [
        { "name": "code-reviewer",         "type": "built-in",   "blocking": true, "threshold": 80 },
        { "name": "security-reviewer",     "type": "built-in",   "blocking": true, "threshold": 95 },
        { "name": "rule-set-enforcement-reviewer", "type": "specialist", "blocking": true, "threshold": 90 }
      ]
    },
    "refactor": {
      "code_review": [
        { "name": "code-reviewer",         "type": "built-in",   "blocking": true, "threshold": 85 },
        { "name": "qa-edge-case-reviewer", "type": "specialist", "blocking": false, "threshold": 75 },
        { "name": "rule-set-enforcement-reviewer", "type": "specialist", "blocking": true, "threshold": 90 }
      ]
    },
    "hotfix": {
      "code_review": [
        { "name": "code-reviewer",     "type": "built-in", "blocking": true, "threshold": 75 },
        { "name": "security-reviewer", "type": "built-in", "blocking": true, "threshold": 80 }
      ]
    }
  }
}
```

### Worked Example File

`schemas/examples/reviewer-chains-feature.json` is a minimal valid file containing only the `feature.code_review` chain. The schema references it via the top-level `examples` array.

## Acceptance Criteria

- [ ] `plugins/autonomous-dev/schemas/reviewer-chains-v1.json` exists, parses with `jq -e .` exit 0, and declares `$schema` of `https://json-schema.org/draft/2020-12/schema`.
- [ ] Schema validates the TDD-020 §6 example (the worked example file) with zero errors.
- [ ] Schema rejects a reviewer entry missing `name` (validation error references the missing required property).
- [ ] Schema rejects a reviewer with `type: "plugin"` (only `built-in` and `specialist` allowed).
- [ ] Schema rejects `threshold: 101` and `threshold: -1`.
- [ ] Schema rejects an unknown `request_type` key (e.g., `chore`) at the top level.
- [ ] Schema rejects a reviewer with `trigger: "backend"` (only `frontend` allowed).
- [ ] `plugins/autonomous-dev/config_defaults/reviewer-chains.json` exists and validates against the schema.
- [ ] All five request types (`feature`, `bug`, `infra`, `refactor`, `hotfix`) have entries in the default config.
- [ ] Each request type has at least one `code_review` gate entry.
- [ ] `feature.code_review` includes `code-reviewer` (built-in, blocking, threshold 80) AND at least 2 specialists.
- [ ] `infra.code_review` includes `security-reviewer` with `threshold: 95`.
- [ ] `hotfix.code_review` contains only `built-in` reviewers (no specialists).
- [ ] `ux-ui-reviewer` and `accessibility-reviewer` in `feature.code_review` both have `trigger: "frontend"`.

## Dependencies

- **None at the artifact level**: pure JSON files.
- **Conceptually consumes from PLAN-020-1**: the four specialist agent names referenced in the default config (`qa-edge-case-reviewer`, `ux-ui-reviewer`, `accessibility-reviewer`, `rule-set-enforcement-reviewer`) must exist as agent definitions delivered by PLAN-020-1. This spec only references them by name; no runtime import.

## Notes

- The schema deliberately uses `patternProperties` instead of an `enum` for gate names because TDD-020 anticipates additional gates (`pre_merge`, `post_deploy`) being added without a schema bump.
- The `enabled` field is included in the schema (default `true`) to support the operator workaround documented in PLAN-020-2 risks: trusted private forks may set `enabled: false` on a built-in reviewer to skip it. The aggregator (SPEC-020-2-03) will treat disabled reviewers as if they were not in the chain at all.
- The default config's threshold choices follow TDD-020 §6 verbatim. Operators tuning their own chain copy the file to `<repo>/.autonomous-dev/reviewer-chains.json` and edit values there.
- Schema is versioned by filename (`v1`); a future `v2.json` would coexist and the chain-resolver (SPEC-020-2-02) would dispatch on the `version` field.

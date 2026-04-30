# SPEC-018-3-01: BugReport Interface, JSON Schema & CLI `--type` Flag

## Metadata
- **Parent Plan**: PLAN-018-3
- **Tasks Covered**: Task 1 (BugReport interface + JSON schema), Task 2 (`--type` flag on `request submit`)
- **Estimated effort**: 3.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-018-3-01-bug-report-interface-schema-cli-type-flag.md`

## Description
Define the canonical `BugReport` data contract — both the TypeScript interface (consumed by every code path that handles bug context) and the JSON schema (consumed by AJV at intake time). Wire the new `--type <feature|bug|infra|refactor|hotfix>` flag into the existing `autonomous-dev request submit` CLI command so the dispatcher can route a typed submission to the daemon. This spec is the foundation for the rest of PLAN-018-3: every later spec consumes either the type enum or the BugReport contract.

The interface mirrors TDD-018 §6.1 verbatim. The JSON schema mirrors TDD-018 §6.2 verbatim and must validate the example payload from TDD-018 §7.2. The CLI flag extends PLAN-011-1's dispatcher (already on main) with a single new option, defaulting to `feature` for backward compatibility with existing scripted submissions.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/types/bug-report.ts` | Create | TypeScript interface + exported `BugReportSchema` JSON object |
| `plugins/autonomous-dev/schemas/bug-report.json` | Create | Standalone AJV-loadable JSON Schema (draft 2020-12) |
| `plugins/autonomous-dev/src/cli/commands/request-submit.ts` | Modify | Add `--type` option, validate against enum, propagate to request payload |
| `plugins/autonomous-dev/src/types/request-type.ts` | Reference | Imports `RequestType` enum from PLAN-018-1 (blocking dep) |

## Implementation Details

### `BugReport` Interface (`src/types/bug-report.ts`)

```typescript
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface BugReport {
  // Required
  title: string;                  // 1-200 chars
  description: string;            // free text, 1-4000 chars
  reproduction_steps: string[];   // ordered, ≥1 item
  expected_behavior: string;      // 1-2000 chars
  actual_behavior: string;        // 1-2000 chars
  error_messages: string[];       // ≥0 items; verbatim stack traces / log lines
  environment: {
    os: string;                   // e.g. "macOS 14.4"
    runtime: string;              // e.g. "node 20.11.0", "bun 1.0.30"
    version: string;              // package version where bug was observed
  };

  // Optional
  affected_components?: string[];  // module/package paths
  severity?: Severity;             // defaults to 'medium' if omitted
  labels?: string[];               // free-form tags
  user_impact?: string;            // 1-1000 chars
}

export const BUG_REPORT_SCHEMA_PATH = 'schemas/bug-report.json';
```

Re-export the parsed schema for runtime use:

```typescript
import schemaJson from '../../schemas/bug-report.json';
export const BugReportSchema = schemaJson;
```

### JSON Schema (`schemas/bug-report.json`)

Draft 2020-12, `$id: "https://autonomous-dev.io/schemas/bug-report.json"`. Required fields exactly: `title`, `description`, `reproduction_steps`, `expected_behavior`, `actual_behavior`, `error_messages`, `environment`. Constraints (non-exhaustive list — full schema mirrors TDD-018 §6.2):

- `title`: string, `minLength: 1`, `maxLength: 200`
- `reproduction_steps`: array of string, `minItems: 1`
- `error_messages`: array of string, `minItems: 0`
- `environment`: object, required `[os, runtime, version]`, all strings `minLength: 1`
- `severity`: string, `enum: ["low","medium","high","critical"]`
- `affected_components`, `labels`: array of string (no minItems)
- `additionalProperties: false` at root

### CLI `--type` Flag (`src/cli/commands/request-submit.ts`)

Extend the option declarations:

```typescript
import { RequestType, REQUEST_TYPES } from '../../types/request-type';

cmd
  .option('--type <type>', `request type (${REQUEST_TYPES.join('|')})`, 'feature')
  // ... existing options ...
  .action(async (opts) => {
    if (!REQUEST_TYPES.includes(opts.type as RequestType)) {
      process.stderr.write(
        `Error: invalid type '${opts.type}'. Valid: ${REQUEST_TYPES.join(', ')}\n`
      );
      process.exit(1);
    }
    // pass `opts.type` into the request payload sent to the daemon
  });
```

`REQUEST_TYPES` is exported from PLAN-018-1's `src/types/request-type.ts` as `['feature','bug','infra','refactor','hotfix'] as const`.

## Acceptance Criteria

- [ ] `src/types/bug-report.ts` exports `BugReport`, `Severity`, and `BugReportSchema`; TypeScript strict-mode compile passes (`tsc --noEmit`).
- [ ] `schemas/bug-report.json` parses with `jq -e .` exit 0.
- [ ] AJV (`new Ajv({strict:true}).compile(BugReportSchema)`) compiles without warnings.
- [ ] AJV validates the TDD-018 §7.2 example `bug_context` payload as valid.
- [ ] AJV rejects a payload missing `reproduction_steps` with error `"must have required property 'reproduction_steps'"`.
- [ ] AJV rejects `severity: "urgent"` with an `enum` error citing the four valid values.
- [ ] AJV rejects an empty `reproduction_steps: []` with `"must NOT have fewer than 1 items"`.
- [ ] `autonomous-dev request submit --repo /path --description "X" --type bug` produces a request payload with `request_type: 'bug'`.
- [ ] `autonomous-dev request submit --type xyz` exits with code 1 and stderr exactly: `Error: invalid type 'xyz'. Valid: feature, bug, infra, refactor, hotfix`.
- [ ] `autonomous-dev request submit --description "X"` (no `--type`) defaults to `feature`.
- [ ] `autonomous-dev request submit --help` lists all five values in the `--type` option's help string.

## Dependencies

- **Blocking**: PLAN-018-1 ships the `RequestType` enum and `REQUEST_TYPES` const at `src/types/request-type.ts`. This spec imports from there; if PLAN-018-1 is not merged, the type import will fail.
- AJV (already a dependency on main).
- Commander (existing CLI option parser).
- No new npm packages introduced.

## Notes

- Bug-context validation (rejecting `--type bug` without a `BugReport`) is **not** in this spec — it lives in SPEC-018-3-02 alongside the interactive flow. This spec only enforces that the type string itself is valid.
- The schema file is the single source of truth. The TypeScript interface is hand-maintained to match; a future spec may auto-generate the interface from the schema, but this spec keeps them in lockstep manually for readability.
- The `additionalProperties: false` constraint at the schema root is intentional: it prevents silent typos (e.g. `repro_steps` vs `reproduction_steps`) from passing validation.
- Default `severity` of `'medium'` is applied at the daemon layer, not at the CLI — the schema documents `severity` as optional. This keeps the CLI thin and centralizes business rules.
- Backward compatibility: existing `autonomous-dev request submit --description "X"` invocations continue to work exactly as before, defaulting to `feature` type. No migration needed for in-flight requests.

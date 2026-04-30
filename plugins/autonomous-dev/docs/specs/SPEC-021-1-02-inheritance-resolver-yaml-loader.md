# SPEC-021-1-02: InheritanceResolver + YAML Loader (safe-load)

## Metadata
- **Parent Plan**: PLAN-021-1
- **Tasks Covered**: Task 3 (InheritanceResolver), Task 4 (YAML loader with safe-load)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-021-1-02-inheritance-resolver-yaml-loader.md`
- **Depends on**: SPEC-021-1-01 (types and schema must exist)

## Description
Implement the runtime that loads and merges standards artifacts. Two deliverables:

1. **YAML loader** (`loader.ts`) — reads a `standards.yaml` from disk using `js-yaml` in safe-load mode (rejects `!!python/object` and similar RCE payloads), parses to a `StandardsArtifact`, validates against `standards-v1.json` via `ajv`, and returns `{artifact, errors[]}` where errors are typed (`parse_error` | `schema_error` | `io_error`). Input file size is capped at 1MB to defend against billion-laughs DoS.

2. **InheritanceResolver** (`resolver.ts`) — exposes `resolveStandards(defaultRules, orgRules, repoRules, requestOverrides)` per TDD-021 §8. Returns a typed result `{rules: Map<string, Rule>, source: Map<string, RuleSource>}` where each rule ID maps to its winning rule plus the source level it came from. Repo overrides org unless the org rule is `immutable: true`. Per-request overrides require admin authorization (gated by `isAdminRequest()` stub which always returns false unless mocked).

These two modules together fulfill the "load + merge" half of the standards substrate. The scanner (SPEC-021-1-03) and CLI (SPEC-021-1-04) layer on top.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/standards/loader.ts` | Create | `loadStandardsFile(path)` with safe-load |
| `plugins/autonomous-dev/src/standards/resolver.ts` | Create | `resolveStandards()` + `Source` tracking |
| `plugins/autonomous-dev/src/standards/errors.ts` | Create | `ValidationError`, `AuthorizationError`, `LoaderError` classes |
| `plugins/autonomous-dev/src/standards/auth.ts` | Create | `isAdminRequest()` stub returning false |
| `plugins/autonomous-dev/src/standards/index.ts` | Modify | Re-export loader, resolver, errors |
| `plugins/autonomous-dev/package.json` | Modify | Add `js-yaml@^4.1.0`, `ajv@^8.12.0` deps; types `@types/js-yaml@^4.0.0` |

## Implementation Details

### `loader.ts` — YAML Loader

```typescript
import { readFile, stat } from "node:fs/promises";
import * as yaml from "js-yaml";
import Ajv from "ajv";
import schema from "../../schemas/standards-v1.json";
import type { StandardsArtifact } from "./types";
import { LoaderError } from "./errors";

const MAX_FILE_BYTES = 1_048_576; // 1MB cap per TDD-021 §16 (DoS guard)

export type LoaderErrorRecord =
  | { type: "io_error"; message: string }
  | { type: "size_exceeded"; message: string; bytes: number }
  | { type: "parse_error"; message: string }
  | { type: "schema_error"; path: string; message: string };

export interface LoaderResult {
  artifact: StandardsArtifact | null;
  errors: LoaderErrorRecord[];
}

export async function loadStandardsFile(path: string): Promise<LoaderResult> {
  // 1. Stat to check size before reading entire file
  // 2. Read file as utf8
  // 3. yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA })  // rejects !!python/object, !!js/function, etc.
  // 4. Validate parsed object via ajv against standards-v1.json
  // 5. Map ajv errors to LoaderErrorRecord with `instancePath` as `path`
  // 6. Return { artifact: validResult ? parsed : null, errors }
}
```

Implementation notes:
- Use `yaml.FAILSAFE_SCHEMA` (not the default schema) to reject all custom tags. This blocks `!!python/object` (RCE via PyYAML port), `!!js/function`, and similar.
- File size check via `stat()` before `readFile()` to avoid loading a 100GB file into memory.
- Ajv compile is cached at module scope (compile once, reuse across calls).
- An `io_error` (file missing, permission denied) is captured rather than thrown so callers can present a single error stream.

### `resolver.ts` — InheritanceResolver

```typescript
import type { Rule, RuleSource } from "./types";
import { ValidationError, AuthorizationError } from "./errors";
import { isAdminRequest } from "./auth";

export interface ResolvedStandards {
  rules: Map<string, Rule>;
  source: Map<string, RuleSource>;
}

export function resolveStandards(
  defaultRules: Rule[],
  orgRules: Rule[],
  repoRules: Rule[],
  requestOverrides: Rule[]
): ResolvedStandards {
  const rules = new Map<string, Rule>();
  const source = new Map<string, RuleSource>();

  // 1. Seed with defaults
  for (const r of defaultRules) { rules.set(r.id, r); source.set(r.id, "default"); }

  // 2. Apply org rules (override defaults)
  for (const r of orgRules) { rules.set(r.id, r); source.set(r.id, "org"); }

  // 3. Apply repo rules — error if repo tries to override an immutable org rule
  for (const r of repoRules) {
    const existing = rules.get(r.id);
    if (existing && existing.immutable && source.get(r.id) === "org") {
      throw new ValidationError(
        `Rule "${r.id}" is marked immutable at the org level and cannot be overridden by the repo.`
      );
    }
    rules.set(r.id, r);
    source.set(r.id, "repo");
  }

  // 4. Apply per-request overrides — require admin
  if (requestOverrides.length > 0 && !isAdminRequest()) {
    throw new AuthorizationError(
      "Per-request standards overrides require admin authorization."
    );
  }
  for (const r of requestOverrides) {
    rules.set(r.id, r);
    source.set(r.id, "request");
  }

  return { rules, source };
}
```

### `errors.ts`

Three named error classes extending `Error`: `ValidationError`, `AuthorizationError`, `LoaderError`. Each sets `name` to its class name so callers can switch on `err.name`. No additional fields needed.

### `auth.ts`

```typescript
/** Stub per PLAN-021-1 task 3 acceptance criteria; full implementation in PRD-009 trust ladder. */
export function isAdminRequest(): boolean {
  return false;
}
```

The stub design lets tests inject a mock via `vi.spyOn(authModule, "isAdminRequest")` without touching production code.

## Acceptance Criteria

### Loader
- [ ] Loading a valid YAML file returns `{artifact: <parsed>, errors: []}`.
- [ ] Loading a YAML with a syntax error returns `{artifact: null, errors: [{type: "parse_error", message: ...}]}`.
- [ ] Loading a YAML that violates the schema returns `{artifact: null, errors: [{type: "schema_error", path: "/rules/0/id", message: ...}]}`.
- [ ] Loading a YAML containing `!!python/object` is rejected by safe-load and returns a `parse_error`.
- [ ] Loading a YAML containing `!!js/function` is rejected by safe-load and returns a `parse_error`.
- [ ] Loading a file > 1MB returns `{artifact: null, errors: [{type: "size_exceeded", bytes: ...}]}` without reading the contents.
- [ ] Loading a non-existent file returns `{artifact: null, errors: [{type: "io_error", ...}]}` (no thrown exception).
- [ ] Multiple schema errors all surface in `errors[]` (not just the first).

### Resolver
- [ ] Default-only input: every rule appears with `source = "default"`.
- [ ] Org rule with the same ID as a default rule: rule overridden, `source = "org"`.
- [ ] Repo rule with the same ID as an org rule (mutable): rule overridden, `source = "repo"`.
- [ ] Repo rule with the same ID as an immutable org rule: throws `ValidationError` with the rule ID in the message.
- [ ] Repo rule with the same ID as an immutable default rule (no org override): allowed (defaults are mutable; only org can mark immutable).
- [ ] Per-request overrides with `isAdminRequest() === false`: throws `AuthorizationError`.
- [ ] Per-request overrides with `isAdminRequest()` mocked to true: applied, `source = "request"`.
- [ ] Empty inputs at all four levels: returns empty maps without error.
- [ ] Resolution of 1000-rule defaults + 100-rule org + 50-rule repo completes in < 50ms (microbenchmark in resolver test file).

### Module shape
- [ ] `src/standards/index.ts` re-exports `loadStandardsFile`, `resolveStandards`, `ValidationError`, `AuthorizationError`, `LoaderError`, `isAdminRequest`.
- [ ] `tsc --strict --noEmit` passes for all new files.
- [ ] `package.json` includes `js-yaml` and `ajv` at the documented versions; `npm ls` shows no peer dependency warnings.

## Dependencies

- SPEC-021-1-01 must be merged: `Rule`, `RuleSource`, `StandardsArtifact` types and `standards-v1.json` schema.
- Runtime: `js-yaml@^4.1.0` (safe-load via FAILSAFE_SCHEMA), `ajv@^8.12.0` (JSON Schema 2020-12 support requires `ajv-formats` and `ajv/dist/2020`).
- The `isAdminRequest()` real implementation lives in PRD-009's trust ladder plan; this spec ships the stub.

## Notes

- `js-yaml` v4's `FAILSAFE_SCHEMA` only allows scalars, sequences, and mappings — no custom tags whatsoever. This is a stricter posture than the default `DEFAULT_SCHEMA` and is the right default for parsing operator-supplied config.
- Ajv's draft 2020-12 support requires importing from `ajv/dist/2020` rather than the default entry. This is a known gotcha; the tests will catch a mistake here because a sample 2020-12 schema feature (`unevaluatedProperties`) will silently no-op under the wrong Ajv build.
- The resolver's immutability check is intentionally only triggered for org-level immutable rules; default rules can be overridden by org because TDD-021 §8 designates org as the operator's primary control plane.
- The 1MB file size cap is a deliberate DoS guard. Operators with legitimate larger standards files can split them across multiple files (multi-file load is a future feature; v1 expects exactly one file per level).
- The `LoaderResult` returns `null` for `artifact` rather than throwing because callers (CLI, resolver, tests) almost always need to inspect both the artifact (if any) and the errors. Throwing would force every caller into a try/catch.

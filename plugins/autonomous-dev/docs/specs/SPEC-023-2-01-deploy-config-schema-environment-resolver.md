# SPEC-023-2-01: deploy-config-v1.json Schema and EnvironmentResolver

## Metadata
- **Parent Plan**: PLAN-023-2
- **Tasks Covered**: Task 1 (author `deploy.yaml` schema), Task 2 (implement `EnvironmentResolver`)
- **Estimated effort**: 5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-023-2-01-deploy-config-schema-environment-resolver.md`

## Description
Establish the declarative configuration surface for multi-environment deployments. This spec ships two artifacts: (1) the `deploy-config-v1.json` JSON Schema that validates `<repo>/.autonomous-dev/deploy.yaml` per TDD-023 §9, and (2) the `EnvironmentResolver` library that loads the YAML, validates against the schema, applies inheritance (env-specific values override repo defaults), and returns a fully populated `ResolvedEnvironment` object for downstream consumers (`BackendSelector` in SPEC-023-2-02 and the deploy orchestrator in SPEC-023-2-03).

When `deploy.yaml` is absent, the resolver MUST return a safe fallback `ResolvedEnvironment` (backend `local`, approval `none`, no cost cap) so that brand-new repos work without any configuration. Schema validation failures abort with a structured error referencing the offending field and JSON Pointer. The schema is the contract; subsequent specs depend on its shape being stable.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/schemas/deploy-config-v1.json` | Create | JSON Schema (draft-07) describing the YAML shape per TDD §9 |
| `plugins/autonomous-dev/schemas/examples/deploy-config-example.yaml` | Create | Worked example referenced by the schema's `examples` block |
| `plugins/autonomous-dev/src/deploy/environment.ts` | Create | `loadConfig(repoPath)`, `resolveEnvironment(config, envName)`, `ResolvedEnvironment` type |
| `plugins/autonomous-dev/src/deploy/types-config.ts` | Create | TypeScript types mirroring the schema (`DeployConfig`, `EnvironmentConfig`, `ApprovalLevel`) |

## Implementation Details

### JSON Schema Shape

```jsonc
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://autonomous-dev/schemas/deploy-config-v1.json",
  "title": "Autonomous-Dev Deploy Configuration",
  "type": "object",
  "required": ["version", "environments"],
  "additionalProperties": false,
  "properties": {
    "version": { "const": "1.0" },
    "default_backend": { "type": "string", "minLength": 1 },
    "environments": {
      "type": "object",
      "minProperties": 1,
      "patternProperties": {
        "^(dev|staging|prod|[a-z][a-z0-9_-]{0,30})$": { "$ref": "#/$defs/environment" }
      },
      "additionalProperties": false
    }
  },
  "$defs": {
    "environment": {
      "type": "object",
      "required": ["backend", "approval", "cost_cap_usd"],
      "additionalProperties": false,
      "properties": {
        "backend": { "type": "string", "minLength": 1 },
        "parameters": { "type": "object" },
        "approval": { "enum": ["none", "single", "two-person", "admin"] },
        "cost_cap_usd": { "type": "number", "minimum": 0 },
        "auto_promote_from": { "type": "string" }
      }
    }
  }
}
```

### `ResolvedEnvironment` Type

```ts
export type ApprovalLevel = "none" | "single" | "two-person" | "admin";

export interface ResolvedEnvironment {
  envName: string;            // "dev" | "staging" | "prod" | custom
  backend: string;            // backend name (post-inheritance, pre-selector override)
  parameters: Record<string, unknown>; // merged: repo defaults <- env-specific
  approval: ApprovalLevel;
  costCapUsd: number;         // 0 means "no cap"
  autoPromoteFrom: string | null;
  source: "deploy.yaml" | "fallback"; // for telemetry & debugging
  configPath: string | null;  // absolute path or null when fallback
}
```

### Resolver Behavior

```ts
// loadConfig: returns parsed+validated config OR null when file is absent.
// Throws ConfigValidationError when file exists but is invalid.
export async function loadConfig(repoPath: string): Promise<DeployConfig | null>;

// resolveEnvironment:
//   - If config is null  -> fallback ResolvedEnvironment (backend="local",
//     approval="none", costCapUsd=0, source="fallback")
//   - Otherwise:
//       1. Look up environments[envName]; throw UnknownEnvironmentError if missing
//       2. Merge parameters: shallow-merge repo-level `parameters` (if any) <- env params
//       3. Resolve backend: env.backend, OR config.default_backend, OR "local"
//       4. Return ResolvedEnvironment with source="deploy.yaml"
export function resolveEnvironment(
  config: DeployConfig | null,
  envName: string,
  options?: { fallbackBackend?: string }
): ResolvedEnvironment;
```

### Inheritance Rules
1. `environments.<env>.parameters` override repo-level `parameters` key-by-key (shallow merge).
2. `environments.<env>.backend` always wins over `default_backend`.
3. `cost_cap_usd: 0` is a valid value meaning "no cap"; `undefined` (missing) is rejected by schema.
4. Fallback path NEVER reads from `default_backend` (no config means no defaults).

### Worked Example (`examples/deploy-config-example.yaml`)

```yaml
version: "1.0"
default_backend: "static"
environments:
  dev:
    backend: "local"
    parameters: {}
    approval: "none"
    cost_cap_usd: 0
  staging:
    backend: "static"
    parameters:
      target_dir: "/var/www/staging"
    approval: "single"
    cost_cap_usd: 5
  prod:
    backend: "static"
    parameters:
      target_dir: "/var/www/prod"
    approval: "two-person"
    cost_cap_usd: 25
    auto_promote_from: "staging"
```

## Acceptance Criteria
1. [ ] Schema validates the worked example with zero errors.
2. [ ] Schema rejects an environment missing `backend` (error references `/environments/<name>/backend`).
3. [ ] Schema rejects `approval: "optional"` (not in enum) with a clear message.
4. [ ] Schema rejects `cost_cap_usd: -10` via `minimum: 0`.
5. [ ] Schema rejects unknown top-level keys via `additionalProperties: false`.
6. [ ] Custom env names matching `^[a-z][a-z0-9_-]{0,30}$` are accepted (e.g., `qa`, `preview-1`).
7. [ ] `loadConfig(repoPath)` returns `null` when `<repoPath>/.autonomous-dev/deploy.yaml` does not exist.
8. [ ] `loadConfig(repoPath)` throws `ConfigValidationError` (with field path + line number when available) when YAML is malformed or fails schema.
9. [ ] `resolveEnvironment(null, "prod")` returns a `ResolvedEnvironment` with `backend="local"`, `approval="none"`, `costCapUsd=0`, `source="fallback"`.
10. [ ] `resolveEnvironment(config, "ghost")` throws `UnknownEnvironmentError` listing the available env names.
11. [ ] Env-specific parameters override repo-level parameters (shallow merge verified by test).
12. [ ] `ResolvedEnvironment.source` is `"deploy.yaml"` for config-backed resolutions and `"fallback"` for fallback path.
13. [ ] Strict TypeScript: no `any`. JSDoc on each exported symbol cites TDD §9.
14. [ ] Unit tests cover: schema valid example, schema rejection (missing backend, bad enum, negative cost), fallback path, env-not-found, parameter inheritance.

## Dependencies
- **Blocks**: SPEC-023-2-02 (BackendSelector consumes `ResolvedEnvironment`), SPEC-023-2-03 (approval state machine reads `ResolvedEnvironment.approval`), SPEC-023-2-04 (`deploy plan` CLI prints resolver output).
- **Consumes**: TDD-023 §9 (config shape). No runtime dependency on PLAN-023-1 backends; the resolver does not validate that `backend` names refer to registered backends — that check happens in SPEC-023-2-02.
- **Library**: `js-yaml` (already in repo lockfile) for YAML parsing; `ajv` for JSON Schema validation.

## Notes
- The schema deliberately allows `parameters: {}` (empty object) so that a backend with no required parameters works without ceremony.
- `auto_promote_from` is parsed but the orchestration logic to act on it is out of scope (per plan §"Out of Scope").
- The fallback `ResolvedEnvironment` does NOT consult `~/.claude/autonomous-dev.json` global caps — those are layered in by SPEC-023-2-04's pre-check.
- Schema lives under `plugins/autonomous-dev/schemas/` (sibling of existing schemas) so that future tooling (`deploy plan --validate`, IDE integrations) can resolve it via `$id`.
- The resolver intentionally does NOT cache config across calls; the orchestrator is expected to load once per deploy invocation. Caching behavior is a future enhancement.

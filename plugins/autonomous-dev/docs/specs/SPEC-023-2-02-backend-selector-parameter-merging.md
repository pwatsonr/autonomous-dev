# SPEC-023-2-02: BackendSelector with 4-Priority Order and Parameter Merging

## Metadata
- **Parent Plan**: PLAN-023-2
- **Tasks Covered**: Task 3 (implement `BackendSelector`), Task 4 (implement parameter merging with backend schema validation)
- **Estimated effort**: 4.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-023-2-02-backend-selector-parameter-merging.md`

## Description
Implement the deterministic backend-selection algorithm specified in TDD-023 §10. Given a deploy request and the `ResolvedEnvironment` from SPEC-023-2-01, the selector chooses the backend by walking a four-priority order (per-request override → per-env config → repo default → autonomous-dev fallback `local`), records the selection source for telemetry, and merges parameters with the chosen backend's parameter schema (consumed from PLAN-023-1's `BackendRegistry`). All parameter values are validated server-side using PLAN-023-1's `validateParameters()` framework before the selector returns.

The selector is a pure function over `(ResolvedEnvironment, SelectionContext, BackendRegistry)`. It does NOT invoke the backend, does NOT touch the filesystem, and does NOT emit telemetry directly — the orchestrator (SPEC-023-2-04) consumes the selector's output and is responsible for telemetry emission. This separation keeps the selector trivially testable.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/deploy/selector.ts` | Create | `selectBackend(context)`, `BackendSelection` type, source enum |
| `plugins/autonomous-dev/src/deploy/selector-errors.ts` | Create | `UnknownBackendError`, `ParameterValidationError` (extends Error with structured fields) |
| `plugins/autonomous-dev/tests/deploy/test-backend-selector.test.ts` | Create | Unit tests for all four sources + parameter merging happy + sad paths |

## Implementation Details

### Types

```ts
export type SelectionSource =
  | "request-override"   // CLI --backend or programmatic override
  | "env-config"         // ResolvedEnvironment.backend (from deploy.yaml)
  | "repo-default"       // DeployConfig.default_backend
  | "fallback";          // hard-coded "local"

export interface SelectionContext {
  resolved: ResolvedEnvironment;       // from SPEC-023-2-01
  registry: BackendRegistry;           // from PLAN-023-1
  override?: { backend: string };      // CLI --backend or API field
  repoDefaultBackend?: string;         // mirrors DeployConfig.default_backend
}

export interface BackendSelection {
  backendName: string;
  source: SelectionSource;
  parameters: Record<string, unknown>; // post-merge, post-validation
  envName: string;                     // pass-through for telemetry
}
```

### `selectBackend()` Algorithm

```ts
export function selectBackend(ctx: SelectionContext): BackendSelection {
  // 1. Determine backend name by priority
  let backendName: string;
  let source: SelectionSource;

  if (ctx.override?.backend) {
    backendName = ctx.override.backend;
    source = "request-override";
  } else if (ctx.resolved.source === "deploy.yaml") {
    backendName = ctx.resolved.backend;
    source = "env-config";
  } else if (ctx.repoDefaultBackend) {
    backendName = ctx.repoDefaultBackend;
    source = "repo-default";
  } else {
    backendName = "local";
    source = "fallback";
  }

  // 2. Verify backend is registered
  const backend = ctx.registry.get(backendName);
  if (!backend) {
    throw new UnknownBackendError(backendName, ctx.registry.list());
  }

  // 3. Merge parameters: backend defaults <- env params <- override params
  const merged = mergeParameters(
    backend.metadata.defaultParameters ?? {},
    ctx.resolved.parameters ?? {},
    /* future: override params - not used in this spec */
  );

  // 4. Validate merged parameters against backend schema
  const result = validateParameters(backend.parameterSchema, merged);
  if (!result.valid) {
    throw new ParameterValidationError(backendName, result.errors);
  }

  return {
    backendName,
    source,
    parameters: result.sanitized,
    envName: ctx.resolved.envName,
  };
}
```

### Parameter Merging Rules

`mergeParameters(defaults, envParams)` is a **shallow merge**:
- Keys present in `envParams` override `defaults`.
- Keys present only in `defaults` are preserved.
- Nested objects are NOT deep-merged (env params replace the entire nested object).
- Arrays are NOT concatenated (env params replace the entire array).

Rationale: deep-merging tends to surprise operators ("why did the env's empty `headers` map not clear the default headers?"). Shallow merge is predictable.

### Validation Behavior
- Validation uses PLAN-023-1's `validateParameters(schema, values)` which returns `{valid, sanitized, errors[]}`.
- `sanitized` contains the validated values cast to their declared types (e.g., string `"8080"` → number `8080` when `type: number`).
- Errors include the failing parameter name, declared type/constraint, and offending value (without leaking secrets — string values longer than 64 chars are truncated in error messages).

### Error Shapes

```ts
export class UnknownBackendError extends Error {
  constructor(public readonly requested: string, public readonly available: string[]) {
    super(`Backend '${requested}' is not registered. Available: ${available.join(", ")}`);
    this.name = "UnknownBackendError";
  }
}

export class ParameterValidationError extends Error {
  constructor(
    public readonly backendName: string,
    public readonly errors: ReadonlyArray<{ field: string; message: string }>,
  ) {
    super(
      `Parameter validation failed for backend '${backendName}': ` +
      errors.map(e => `${e.field}: ${e.message}`).join("; "),
    );
    this.name = "ParameterValidationError";
  }
}
```

## Acceptance Criteria
1. [ ] With `override.backend = "static"`, returns `{backendName: "static", source: "request-override"}` regardless of env config.
2. [ ] Without override, with `resolved.source === "deploy.yaml"` and `resolved.backend === "docker-local"`, returns `{backendName: "docker-local", source: "env-config"}`.
3. [ ] Without override, with `resolved.source === "fallback"` and `repoDefaultBackend === "static"`, returns `{backendName: "static", source: "repo-default"}`.
4. [ ] Without override, with `resolved.source === "fallback"` and no `repoDefaultBackend`, returns `{backendName: "local", source: "fallback"}`.
5. [ ] Throws `UnknownBackendError` when the chosen backend name is not in the registry; error lists available backends.
6. [ ] Parameter merging: backend default `{port: 8080}` and env params `{port: 9090}` → merged `{port: 9090}`.
7. [ ] Parameter merging: backend default `{port: 8080, host: "0.0.0.0"}` and env params `{port: 9090}` → merged `{port: 9090, host: "0.0.0.0"}`.
8. [ ] Parameter merging is shallow: backend default `{tls: {cert: "/a", key: "/b"}}` and env params `{tls: {cert: "/x"}}` → merged `{tls: {cert: "/x"}}` (NOT `{tls: {cert: "/x", key: "/b"}}`).
9. [ ] Validation: backend declaring `target_dir: {type: "string", format: "path"}` accepts `"/var/www"` and rejects `"/etc/passwd"` with `ParameterValidationError`.
10. [ ] Validation: numeric coercion works — backend declaring `port: {type: "number"}` accepts string `"9090"` and returns `sanitized.port === 9090`.
11. [ ] Validation errors do NOT leak parameter values longer than 64 characters (truncated with `...`).
12. [ ] Selector is a pure function: same inputs produce identical outputs across repeated calls.
13. [ ] Selector does NOT call `backend.deploy()`, `backend.build()`, or any backend method other than reading `metadata` and `parameterSchema`.
14. [ ] Strict TypeScript: no `any`. Tests cover all four sources + happy/sad merge paths.

## Dependencies
- **Blocks**: SPEC-023-2-04 (orchestrator + `deploy plan` CLI consume `BackendSelection`).
- **Consumes**:
  - SPEC-023-2-01 (`ResolvedEnvironment`, `DeployConfig` types).
  - PLAN-023-1: `BackendRegistry`, `validateParameters()`, `BackendMetadata.defaultParameters`, `parameterSchema`.
- No new external libraries.

## Notes
- The selector intentionally does NOT log or emit telemetry. The orchestrator (SPEC-023-2-04) is the single emission point so that one deploy → one selection telemetry event (and not duplicate events from multiple call sites).
- Future enhancement: per-request parameter overrides (CLI `--param key=value`). The `SelectionContext.override` shape is positioned to extend with `parameters?: Record<string, unknown>`; the merge order would be `defaults <- env <- override`.
- `repoDefaultBackend` is passed as a separate field (rather than read from `ResolvedEnvironment`) because the resolver does not surface it on the resolved object — `default_backend` is a config-level concept, not an env-level concept.
- Conformance tests for individual backends live in PLAN-023-1's `tests/deploy/conformance.test.ts`. This spec only tests the selector's selection + merge logic, with backends mocked via stub registry entries.
- The four-source priority order is load-bearing: changing it later would invalidate operator-facing documentation and the telemetry shape. If a fifth source is needed (e.g., a global org-default), it should be inserted between `repo-default` and `fallback` and documented as a breaking change.

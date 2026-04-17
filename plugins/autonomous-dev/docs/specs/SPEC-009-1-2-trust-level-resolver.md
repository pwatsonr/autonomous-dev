# SPEC-009-1-2: Trust Level Resolver

## Metadata
- **Parent Plan**: PLAN-009-1
- **Tasks Covered**: Task 3 (Implement Trust Level Resolver), Task 6 (Implement Trust Configuration loader)
- **Estimated effort**: 7 hours

## Description

Implement the three-tier trust level resolution algorithm and the configuration loader that feeds it. The resolver determines the effective trust level for a given gate check by evaluating: (1) per-request override, (2) per-repo default, (3) system global default, with a hardcoded fallback to L1 when no configuration is present. The configuration loader parses and validates the `trust:` YAML section and supports hot-reload at gate boundaries.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/trust/trust-resolver.ts` | Create | Three-tier trust level resolution |
| `src/trust/trust-config.ts` | Create | YAML config parsing, validation, hot-reload |

## Implementation Details

### trust-resolver.ts

```typescript
export interface TrustResolutionContext {
  requestOverride?: TrustLevel;  // Per-request trust level override
  repositoryId: string;          // Used to look up per-repo config
}

export class TrustResolver {
  resolve(context: TrustResolutionContext, config: TrustConfig): TrustLevel
}
```

Resolution algorithm:
1. If `context.requestOverride` is defined and is a valid `TrustLevel` (0-3), return it.
2. Else if `config.repositories[context.repositoryId]?.default_level` is defined, return it.
3. Else if `config.system_default_level` is defined, return it.
4. Else return `1` (L1 hardcoded fallback).

Resolution is stateless and per-invocation -- the resolver does not cache results across gate checks. This ensures that config hot-reload and mid-pipeline trust changes take effect at the next gate boundary.

### trust-config.ts

```typescript
export class TrustConfigLoader {
  constructor(private configProvider: ConfigProvider) {}

  load(): TrustConfig                    // Parse + validate
  onConfigChange(callback: () => void)   // Hot-reload subscription
}
```

Validation rules:
- `system_default_level` must be 0, 1, 2, or 3. Invalid values log a validation error and fall back to `1`.
- `repositories.<repo>.default_level` must be 0, 1, 2, or 3. Invalid entries are skipped with a warning.
- `promotion.require_human_approval` must be `true`. If set to `false`, reject the config with a logged error and force `true`.
- `auto_demotion.failure_threshold` must be a positive integer. Default: `3`.
- `auto_demotion.window_hours` must be a positive number. Default: `24`.

Hot-reload behavior:
- The config loader watches the YAML file for changes (via the existing plugin config system's change notification).
- When a change is detected, it re-parses and re-validates the config.
- The new config is stored but not applied until the next gate check (snapshot semantics at gate boundaries).
- If the new config is invalid, the previous valid config is retained and an error is logged.

Default `TrustConfig` when no configuration is present:
```typescript
const DEFAULT_TRUST_CONFIG: TrustConfig = {
  system_default_level: 1,
  repositories: {},
  auto_demotion: { enabled: false, failure_threshold: 3, window_hours: 24 },
  promotion: { require_human_approval: true, min_successful_runs: 10, cooldown_hours: 72 },
};
```

## Acceptance Criteria

1. Resolver returns the per-request override when present.
2. Resolver returns the per-repo default when no per-request override exists.
3. Resolver returns the system default when neither per-request nor per-repo config exists.
4. Resolver returns `1` (L1) when no configuration is present at all.
5. Resolver does not cache -- calling `resolve()` twice with different configs returns different results.
6. Valid `trust:` YAML config loads correctly into `TrustConfig`.
7. Invalid `system_default_level` (e.g., `5`, `-1`, `"high"`) falls back to `1` with a logged warning.
8. Invalid `repositories.<repo>.default_level` is skipped; other repos still load.
9. Setting `promotion.require_human_approval: false` is rejected; value forced to `true` with logged error.
10. Hot-reload: changing the YAML file causes the next `load()` call to return the new config.
11. Hot-reload: if the new config is invalid, the previous valid config is retained.

## Test Cases

1. **Per-request override takes precedence** -- `resolve({ requestOverride: 3, repositoryId: "repo-a" }, config)` returns `3` even when repo-a has `default_level: 0`.
2. **Per-repo default used when no override** -- `resolve({ repositoryId: "repo-a" }, configWithRepoA)` returns repo-a's configured level.
3. **System default used when no repo config** -- `resolve({ repositoryId: "unknown-repo" }, configWithSystemDefault)` returns system default.
4. **Hardcoded L1 fallback** -- `resolve({ repositoryId: "x" }, emptyConfig)` returns `1`.
5. **No caching between calls** -- Call resolve, change config, call resolve again with same context; second call reflects new config.
6. **Config: valid full config** -- YAML with all fields parses correctly.
7. **Config: missing trust section** -- Returns `DEFAULT_TRUST_CONFIG`.
8. **Config: invalid system_default_level = 5** -- Falls back to `1`, logs warning.
9. **Config: invalid system_default_level = "high"** -- Falls back to `1`, logs warning.
10. **Config: invalid repo level** -- Repo entry skipped, other repos intact.
11. **Config: require_human_approval set to false** -- Forced to `true`, error logged.
12. **Config: partial config** -- Missing fields filled with defaults.
13. **Hot-reload: valid new config** -- New config returned on next load.
14. **Hot-reload: invalid new config** -- Previous config retained, error logged.

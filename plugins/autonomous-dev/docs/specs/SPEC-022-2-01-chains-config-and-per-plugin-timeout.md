# SPEC-022-2-01: Chains Config Section + Per-Plugin Timeout Enforcement

## Metadata
- **Parent Plan**: PLAN-022-2
- **Tasks Covered**: Task 1 (add `chains` config section), Task 2 (per-plugin timeout via `Promise.race`)
- **Estimated effort**: 4.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-022-2-01-chains-config-and-per-plugin-timeout.md`

## Description
Establish the operational baseline for chain execution by introducing the `chains` configuration namespace in `~/.claude/autonomous-dev.json` (per TDD-022 §9) and wiring per-plugin timeout enforcement into the `ChainExecutor` shipped by PLAN-022-1. After this spec, every chain has a documented resource budget, conservative defaults are written by `config init --global`, and a runaway plugin invocation is killed at the configured timeout boundary instead of hanging the executor. This is the foundation that all remaining PLAN-022-2 specs (limits, approval gate, trust, telemetry) build upon.

The timeout mechanism uses `Promise.race` between the plugin invocation promise and a deadline timer. On timeout, the plugin invocation is marked failed with a typed `PluginTimeoutError`, control returns to the executor, and the failure-mode semantics defined in SPEC-022-2-02 (default: `warn`) determine whether downstream proceeds. The manifest may override the global default with an optional per-plugin `timeout_seconds` in the produces declaration.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/schemas/autonomous-dev-config.schema.json` | Modify | Add `chains` object with five integer properties + ranges |
| `plugins/autonomous-dev/config_defaults.json` | Modify | Add `chains` block with TDD §9 defaults |
| `plugins/autonomous-dev/src/chains/executor.ts` | Modify | Wrap each `pluginRunner.invoke()` in `Promise.race` against a deadline |
| `plugins/autonomous-dev/src/chains/errors.ts` | Modify | Export `PluginTimeoutError extends ChainError` with `plugin_id`, `timeout_ms` fields |
| `plugins/autonomous-dev/schemas/plugin-manifest-v2.json` | Modify | Add optional `timeout_seconds` to the produces declaration schema |
| `plugins/autonomous-dev/tests/chains/test-timeout.test.ts` | Create | Unit tests for timeout race using mocked timers |

## Implementation Details

### `chains` Section in `autonomous-dev-config.schema.json`

Add under `properties`:

```json
"chains": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "max_length": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 },
    "per_plugin_timeout_seconds": { "type": "integer", "minimum": 5, "maximum": 1800, "default": 120 },
    "per_chain_timeout_seconds": { "type": "integer", "minimum": 30, "maximum": 7200, "default": 600 },
    "max_artifact_size_mb": { "type": "integer", "minimum": 1, "maximum": 100, "default": 10 },
    "max_concurrent_chains": { "type": "integer", "minimum": 1, "maximum": 32, "default": 3 }
  },
  "default": {
    "max_length": 10,
    "per_plugin_timeout_seconds": 120,
    "per_chain_timeout_seconds": 600,
    "max_artifact_size_mb": 10,
    "max_concurrent_chains": 3
  }
}
```

### `config_defaults.json` Block

```json
"chains": {
  "max_length": 10,
  "per_plugin_timeout_seconds": 120,
  "per_chain_timeout_seconds": 600,
  "max_artifact_size_mb": 10,
  "max_concurrent_chains": 3
}
```

### `PluginTimeoutError`

```ts
export class PluginTimeoutError extends ChainError {
  constructor(
    public readonly plugin_id: string,
    public readonly timeout_ms: number,
    public readonly chain_id: string,
  ) {
    super(`Plugin "${plugin_id}" exceeded ${timeout_ms}ms timeout in chain ${chain_id}`);
    this.name = 'PluginTimeoutError';
  }
}
```

### `Promise.race` Wrapper in `ChainExecutor`

Resolved timeout precedence (highest wins):
1. `manifest.produces[i].timeout_seconds` (per-declaration override)
2. `config.chains.per_plugin_timeout_seconds` (global)

```ts
private async invokeWithTimeout(plugin: PluginRecord, ctx: InvocationContext): Promise<InvocationResult> {
  const timeoutMs = (plugin.manifest.produces?.timeout_seconds
    ?? this.config.chains.per_plugin_timeout_seconds) * 1000;

  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new PluginTimeoutError(plugin.id, timeoutMs, ctx.chain_id)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([this.runner.invoke(plugin, ctx), timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}
```

The cleared timer prevents leaked handles when the invocation wins the race. The executor catches `PluginTimeoutError`, records the failure on the chain state, emits an escalation (existing PLAN-009 router), and lets the failure-mode resolver (SPEC-022-2-02) decide downstream behavior.

### Manifest Schema Addition (`plugin-manifest-v2.json`)

Inside the existing `produces` object schema:

```json
"timeout_seconds": {
  "type": "integer",
  "minimum": 5,
  "maximum": 1800,
  "description": "Per-plugin override for chains.per_plugin_timeout_seconds. Optional."
}
```

## Acceptance Criteria

- [ ] `autonomous-dev config init --global` writes a config containing `chains.max_length=10`, `chains.per_plugin_timeout_seconds=120`, `chains.per_chain_timeout_seconds=600`, `chains.max_artifact_size_mb=10`, `chains.max_concurrent_chains=3`.
- [ ] `autonomous-dev config validate` against a config with values outside the schema ranges (e.g. `max_length: 0` or `per_plugin_timeout_seconds: 4`) exits non-zero with a validation error naming the offending field.
- [ ] `autonomous-dev config validate` against a config with the documented defaults exits zero.
- [ ] A fixture plugin that resolves after 5ms completes normally with the global 120s timeout in effect (no false-positive timeout).
- [ ] A fixture plugin that resolves after 130 simulated seconds is killed at exactly 120 simulated seconds (using vitest fake timers) and the executor receives a `PluginTimeoutError` with `plugin_id`, `timeout_ms=120000`, and `chain_id`.
- [ ] A manifest declaring `produces.timeout_seconds: 30` overrides the global 120s; a 40-second invocation is killed at 30s.
- [ ] A timed-out invocation does not leak `setTimeout` handles (verified by counting handles before and after via `process._getActiveHandles()` in test).
- [ ] `PluginTimeoutError` extends `ChainError` and serializes to JSON with `name`, `plugin_id`, `timeout_ms`, `chain_id` fields preserved.
- [ ] Unit-test coverage on the new timeout-related code paths in `executor.ts` is ≥95% (line + branch).

## Dependencies

- **Blocked by**: PLAN-022-1 must be merged so `ChainExecutor`, `pluginRunner.invoke()`, the `produces` manifest section, and the `ChainError` base class exist.
- Consumes: PLAN-009-X escalation router for the timeout-triggered escalation (existing on main).
- No new npm packages introduced.

## Notes

- Timeout uses wall-clock (`setTimeout`) on purpose: chains run inside the daemon's event loop and the goal is to prevent indefinite waits, not to enforce CPU budgets. CPU profiling is out of scope.
- We deliberately do NOT call `worker.terminate()` or `child.kill()` on timeout: PLAN-022-1's `pluginRunner.invoke()` returns a promise from an in-process invocation. If a future plan moves invocation into a worker thread or subprocess, this spec's timeout still fires, but a follow-up will be needed to also signal the worker. Documented as a future enhancement.
- The `per_chain_timeout_seconds` field is reserved here for SPEC-022-2-02; it is added to the schema and defaults now so operators do not see config churn between specs.
- Per-plugin override via `timeout_seconds` is intentionally on the produces declaration (not a top-level manifest field) so plugins that produce multiple artifacts can have different budgets per output. Most plugins produce exactly one artifact, in which case the placement does not matter.
- Mocked timers (vitest `vi.useFakeTimers()`) are mandatory in tests; do NOT introduce real `await sleep(120_000)` calls — the suite must complete in seconds.

# SPEC-022-2-02: Chain-Length, Artifact-Size, Concurrent-Chain Limits + Per-Declaration Failure Mode

## Metadata
- **Parent Plan**: PLAN-022-2
- **Tasks Covered**: Task 3 (chain-length + artifact-size limits), Task 4 (concurrent-chain cap), Task 5 (per-declaration `on_failure` mode)
- **Estimated effort**: 7.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-022-2-02-chain-artifact-concurrent-limits-and-failure-modes.md`

## Description
Round out the resource-budget enforcement layer of `ChainExecutor` by adding three structural limits and the per-declaration failure-mode semantics that govern how downstream plugins react when an upstream plugin fails (timeout from SPEC-022-2-01, schema violation, runtime exception, or one of the new limit errors here). Chain-length is enforced before execution (topological-order length vs `chains.max_length`), artifact-size is enforced at persist time inside `ArtifactRegistry.persist()`, and concurrent-chain cap is enforced at the executor entry point against an in-memory counter scoped to the daemon process.

The `on_failure: 'block' | 'warn' | 'ignore'` field is added to both `ProducesDeclaration` and `ConsumesDeclaration`. Default is `warn` (preserving PLAN-022-1 behavior). `block` halts the entire chain and propagates the upstream error; `warn` logs and skips downstream consumers (status quo); `ignore` continues including downstream consumers (which will then fail their consumes-validation if they require the missing artifact, surfacing as a separate consumer-side error).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/chains/executor.ts` | Modify | Pre-flight chain-length check, concurrent-chain semaphore, failure-mode resolver |
| `plugins/autonomous-dev/src/chains/artifact-registry.ts` | Modify | Size check inside `persist()` against `config.chains.max_artifact_size_mb` |
| `plugins/autonomous-dev/src/chains/errors.ts` | Modify | Add `ChainTooLongError`, `ArtifactTooLargeError`, `ConcurrentChainLimitError` |
| `plugins/autonomous-dev/schemas/plugin-manifest-v2.json` | Modify | Add `on_failure` enum to `produces` and `consumes` declaration schemas |
| `plugins/autonomous-dev/src/chains/types.ts` | Modify | Extend `ProducesDeclaration` and `ConsumesDeclaration` TS interfaces |
| `plugins/autonomous-dev/tests/chains/test-resource-limits.test.ts` | Create | Unit tests for length, size, concurrent-chain limits |
| `plugins/autonomous-dev/tests/chains/test-failure-modes.test.ts` | Create | Unit tests for `block` / `warn` / `ignore` paths |

## Implementation Details

### New Error Types

```ts
export class ChainTooLongError extends ChainError {
  constructor(public readonly chain_path: string[], public readonly max_length: number) {
    super(`Chain length ${chain_path.length} exceeds max_length=${max_length}: ${chain_path.join(' -> ')}`);
    this.name = 'ChainTooLongError';
  }
}

export class ArtifactTooLargeError extends ChainError {
  constructor(
    public readonly artifact_id: string,
    public readonly producer_id: string,
    public readonly size_bytes: number,
    public readonly max_bytes: number,
  ) {
    super(`Artifact ${artifact_id} from ${producer_id} is ${size_bytes}B, exceeds cap ${max_bytes}B`);
    this.name = 'ArtifactTooLargeError';
  }
}

export class ConcurrentChainLimitError extends ChainError {
  constructor(public readonly active_count: number, public readonly cap: number) {
    super(`Cannot start chain: ${active_count} chains active, cap=${cap}`);
    this.name = 'ConcurrentChainLimitError';
  }
}
```

### Chain-Length Pre-Flight

After topological sort in `ChainExecutor.execute()`, before invoking the first plugin:

```ts
const order = this.dependencyGraph.topologicalOrder();
if (order.length > this.config.chains.max_length) {
  throw new ChainTooLongError(order.map(p => p.id), this.config.chains.max_length);
}
```

### Artifact Size Cap (`artifact-registry.ts`)

Inside `persist(artifact)`:

```ts
const serialized = JSON.stringify(artifact);
const sizeBytes = Buffer.byteLength(serialized, 'utf8');
const capBytes = this.config.chains.max_artifact_size_mb * 1024 * 1024;
if (sizeBytes > capBytes) {
  throw new ArtifactTooLargeError(artifact.id, artifact.producer_id, sizeBytes, capBytes);
}
// continue existing persist logic
```

The thrown error bubbles up to `ChainExecutor`, which marks the producer plugin's invocation as failed (does NOT crash the executor). Failure-mode resolver then decides downstream behavior.

### Concurrent-Chain Semaphore

Daemon-scoped counter (NOT per-request — request boundary is loose for concurrent triggers):

```ts
class ChainExecutor {
  private static activeChains = 0;

  async execute(graph: ChainGraph, ctx: ChainContext): Promise<ChainResult> {
    if (ChainExecutor.activeChains >= this.config.chains.max_concurrent_chains) {
      throw new ConcurrentChainLimitError(
        ChainExecutor.activeChains,
        this.config.chains.max_concurrent_chains,
      );
    }
    ChainExecutor.activeChains += 1;
    try {
      return await this.runChain(graph, ctx);
    } finally {
      ChainExecutor.activeChains -= 1;
    }
  }
}
```

Static counter is acceptable: the daemon is single-process. If the codebase ever multi-instances the daemon, this becomes per-process, which is the desired semantic.

### `on_failure` Field

Manifest schema addition (applies to both `produces` and `consumes` items):

```json
"on_failure": {
  "type": "string",
  "enum": ["block", "warn", "ignore"],
  "default": "warn",
  "description": "Behavior when this declaration's plugin fails. block halts chain; warn skips downstream (default); ignore continues downstream regardless."
}
```

### Failure-Mode Resolver

```ts
private resolveFailureBehavior(failedPlugin: PluginRecord): 'block' | 'warn' | 'ignore' {
  // Producer's produces.on_failure wins; if absent, use consumer's consumes.on_failure; else default warn.
  const producesMode = failedPlugin.manifest.produces?.on_failure;
  if (producesMode) return producesMode;
  const consumerMode = this.findFirstConsumerOf(failedPlugin)?.manifest.consumes?.on_failure;
  return consumerMode ?? 'warn';
}

private async handlePluginFailure(plugin: PluginRecord, error: Error): Promise<FailureDecision> {
  const mode = this.resolveFailureBehavior(plugin);
  this.recordFailure(plugin.id, error, mode);
  switch (mode) {
    case 'block':  return { stopChain: true, skipDownstream: true };
    case 'warn':   return { stopChain: false, skipDownstream: true };
    case 'ignore': return { stopChain: false, skipDownstream: false };
  }
}
```

## Acceptance Criteria

- [ ] A chain whose topological order has length 12 is rejected with `ChainTooLongError` when `max_length=10`; the error's `chain_path` contains all 12 plugin IDs in order.
- [ ] A chain of length 10 with `max_length=10` executes (boundary inclusive).
- [ ] An artifact whose JSON serialization is 11MB is rejected by `ArtifactRegistry.persist()` with `ArtifactTooLargeError` when `max_artifact_size_mb=10`; the error includes `size_bytes` and `max_bytes` (10485760).
- [ ] An artifact of exactly 10MB (10485760 bytes) is accepted (boundary inclusive).
- [ ] When an artifact is rejected for size, the producer plugin's invocation is recorded as failed but the executor does not throw out of `runChain`; downstream behavior follows the failure-mode resolver.
- [ ] With `max_concurrent_chains=3` and 3 chains in flight (held open by an unresolved fixture promise), a 4th call to `execute()` throws `ConcurrentChainLimitError` with `active_count=3`, `cap=3`.
- [ ] When one of the 3 in-flight chains completes, a 4th call to `execute()` succeeds.
- [ ] Concurrent-chain counter is decremented even when `runChain` throws (verified by completing 3 chains where one throws, then starting a 4th successfully).
- [ ] A plugin with `produces.on_failure: 'block'` that throws halts the chain: no downstream plugins invoked, `runChain` returns a result with `outcome: 'blocked'` and the upstream error attached.
- [ ] A plugin with `produces.on_failure: 'warn'` that throws causes downstream consumers to be skipped; non-consumers in the topological order still run.
- [ ] A plugin with `produces.on_failure: 'ignore'` that throws causes downstream consumers to be invoked; consumers that strictly require the missing artifact then fail their own consumes-validation (separate error, expected).
- [ ] If a producer omits `on_failure`, the resolver falls back to the consumer's `consumes.on_failure`; if both omit, defaults to `warn`.
- [ ] Unit-test coverage on resource-limit and failure-mode code paths is ≥95% (line + branch).

## Dependencies

- **Blocked by**: SPEC-022-2-01 (provides the `chains` config section that this spec reads from).
- **Blocked by**: PLAN-022-1 (provides `ChainExecutor`, `ArtifactRegistry`, `ProducesDeclaration`, `ConsumesDeclaration`).
- No new npm packages introduced.

## Notes

- The artifact-size check is at JSON-serialization time, not raw-object time, because that is the byte cost the daemon actually pays (disk I/O, AJV validation, telemetry transport). For chains that include large blob outputs (binary patches, screenshots), a future enhancement will allow `artifact_blob` references with on-disk side files; that path is out of scope here.
- The static concurrent-chain counter is intentional and documented. If a test creates two `ChainExecutor` instances in the same process, they share the counter — which matches production semantics and prevents test-only divergence.
- Concurrent-chain rejection is fail-fast (throw immediately) rather than queueing. Queueing is documented as a future enhancement; operators who need higher throughput raise `max_concurrent_chains`.
- `on_failure: 'block'` is the strictest mode and is intended for security-critical chains (e.g., a sandboxer that gates a code-fixer must `block` if the sandboxer fails). Operators should default to `block` for any privileged chain (SPEC-022-2-04).
- `on_failure: 'ignore'` exists for chains where downstream is independent of upstream (rare). The consumer-side validation will surface a distinct error if the artifact was actually required, which is the safer default than masking the missing data.

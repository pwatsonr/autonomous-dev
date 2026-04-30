# SPEC-019-2-04: HookExecutor Wiring & Performance Benchmark

## Metadata
- **Parent Plan**: PLAN-019-2 (Hook Output Validation Pipeline: AJV + Custom Formats)
- **Tasks Covered**: Task 7 (HookExecutor integration), Task 8 (performance benchmark)
- **Estimated effort**: 5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-2-04-executor-wiring-and-benchmark.md`

## Description
Wire the `ValidationPipeline` (SPEC-019-2-01 through -03) into the `HookExecutor` from PLAN-019-1 so every hook invocation is gated by input validation before the hook runs and output validation (with sanitization) after it returns. Then prove the validation overhead stays under budget with a performance benchmark that asserts < 5 ms p95 for a typical 100-field, ~5 KB payload on CI's `ubuntu-latest` Node 20 runner.

This spec is deliberately minimal on failure-mode semantics — the full block/warn/ignore matrix is owned by PLAN-019-4. Here, input failures cause the hook to be skipped (with a logged warning), and output failures cause the sanitized output to be returned (also with a warning). Stats are recorded for both paths via the integration from SPEC-019-2-03.

The benchmark is gated to a CI-only `npm test:perf` script so it doesn't slow the standard unit-test run. Output is captured as a workflow artifact for trend tracking.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/hooks/executor.ts` | Modify | Inject `ValidationPipeline`; add validation calls around hook invocation |
| `plugins/autonomous-dev/src/hooks/types.ts` | Modify | Add `ExecutorWarning` type if not present; thread through return shape |
| `plugins/autonomous-dev/tests/perf/test-validation-pipeline.bench.ts` | Create | Benchmark using `tinybench` (or built-in `node:perf_hooks`) |
| `plugins/autonomous-dev/package.json` | Modify | Add `tinybench@^2.9.0` to `devDependencies`; add `test:perf` script |
| `.github/workflows/ci.yml` | Modify | Add `test-perf` job that runs `npm run test:perf` and uploads artifact |

## Implementation Details

### HookExecutor Changes

The existing `HookExecutor` from PLAN-019-1 is assumed to expose:
```typescript
class HookExecutor {
  constructor(registry: HookRegistry, /* PLAN-019-1 deps */);
  async executeHooks(point: HookPoint, input: unknown): Promise<HookExecutionResult[]>;
}
```

Add a `ValidationPipeline` constructor parameter (required, not optional — every executor must validate):
```typescript
constructor(
  registry: HookRegistry,
  pipeline: ValidationPipeline,
  logger: Logger,
);
```

Modify `executeHooks` to wrap each hook invocation:
```typescript
async executeHooks(point: HookPoint, input: unknown): Promise<HookExecutionResult[]> {
  const results: HookExecutionResult[] = [];
  const hooks = this.registry.getHooks(point);

  for (const hook of hooks) {
    // 1. Input validation (gates execution)
    const inputResult = await this.pipeline.validateHookInput(
      point,
      hook.schemaVersion,
      input,
    );
    if (!inputResult.isValid) {
      this.logger.warn(
        `Skipping hook '${hook.pluginName}/${hook.name}' at point '${point}': input validation failed. ` +
        `Errors: ${JSON.stringify(inputResult.errors)}`,
      );
      results.push({
        hook,
        status: 'skipped-invalid-input',
        validationErrors: inputResult.errors,
      });
      continue;
    }

    // 2. Invoke hook with sanitized input (defaults applied, extras stripped)
    let rawOutput: unknown;
    try {
      rawOutput = await hook.invoke(inputResult.sanitizedOutput);
    } catch (err) {
      results.push({ hook, status: 'invocation-error', error: err });
      continue;
    }

    // 3. Output validation (sanitizes; does not block)
    const outputResult = await this.pipeline.validateHookOutput(
      point,
      hook.schemaVersion,
      rawOutput,
    );
    if (!outputResult.isValid) {
      this.logger.warn(
        `Hook '${hook.pluginName}/${hook.name}' at point '${point}' produced invalid output. ` +
        `Returning sanitized payload. Errors: ${JSON.stringify(outputResult.errors)}`,
      );
    }

    results.push({
      hook,
      status: outputResult.isValid ? 'success' : 'success-with-warnings',
      output: outputResult.sanitizedOutput, // ALWAYS return sanitized form
      validationErrors: outputResult.errors,
      warnings: [...inputResult.warnings, ...outputResult.warnings],
    });
  }

  return results;
}
```

Key invariants:
- Hook never receives raw caller input — always the sanitized, defaults-applied payload from `inputResult.sanitizedOutput`.
- Caller never receives raw hook output — always the sanitized payload from `outputResult.sanitizedOutput`.
- Input validation failure SKIPS the hook (does not throw).
- Output validation failure RETURNS the sanitized payload (does not throw); a warning is logged with the structured error list.
- Invocation errors (the hook function itself throws) are caught and recorded with `status: 'invocation-error'`. Validation errors are categorically separate from invocation errors.

### `HookExecutionResult` Shape

Extend (or add) the result type:
```typescript
export type HookExecutionStatus =
  | 'success'                  // ran cleanly, output validated
  | 'success-with-warnings'    // ran, output had to be sanitized
  | 'skipped-invalid-input'    // input failed validation, hook never ran
  | 'invocation-error';        // hook threw at runtime

export interface HookExecutionResult {
  hook: HookManifest;
  status: HookExecutionStatus;
  output?: unknown;
  validationErrors?: ValidationResult['errors'];
  warnings?: string[];
  error?: unknown; // populated only when status === 'invocation-error'
}
```

### Performance Benchmark

`tests/perf/test-validation-pipeline.bench.ts`:

```typescript
import { Bench } from 'tinybench';
import { ValidationPipeline } from '../../src/hooks/validation-pipeline.js';
import path from 'node:path';

// Synthetic 100-field, ~5 KB payload representative of a real hook output
const payload: Record<string, unknown> = {};
for (let i = 0; i < 100; i++) {
  payload[`field_${i}`] = i % 3 === 0
    ? `string-value-${i}-${'x'.repeat(20)}` // ~30 chars
    : i % 3 === 1
      ? i * 1000
      : { nested: `value-${i}`, count: i };
}

async function main() {
  const pipeline = new ValidationPipeline({
    schemasRoot: path.resolve(__dirname, '../../schemas/hooks'),
  });
  await pipeline.loadSchemas();

  // Warm-up: hot-cache the validator (excluded from measurement)
  for (let i = 0; i < 100; i++) {
    await pipeline.validateHookOutput('intake-post-classify', '1.0.0', payload);
  }

  const bench = new Bench({ time: 5000 }); // 5s per task
  bench.add('validateHookOutput (100 fields, ~5KB)', async () => {
    await pipeline.validateHookOutput('intake-post-classify', '1.0.0', payload);
  });

  await bench.run();

  const task = bench.tasks[0]!;
  const stats = task.result!;
  const p95Ms = stats.p95 / 1_000_000; // tinybench reports nanoseconds
  const p99Ms = stats.p99 / 1_000_000;

  console.log(JSON.stringify({
    task: task.name,
    samples: stats.samples.length,
    meanMs: stats.mean / 1_000_000,
    p50Ms: stats.p50 / 1_000_000,
    p95Ms,
    p99Ms,
  }, null, 2));

  if (p95Ms >= 5) {
    console.error(`FAIL: p95=${p95Ms.toFixed(3)}ms exceeds 5ms budget`);
    process.exit(1);
  }
  if (p99Ms >= 20) {
    console.error(`FAIL: p99=${p99Ms.toFixed(3)}ms exceeds 20ms budget`);
    process.exit(1);
  }
  console.log(`PASS: p95=${p95Ms.toFixed(3)}ms < 5ms, p99=${p99Ms.toFixed(3)}ms < 20ms`);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

`package.json` additions:
```json
{
  "scripts": {
    "test:perf": "tsx tests/perf/test-validation-pipeline.bench.ts | tee perf-results.json"
  },
  "devDependencies": {
    "tinybench": "^2.9.0"
  }
}
```

### CI Workflow Addition

In `.github/workflows/ci.yml`, add a job that runs after `test`:
```yaml
test-perf:
  needs: test
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: '20' }
    - run: npm ci
    - run: npm run test:perf
    - uses: actions/upload-artifact@v4
      if: always()
      with:
        name: perf-results
        path: perf-results.json
        retention-days: 30
```

The job uploads the JSON output even on failure so trend regressions are visible.

## Acceptance Criteria

### Executor Wiring

- [ ] `HookExecutor` constructor signature accepts `ValidationPipeline` as a required parameter; instantiating without one is a TypeScript error.
- [ ] A hook with valid input and valid output runs to completion; result has `status: 'success'`, `output` populated with the sanitized payload, `validationErrors` is empty/absent.
- [ ] A hook with invalid input (e.g., missing required field per its schema) is SKIPPED; result has `status: 'skipped-invalid-input'`, `validationErrors` populated, the hook's invoke function is never called (verified by spy/mock).
- [ ] A hook with valid input but invalid output (e.g., wrong type on a declared field) returns `status: 'success-with-warnings'`; the sanitized output is in `result.output`, `validationErrors` populated.
- [ ] A hook with extra (undeclared) output fields has them stripped from `result.output`. The original undeclared fields are NOT present in the returned object (verified by `Object.keys` snapshot).
- [ ] A hook with `x-allow-extensions: ["customField"]` declared in its output schema retains `customField` in `result.output`.
- [ ] A hook that throws during invocation produces `status: 'invocation-error'`, `error` populated; this is categorically distinct from validation failures.
- [ ] Skipped or invocation-errored hooks do NOT prevent subsequent hooks at the same point from running (verified with three fixture hooks: pass, fail-input, pass).
- [ ] Warning logs include the plugin name, hook name, and hook point — operators can identify the misbehaving hook from a single log line.
- [ ] `ValidationStats.getStats()` reflects every executor invocation: a run that processed 3 hooks (1 skipped at input, 2 ran to completion) shows `total=3` for input validation and `total=2` for output validation.

### Performance Benchmark

- [ ] `npm run test:perf` runs without errors locally and in CI.
- [ ] Benchmark output (JSON) includes `meanMs`, `p50Ms`, `p95Ms`, `p99Ms`, `samples` count.
- [ ] On `ubuntu-latest` / Node 20, `p95Ms < 5` for the 100-field synthetic payload.
- [ ] On `ubuntu-latest` / Node 20, `p99Ms < 20`.
- [ ] Benchmark exit code is 0 on pass, non-zero on budget breach (so CI fails loudly on regression).
- [ ] CI uploads `perf-results.json` as an artifact retained 30 days.
- [ ] Warm-up phase (excluded from measurement) runs 100 iterations to hot-cache the validator before measurement begins.
- [ ] Benchmark uses the actual `loadSchemas()` flow against the on-disk baseline schemas — not a mocked validator — to ensure realism.

## Dependencies

- **Blocked by**: SPEC-019-2-01 (pipeline class), SPEC-019-2-02 (formats/keywords), SPEC-019-2-03 (stats + baseline schemas), PLAN-019-1 (`HookExecutor`, `HookRegistry`, `HookManifest`).
- **Consumed by**: SPEC-019-2-05 (integration tests exercise the wired executor), PLAN-019-3 (trust gate runs after validation), PLAN-019-4 (failure-mode matrix replaces the skip-on-input-fail policy with the configurable block/warn/ignore semantics).
- New dev deps: `tinybench@^2.9.0`. No new runtime deps.

## Notes

- The "skip on input failure" policy here is provisional. PLAN-019-4 introduces `failure_mode: block | warn | ignore` per hook in the manifest, which will replace this policy. We chose "skip + warn" as the default because it is the safest neutral behavior: no data corruption (input never reaches a hook with bad shape), no silent loss (warning is logged), and it keeps the rest of the chain running.
- We deliberately ALWAYS return the sanitized output, even when validation succeeds. This guarantees consumers downstream of the executor can rely on the schema's contract — no surprise extra fields, no type coercion mismatches.
- The 5 ms p95 budget is for a 100-field, ~5 KB payload. Larger payloads will scale roughly linearly (AJV validation is O(n) in field count). Hooks that emit dramatically larger outputs should consider chunking or streaming instead of single-payload validation.
- Cold-start cost (first call after `loadSchemas()`) is excluded from the budget per the PLAN-019-2 risk register. The warm-up loop in the benchmark amortizes that cost before measurement begins.
- `tinybench` is preferred over `node:test`'s built-in `--test` mode for benchmarks because it computes stable percentiles natively and supports timed runs (vs fixed iteration counts), which is more robust on noisy CI runners.
- The CI artifact retention (30 days) gives enough history to spot regressions in subsequent PRs without ballooning storage. Long-term trend analysis would require a separate ingestion pipeline (out of scope here).
- We do NOT add the perf job to the required-checks set on PRs by default. Operators who want regression-blocking can opt in by promoting the job to a required check in branch protection. Documented in the workflow comment.

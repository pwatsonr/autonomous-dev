/**
 * Validation pipeline performance benchmark (SPEC-019-2-04, Task 8).
 *
 * Uses `node:perf_hooks` rather than tinybench to keep the dev-dep surface
 * lean. Asserts:
 *   - p95 < 5 ms for a 100-field, ~5 KB synthetic payload.
 *   - p99 < 20 ms.
 *
 * Output is a single JSON line written to stdout, captured by the
 * `npm run test:perf` invocation. Exit code is non-zero on budget breach.
 *
 * Run: `npx ts-node tests/perf/test-validation-pipeline.bench.ts` or via
 *      the npm script `test:perf`.
 */

import { performance } from 'node:perf_hooks';
import * as path from 'node:path';

import { ValidationPipeline } from '../../intake/hooks/validation-pipeline';

// --- Synthetic 100-field, ~5 KB payload representative of a real hook output ---
const payload: Record<string, unknown> = {};
for (let i = 0; i < 100; i += 1) {
  payload[`field_${i}`] =
    i % 3 === 0
      ? `string-value-${i}-${'x'.repeat(20)}` // ~30 chars
      : i % 3 === 1
        ? i * 1000
        : { nested: `value-${i}`, count: i };
}

const WARMUP_ITERATIONS = 100;
const MEASURED_ITERATIONS = 5000;
const BUDGET_P95_MS = 5;
const BUDGET_P99_MS = 20;

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[idx];
}

async function main(): Promise<void> {
  const schemasRoot = path.resolve(__dirname, '..', '..', 'schemas', 'hooks');
  const pipeline = new ValidationPipeline({ schemasRoot });
  await pipeline.loadSchemas();

  // Warm-up: hot-cache the validator (excluded from measurement).
  for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
    await pipeline.validateHookOutput('intake-post-classify', '1.0.0', payload);
  }

  const samples: number[] = new Array(MEASURED_ITERATIONS);
  for (let i = 0; i < MEASURED_ITERATIONS; i += 1) {
    const start = performance.now();
    await pipeline.validateHookOutput('intake-post-classify', '1.0.0', payload);
    samples[i] = performance.now() - start;
  }

  const meanMs = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p50Ms = percentile(samples, 0.5);
  const p95Ms = percentile(samples, 0.95);
  const p99Ms = percentile(samples, 0.99);

  const result = {
    task: 'validateHookOutput (100 fields, ~5KB)',
    samples: samples.length,
    meanMs,
    p50Ms,
    p95Ms,
    p99Ms,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));

  if (p95Ms >= BUDGET_P95_MS) {
    // eslint-disable-next-line no-console
    console.error(`FAIL: p95=${p95Ms.toFixed(3)}ms exceeds ${BUDGET_P95_MS}ms budget`);
    process.exit(1);
  }
  if (p99Ms >= BUDGET_P99_MS) {
    // eslint-disable-next-line no-console
    console.error(`FAIL: p99=${p99Ms.toFixed(3)}ms exceeds ${BUDGET_P99_MS}ms budget`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(
    `PASS: p95=${p95Ms.toFixed(3)}ms < ${BUDGET_P95_MS}ms, p99=${p99Ms.toFixed(3)}ms < ${BUDGET_P99_MS}ms`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

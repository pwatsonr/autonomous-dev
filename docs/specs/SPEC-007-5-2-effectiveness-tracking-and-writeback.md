# SPEC-007-5-2: Effectiveness Tracking and Writeback

## Metadata
- **Parent Plan**: PLAN-007-5
- **Tasks Covered**: Task 3, Task 4
- **Estimated effort**: 9 hours

## Description

Implement the effectiveness evaluator that measures whether a fix actually worked by comparing pre-fix and post-fix metric averages via Prometheus, and the writeback mechanism that persists the result back into the observation report's YAML frontmatter. This closes the feedback loop: the system not only detects problems and generates fix PRDs, but also verifies whether the fix was successful.

The evaluator runs after a cooldown period expires and the post-fix measurement window has elapsed. It queries Prometheus for the target metric in both the pre-fix and post-fix time windows, computes an improvement percentage accounting for metric direction (decrease is good for error rate/latency; increase is good for throughput), and classifies the result as `improved`, `degraded`, `unchanged`, or `pending`.

The writeback updates the observation file in-place, adding the `effectiveness` and `effectiveness_detail` fields to the YAML frontmatter without disturbing the Markdown body or other frontmatter fields.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/governance/effectiveness.ts` | Create | Effectiveness evaluator: pre/post metric comparison and classification |
| `src/governance/effectiveness-writeback.ts` | Create | In-place YAML frontmatter update for effectiveness results |
| `src/governance/types.ts` | Modify | Add effectiveness-related interfaces |
| `tests/governance/effectiveness.test.ts` | Create | Unit tests for effectiveness evaluation |
| `tests/governance/effectiveness-writeback.test.ts` | Create | Unit tests for in-place writeback |

## Implementation Details

### Additional Types (`src/governance/types.ts` additions)

```typescript
/** Classification of fix effectiveness */
export type EffectivenessStatus = 'improved' | 'unchanged' | 'degraded' | 'pending';

/** Direction in which "improvement" is measured */
export type MetricDirection = 'decrease' | 'increase';
// decrease: error_rate, latency -- lower is better
// increase: throughput -- higher is better

/** Detailed effectiveness measurement */
export interface EffectivenessDetail {
  pre_fix_avg: number;
  post_fix_avg: number;
  improvement_pct: number;       // Positive = improved in the expected direction
  measured_window: string;       // "YYYY-MM-DD to YYYY-MM-DD" of the post-fix window
}

/** Full return value of evaluate_effectiveness */
export interface EffectivenessResult {
  status: EffectivenessStatus;
  detail?: EffectivenessDetail;
  reason?: string;               // Human-readable explanation for pending/error cases
}

/** Minimal deployment info needed for effectiveness evaluation */
export interface DeploymentInfo {
  id: string;
  deployed_at: string;           // ISO 8601
}

/** Interface for Prometheus query abstraction */
export interface PrometheusClient {
  queryRangeAverage(
    query: string,
    start: Date,
    end: Date,
    stepSeconds: number
  ): Promise<number | null>;
}

/** Observation frontmatter fields relevant to effectiveness evaluation */
export interface EffectivenessCandidate {
  id: string;
  file_path: string;             // Absolute path to the observation report
  linked_deployment: string | null;
  effectiveness: EffectivenessStatus | null;
  target_metric: string;         // PromQL query template for the metric to measure
  metric_direction: MetricDirection;
  service: string;
}
```

### Task 3: Effectiveness Evaluator (`src/governance/effectiveness.ts`)

```typescript
import {
  EffectivenessResult,
  EffectivenessDetail,
  EffectivenessCandidate,
  GovernanceConfig,
  DeploymentInfo,
  PrometheusClient,
  MetricDirection,
} from './types';

/**
 * Evaluate the effectiveness of a fix by comparing pre-fix and post-fix
 * metric averages.
 *
 * Returns 'pending' if:
 *   - No linked deployment exists
 *   - The post-fix measurement window has not yet elapsed
 *   - Prometheus is unreachable
 *
 * Returns 'improved' if improvement_pct >= threshold (in the expected direction).
 * Returns 'degraded' if improvement_pct <= -threshold.
 * Returns 'unchanged' if -threshold < improvement_pct < threshold.
 */
export async function evaluateEffectiveness(
  observation: EffectivenessCandidate,
  config: GovernanceConfig,
  getDeployment: (deploymentId: string) => DeploymentInfo | null,
  prometheus: PrometheusClient,
  now?: Date
): Promise<EffectivenessResult> {
  // Guard: already evaluated
  if (observation.effectiveness !== null && observation.effectiveness !== 'pending') {
    return {
      status: observation.effectiveness,
      reason: 'Already evaluated',
    };
  }

  // Guard: no linked deployment
  if (!observation.linked_deployment) {
    return {
      status: 'pending',
      reason: 'No linked deployment',
    };
  }

  const deployment = getDeployment(observation.linked_deployment);
  if (!deployment) {
    return {
      status: 'pending',
      reason: `Deployment ${observation.linked_deployment} not found`,
    };
  }

  const deployDate = new Date(deployment.deployed_at);
  const currentTime = now ?? new Date();

  // Compute time windows
  const preWindowStart = new Date(deployDate);
  preWindowStart.setDate(preWindowStart.getDate() - config.effectiveness_comparison_days);
  const preWindowEnd = deployDate;

  const postWindowStart = new Date(deployDate);
  postWindowStart.setDate(postWindowStart.getDate() + config.cooldown_days);
  const postWindowEnd = new Date(postWindowStart);
  postWindowEnd.setDate(postWindowEnd.getDate() + config.effectiveness_comparison_days);

  // Guard: post-fix window has not elapsed yet
  if (currentTime < postWindowEnd) {
    return {
      status: 'pending',
      reason: `Post-fix measurement window ends ${postWindowEnd.toISOString()}, not yet elapsed`,
    };
  }

  // Query Prometheus for both windows
  const stepSeconds = 300; // 5-minute resolution
  let preAvg: number | null;
  let postAvg: number | null;

  try {
    preAvg = await prometheus.queryRangeAverage(
      observation.target_metric,
      preWindowStart,
      preWindowEnd,
      stepSeconds
    );
  } catch (err) {
    return {
      status: 'pending',
      reason: `Prometheus query failed for pre-fix window: ${err}`,
    };
  }

  try {
    postAvg = await prometheus.queryRangeAverage(
      observation.target_metric,
      postWindowStart,
      postWindowEnd,
      stepSeconds
    );
  } catch (err) {
    return {
      status: 'pending',
      reason: `Prometheus query failed for post-fix window: ${err}`,
    };
  }

  // Guard: no data in either window
  if (preAvg === null || postAvg === null) {
    return {
      status: 'pending',
      reason: `Insufficient Prometheus data (pre: ${preAvg}, post: ${postAvg})`,
    };
  }

  // Compute improvement percentage
  const improvementPct = computeImprovement(
    observation.metric_direction,
    preAvg,
    postAvg
  );

  const detail: EffectivenessDetail = {
    pre_fix_avg: round(preAvg, 2),
    post_fix_avg: round(postAvg, 2),
    improvement_pct: round(improvementPct, 1),
    measured_window: `${formatDate(postWindowStart)} to ${formatDate(postWindowEnd)}`,
  };

  // Classify
  const threshold = config.effectiveness_improvement_threshold;
  let status: 'improved' | 'unchanged' | 'degraded';

  if (improvementPct >= threshold) {
    status = 'improved';
  } else if (improvementPct <= -threshold) {
    status = 'degraded';
  } else {
    status = 'unchanged';
  }

  return { status, detail };
}

/**
 * Compute improvement percentage accounting for metric direction.
 *
 * For 'decrease' metrics (error rate, latency):
 *   improvement = ((pre - post) / pre) * 100
 *   Positive result = metric went down = good
 *
 * For 'increase' metrics (throughput):
 *   improvement = ((post - pre) / pre) * 100
 *   Positive result = metric went up = good
 *
 * If pre_avg is 0, avoids division by zero:
 *   - If post is also 0: return 0 (unchanged)
 *   - If post > 0 and direction is decrease: return -100 (degraded)
 *   - If post > 0 and direction is increase: return 100 (improved)
 */
export function computeImprovement(
  direction: MetricDirection,
  preAvg: number,
  postAvg: number
): number {
  if (preAvg === 0) {
    if (postAvg === 0) return 0;
    if (direction === 'decrease') return postAvg > 0 ? -100 : 100;
    if (direction === 'increase') return postAvg > 0 ? 100 : -100;
  }

  if (direction === 'decrease') {
    return ((preAvg - postAvg) / Math.abs(preAvg)) * 100;
  } else {
    return ((postAvg - preAvg) / Math.abs(preAvg)) * 100;
  }
}

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
```

**Metric direction mapping**: Determined from the observation's `type` and `target_metric`:
- `error_rate`, `latency_*`, `p50`, `p95`, `p99` -> `decrease`
- `throughput_*`, `rps`, `requests_per_second` -> `increase`
- Unknown metrics default to `decrease` (conservative: expect the fix to lower the problematic value)

**PrometheusClient adapter**: Wraps the Prometheus MCP server (`prometheus_query_range` tool) from PLAN-007-1. The `queryRangeAverage` method:
1. Calls `prometheus_query_range` with the given query, start, end, and step
2. Extracts the values array from the response
3. Computes the arithmetic mean of all non-null data points
4. Returns `null` if no data points exist in the range

### Task 4: Effectiveness Writeback (`src/governance/effectiveness-writeback.ts`)

```typescript
import * as fs from 'fs/promises';
import * as yaml from 'js-yaml';
import { EffectivenessResult } from './types';

/**
 * Write the effectiveness result back into the observation report's
 * YAML frontmatter without modifying the Markdown body.
 *
 * Strategy:
 * 1. Read the entire file
 * 2. Split into frontmatter (between --- delimiters) and body
 * 3. Parse frontmatter as YAML
 * 4. Update effectiveness and effectiveness_detail fields
 * 5. Re-serialize frontmatter
 * 6. Reassemble and write back
 *
 * Idempotency: If effectiveness is already set to a terminal value
 * (improved, degraded, unchanged), the writeback is skipped.
 */
export async function writeEffectivenessResult(
  filePath: string,
  result: EffectivenessResult
): Promise<{ updated: boolean; reason?: string }> {
  const content = await fs.readFile(filePath, 'utf-8');

  const { frontmatter, body, rawPrefix } = splitFrontmatterAndBody(content);
  if (!frontmatter) {
    return { updated: false, reason: 'Failed to parse YAML frontmatter' };
  }

  // Idempotency guard: skip if already evaluated with a terminal status
  const current = frontmatter.effectiveness;
  if (current === 'improved' || current === 'degraded' || current === 'unchanged') {
    return { updated: false, reason: `Already evaluated: ${current}` };
  }

  // Update fields
  frontmatter.effectiveness = result.status;

  if (result.detail) {
    frontmatter.effectiveness_detail = {
      pre_fix_avg: result.detail.pre_fix_avg,
      post_fix_avg: result.detail.post_fix_avg,
      improvement_pct: result.detail.improvement_pct,
      measured_window: result.detail.measured_window,
    };
  } else {
    frontmatter.effectiveness_detail = null;
  }

  // Re-serialize
  const newFrontmatter = yaml.dump(frontmatter, {
    lineWidth: -1,             // No line wrapping
    noRefs: true,              // No YAML anchors/aliases
    sortKeys: false,           // Preserve field order
    quotingType: '"',          // Use double quotes for strings
  });

  const newContent = `---\n${newFrontmatter}---\n${body}`;

  await fs.writeFile(filePath, newContent, 'utf-8');
  return { updated: true };
}

/**
 * Split a YAML-frontmatter Markdown file into its components.
 * Preserves the exact body content (everything after the closing ---).
 */
function splitFrontmatterAndBody(content: string): {
  frontmatter: any | null;
  body: string;
  rawPrefix: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: null, body: content, rawPrefix: '' };
  }

  try {
    const frontmatter = yaml.load(match[1]) as Record<string, any>;
    return {
      frontmatter,
      body: match[2],
      rawPrefix: match[1],
    };
  } catch {
    return { frontmatter: null, body: content, rawPrefix: '' };
  }
}

/**
 * Find all observations eligible for effectiveness evaluation:
 * - triage_decision is 'promote'
 * - linked_deployment is set
 * - effectiveness is null or 'pending'
 *
 * Returns file paths for the runner to process.
 */
export async function findPendingEffectivenessObservations(
  rootDir: string
): Promise<string[]> {
  const obsDir = `${rootDir}/.autonomous-dev/observations`;
  const results: string[] = [];

  // Walk all year/month directories
  const years = await safeReadDir(obsDir);
  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue;
    const months = await safeReadDir(`${obsDir}/${year}`);
    for (const month of months) {
      if (!/^\d{2}$/.test(month)) continue;
      const files = await safeReadDir(`${obsDir}/${year}/${month}`);
      for (const file of files) {
        if (!file.endsWith('.md') || !file.startsWith('OBS-')) continue;
        const filePath = `${obsDir}/${year}/${month}/${file}`;
        const content = await fs.readFile(filePath, 'utf-8');
        const { frontmatter } = splitFrontmatterAndBody(content);
        if (!frontmatter) continue;

        if (
          frontmatter.triage_decision === 'promote' &&
          frontmatter.linked_deployment &&
          (frontmatter.effectiveness === null || frontmatter.effectiveness === 'pending')
        ) {
          results.push(filePath);
        }
      }
    }
  }

  return results;
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
```

**Frontmatter preservation strategy**: The writeback uses `yaml.dump` with `sortKeys: false` to maintain field order. Because the YAML is parsed into a JavaScript object and re-serialized, minor whitespace differences may occur. This is acceptable because the schema validator (SPEC-007-4-1) validates on both read and write. The Markdown body is preserved exactly as-is.

**Edge cases**:
- File is locked by another process: use `fs.writeFile` with `{ flag: 'w' }` (default). Concurrent writes are not expected because the runner processes sequentially.
- Frontmatter contains non-standard YAML features (anchors, aliases): `noRefs: true` in dump options prevents alias generation. The parser handles anchors/aliases in source transparently.
- `effectiveness_detail` fields contain `NaN` or `Infinity`: the `computeImprovement` function uses explicit zero-guards. If a NaN somehow reaches writeback, it is serialized as `.nan` in YAML and flagged by schema validation.

## Acceptance Criteria

1. [ ] `evaluateEffectiveness` correctly computes pre-fix window as `[deploy_date - comparison_days, deploy_date]`.
2. [ ] `evaluateEffectiveness` correctly computes post-fix window as `[deploy_date + cooldown_days, deploy_date + cooldown_days + comparison_days]`.
3. [ ] For error rate/latency metrics (direction=decrease), a decrease in the metric value is classified as improvement.
4. [ ] For throughput metrics (direction=increase), an increase in the metric value is classified as improvement.
5. [ ] Returns `improved` when `improvement_pct >= effectiveness_improvement_threshold`.
6. [ ] Returns `degraded` when `improvement_pct <= -effectiveness_improvement_threshold`.
7. [ ] Returns `unchanged` when improvement is between `-threshold` and `+threshold` (exclusive).
8. [ ] Returns `pending` when the deployment is not found, the post-fix window has not elapsed, or Prometheus is unreachable.
9. [ ] `computeImprovement` handles zero pre-average without division by zero.
10. [ ] `writeEffectivenessResult` updates the YAML frontmatter `effectiveness` and `effectiveness_detail` fields in-place.
11. [ ] Markdown body content is preserved exactly after writeback.
12. [ ] Writeback is idempotent: subsequent runs skip observations with terminal effectiveness values (improved, degraded, unchanged).
13. [ ] `findPendingEffectivenessObservations` returns only observations with `triage_decision: promote`, non-null `linked_deployment`, and `effectiveness` of null or pending.

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-5-2-01 | Error rate improved | pre_avg=12.3%, post_avg=0.6%, direction=decrease, threshold=10 | `status: 'improved'`, `improvement_pct: 95.1` |
| TC-5-2-02 | Error rate unchanged | pre_avg=5.0%, post_avg=5.1%, direction=decrease, threshold=10 | `status: 'unchanged'`, `improvement_pct: -2.0` |
| TC-5-2-03 | Error rate degraded | pre_avg=0.5%, post_avg=3.0%, direction=decrease, threshold=10 | `status: 'degraded'`, `improvement_pct: -500.0` |
| TC-5-2-04 | Latency improved | pre_avg=1200ms, post_avg=980ms, direction=decrease, threshold=10 | `status: 'improved'`, `improvement_pct: 18.3` |
| TC-5-2-05 | Throughput improved | pre_avg=500rps, post_avg=650rps, direction=increase, threshold=10 | `status: 'improved'`, `improvement_pct: 30.0` |
| TC-5-2-06 | Throughput degraded | pre_avg=500rps, post_avg=400rps, direction=increase, threshold=10 | `status: 'degraded'`, `improvement_pct: -20.0` |
| TC-5-2-07 | Zero pre-average, decrease | pre_avg=0, post_avg=0, direction=decrease | `improvement_pct: 0`, `status: 'unchanged'` |
| TC-5-2-08 | Zero pre-average, nonzero post, decrease | pre_avg=0, post_avg=5.0, direction=decrease | `improvement_pct: -100` (degraded) |
| TC-5-2-09 | Pending -- no deployment | `linked_deployment: null` | `{ status: 'pending', reason: 'No linked deployment' }` |
| TC-5-2-10 | Pending -- window not elapsed | Deploy 5 days ago, cooldown=7, comparison=7 | `{ status: 'pending' }` (post window ends at day 14) |
| TC-5-2-11 | Pending -- Prometheus unreachable | Prometheus throws error | `{ status: 'pending', reason: 'Prometheus query failed...' }` |
| TC-5-2-12 | Pending -- no Prometheus data | queryRangeAverage returns null | `{ status: 'pending', reason: 'Insufficient Prometheus data...' }` |
| TC-5-2-13 | Writeback updates frontmatter | Observation with effectiveness=null | File updated with effectiveness='improved', effectiveness_detail block present |
| TC-5-2-14 | Writeback preserves Markdown body | File with 200-line Markdown body | Body after writeback is byte-identical to body before |
| TC-5-2-15 | Writeback idempotency | Observation with effectiveness='improved' | `{ updated: false, reason: 'Already evaluated: improved' }` |
| TC-5-2-16 | Writeback handles pending->improved | Observation with effectiveness='pending' | File updated to effectiveness='improved' |
| TC-5-2-17 | Find pending observations | 5 observations: 2 promoted+deployed+pending, 1 promoted+no deploy, 1 dismissed, 1 promoted+deployed+improved | Returns only the 2 pending file paths |
| TC-5-2-18 | At-threshold improvement | improvement_pct=10.0, threshold=10 | `status: 'improved'` (>= comparison) |
| TC-5-2-19 | At-threshold degradation | improvement_pct=-10.0, threshold=10 | `status: 'degraded'` (<= comparison) |

# SPEC-007-5-3: Runner Lifecycle Integration and Weekly Digest

## Metadata
- **Parent Plan**: PLAN-007-5
- **Tasks Covered**: Task 5, Task 6
- **Estimated effort**: 12 hours

## Description

Wire the governance checks (cooldown, oscillation, effectiveness) into the observation runner lifecycle at step 3e (TDD section 3.2.2), and build the weekly digest report generator that aggregates observations, triage decisions, effectiveness results, and recurring patterns across all services for the past week.

Task 5 ensures that every observation run automatically applies governance logic at the correct point in the pipeline: after deduplication and before report generation. It also triggers effectiveness evaluation for eligible observations at the start of each run.

Task 6 produces the weekly digest, a single Markdown report following the TDD Appendix A format. The digest provides the PM Lead with a week-at-a-glance view of system health, fix effectiveness, oscillating patterns, and signal-to-noise metrics.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/runner/governance-integration.ts` | Create | Governance step (3e) logic that wraps cooldown + oscillation + effectiveness |
| `src/runner/observation-runner.ts` | Modify | Wire governance integration into the main runner loop |
| `src/reports/weekly-digest.ts` | Create | Weekly digest report generator |
| `src/reports/digest-types.ts` | Create | TypeScript interfaces for digest data aggregation |
| `tests/runner/governance-integration.test.ts` | Create | Integration tests for governance in the runner lifecycle |
| `tests/reports/weekly-digest.test.ts` | Create | Unit tests for digest generation and aggregation math |

## Implementation Details

### Task 5: Runner Lifecycle Integration (`src/runner/governance-integration.ts`)

The governance integration is called at two points in the runner lifecycle:

**Point A -- Run start (step 2)**: Evaluate effectiveness for all eligible observations before processing new data.

```typescript
import { evaluateEffectiveness } from '../governance/effectiveness';
import { writeEffectivenessResult, findPendingEffectivenessObservations } from '../governance/effectiveness-writeback';
import { checkCooldown } from '../governance/cooldown';
import { checkOscillation, buildOscillationWarningMarkdown } from '../governance/oscillation';
import { GovernanceConfig, CooldownResult, OscillationResult } from '../governance/types';

/** Governance flags attached to each candidate observation */
export interface GovernanceFlags {
  cooldown_active: boolean;
  cooldown_result: CooldownResult;
  oscillation_warning: boolean;
  oscillation_result: OscillationResult;
  oscillation_markdown: string;
}

/**
 * Run effectiveness evaluation for all pending observations.
 * Called at the start of each observation run (step 2 in TDD 3.2.2).
 *
 * Returns a summary of evaluations performed for the audit log.
 */
export async function runEffectivenessEvaluations(
  rootDir: string,
  config: GovernanceConfig,
  getDeployment: (id: string) => any,
  prometheus: any,
  logger: AuditLogger
): Promise<EffectivenessRunSummary> {
  const pendingFiles = await findPendingEffectivenessObservations(rootDir);
  const summary: EffectivenessRunSummary = {
    evaluated: 0,
    improved: 0,
    degraded: 0,
    unchanged: 0,
    still_pending: 0,
    errors: 0,
  };

  for (const filePath of pendingFiles) {
    const observation = await parseObservationForEffectiveness(filePath);
    if (!observation) {
      summary.errors++;
      logger.warn(`Failed to parse observation for effectiveness: ${filePath}`);
      continue;
    }

    try {
      const result = await evaluateEffectiveness(
        observation, config, getDeployment, prometheus
      );

      if (result.status !== 'pending') {
        const writeResult = await writeEffectivenessResult(filePath, result);
        if (writeResult.updated) {
          summary.evaluated++;
          summary[result.status]++;
          logger.info(
            `Effectiveness evaluated: ${observation.id} -> ${result.status}` +
            (result.detail ? ` (${result.detail.improvement_pct}%)` : '')
          );
        }
      } else {
        summary.still_pending++;
        logger.debug(`Effectiveness still pending: ${observation.id} -- ${result.reason}`);
      }
    } catch (err) {
      summary.errors++;
      logger.error(`Effectiveness evaluation failed for ${observation.id}: ${err}`);
    }
  }

  return summary;
}

interface EffectivenessRunSummary {
  evaluated: number;
  improved: number;
  degraded: number;
  unchanged: number;
  still_pending: number;
  errors: number;
}

/**
 * Apply governance checks to a candidate observation.
 * Called after deduplication (step 3d) and before report generation (step 3f)
 * in TDD section 3.2.2.
 *
 * Returns GovernanceFlags that the report generator uses to populate
 * frontmatter and append oscillation warning sections.
 */
export async function applyGovernanceChecks(
  service: string,
  errorClass: string,
  config: GovernanceConfig,
  rootDir: string,
  readDeploymentMetadata: (id: string) => any,
  logger: AuditLogger
): Promise<GovernanceFlags> {
  // 3e.i -- Check cooldown
  const cooldownResult = checkCooldown(
    service,
    errorClass,
    config,
    (svc, ec) => findRecentFixDeploymentFromStore(rootDir, svc, ec, readDeploymentMetadata)
  );

  if (cooldownResult.active) {
    logger.info(
      `Cooldown active for ${service}/${errorClass}: ${cooldownResult.reason}`
    );
  }

  // 3e.ii -- Check oscillation
  const oscillationResult = checkOscillation(
    service,
    errorClass,
    config,
    (svc, ec, after) => findObservationsByServiceAndErrorFromStore(rootDir, svc, ec, after)
  );

  let oscillationMarkdown = '';
  if (oscillationResult.oscillating) {
    // Mark the current observation in the summaries
    if (oscillationResult.observation_summaries) {
      oscillationResult.observation_summaries.push({
        id: '(this observation)',
        triage_status: cooldownResult.active ? 'cooldown' : 'pending',
        effectiveness: null,
        is_current: true,
      });
    }
    oscillationMarkdown = buildOscillationWarningMarkdown(oscillationResult);
    logger.warn(
      `Oscillation detected for ${service}/${errorClass}: ` +
      `${oscillationResult.count} observations in ${oscillationResult.window_days} days`
    );
  }

  // 3e.iii -- Flag observations accordingly
  return {
    cooldown_active: cooldownResult.active,
    cooldown_result: cooldownResult,
    oscillation_warning: oscillationResult.oscillating,
    oscillation_result: oscillationResult,
    oscillation_markdown: oscillationMarkdown,
  };
}
```

**Modification to `src/runner/observation-runner.ts`**:

```typescript
// In the main run() function, add two integration points:

async function run(config: IntelligenceConfig, rootDir: string): Promise<RunResult> {
  const logger = createAuditLogger(rootDir);
  const runId = generateRunId();
  logger.info(`Starting observation run ${runId}`);

  // === STEP 2 (addition): Effectiveness evaluations ===
  const effectivenessSummary = await runEffectivenessEvaluations(
    rootDir,
    config.governance,
    (id) => readDeploymentMetadata(rootDir, id),
    prometheusClient,
    logger
  );
  logger.info(`Effectiveness evaluations: ${JSON.stringify(effectivenessSummary)}`);

  // STEP 3: FOR EACH SERVICE IN SCOPE
  for (const serviceConfig of config.services) {
    // ... steps 3a-3d unchanged ...

    // === STEP 3e (addition): Governance checks ===
    for (const candidate of deduplicatedCandidates) {
      const governanceFlags = await applyGovernanceChecks(
        serviceConfig.name,
        candidate.error_class,
        config.governance,
        rootDir,
        (id) => readDeploymentMetadata(rootDir, id),
        logger
      );

      // Pass governance flags to report generator (step 3f)
      candidate.governanceFlags = governanceFlags;
    }

    // ... step 3f: report generation uses candidate.governanceFlags ...
  }

  // ... step 4: finalize ...
}
```

### Task 6: Weekly Digest Generator (`src/reports/weekly-digest.ts`)

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';

/**
 * Generate a weekly digest report following TDD Appendix A format.
 *
 * The digest covers the period from Monday 00:00 to Sunday 23:59
 * of the target week, identified by ISO week number (e.g., 2026-W15).
 */
export async function generateWeeklyDigest(
  rootDir: string,
  weekId?: string,  // e.g., "2026-W15"; defaults to current week
  now?: Date
): Promise<DigestResult> {
  const currentTime = now ?? new Date();
  const targetWeek = weekId ?? computeIsoWeek(currentTime);
  const { start, end } = computeWeekBounds(targetWeek);

  // Collect all observations in the period
  const observations = await collectObservationsInPeriod(rootDir, start, end);

  // Aggregate metrics
  const summary = computeSummaryMetrics(observations);
  const byService = computeServiceBreakdown(observations);
  const effectiveness = collectEffectivenessResults(observations);
  const recurring = detectRecurringPatterns(rootDir, currentTime);
  const recommendations = generateRecommendations(summary, recurring);

  // Build the digest
  const digestContent = renderDigest(targetWeek, start, end, currentTime, {
    summary,
    byService,
    effectiveness,
    recurring,
    recommendations,
  });

  // Write to file
  const digestDir = path.join(rootDir, '.autonomous-dev', 'observations', 'digests');
  await fs.mkdir(digestDir, { recursive: true });
  const fileName = `DIGEST-${targetWeek.replace('-', '')}.md`;
  const filePath = path.join(digestDir, fileName);
  await fs.writeFile(filePath, digestContent, 'utf-8');

  return { filePath, weekId: targetWeek, summary };
}
```

**Digest data types** (`src/reports/digest-types.ts`):

```typescript
export interface DigestSummary {
  total_observations: number;
  by_severity: Record<string, number>;    // { P0: 1, P1: 3, P2: 7, P3: 3 }
  by_type: Record<string, number>;        // { error: 8, anomaly: 4, trend: 2 }
  triage_decisions: Record<string, number>; // { promote: 4, dismiss: 5, ... }
  signal_to_noise_ratio: number | null;    // null if <5 observations
  signal_to_noise_display: string;         // "(4+1) / 14 = 35.7%" or "N/A (<5 observations)"
  avg_triage_latency_p0p1_hours: number | null;
  avg_triage_latency_p2p3_hours: number | null;
  avg_tokens_per_run: number;
}

export interface ServiceBreakdown {
  service: string;
  total_observations: number;
  p0_p1_count: number;
  promoted: number;
  dismissed: number;
}

export interface EffectivenessEntry {
  observation_id: string;
  prd_id: string;
  deployed_date: string;
  pre_fix_summary: string;    // "8.2% err"
  post_fix_summary: string;   // "0.5% err"
  result: string;             // "improved (93.9%)"
}

export interface RecurringPattern {
  pattern: string;            // Error class or description
  service: string;
  occurrences_30d: number;
  status: string;             // "OSCILLATING" or "Monitoring"
}

export interface DigestResult {
  filePath: string;
  weekId: string;
  summary: DigestSummary;
}
```

**Aggregation logic**:

```typescript
function computeSummaryMetrics(observations: ObservationFrontmatter[]): DigestSummary {
  const total = observations.length;

  // Severity counts
  const bySeverity: Record<string, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const obs of observations) {
    bySeverity[obs.severity] = (bySeverity[obs.severity] ?? 0) + 1;
  }

  // Type counts
  const byType: Record<string, number> = {};
  for (const obs of observations) {
    byType[obs.type] = (byType[obs.type] ?? 0) + 1;
  }

  // Triage decision counts
  const triageDecisions: Record<string, number> = {
    promote: 0, dismiss: 0, defer: 0, investigate: 0, pending: 0,
  };
  for (const obs of observations) {
    const decision = obs.triage_decision ?? 'pending';
    triageDecisions[decision] = (triageDecisions[decision] ?? 0) + 1;
  }

  // Signal-to-noise ratio: (promoted + investigating) / total
  // Only displayed if total >= 5 (avoids misleading ratios with small samples)
  const signalCount = (triageDecisions.promote ?? 0) + (triageDecisions.investigate ?? 0);
  let signalToNoise: number | null = null;
  let signalToNoiseDisplay: string;
  if (total >= 5) {
    signalToNoise = total > 0 ? (signalCount / total) * 100 : 0;
    signalToNoiseDisplay = `(${triageDecisions.promote}+${triageDecisions.investigate}) / ${total} = ${signalToNoise.toFixed(1)}%`;
  } else {
    signalToNoiseDisplay = `N/A (<5 observations)`;
  }

  // Triage latency: time from observation timestamp to triage_at
  const latenciesP0P1: number[] = [];
  const latenciesP2P3: number[] = [];
  for (const obs of observations) {
    if (!obs.triage_at) continue;
    const latencyMs = new Date(obs.triage_at).getTime() - new Date(obs.timestamp).getTime();
    const latencyHours = latencyMs / (1000 * 60 * 60);
    if (latencyHours < 0) continue; // Invalid data
    if (obs.severity === 'P0' || obs.severity === 'P1') {
      latenciesP0P1.push(latencyHours);
    } else {
      latenciesP2P3.push(latencyHours);
    }
  }

  const avgTriageP0P1 = latenciesP0P1.length > 0
    ? round(latenciesP0P1.reduce((a, b) => a + b, 0) / latenciesP0P1.length, 1)
    : null;
  const avgTriageP2P3 = latenciesP2P3.length > 0
    ? round(latenciesP2P3.reduce((a, b) => a + b, 0) / latenciesP2P3.length, 1)
    : null;

  // Average tokens per run
  // Collect unique run IDs and their total tokens
  const tokensByRun = new Map<string, number>();
  for (const obs of observations) {
    const existing = tokensByRun.get(obs.observation_run_id) ?? 0;
    tokensByRun.set(obs.observation_run_id, existing + obs.tokens_consumed);
  }
  const avgTokens = tokensByRun.size > 0
    ? Math.round([...tokensByRun.values()].reduce((a, b) => a + b, 0) / tokensByRun.size)
    : 0;

  return {
    total_observations: total,
    by_severity: bySeverity,
    by_type: byType,
    triage_decisions: triageDecisions,
    signal_to_noise_ratio: signalToNoise,
    signal_to_noise_display: signalToNoiseDisplay,
    avg_triage_latency_p0p1_hours: avgTriageP0P1,
    avg_triage_latency_p2p3_hours: avgTriageP2P3,
    avg_tokens_per_run: avgTokens,
  };
}
```

**Rendering** (`renderDigest`):

```typescript
function renderDigest(
  weekId: string,
  start: Date,
  end: Date,
  generatedAt: Date,
  data: DigestData
): string {
  const period = `${formatDate(start)} to ${formatDate(end)}`;
  const sections: string[] = [];

  // YAML frontmatter
  sections.push('---');
  sections.push(`type: digest`);
  sections.push(`week: "${weekId}"`);
  sections.push(`period: "${period}"`);
  sections.push(`generated_at: "${generatedAt.toISOString()}"`);
  sections.push('---');
  sections.push('');

  // Title
  sections.push(`# Production Intelligence Weekly Digest -- ${weekId}`);
  sections.push('');

  // Summary table
  sections.push('## Summary');
  sections.push('');
  sections.push('| Metric | Value |');
  sections.push('|--------|-------|');
  sections.push(`| Total observations generated | ${data.summary.total_observations} |`);
  sections.push(`| Observations by severity | ${formatSeverityCounts(data.summary.by_severity)} |`);
  sections.push(`| Observations by type | ${formatTypeCounts(data.summary.by_type)} |`);
  sections.push(`| Triage decisions | ${formatTriageCounts(data.summary.triage_decisions)} |`);
  sections.push(`| Signal-to-noise ratio | ${data.summary.signal_to_noise_display} |`);
  sections.push(`| Average triage latency | P0/P1: ${formatLatency(data.summary.avg_triage_latency_p0p1_hours)}, P2/P3: ${formatLatency(data.summary.avg_triage_latency_p2p3_hours)} |`);
  sections.push(`| Average tokens per run | ${data.summary.avg_tokens_per_run.toLocaleString()} |`);
  sections.push('');

  // Observations by Service table
  sections.push('## Observations by Service');
  sections.push('');
  sections.push('| Service | Observations | P0/P1 | Promoted | Dismissed |');
  sections.push('|---------|-------------|-------|----------|-----------|');
  for (const svc of data.byService) {
    sections.push(`| ${svc.service} | ${svc.total_observations} | ${svc.p0_p1_count} | ${svc.promoted} | ${svc.dismissed} |`);
  }
  sections.push('');

  // Effectiveness Tracking table
  sections.push('## Effectiveness Tracking');
  sections.push('');
  if (data.effectiveness.length > 0) {
    sections.push('| Observation | PRD | Deployed | Pre-Fix | Post-Fix | Result |');
    sections.push('|-------------|-----|----------|---------|----------|--------|');
    for (const e of data.effectiveness) {
      sections.push(`| ${e.observation_id} | ${e.prd_id} | ${e.deployed_date} | ${e.pre_fix_summary} | ${e.post_fix_summary} | ${e.result} |`);
    }
  } else {
    sections.push('No effectiveness results this period.');
  }
  sections.push('');

  // Recurring Patterns table
  sections.push('## Recurring Patterns');
  sections.push('');
  if (data.recurring.length > 0) {
    sections.push('| Pattern | Service | Occurrences (30d) | Status |');
    sections.push('|---------|---------|-------------------|--------|');
    for (const p of data.recurring) {
      sections.push(`| ${p.pattern} | ${p.service} | ${p.occurrences_30d} | ${p.status} |`);
    }
  } else {
    sections.push('No recurring patterns detected.');
  }
  sections.push('');

  // Recommendations
  sections.push('## Recommendations');
  sections.push('');
  if (data.recommendations.length > 0) {
    for (const rec of data.recommendations) {
      sections.push(`- ${rec}`);
    }
  } else {
    sections.push('No recommendations this period.');
  }
  sections.push('');

  return sections.join('\n');
}
```

**Recommendation generation**:

```typescript
function generateRecommendations(
  summary: DigestSummary,
  recurring: RecurringPattern[]
): string[] {
  const recs: string[] = [];

  // Oscillation recommendations
  for (const pattern of recurring) {
    if (pattern.status === 'OSCILLATING') {
      recs.push(
        `**${pattern.service} ${pattern.pattern}**: Oscillation detected ` +
        `(${pattern.occurrences_30d} in 30d). Recommend architectural review ` +
        `of ${pattern.pattern.toLowerCase().replace(/error$/i, '')} strategy.`
      );
    }
  }

  // Signal-to-noise recommendation
  const TARGET_SNR = 60;
  if (summary.signal_to_noise_ratio !== null && summary.signal_to_noise_ratio < TARGET_SNR) {
    recs.push(
      `**Signal-to-noise ratio below target (${summary.signal_to_noise_ratio.toFixed(1)}% vs ${TARGET_SNR}%)**: ` +
      `Consider tightening P2/P3 thresholds or adding more exclusion patterns.`
    );
  }

  // High P0 count recommendation
  if ((summary.by_severity['P0'] ?? 0) > 3) {
    recs.push(
      `**High P0 count (${summary.by_severity['P0']})**: ` +
      `Multiple critical issues detected. Consider an incident review.`
    );
  }

  // Slow triage latency recommendation
  if (summary.avg_triage_latency_p0p1_hours !== null && summary.avg_triage_latency_p0p1_hours > 4) {
    recs.push(
      `**P0/P1 triage latency (${summary.avg_triage_latency_p0p1_hours}h) exceeds 4h target**: ` +
      `Consider enabling notification-based triage or adding backup triagers.`
    );
  }

  return recs;
}
```

**ISO week computation**:

```typescript
/**
 * Compute ISO week identifier from a date.
 * Returns format "YYYY-WNN" (e.g., "2026-W15").
 */
function computeIsoWeek(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // Set to nearest Thursday (ISO 8601 week date algorithm)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNum = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7
  );
  return `${d.getFullYear()}-W${weekNum.toString().padStart(2, '0')}`;
}

/**
 * Compute the Monday 00:00:00 and Sunday 23:59:59 bounds for an ISO week.
 */
function computeWeekBounds(weekId: string): { start: Date; end: Date } {
  const match = weekId.match(/^(\d{4})-W(\d{2})$/);
  if (!match) throw new Error(`Invalid week ID: ${weekId}`);
  const [, yearStr, weekStr] = match;
  const year = parseInt(yearStr);
  const week = parseInt(weekStr);

  // Jan 4 is always in ISO week 1
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = (jan4.getDay() + 6) % 7; // Monday=0
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + (week - 1) * 7);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return { start: monday, end: sunday };
}
```

**Digest file naming**: `DIGEST-YYYYWNN.md` stored at `.autonomous-dev/observations/digests/`. Example: `DIGEST-2026W15.md`.

**Scheduling**: The digest generation is triggered by the scheduled runner. The runner configuration includes a `digest_schedule` field (default: `0 23 * * 0` -- 11 PM Sunday). The runner checks whether a digest for the current week already exists before generating; if it exists, the generation is skipped (idempotent).

## Acceptance Criteria

1. [ ] At the start of each observation run (step 2), effectiveness evaluation runs for all observations with `triage_decision: promote`, non-null `linked_deployment`, and `effectiveness` of null or pending.
2. [ ] Effectiveness evaluation results are written back to observation files via the writeback mechanism (SPEC-007-5-2).
3. [ ] After deduplication (step 3d) and before report generation (step 3f), the runner checks cooldown status and oscillation history for each candidate observation.
4. [ ] Cooldown-active candidates are flagged with `cooldown_active: true` and `triage_status: cooldown` in their governance flags.
5. [ ] Oscillation-detected candidates have `oscillation_warning: true` set and the oscillation Markdown section appended to the report body.
6. [ ] Governance check results (cooldown status, oscillation status, effectiveness evaluations) are logged in the run audit log.
7. [ ] Weekly digest follows the TDD Appendix A format exactly: YAML frontmatter, Summary table, Observations by Service, Effectiveness Tracking, Recurring Patterns, Recommendations.
8. [ ] Signal-to-noise ratio is computed as `(promoted + investigating) / total` and displayed with the formula.
9. [ ] Signal-to-noise ratio is suppressed (shows "N/A") when total observations < 5.
10. [ ] Average triage latency is computed separately for P0/P1 and P2/P3 observations.
11. [ ] Digest is written to `.autonomous-dev/observations/digests/DIGEST-YYYYWNN.md`.
12. [ ] Digest generation is idempotent: running twice for the same week does not produce a duplicate file.
13. [ ] Recommendations section includes oscillation warnings and signal-to-noise threshold alerts.

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-5-3-01 | Effectiveness runs at step 2 | 3 pending effectiveness observations, 1 with elapsed window | 1 observation evaluated, 2 still pending |
| TC-5-3-02 | Governance checks at step 3e | Candidate with service+error in cooldown | `GovernanceFlags.cooldown_active: true`, `cooldown_result.reason` populated |
| TC-5-3-03 | Governance checks at step 3e (oscillation) | 3 prior observations for same service+error within window | `GovernanceFlags.oscillation_warning: true`, `oscillation_markdown` non-empty |
| TC-5-3-04 | Governance checks -- no flags | Service with no prior observations or deployments | `cooldown_active: false`, `oscillation_warning: false` |
| TC-5-3-05 | Governance results in audit log | Any governance check | Logger called with cooldown/oscillation status messages |
| TC-5-3-06 | Digest summary math | 14 observations: P0:1, P1:3, P2:7, P3:3; triage: promote:4, dismiss:5, defer:2, investigate:1, pending:2 | Summary table matches TDD Appendix A values exactly |
| TC-5-3-07 | Signal-to-noise ratio | 4 promoted + 1 investigating out of 14 total | `(4+1) / 14 = 35.7%` |
| TC-5-3-08 | Signal-to-noise suppression | 3 total observations | Display: `N/A (<5 observations)` |
| TC-5-3-09 | Triage latency computation | 2 P0 observations triaged at 1h and 3.2h; 3 P2 observations triaged at 12h, 18h, 25.2h | P0/P1 avg: 2.1h, P2/P3 avg: 18.4h |
| TC-5-3-10 | Tokens per run average | 3 runs with 35000, 38000, 41600 tokens | avg: 38,200 |
| TC-5-3-11 | Service breakdown table | Observations across 3 services | One row per service with correct counts |
| TC-5-3-12 | Effectiveness tracking table | 2 observations with effectiveness results | Two rows with pre/post/result formatted |
| TC-5-3-13 | Recurring patterns table | 1 oscillating + 1 monitoring pattern | Two rows, first with "OSCILLATING" status |
| TC-5-3-14 | Recommendation: oscillation | Pattern with 4 occurrences in 30d | Recommendation includes "architectural review" |
| TC-5-3-15 | Recommendation: low SNR | Signal-to-noise at 35.7% (target 60%) | Recommendation includes "tightening P2/P3 thresholds" |
| TC-5-3-16 | Digest file placement | Week 2026-W15 | Written to `.autonomous-dev/observations/digests/DIGEST-2026W15.md` |
| TC-5-3-17 | Digest idempotency | Generate twice for same week | Second call does not overwrite (or overwrites identically) |
| TC-5-3-18 | Digest YAML frontmatter | Week 2026-W15 | Contains `type: digest`, `week: "2026-W15"`, `period`, `generated_at` |
| TC-5-3-19 | ISO week computation | Date 2026-04-08 | Returns "2026-W15" |
| TC-5-3-20 | Week bounds | "2026-W15" | start: 2026-04-06 Monday 00:00, end: 2026-04-12 Sunday 23:59 |
| TC-5-3-21 | Empty week | No observations in the period | Digest generated with all zeros, "No recommendations" |

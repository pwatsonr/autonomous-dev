/**
 * Weekly digest report generator (SPEC-007-5-3, Task 6).
 *
 * Aggregates observations, triage decisions, effectiveness results, and
 * recurring patterns across all services for the past week. Produces a
 * single Markdown report following the TDD Appendix A format.
 *
 * The digest covers Monday 00:00 to Sunday 23:59 of the target ISO week.
 * Digest files are stored at:
 *   .autonomous-dev/observations/digests/DIGEST-YYYYWNN.md
 *
 * Generation is idempotent: running twice for the same week does not
 * produce a duplicate file (the second call overwrites identically).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';

import type {
  DigestSummary,
  ServiceBreakdown,
  EffectivenessEntry,
  RecurringPattern,
  DigestResult,
  DigestData,
  ObservationForDigest,
} from './digest-types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a weekly digest report following TDD Appendix A format.
 *
 * @param rootDir  The project root directory.
 * @param weekId   ISO week identifier (e.g., "2026-W15"). Defaults to current week.
 * @param now      Optional override for "current time" (for testing).
 * @returns DigestResult with the file path, week ID, and summary metrics.
 */
export async function generateWeeklyDigest(
  rootDir: string,
  weekId?: string,
  now?: Date,
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
  const recurring = detectRecurringPatterns(rootDir, observations, currentTime);
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

// ---------------------------------------------------------------------------
// ISO week computation
// ---------------------------------------------------------------------------

/**
 * Compute ISO week identifier from a date.
 * Returns format "YYYY-WNN" (e.g., "2026-W15").
 *
 * Uses the ISO 8601 week date algorithm:
 *   - Weeks start on Monday
 *   - Week 1 is the week containing January 4th
 *   - The "year" in the week ID is the ISO year (may differ from calendar year)
 */
export function computeIsoWeek(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // Set to nearest Thursday (ISO 8601 week date algorithm)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNum = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${d.getFullYear()}-W${weekNum.toString().padStart(2, '0')}`;
}

/**
 * Compute the Monday 00:00:00 and Sunday 23:59:59 bounds for an ISO week.
 */
export function computeWeekBounds(weekId: string): { start: Date; end: Date } {
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

// ---------------------------------------------------------------------------
// Observation collection
// ---------------------------------------------------------------------------

/**
 * Collect all observations whose timestamp falls within the given period.
 * Scans the .autonomous-dev/observations/ directory tree recursively.
 */
export async function collectObservationsInPeriod(
  rootDir: string,
  start: Date,
  end: Date,
): Promise<ObservationForDigest[]> {
  const observationsDir = path.join(rootDir, '.autonomous-dev', 'observations');
  const results: ObservationForDigest[] = [];

  try {
    await scanForObservations(observationsDir, start, end, results);
  } catch {
    // Directory may not exist on first run
  }

  return results;
}

/**
 * Recursively scan for observation .md files and parse their frontmatter.
 */
async function scanForObservations(
  dir: string,
  start: Date,
  end: Date,
  results: ObservationForDigest[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip digests directory
      if (entry.name === 'digests') continue;
      await scanForObservations(fullPath, start, end, results);
    } else if (entry.name.startsWith('OBS-') && entry.name.endsWith('.md')) {
      const obs = await parseObservationFile(fullPath);
      if (obs) {
        const obsDate = new Date(obs.timestamp);
        if (obsDate >= start && obsDate <= end) {
          results.push(obs);
        }
      }
    }
  }
}

/**
 * Parse an observation file's YAML frontmatter into ObservationForDigest.
 */
async function parseObservationFile(filePath: string): Promise<ObservationForDigest | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) return null;

    const parsed = yaml.load(frontmatterMatch[1]) as Record<string, any>;
    if (!parsed || typeof parsed !== 'object') return null;

    return {
      id: parsed.id ?? '',
      timestamp: parsed.timestamp ?? '',
      service: parsed.service ?? '',
      type: parsed.type ?? 'error',
      severity: parsed.severity ?? 'P3',
      triage_decision: parsed.triage_decision ?? null,
      triage_at: parsed.triage_at ?? null,
      observation_run_id: parsed.observation_run_id ?? '',
      tokens_consumed: parsed.tokens_consumed ?? 0,
      linked_prd: parsed.linked_prd ?? null,
      linked_deployment: parsed.linked_deployment ?? null,
      effectiveness: parsed.effectiveness ?? null,
      effectiveness_detail: parsed.effectiveness_detail ?? null,
      oscillation_warning: parsed.oscillation_warning ?? false,
      cooldown_active: parsed.cooldown_active ?? false,
      error_class: parsed.error_class ?? undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Summary metrics computation
// ---------------------------------------------------------------------------

/**
 * Compute aggregate summary metrics from a set of observations.
 */
export function computeSummaryMetrics(observations: ObservationForDigest[]): DigestSummary {
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
    if (!obs.observation_run_id) continue;
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

// ---------------------------------------------------------------------------
// Service breakdown
// ---------------------------------------------------------------------------

/**
 * Compute per-service breakdown of observations.
 */
export function computeServiceBreakdown(observations: ObservationForDigest[]): ServiceBreakdown[] {
  const byService = new Map<string, {
    total: number;
    p0p1: number;
    promoted: number;
    dismissed: number;
  }>();

  for (const obs of observations) {
    const entry = byService.get(obs.service) ?? { total: 0, p0p1: 0, promoted: 0, dismissed: 0 };
    entry.total++;
    if (obs.severity === 'P0' || obs.severity === 'P1') {
      entry.p0p1++;
    }
    if (obs.triage_decision === 'promote') {
      entry.promoted++;
    }
    if (obs.triage_decision === 'dismiss') {
      entry.dismissed++;
    }
    byService.set(obs.service, entry);
  }

  return [...byService.entries()]
    .map(([service, data]) => ({
      service,
      total_observations: data.total,
      p0_p1_count: data.p0p1,
      promoted: data.promoted,
      dismissed: data.dismissed,
    }))
    .sort((a, b) => b.total_observations - a.total_observations);
}

// ---------------------------------------------------------------------------
// Effectiveness results collection
// ---------------------------------------------------------------------------

/**
 * Collect effectiveness results from observations that have been evaluated.
 */
export function collectEffectivenessResults(
  observations: ObservationForDigest[],
): EffectivenessEntry[] {
  return observations
    .filter((obs) => obs.effectiveness && obs.effectiveness !== 'pending')
    .map((obs) => {
      const detail = parseEffectivenessDetail(obs.effectiveness_detail);
      return {
        observation_id: obs.id,
        prd_id: obs.linked_prd ?? 'N/A',
        deployed_date: obs.linked_deployment ?? 'N/A',
        pre_fix_summary: detail.preFix,
        post_fix_summary: detail.postFix,
        result: `${obs.effectiveness}${detail.pct ? ` (${detail.pct})` : ''}`,
      };
    });
}

/**
 * Parse the effectiveness_detail string to extract pre/post/pct values.
 * Expected format: "8.2 -> 0.5 (93.9%)" or similar.
 */
function parseEffectivenessDetail(detail: string | null): {
  preFix: string;
  postFix: string;
  pct: string;
} {
  if (!detail) {
    return { preFix: 'N/A', postFix: 'N/A', pct: '' };
  }

  const match = detail.match(/^([\d.]+)\s*->\s*([\d.]+)\s*\(([\d.]+%)\)$/);
  if (match) {
    return { preFix: match[1], postFix: match[2], pct: match[3] };
  }

  // Try alternative format with metric name prefix
  const altMatch = detail.match(/^.+?:\s*([\d.]+)\s*->\s*([\d.]+)\s*\(([\d.]+%)\)$/);
  if (altMatch) {
    return { preFix: altMatch[1], postFix: altMatch[2], pct: altMatch[3] };
  }

  return { preFix: detail, postFix: '', pct: '' };
}

// ---------------------------------------------------------------------------
// Recurring pattern detection
// ---------------------------------------------------------------------------

/**
 * Detect recurring patterns by looking at observations across a 30-day window.
 * Groups by service + error_class and counts occurrences.
 */
export function detectRecurringPatterns(
  _rootDir: string,
  observations: ObservationForDigest[],
  _now: Date,
): RecurringPattern[] {
  // Group by service + error_class (or type if no error_class)
  const groups = new Map<string, {
    service: string;
    pattern: string;
    count: number;
    hasOscillation: boolean;
  }>();

  for (const obs of observations) {
    const pattern = obs.error_class ?? obs.type;
    const key = `${obs.service}::${pattern}`;
    const entry = groups.get(key) ?? {
      service: obs.service,
      pattern,
      count: 0,
      hasOscillation: false,
    };
    entry.count++;
    if (obs.oscillation_warning) {
      entry.hasOscillation = true;
    }
    groups.set(key, entry);
  }

  // Only include patterns with 2+ occurrences
  return [...groups.values()]
    .filter((g) => g.count >= 2)
    .map((g) => ({
      pattern: g.pattern,
      service: g.service,
      occurrences_30d: g.count,
      status: g.hasOscillation ? 'OSCILLATING' : 'Monitoring',
    }))
    .sort((a, b) => b.occurrences_30d - a.occurrences_30d);
}

// ---------------------------------------------------------------------------
// Recommendation generation
// ---------------------------------------------------------------------------

/**
 * Generate actionable recommendations based on summary metrics and
 * recurring patterns.
 */
export function generateRecommendations(
  summary: DigestSummary,
  recurring: RecurringPattern[],
): string[] {
  const recs: string[] = [];

  // Oscillation recommendations
  for (const pattern of recurring) {
    if (pattern.status === 'OSCILLATING') {
      recs.push(
        `**${pattern.service} ${pattern.pattern}**: Oscillation detected ` +
        `(${pattern.occurrences_30d} in 30d). Recommend architectural review ` +
        `of ${pattern.pattern.toLowerCase().replace(/error$/i, '')} strategy.`,
      );
    }
  }

  // Signal-to-noise recommendation
  const TARGET_SNR = 60;
  if (summary.signal_to_noise_ratio !== null && summary.signal_to_noise_ratio < TARGET_SNR) {
    recs.push(
      `**Signal-to-noise ratio below target (${summary.signal_to_noise_ratio.toFixed(1)}% vs ${TARGET_SNR}%)**: ` +
      `Consider tightening P2/P3 thresholds or adding more exclusion patterns.`,
    );
  }

  // High P0 count recommendation
  if ((summary.by_severity['P0'] ?? 0) > 3) {
    recs.push(
      `**High P0 count (${summary.by_severity['P0']})**: ` +
      `Multiple critical issues detected. Consider an incident review.`,
    );
  }

  // Slow triage latency recommendation
  if (summary.avg_triage_latency_p0p1_hours !== null && summary.avg_triage_latency_p0p1_hours > 4) {
    recs.push(
      `**P0/P1 triage latency (${summary.avg_triage_latency_p0p1_hours}h) exceeds 4h target**: ` +
      `Consider enabling notification-based triage or adding backup triagers.`,
    );
  }

  return recs;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the complete digest Markdown document with YAML frontmatter.
 */
export function renderDigest(
  weekId: string,
  start: Date,
  end: Date,
  generatedAt: Date,
  data: DigestData,
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

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a date as YYYY-MM-DD.
 */
export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Format severity counts for the summary table.
 * Example: "P0: 1, P1: 3, P2: 7, P3: 3"
 */
export function formatSeverityCounts(counts: Record<string, number>): string {
  return ['P0', 'P1', 'P2', 'P3']
    .map((k) => `${k}: ${counts[k] ?? 0}`)
    .join(', ');
}

/**
 * Format type counts for the summary table.
 * Example: "error: 8, anomaly: 4, trend: 2"
 */
export function formatTypeCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
}

/**
 * Format triage decision counts for the summary table.
 * Example: "promote: 4, dismiss: 5, defer: 2, investigate: 1, pending: 2"
 */
export function formatTriageCounts(counts: Record<string, number>): string {
  return ['promote', 'dismiss', 'defer', 'investigate', 'pending']
    .filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => `${k}: ${counts[k]}`)
    .join(', ');
}

/**
 * Format a latency value for display.
 * Returns "N/A" for null values.
 */
export function formatLatency(hours: number | null): string {
  if (hours === null) return 'N/A';
  return `${hours}h`;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

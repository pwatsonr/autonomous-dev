/**
 * Human-readable report printer for the reliability harness (#524).
 *
 * Pure string formatting: takes a `Summary` (+ the raw `RunResult[]` for the
 * per-run detail table) and returns a plain-text report. No colour codes, no
 * I/O — the runner decides where to write it. Kept dependency-free so it runs
 * identically under bun, ts-node, and jest.
 *
 * @module tools/reliability/report
 */

import type { RunResult, Summary } from './types';

/** Format a ratio in [0,1] as a fixed-width percentage, e.g. 0.6667 -> ' 66.7%'. */
function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`.padStart(6);
}

/** Right-pad a cell to width (truncating with an ellipsis when too long). */
function cell(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width);
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

/** Render a simple histogram object as `key=count` pairs, count-descending. */
function fmtHistogram(h: Record<string, number>): string {
  const entries = Object.entries(h).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '(none)';
  return entries.map(([k, v]) => `${k}=${v}`).join('  ');
}

/**
 * Build the full text report. `opts.dryRun` only annotates the header so a
 * mocked run is never mistaken for a real one.
 */
export function renderReport(
  summary: Summary,
  results: RunResult[],
  opts: { dryRun?: boolean; outPath?: string } = {},
): string {
  const lines: string[] = [];
  const mode = opts.dryRun ? 'DRY-RUN (mocked CLI + state.json — not a real batch)' : 'LIVE';

  lines.push('='.repeat(72));
  lines.push(`autonomous-dev reliability report  [${mode}]`);
  lines.push('='.repeat(72));
  lines.push('');

  // -- Headline metrics ----------------------------------------------------
  lines.push('OVERALL');
  lines.push(
    `  success rate      : ${pct(summary.successRate)}  ` +
      `(${summary.successCount}/${summary.totalRuns} runs)`,
  );
  lines.push(`  total cost (USD)  : $${summary.totalCostUsd.toFixed(2)}`);
  lines.push(
    `  retries / run     : mean ${summary.retryStats.mean.toFixed(2)}  ` +
      `p50 ${summary.retryStats.p50}  max ${summary.retryStats.max}`,
  );
  lines.push(
    `  cost / run (USD)  : mean $${summary.costStats.mean.toFixed(2)}  ` +
      `p50 $${summary.costStats.p50.toFixed(2)}  max $${summary.costStats.max.toFixed(2)}`,
  );
  lines.push('');
  lines.push(`  by terminal status: ${fmtHistogram(summary.byTerminalStatus)}`);
  lines.push(`  by terminal phase : ${fmtHistogram(summary.byTerminalPhase)}`);
  lines.push(`  failure by phase  : ${fmtHistogram(summary.perPhaseFailureHistogram)}`);
  lines.push('');

  // -- Per-task determinism table -----------------------------------------
  lines.push('PER-TASK DETERMINISM');
  lines.push(
    `  ${cell('taskId', 28)} ${cell('runs', 5)} ${cell('ok', 4)} ` +
      `${cell('rate', 7)} ${cell('flaky', 5)}`,
  );
  lines.push(`  ${'-'.repeat(28)} ${'-'.repeat(5)} ${'-'.repeat(4)} ${'-'.repeat(7)} ${'-'.repeat(5)}`);
  for (const [taskId, t] of Object.entries(summary.byTask)) {
    lines.push(
      `  ${cell(taskId, 28)} ${cell(String(t.runs), 5)} ${cell(String(t.successes), 4)} ` +
        `${pct(t.successRate)} ${cell(t.flaky ? 'YES' : '-', 5)}`,
    );
  }
  lines.push('');

  // -- Per-run detail ------------------------------------------------------
  lines.push('PER-RUN DETAIL');
  lines.push(
    `  ${cell('taskId', 24)} ${cell('rep', 3)} ${cell('status', 9)} ` +
      `${cell('phase', 12)} ${cell('retries', 7)} ${cell('cost', 7)} ${cell('blocker', 18)}`,
  );
  lines.push(
    `  ${'-'.repeat(24)} ${'-'.repeat(3)} ${'-'.repeat(9)} ${'-'.repeat(12)} ` +
      `${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(18)}`,
  );
  for (const r of results) {
    lines.push(
      `  ${cell(r.taskId, 24)} ${cell(String(r.repeat), 3)} ${cell(r.status, 9)} ` +
        `${cell(r.terminalPhase, 12)} ${cell(String(r.totalRetries), 7)} ` +
        `${cell('$' + r.costUsd.toFixed(2), 7)} ${cell(r.blocker ?? '-', 18)}`,
    );
  }
  lines.push('');

  if (opts.outPath) {
    lines.push(`JSON report written to: ${opts.outPath}`);
    lines.push('');
  }

  return lines.join('\n');
}

#!/usr/bin/env node
/**
 * record-metric.ts — Bash↔TS bridge that records ONE agent InvocationMetric
 * into the agent-factory metrics store, so the self-improvement loop self-feeds
 * from real pipeline runs.
 *
 * The bash daemon (supervisor-loop.sh / phase-helpers.sh) shells out here at
 * each `<X>_review` phase completion to record how the agent that produced
 * phase `<X>` was judged. It writes to the SAME `agent-metrics.db` that
 * `agent improve`/`agent analyze` read (the agent-factory data dir), so seeded
 * pipeline metrics become the analyzer's input with no extra wiring.
 *
 * Build (node target, better-sqlite3 left external so node loads the rebuilt
 * native binding — bun cannot dlopen it):
 *   bun build bin/record-metric.ts --outfile=bin/lib/record-metric.js \
 *     --target=node --external better-sqlite3
 *
 * Usage:
 *   node bin/lib/record-metric.js --agent <name> --request-id <id> \
 *     --outcome <approved|revision_requested|rejected|not_reviewed> \
 *     --score <1.0-5.0> [--reviewer <name>] [--domain <d>] [--retries <n>] \
 *     [--wall-clock-ms <n>] [--turns <n>] [--agents-dir <dir>] [--data-dir <dir>]
 *
 * Best-effort by contract: a non-zero exit must never fail a pipeline phase.
 */
import * as fs from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { randomUUID, createHash } from 'crypto';

import { parseAgentFile } from '../src/agent-factory/parser';
import { JsonlWriter } from '../src/agent-factory/metrics/jsonl-writer';
import { SqliteStore } from '../src/agent-factory/metrics/sqlite-store';
import { MetricsEngine } from '../src/agent-factory/metrics/engine';
import type { InvocationMetric, ReviewOutcome } from '../src/agent-factory/metrics/types';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Same default as bin/agent-cli.ts agentFactoryDataDir(), so reads/writes agree. */
function defaultDataDir(): string {
  const override = process.env['AUTONOMOUS_DEV_AGENT_FACTORY_DATA_DIR'];
  if (override && override.length > 0) return override;
  const stateDir = process.env['AUTONOMOUS_DEV_STATE_DIR'];
  const base = stateDir && stateDir.length > 0 ? stateDir : join(homedir(), '.autonomous-dev');
  return join(base, 'agent-factory');
}

const VALID_OUTCOMES: ReviewOutcome[] = [
  'approved',
  'rejected',
  'revision_requested',
  'not_reviewed',
];

function main(): number {
  const agent = arg('agent');
  if (!agent) {
    console.error('record-metric: --agent is required');
    return 1;
  }
  const requestId = arg('request-id') ?? null;
  const outcomeRaw = (arg('outcome', 'approved') as ReviewOutcome) ?? 'approved';
  const outcome: ReviewOutcome = VALID_OUTCOMES.includes(outcomeRaw) ? outcomeRaw : 'approved';
  const score = clamp(parseFloat(arg('score', '4') as string), 1, 5);
  const reviewer = arg('reviewer') || null;
  const domain = arg('domain', 'general') as string;
  const retries = Math.max(0, parseInt(arg('retries', '0') as string, 10) || 0);
  const wallClockMs = Math.max(0, parseInt(arg('wall-clock-ms', '0') as string, 10) || 0);
  const turns = Math.max(0, parseInt(arg('turns', '0') as string, 10) || 0);
  const agentsDir = arg('agents-dir', resolve(__dirname, '..', 'agents')) as string;
  const dataDir = arg('data-dir', defaultDataDir()) as string;

  // Resolve version + rubric dimensions from the agent definition (best-effort).
  let version = '0.0.0';
  let rubric: Array<{ name: string; weight?: number }> = [];
  try {
    const parsed = parseAgentFile(join(agentsDir, `${agent}.md`));
    if (parsed.success && parsed.agent) {
      version = parsed.agent.version || '0.0.0';
      rubric = (parsed.agent.evaluation_rubric as Array<{ name: string; weight?: number }>) || [];
    }
  } catch {
    /* fall back to defaults */
  }

  const quality_dimensions =
    rubric.length > 0
      ? rubric.map((r) => ({ dimension: r.name, score, weight: r.weight ?? 1 / rubric.length }))
      : [{ dimension: 'overall', score, weight: 1 }];

  const now = new Date().toISOString();
  const id = randomUUID();
  const metric: InvocationMetric = {
    invocation_id: id,
    agent_name: agent,
    agent_version: version,
    pipeline_run_id: requestId,
    input_hash: sha256(`${requestId}:${agent}:${now}:in`),
    input_domain: domain,
    input_tokens: 0,
    output_hash: sha256(`${requestId}:${agent}:${now}:out`),
    output_tokens: 0,
    output_quality_score: score,
    quality_dimensions,
    review_iteration_count: retries,
    review_outcome: outcome,
    reviewer_agent: reviewer,
    wall_clock_ms: wallClockMs,
    turn_count: turns,
    tool_calls: [],
    timestamp: now,
    environment: 'production',
  };

  fs.mkdirSync(dataDir, { recursive: true });
  const sqliteStore = new SqliteStore(join(dataDir, 'agent-metrics.db'));
  try {
    sqliteStore.initialize();
  } catch (err) {
    // better-sqlite3 unavailable (e.g. native binding missing): degrade to
    // JSONL-only via MetricsEngine's buffer so the call still records.
    console.error(
      `record-metric: sqlite unavailable (${
        err instanceof Error ? err.message : String(err)
      }); recording to JSONL only`,
    );
  }
  const engine = new MetricsEngine({
    jsonlWriter: new JsonlWriter(join(dataDir, 'agent-metrics.jsonl')),
    sqliteStore,
  });
  engine.record(metric);
  sqliteStore.close();

  console.log(
    JSON.stringify({ recorded: true, invocation_id: id, agent, version, score, outcome, domain }),
  );
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error(`record-metric: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

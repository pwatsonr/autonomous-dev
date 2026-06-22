/**
 * Assemble the full improvement-subsystem `CliContext` (issue #576).
 *
 * Before this, `bin/agent-cli.ts` passed an empty `{}` context, so
 * `commandImprove` / `commandPromote` / `commandAnalyze` hit their dependency
 * guards and returned "Improvement subsystem not available" — the human-gated
 * self-improvement loop (#529) was inert in the shipped CLI. This builder wires
 * the real stores (metrics, weakness reports, proposals, audit) and the real
 * Claude-backed runtimes/LLM invoker so those verbs actually run.
 *
 * All persistent state lives under `dataDir` (defaults to
 * `${AUTONOMOUS_DEV_STATE_DIR:-~/.autonomous-dev}/agent-factory`). Promotion —
 * the only step that writes an agent file + git commit — uses `projectRoot`.
 */
import * as fs from 'fs';
import { join } from 'path';

import type { IAgentRegistry } from '../types';
import type { CliContext } from '../cli';
import type { AgentFactoryConfig } from '../config';
import { getDefaultConfig } from '../config';

import { PerformanceAnalyzer } from './analyzer';
import { ProposalGenerator } from './proposer';
import { ProposalStore } from './proposal-store';
import { WeaknessReportStore } from './types';
import { MetaReviewOrchestrator } from './meta-reviewer';
import { Promoter } from '../promotion/promoter';
import { AuditLogger } from '../audit';
import { ObservationTracker } from '../metrics/observation';
import { MetricsEngine } from '../metrics/engine';
import { JsonlWriter } from '../metrics/jsonl-writer';
import { SqliteStore } from '../metrics/sqlite-store';
import { createClaudeRuntime, ClaudeLLMInvoker } from './claude-runtime';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface ImprovementContextOptions {
  registry: IAgentRegistry;
  /** Directory holding the agent `.md` files. */
  agentsDir: string;
  /** Directory for persistent stores (metrics db, proposals, reports, audit). */
  dataDir: string;
  /** Git repo root used by the Promoter for the promotion commit. */
  projectRoot: string;
  config?: AgentFactoryConfig;
}

/**
 * Build the improvement-subsystem `CliContext` with REAL Claude-backed
 * runtimes. Safe to call repeatedly; creates `dataDir` if missing. If
 * better-sqlite3 is unavailable the metrics store degrades (the analyzer then
 * simply sees no metrics and recommends `no_action`).
 */
export function buildImprovementContext(opts: ImprovementContextOptions): Partial<CliContext> {
  const { registry, agentsDir, dataDir, projectRoot } = opts;
  const config = opts.config ?? getDefaultConfig();
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = join(dataDir, 'agent-metrics.db');
  const jsonlWriter = new JsonlWriter(join(dataDir, 'agent-metrics.jsonl'));
  const sqliteStore = new SqliteStore(dbPath);
  try {
    sqliteStore.initialize();
  } catch {
    /* better-sqlite3 missing → MetricsEngine runs in degraded mode (no metrics) */
  }
  const metricsEngine = new MetricsEngine({ jsonlWriter, sqliteStore });

  const auditLogger = new AuditLogger(join(dataDir, 'agent-audit.log'));
  const reportStore = new WeaknessReportStore(join(dataDir, 'weakness-reports.jsonl'), noopLogger);
  const proposalStore = new ProposalStore(join(dataDir, 'proposals.jsonl'), dbPath, {
    warn: () => {},
  });
  const observationTracker = new ObservationTracker({
    config,
    statePath: join(dataDir, 'observation-state.json'),
    logger: noopLogger,
  });

  const performanceAnalyzer = new PerformanceAnalyzer({
    registry,
    metricsEngine,
    observationTracker,
    auditLogger,
    reportStore,
    domainGapsPath: join(dataDir, 'domain-gaps.jsonl'),
    logger: noopLogger,
    createRuntime: createClaudeRuntime,
  });
  const proposalGenerator = new ProposalGenerator(registry, new ClaudeLLMInvoker(), auditLogger, {
    agentsDir,
  });
  const metaOrchestrator = new MetaReviewOrchestrator({
    registry,
    auditLogger,
    logger: noopLogger,
    createRuntime: createClaudeRuntime,
  });
  const promoter = new Promoter({
    registry,
    proposalStore,
    auditLogger,
    observationTracker,
    agentsDir,
    projectRoot,
    loadWeaknessReport: (id: string) => reportStore.getById(id),
  });

  return {
    performanceAnalyzer,
    proposalGenerator,
    proposalStore,
    auditLogger,
    invokeMetaReview: (p) => metaOrchestrator.review(p),
    promoter,
    metricsEngine,
  };
}

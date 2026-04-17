/**
 * Agent Factory CLI command handlers (SPEC-005-1-4 Task 10, SPEC-005-2-5 Task 13,
 * SPEC-005-3-5 Task 13, SPEC-005-4-5 Tasks 11-14).
 *
 * Implements all Agent Factory CLI commands:
 *   - agent list       -- Tabular display of all registered agents
 *   - agent inspect    -- Full configuration dump for a single agent
 *   - agent reload     -- Trigger full registry reload
 *   - agent freeze     -- Freeze an agent (set state to FROZEN)
 *   - agent unfreeze   -- Unfreeze an agent (set state to ACTIVE)
 *   - agent metrics    -- Aggregate metrics, trend, domain breakdown, alerts
 *   - agent dashboard  -- Summary table sorted by approval rate with trends
 *   - agent rollback   -- Rollback an agent to a previous version
 *   - agent analyze    -- Trigger improvement analysis for an agent
 *   - agent compare    -- Manual A/B comparison between two agent versions
 *   - agent promote    -- Promote an agent to a validated version
 *   - agent reject     -- Reject a proposed agent version
 *   - agent accept     -- Accept a proposed new agent
 *   - agent gaps       -- List all detected domain gaps
 *
 * Each command is a pure function that takes the registry (and any
 * arguments) and returns formatted output. This keeps command logic
 * testable without process-level side effects.
 */

import type { IAgentRegistry, AgentRecord, RegistryLoadResult } from './types';
import type { IMetricsEngine, AggregateMetrics, AlertRecord } from './metrics/types';
import type { RollbackManager, RollbackResult, ImpactAnalysis } from './rollback';
import type { ObservationTrigger } from './improvement/observation-trigger';
import type { PerformanceAnalyzer } from './improvement/analyzer';
import type { ProposalGenerator } from './improvement/proposer';
import type { ProposalStore } from './improvement/proposal-store';
import type { AuditLogger } from './audit';
import type { Promoter, PromotionResult } from './promotion/promoter';
import type { Rejector, RejectionResult } from './promotion/rejector';
import type { DomainGapDetector, GapRecord } from './gaps/detector';
import type { ABValidationOrchestrator } from './validation/orchestrator';
import type {
  WeaknessReport,
  AnalysisResult,
  ProposalResult,
  MetaReviewResult,
  ABEvaluationResult,
  AgentProposal,
} from './improvement/types';

// ---------------------------------------------------------------------------
// Output formatting helpers
// ---------------------------------------------------------------------------

/**
 * Pad a string to a fixed width (right-padded with spaces).
 */
function pad(str: string, width: number): string {
  if (str.length >= width) return str;
  return str + ' '.repeat(width - str.length);
}

/**
 * Truncate a string to maxLen, appending '...' if truncated.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}

/**
 * Format a Date as a readable ISO-like timestamp.
 */
function formatTimestamp(date: Date): string {
  return date.toISOString();
}

// ---------------------------------------------------------------------------
// Command: agent list
// ---------------------------------------------------------------------------

/**
 * Format the agent list as a table.
 *
 * Output format:
 * ```
 * NAME                  VERSION  ROLE      STATE    EXPERTISE
 * prd-author            1.0.0    author    ACTIVE   product-requirements, user-stories
 * ...
 * ```
 *
 * @param registry  The agent registry to query.
 * @returns         Formatted table string.
 */
export function commandList(registry: IAgentRegistry): string {
  const agents = registry.list();

  if (agents.length === 0) {
    return 'No agents registered.';
  }

  // Sort alphabetically by name for consistent output
  const sorted = [...agents].sort((a, b) => a.agent.name.localeCompare(b.agent.name));

  // Column widths
  const COL_NAME = 22;
  const COL_VERSION = 9;
  const COL_ROLE = 10;
  const COL_STATE = 9;

  const header = [
    pad('NAME', COL_NAME),
    pad('VERSION', COL_VERSION),
    pad('ROLE', COL_ROLE),
    pad('STATE', COL_STATE),
    'EXPERTISE',
  ].join('');

  const rows = sorted.map((record) => {
    const expertiseStr = record.agent.expertise.slice(0, 2).join(', ');
    return [
      pad(record.agent.name, COL_NAME),
      pad(record.agent.version, COL_VERSION),
      pad(record.agent.role, COL_ROLE),
      pad(record.state, COL_STATE),
      expertiseStr,
    ].join('');
  });

  return [header, ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Command: agent inspect <name>
// ---------------------------------------------------------------------------

/**
 * Format a full configuration dump for a single agent.
 *
 * Includes all frontmatter fields, SHA-256 hash, loaded timestamp,
 * current state, file path, and the first 5 lines of the system prompt.
 *
 * @param registry  The agent registry to query.
 * @param name      The agent name to inspect.
 * @returns         Formatted inspection output, or an error message.
 */
export function commandInspect(registry: IAgentRegistry, name: string): string {
  const record = registry.get(name);

  if (!record) {
    return `Error: Agent '${name}' not found`;
  }

  const a = record.agent;

  // First 5 lines of system prompt
  const promptLines = a.system_prompt.split('\n');
  const truncatedPrompt = promptLines.slice(0, 5).join('\n');
  const promptSuffix = promptLines.length > 5 ? '\n  ...' : '';

  const lines = [
    `Agent: ${a.name}`,
    `  version:           ${a.version}`,
    `  role:              ${a.role}`,
    `  model:             ${a.model}`,
    `  temperature:       ${a.temperature}`,
    `  turn_limit:        ${a.turn_limit}`,
    `  tools:             [${a.tools.join(', ')}]`,
    `  expertise:         [${a.expertise.join(', ')}]`,
    `  description:       ${a.description}`,
    `  frozen:            ${a.frozen ?? false}`,
    `  risk_tier:         ${a.risk_tier ?? 'none'}`,
    '',
    `  evaluation_rubric:`,
    ...a.evaluation_rubric.map(
      (d) => `    - ${d.name} (weight: ${d.weight}): ${d.description}`,
    ),
    '',
    `  version_history:`,
    ...a.version_history.map(
      (h) => `    - ${h.version} (${h.date}): ${h.change}`,
    ),
    '',
    `Registry:`,
    `  state:             ${record.state}`,
    `  diskHash:          ${record.diskHash}`,
    `  loadedAt:          ${formatTimestamp(record.loadedAt)}`,
    `  filePath:          ${record.filePath}`,
    '',
    `System Prompt (first 5 lines):`,
    `  ${truncatedPrompt.split('\n').join('\n  ')}${promptSuffix}`,
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Command: agent reload
// ---------------------------------------------------------------------------

/**
 * Format the result of a registry reload operation.
 *
 * @param result  The RegistryLoadResult from registry.reload().
 * @returns       Formatted result string.
 */
export function formatReloadResult(result: RegistryLoadResult): string {
  const lines = [
    `Registry reloaded.`,
    `  Loaded:   ${result.loaded}`,
    `  Rejected: ${result.rejected}`,
    `  Duration: ${result.duration_ms}ms`,
  ];

  if (result.errors.length > 0) {
    lines.push('');
    lines.push('  Errors:');
    for (const err of result.errors) {
      lines.push(`    - ${err.file}: ${err.reason}`);
    }
  }

  return lines.join('\n');
}

/**
 * Execute the reload command: clear and re-load the registry.
 *
 * @param registry   The agent registry.
 * @param agentsDir  Path to the agents directory.
 * @returns          Formatted result string.
 */
export async function commandReload(
  registry: IAgentRegistry,
  agentsDir: string,
): Promise<string> {
  const result = await registry.reload(agentsDir);
  return formatReloadResult(result);
}

// ---------------------------------------------------------------------------
// Command: agent freeze <name>
// ---------------------------------------------------------------------------

/**
 * Freeze an agent and return a confirmation message.
 *
 * @param registry  The agent registry.
 * @param name      The agent name to freeze.
 * @returns         Confirmation or error message.
 */
export function commandFreeze(registry: IAgentRegistry, name: string): string {
  try {
    registry.freeze(name);
    return `Agent '${name}' has been frozen (state: FROZEN).`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Command: agent unfreeze <name>
// ---------------------------------------------------------------------------

/**
 * Unfreeze an agent and return a confirmation message.
 *
 * @param registry  The agent registry.
 * @param name      The agent name to unfreeze.
 * @returns         Confirmation or error message.
 */
export function commandUnfreeze(registry: IAgentRegistry, name: string): string {
  try {
    registry.unfreeze(name);
    return `Agent '${name}' has been unfrozen (state: ACTIVE).`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Command: agent metrics <name>
// ---------------------------------------------------------------------------

/**
 * Format aggregate metrics, trend, domain breakdown, and active alerts
 * for a single agent.
 *
 * @param registry       The agent registry.
 * @param metricsEngine  The metrics engine for querying data.
 * @param name           The agent name.
 * @returns              Formatted metrics output, or an error message.
 */
export function commandMetrics(
  registry: IAgentRegistry,
  metricsEngine: IMetricsEngine,
  name: string,
): string {
  const record = registry.get(name);
  if (!record) {
    return `Error: Agent '${name}' not found`;
  }

  const aggregate = metricsEngine.getAggregate(name);
  if (!aggregate) {
    return `Agent: ${name} (v${record.agent.version})\n${'─'.repeat(33)}\nNo metrics data available.`;
  }

  const alerts = metricsEngine.getAlerts({ agentName: name, activeOnly: true });

  return formatMetricsOutput(name, record.agent.version, aggregate, alerts);
}

/**
 * Format the full metrics display for an agent.
 */
function formatMetricsOutput(
  name: string,
  version: string,
  agg: AggregateMetrics,
  alerts: AlertRecord[],
): string {
  const lines: string[] = [];

  lines.push(`Agent: ${name} (v${version})`);
  lines.push('─'.repeat(33));
  lines.push(`Invocations (${agg.window_days}d):  ${agg.invocation_count}`);
  lines.push(`Approval Rate:      ${formatPercent(agg.approval_rate)}`);
  lines.push(`Avg Quality:        ${agg.avg_quality_score.toFixed(1)} / 5.0`);
  lines.push(`Median Quality:     ${agg.median_quality_score.toFixed(1)} / 5.0`);
  lines.push(`Stddev Quality:     ${agg.stddev_quality_score.toFixed(1)}`);
  lines.push(`Avg Iterations:     ${agg.avg_review_iterations.toFixed(1)}`);
  lines.push(`Avg Wall Clock:     ${(agg.avg_wall_clock_ms / 1000).toFixed(1)}s`);
  lines.push(`Avg Turns:          ${agg.avg_turns.toFixed(1)}`);
  lines.push(`Total Tokens:       ${formatNumber(agg.total_tokens)}`);

  // Trend
  const trendLabel = agg.trend.direction;
  const trendDetail = `slope: ${agg.trend.slope >= 0 ? '+' : ''}${agg.trend.slope.toFixed(2)}, R\u00B2: ${agg.trend.confidence.toFixed(2)}`;
  lines.push(`Trend:              ${trendLabel} (${trendDetail})`);

  // Domain breakdown
  const domains = Object.entries(agg.domain_breakdown);
  if (domains.length > 0) {
    lines.push('');
    lines.push('Domain Breakdown:');
    for (const [domain, stats] of domains) {
      lines.push(
        `  ${pad(domain + ':', 16)}${stats.invocation_count} invocations, ` +
          `${formatPercent(stats.approval_rate)} approved, ` +
          `avg ${stats.avg_quality_score.toFixed(1)}`,
      );
    }
  }

  // Active alerts
  if (alerts.length > 0) {
    lines.push('');
    lines.push('Active Alerts:');
    for (const alert of alerts) {
      const severityTag = `[${alert.severity.toUpperCase()}]`;
      lines.push(`  ${severityTag} ${alert.rule_id}: ${alert.message}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Command: agent dashboard
// ---------------------------------------------------------------------------

/**
 * Format a summary dashboard of all agents sorted by approval rate.
 *
 * @param registry       The agent registry.
 * @param metricsEngine  The metrics engine for querying data.
 * @returns              Formatted dashboard output.
 */
export function commandDashboard(
  registry: IAgentRegistry,
  metricsEngine: IMetricsEngine,
): string {
  const agents = registry.list();

  if (agents.length === 0) {
    return 'No agents registered.';
  }

  // Gather metrics for each agent
  interface DashboardRow {
    name: string;
    version: string;
    role: string;
    approvalRate: number;
    avgQuality: number;
    trendDirection: 'improving' | 'stable' | 'declining';
    hasMetrics: boolean;
  }

  const rows: DashboardRow[] = [];
  let totalAlerts = 0;
  let criticalAlerts = 0;

  for (const record of agents) {
    const agg = metricsEngine.getAggregate(record.agent.name);
    const alerts = metricsEngine.getAlerts({
      agentName: record.agent.name,
      activeOnly: true,
    });

    totalAlerts += alerts.length;
    criticalAlerts += alerts.filter((a) => a.severity === 'critical').length;

    rows.push({
      name: record.agent.name,
      version: record.agent.version,
      role: record.agent.role,
      approvalRate: agg?.approval_rate ?? 0,
      avgQuality: agg?.avg_quality_score ?? 0,
      trendDirection: agg?.trend.direction ?? 'stable',
      hasMetrics: agg !== null,
    });
  }

  // Sort by approval rate descending
  rows.sort((a, b) => b.approvalRate - a.approvalRate);

  // Build table
  const COL_NAME = 22;
  const COL_VER = 7;
  const COL_ROLE = 10;
  const COL_RATE = 8;
  const COL_QUAL = 7;

  const lines: string[] = [];
  lines.push('AGENT FACTORY DASHBOARD');
  lines.push('\u2550'.repeat(63));

  const header = [
    pad('NAME', COL_NAME),
    pad('VER', COL_VER),
    pad('ROLE', COL_ROLE),
    pad('RATE', COL_RATE),
    pad('QUAL', COL_QUAL),
    'TREND',
  ].join('');
  lines.push(header);
  lines.push('\u2500'.repeat(63));

  for (const row of rows) {
    const trendIndicator = trendArrow(row.trendDirection);
    const rateStr = row.hasMetrics ? formatPercent(row.approvalRate) : '-';
    const qualStr = row.hasMetrics ? row.avgQuality.toFixed(1) : '-';

    lines.push(
      [
        pad(row.name, COL_NAME),
        pad(row.version, COL_VER),
        pad(row.role, COL_ROLE),
        pad(rateStr, COL_RATE),
        pad(qualStr, COL_QUAL),
        trendIndicator,
      ].join(''),
    );
  }

  lines.push('\u2500'.repeat(63));

  const alertSummary =
    totalAlerts > 0
      ? `${totalAlerts} (${criticalAlerts} critical)`
      : '0';
  lines.push(
    `Agents: ${agents.length} | Active Alerts: ${alertSummary} | Last update: ${formatTimestamp(new Date())}`,
  );

  return lines.join('\n');
}

/**
 * Map trend direction to an arrow indicator.
 */
function trendArrow(direction: 'improving' | 'stable' | 'declining'): string {
  switch (direction) {
    case 'improving':
      return '\u2191';
    case 'declining':
      return '\u2193';
    case 'stable':
    default:
      return '\u2192';
  }
}

// ---------------------------------------------------------------------------
// Command: agent rollback <name> [--force]
// ---------------------------------------------------------------------------

/**
 * Format impact analysis for display.
 */
export function formatImpactAnalysis(impact: ImpactAnalysis): string {
  const lines: string[] = [];
  lines.push('Impact Analysis:');
  lines.push(`  Current version invocations: ${impact.currentVersionInvocations}`);
  lines.push(`  In-flight pipeline runs:     ${impact.inFlightPipelineRuns.length}`);
  if (impact.warningMessage) {
    lines.push(`  WARNING: ${impact.warningMessage}`);
  }
  if (impact.diff && impact.diff !== '(diff unavailable)') {
    const diffLines = impact.diff.split('\n').slice(0, 20);
    lines.push('  Diff (first 20 lines):');
    for (const line of diffLines) {
      lines.push(`    ${line}`);
    }
    if (impact.diff.split('\n').length > 20) {
      lines.push('    ...');
    }
  }
  return lines.join('\n');
}

/**
 * Format a rollback result for display.
 */
export function formatRollbackResult(result: RollbackResult): string {
  if (!result.success) {
    return `Rollback failed: ${result.error}`;
  }

  const lines: string[] = [];
  lines.push(`Rollback successful.`);
  lines.push(`  Agent:            ${result.agentName}`);
  lines.push(`  Previous version: v${result.previousVersion}`);
  lines.push(`  Restored version: v${result.restoredVersion}`);
  lines.push(`  Commit:           ${result.commitHash}`);
  return lines.join('\n');
}

/**
 * Execute the rollback command.
 *
 * @param rollbackManager  The rollback manager.
 * @param name             The agent name to roll back.
 * @param force            Whether to skip confirmation.
 * @returns                Formatted result string.
 */
export async function commandRollback(
  rollbackManager: RollbackManager,
  name: string,
  force: boolean = false,
): Promise<string> {
  // Get impact analysis first for display
  const impact = rollbackManager.getImpactAnalysis(name);
  if (!impact) {
    return `Error: Could not analyze impact for agent '${name}'. Agent may not exist or have no git history.`;
  }

  const impactDisplay = formatImpactAnalysis(impact);

  if (!force) {
    // In non-force mode, return the analysis and a prompt message.
    // The actual confirmation is handled by the caller.
    return `${impactDisplay}\n\nConfirmation required. Use --force to skip confirmation and proceed with rollback.`;
  }

  // Force mode: proceed with rollback
  const result = await rollbackManager.rollback(name, { force: true });
  return `${impactDisplay}\n\n${formatRollbackResult(result)}`;
}

// ---------------------------------------------------------------------------
// Formatting utilities
// ---------------------------------------------------------------------------

/**
 * Format a number as a percentage string (e.g., "83.0%").
 */
function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Format a large number with comma separators (e.g., "1,240,000").
 */
function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// CLI dispatcher
// ---------------------------------------------------------------------------

/**
 * Extended CLI context providing optional dependencies for metrics,
 * rollback, and improvement commands. These are optional so existing
 * callers (which only use registry commands) continue to work without
 * modification.
 */
export interface CliContext {
  registry: IAgentRegistry;
  agentsDir: string;
  metricsEngine?: IMetricsEngine;
  rollbackManager?: RollbackManager;
  // Improvement lifecycle dependencies (SPEC-005-3-5)
  observationTrigger?: ObservationTrigger;
  performanceAnalyzer?: PerformanceAnalyzer;
  proposalGenerator?: ProposalGenerator;
  proposalStore?: ProposalStore;
  auditLogger?: AuditLogger;
  /**
   * Optional meta-review invoker. Takes a proposal and returns a
   * MetaReviewResult. Injected for testability.
   */
  invokeMetaReview?: (proposal: import('./improvement/types').AgentProposal) => Promise<MetaReviewResult>;
  // Phase 2 dependencies (SPEC-005-4-5)
  /** Promoter for the `agent promote` command. */
  promoter?: Promoter;
  /** Rejector for the `agent reject` command. */
  rejector?: Rejector;
  /** Domain gap detector for the `agent gaps` command and gap detection. */
  gapDetector?: DomainGapDetector;
  /** A/B validation orchestrator for the `agent compare` command. */
  abOrchestrator?: ABValidationOrchestrator;
  /**
   * Git version retriever: given agent name and version, returns the
   * agent definition content from git history. Used by `agent compare`.
   */
  getAgentDefinitionFromGit?: (agentName: string, version: string) => string | null;
  /**
   * Path to the `data/proposed-agents/` directory for `agent accept`.
   */
  proposedAgentsDir?: string;
}

/**
 * Parse and dispatch an agent CLI command.
 *
 * Supported commands:
 *   agent list
 *   agent inspect <name>
 *   agent reload
 *   agent freeze <name>
 *   agent unfreeze <name>
 *   agent metrics <name>
 *   agent dashboard
 *   agent rollback <name> [--force]
 *   agent analyze <name> [--force]
 *   agent compare <name> --version-a X --version-b Y [--inputs N]
 *   agent promote <name> <version>
 *   agent reject <name> <version> --reason "<reason>"
 *   agent accept <name>
 *   agent gaps
 *
 * @param registry   The agent registry.
 * @param args       Command arguments (e.g., ['list'] or ['inspect', 'code-executor']).
 * @param agentsDir  Path to agents directory (used by reload).
 * @param ctx        Optional extended context for metrics, rollback, and improvement commands.
 * @returns          Formatted output string.
 */
export async function dispatchCommand(
  registry: IAgentRegistry,
  args: string[],
  agentsDir: string,
  ctx?: Partial<CliContext>,
): Promise<string> {
  if (args.length === 0) {
    return usageMessage();
  }

  const subcommand = args[0];

  switch (subcommand) {
    case 'list':
      return commandList(registry);

    case 'inspect': {
      const name = args[1];
      if (!name) {
        return 'Error: agent inspect requires a name argument.\nUsage: agent inspect <name>';
      }
      return commandInspect(registry, name);
    }

    case 'reload':
      return commandReload(registry, agentsDir);

    case 'freeze': {
      const name = args[1];
      if (!name) {
        return 'Error: agent freeze requires a name argument.\nUsage: agent freeze <name>';
      }
      return commandFreeze(registry, name);
    }

    case 'unfreeze': {
      const name = args[1];
      if (!name) {
        return 'Error: agent unfreeze requires a name argument.\nUsage: agent unfreeze <name>';
      }
      return commandUnfreeze(registry, name);
    }

    case 'metrics': {
      const name = args[1];
      if (!name) {
        return 'Error: agent metrics requires a name argument.\nUsage: agent metrics <name>';
      }
      const metricsEngine = ctx?.metricsEngine;
      if (!metricsEngine) {
        return 'Error: Metrics engine not available. Ensure the metrics subsystem is initialised.';
      }
      return commandMetrics(registry, metricsEngine, name);
    }

    case 'dashboard': {
      const metricsEngine = ctx?.metricsEngine;
      if (!metricsEngine) {
        return 'Error: Metrics engine not available. Ensure the metrics subsystem is initialised.';
      }
      return commandDashboard(registry, metricsEngine);
    }

    case 'rollback': {
      const name = args[1];
      if (!name) {
        return 'Error: agent rollback requires a name argument.\nUsage: agent rollback <name> [--force]';
      }
      const rollbackMgr = ctx?.rollbackManager;
      if (!rollbackMgr) {
        return 'Error: Rollback manager not available. Ensure the rollback subsystem is initialised.';
      }
      const force = args.includes('--force');
      return commandRollback(rollbackMgr, name, force);
    }

    case 'analyze': {
      const name = args[1];
      if (!name) {
        return 'Error: agent analyze requires a name argument.\nUsage: agent analyze <name> [--force]';
      }
      const force = args.includes('--force');
      return commandAnalyze(registry, name, force, ctx ?? {});
    }

    // ----- Phase 2 commands (SPEC-005-4-5) -----

    case 'compare': {
      const name = args[1];
      if (!name) {
        return 'Error: agent compare requires a name argument.\nUsage: agent compare <name> --version-a X --version-b Y [--inputs N]';
      }
      const versionA = parseFlag(args, '--version-a');
      const versionB = parseFlag(args, '--version-b');
      if (!versionA || !versionB) {
        return 'Error: agent compare requires --version-a and --version-b flags.\nUsage: agent compare <name> --version-a X --version-b Y [--inputs N]';
      }
      const inputsStr = parseFlag(args, '--inputs');
      const inputCount = inputsStr ? parseInt(inputsStr, 10) : 3;
      return commandCompare(registry, name, versionA, versionB, inputCount, ctx ?? {});
    }

    case 'promote': {
      const name = args[1];
      const version = args[2];
      if (!name || !version) {
        return 'Error: agent promote requires name and version arguments.\nUsage: agent promote <name> <version>';
      }
      return commandPromote(registry, name, version, ctx ?? {});
    }

    case 'reject': {
      const name = args[1];
      const version = args[2];
      if (!name || !version) {
        return 'Error: agent reject requires name and version arguments.\nUsage: agent reject <name> <version> --reason "<reason>"';
      }
      const reason = parseFlag(args, '--reason');
      if (!reason) {
        return 'Error: Missing required flag: --reason\nUsage: agent reject <name> <version> --reason "<reason>"';
      }
      return commandReject(registry, name, version, reason, ctx ?? {});
    }

    case 'accept': {
      const name = args[1];
      if (!name) {
        return 'Error: agent accept requires a name argument.\nUsage: agent accept <name>';
      }
      return commandAccept(name, ctx ?? {});
    }

    case 'gaps': {
      return commandGaps(ctx ?? {});
    }

    default:
      return `Error: Unknown command '${subcommand}'.\n${usageMessage()}`;
  }
}

// ---------------------------------------------------------------------------
// Command: agent analyze <name> [--force]
// ---------------------------------------------------------------------------

/**
 * Format a weakness report for CLI display.
 */
function formatWeaknessReport(report: WeaknessReport): string {
  const lines: string[] = [];

  lines.push('Weakness Report:');
  lines.push(`  Overall Assessment: ${report.overall_assessment}`);
  lines.push('');

  if (report.weaknesses.length > 0) {
    lines.push('  Weaknesses:');
    for (const w of report.weaknesses) {
      lines.push(`    - ${w.dimension} (${w.severity}): ${w.evidence}`);
      lines.push(`      Affected domains: ${w.affected_domains.join(', ') || 'none'}`);
      lines.push(`      Focus: ${w.suggested_focus}`);
    }
  } else {
    lines.push('  Weaknesses: none');
  }

  lines.push('');

  if (report.strengths.length > 0) {
    lines.push('  Strengths:');
    for (const s of report.strengths) {
      lines.push(`    - ${s}`);
    }
  } else {
    lines.push('  Strengths: none');
  }

  lines.push('');
  lines.push(`  Recommendation: ${report.recommendation}`);

  return lines.join('\n');
}

/**
 * Execute the `agent analyze <name> [--force]` command.
 *
 * Full improvement lifecycle:
 *   1. Guard checks (FROZEN, UNDER_REVIEW).
 *   2. Observation threshold check (or --force bypass).
 *   3. Performance analysis (weakness report generation).
 *   4. Proposal generation (if recommendation is propose_modification).
 *   5. Meta-review invocation.
 *   6. State transition to UNDER_REVIEW.
 *   7. Audit events at each step.
 *
 * @param registry  The agent registry.
 * @param name      The agent name to analyze.
 * @param force     Whether to bypass the observation threshold.
 * @param ctx       Extended CLI context with improvement dependencies.
 * @returns         Formatted output string.
 */
export async function commandAnalyze(
  registry: IAgentRegistry,
  name: string,
  force: boolean,
  ctx: Partial<CliContext>,
): Promise<string> {
  const output: string[] = [];

  // ------ Validate dependencies ------
  const observationTrigger = ctx.observationTrigger;
  const performanceAnalyzer = ctx.performanceAnalyzer;
  const auditLogger = ctx.auditLogger;

  if (!observationTrigger || !performanceAnalyzer || !auditLogger) {
    return 'Error: Improvement subsystem not available. Ensure the observation trigger, performance analyzer, and audit logger are initialised.';
  }

  // ------ Look up the agent ------
  const record = registry.get(name);
  if (!record) {
    return `Error: Agent '${name}' not found`;
  }

  // ------ Guard: FROZEN agents cannot be analyzed ------
  if (record.state === 'FROZEN') {
    return `Error: Agent '${name}' is FROZEN. Cannot analyze frozen agents.`;
  }

  // ------ Guard: already UNDER_REVIEW ------
  if (record.state === 'UNDER_REVIEW') {
    return `Error: Agent '${name}' is already UNDER_REVIEW.`;
  }

  output.push(`Analyzing agent '${name}' (v${record.agent.version})...`);
  output.push('');

  // ------ Observation threshold check ------
  if (force) {
    output.push('Forcing analysis (bypassing threshold)...');

    // Audit: analysis_triggered (forced)
    auditLogger.log({
      timestamp: new Date().toISOString(),
      event_type: 'analysis_triggered',
      agent_name: name,
      details: {
        agent_name: name,
        invocation_count: 0,
        threshold: 0,
        forced: true,
      },
    });
  } else {
    // Use the observation trigger to check threshold
    const triggerDecision = observationTrigger.check(name, record.agent.version);
    output.push(
      `Observation state: ${triggerDecision.invocationCount}/${triggerDecision.threshold} invocations` +
        ` (${triggerDecision.triggered ? 'threshold reached' : 'collecting'})`,
    );

    if (!triggerDecision.triggered) {
      return output.join('\n') + `\nError: Threshold not reached. Use --force to bypass.`;
    }

    // Audit: analysis_triggered
    auditLogger.log({
      timestamp: new Date().toISOString(),
      event_type: 'analysis_triggered',
      agent_name: name,
      details: {
        agent_name: name,
        invocation_count: triggerDecision.invocationCount,
        threshold: triggerDecision.threshold,
        forced: false,
      },
    });
  }

  // ------ Invoke performance-analyst ------
  output.push('Invoking performance-analyst...');
  output.push('');

  const analysisResult: AnalysisResult = await performanceAnalyzer.analyze(name);

  if (!analysisResult.success || !analysisResult.report) {
    return output.join('\n') + `\nAnalysis failed: ${analysisResult.error ?? 'unknown error'}`;
  }

  const report = analysisResult.report;

  // Audit: weakness_report_generated
  auditLogger.log({
    timestamp: new Date().toISOString(),
    event_type: 'weakness_report_generated',
    agent_name: name,
    details: {
      agent_name: name,
      report_id: report.report_id,
      overall_assessment: report.overall_assessment,
      weakness_count: report.weaknesses.length,
    },
  });

  // Display the weakness report
  output.push(formatWeaknessReport(report));
  output.push('');

  // ------ Route based on recommendation ------
  if (report.recommendation === 'no_action') {
    output.push('No action required. Agent is healthy.');
    return output.join('\n');
  }

  if (report.recommendation === 'propose_specialist') {
    output.push('Recommendation: propose_specialist (domain gap logged).');
    return output.join('\n');
  }

  // ------ Generate proposal (recommend === 'propose_modification') ------
  const proposalGenerator = ctx.proposalGenerator;
  const proposalStore = ctx.proposalStore;

  if (!proposalGenerator || !proposalStore) {
    return output.join('\n') + '\nError: Proposal generator or store not available.';
  }

  output.push('Generating proposal...');
  const proposalResult: ProposalResult = await proposalGenerator.generateProposal(name, report);

  if (!proposalResult.success || !proposalResult.proposal) {
    // Check for constraint violations
    if (proposalResult.constraintViolations && proposalResult.constraintViolations.length > 0) {
      // Audit: proposal_rejected_constraint_violation
      auditLogger.log({
        timestamp: new Date().toISOString(),
        event_type: 'proposal_rejected_constraint_violation',
        agent_name: name,
        details: {
          agent_name: name,
          proposal_id: 'n/a',
          violations: proposalResult.constraintViolations.map((v) => ({
            field: v.field,
            rule: v.rule,
            current_value: v.current_value,
            proposed_value: v.proposed_value,
          })),
        },
      });

      const violationLines = proposalResult.constraintViolations.map(
        (v) => `  - ${v.field}: ${v.rule}`,
      );
      return output.join('\n') + `\nProposal rejected (constraint violations):\n${violationLines.join('\n')}`;
    }

    return output.join('\n') + `\nProposal generation failed: ${proposalResult.error ?? 'unknown error'}`;
  }

  const proposal = proposalResult.proposal;

  // Persist proposal
  proposalStore.append(proposal);

  // Audit: proposal_generated
  auditLogger.log({
    timestamp: new Date().toISOString(),
    event_type: 'proposal_generated',
    agent_name: name,
    details: {
      agent_name: name,
      proposal_id: proposal.proposal_id,
      current_version: proposal.current_version,
      proposed_version: proposal.proposed_version,
      version_bump: proposal.version_bump,
    },
  });

  output.push(
    `  Proposal ID: ${proposal.proposal_id}`,
  );
  output.push(
    `  Version bump: ${proposal.version_bump} (${proposal.current_version} -> ${proposal.proposed_version})`,
  );
  output.push(`  Status: ${proposal.status}`);
  output.push('');

  // ------ Self-referential meta-review bypass ------
  // If the proposal is for the meta-reviewer agent itself, bypass meta-review
  if (name === 'agent-meta-reviewer') {
    // Audit: meta_review_bypassed_self_referential
    auditLogger.log({
      timestamp: new Date().toISOString(),
      event_type: 'meta_review_bypassed_self_referential',
      agent_name: name,
      details: {
        agent_name: name,
        proposal_id: proposal.proposal_id,
      },
    });

    proposalStore.updateStatus(proposal.proposal_id, 'pending_human_review');
    output.push('Meta-review bypassed (self-referential agent).');
    output.push(`  Status: pending_human_review`);
    output.push('');
    output.push(`Agent '${name}' proposal requires human review.`);
    return output.join('\n');
  }

  // ------ Meta-review ------
  const invokeMetaReview = ctx.invokeMetaReview;
  if (!invokeMetaReview) {
    output.push('Meta-review not available. Proposal remains in pending_meta_review.');
    return output.join('\n');
  }

  output.push('Running meta-review...');
  const metaReviewResult: MetaReviewResult = await invokeMetaReview(proposal);

  const findingsCount = metaReviewResult.findings.length;
  const blockersCount = metaReviewResult.findings.filter(
    (f) => f.severity === 'high',
  ).length;
  const warningsCount = findingsCount - blockersCount;
  const verdict = metaReviewResult.approved ? 'approved' : 'rejected';

  // Set meta_review_id (use summary as a simple review identifier)
  const reviewId = `mr-${proposal.proposal_id.substring(0, 8)}`;
  proposalStore.setMetaReviewId(proposal.proposal_id, reviewId);

  // Audit: meta_review_completed
  auditLogger.log({
    timestamp: new Date().toISOString(),
    event_type: 'meta_review_completed',
    agent_name: name,
    details: {
      agent_name: name,
      proposal_id: proposal.proposal_id,
      review_id: reviewId,
      verdict,
      findings_count: findingsCount,
      blockers_count: blockersCount,
    },
  });

  if (metaReviewResult.approved) {
    proposalStore.updateStatus(proposal.proposal_id, 'meta_approved');
    output.push(`  Verdict: approved (${blockersCount} blockers, ${warningsCount} warnings)`);
    output.push(`  Status: meta_approved`);
    output.push('');

    // Transition agent state to UNDER_REVIEW
    try {
      registry.setState(name, 'UNDER_REVIEW');

      // Audit: agent_state_changed
      auditLogger.log({
        timestamp: new Date().toISOString(),
        event_type: 'agent_state_changed',
        agent_name: name,
        details: {
          agent_name: name,
          from: 'ACTIVE',
          to: 'UNDER_REVIEW',
        },
      });

      output.push(`Agent '${name}' is now UNDER_REVIEW.`);
      output.push(`Next step: A/B validation (run 'agent compare ${name}')`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.push(`Warning: Failed to transition agent state: ${message}`);
    }
  } else {
    proposalStore.updateStatus(proposal.proposal_id, 'meta_rejected');
    output.push(`  Verdict: rejected (${blockersCount} blockers, ${warningsCount} warnings)`);
    output.push(`  Status: meta_rejected`);
    output.push('');
    output.push(`Proposal rejected by meta-review. ${metaReviewResult.summary}`);
  }

  return output.join('\n');
}

/**
 * Return a usage help message listing all available commands.
 */
function usageMessage(): string {
  return [
    'Agent Factory CLI Commands:',
    '  agent list               List all registered agents',
    '  agent inspect <name>     Show full configuration for an agent',
    '  agent reload             Reload all agents from disk',
    '  agent freeze <name>      Freeze an agent (set state to FROZEN)',
    '  agent unfreeze <name>    Unfreeze an agent (set state to ACTIVE)',
    '  agent metrics <name>     Show aggregate metrics for an agent',
    '  agent dashboard          Show summary dashboard for all agents',
    '  agent rollback <name>    Rollback an agent to a previous version',
    '  agent analyze <name>     Trigger improvement analysis for an agent',
    '  agent compare <name>     Manual A/B comparison between two versions',
    '  agent promote <name>     Promote an agent to a validated version',
    '  agent reject <name>      Reject a proposed agent version',
    '  agent accept <name>      Accept a proposed new agent',
    '  agent gaps               List all detected domain gaps',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Argument parsing helper
// ---------------------------------------------------------------------------

/**
 * Parse a --flag value from the args array.
 *
 * Supports: `--flag value` and `--flag=value` forms.
 * Returns null if the flag is not present.
 */
function parseFlag(args: string[], flag: string): string | null {
  for (let i = 0; i < args.length; i++) {
    // --flag=value form
    if (args[i].startsWith(`${flag}=`)) {
      return args[i].substring(flag.length + 1);
    }
    // --flag value form
    if (args[i] === flag && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Command: agent compare <name> --version-a X --version-b Y [--inputs N]
// ---------------------------------------------------------------------------

/**
 * Execute a manual A/B comparison between two agent versions.
 *
 * Follows the same 7-step A/B protocol as automated validation, but
 * the operator specifies which two versions to compare and the input
 * count (default 3, max 5).
 *
 * Results are stored at `data/evaluations/manual-<evaluation_id>.json`.
 *
 * @param registry    The agent registry.
 * @param name        The agent name.
 * @param versionA    First version to compare.
 * @param versionB    Second version to compare.
 * @param inputCount  Number of inputs to use (default 3, max 5).
 * @param ctx         Extended CLI context.
 * @returns           Formatted comparison output.
 */
export async function commandCompare(
  registry: IAgentRegistry,
  name: string,
  versionA: string,
  versionB: string,
  inputCount: number,
  ctx: Partial<CliContext>,
): Promise<string> {
  const output: string[] = [];

  // Validate agent exists
  const record = registry.get(name);
  if (!record) {
    return `Error: Agent '${name}' not found`;
  }

  // Validate dependencies
  const abOrchestrator = ctx.abOrchestrator;
  const getDefFromGit = ctx.getAgentDefinitionFromGit;

  if (!abOrchestrator) {
    return 'Error: A/B validation orchestrator not available. Ensure the validation subsystem is initialised.';
  }

  if (!getDefFromGit) {
    return 'Error: Git version retriever not available. Ensure the git subsystem is initialised.';
  }

  // Cap inputs to max 5
  let effectiveInputCount = inputCount;
  if (effectiveInputCount > 5) {
    output.push(`Warning: --inputs capped to maximum of 5 (requested ${effectiveInputCount}).`);
    effectiveInputCount = 5;
  }
  if (effectiveInputCount < 1) {
    effectiveInputCount = 3;
  }

  // Retrieve definitions for both versions from git
  const defA = getDefFromGit(name, versionA);
  if (!defA) {
    return `Error: Could not retrieve definition for ${name} v${versionA} from git history.`;
  }

  const defB = getDefFromGit(name, versionB);
  if (!defB) {
    return `Error: Could not retrieve definition for ${name} v${versionB} from git history.`;
  }

  output.push(`A/B Comparison: ${name} v${versionA} vs v${versionB}`);
  output.push('\u2550'.repeat(47));
  output.push('');
  output.push(`Inputs: ${effectiveInputCount} | Budget: 100,000 tokens`);
  output.push('');

  // Build a synthetic proposal to drive the A/B orchestrator
  const syntheticProposal: AgentProposal = {
    proposal_id: `manual-${crypto_randomUUID()}`,
    agent_name: name,
    current_version: versionA,
    proposed_version: versionB,
    version_bump: 'patch',
    weakness_report_id: 'manual-comparison',
    current_definition: defA,
    proposed_definition: defB,
    diff: '(manual comparison)',
    rationale: `Manual A/B comparison: v${versionA} vs v${versionB}`,
    status: 'validating',
    created_at: new Date().toISOString(),
  };

  // Run the A/B validation
  let evaluation: ABEvaluationResult;
  try {
    evaluation = await abOrchestrator.runValidation(syntheticProposal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return output.join('\n') + `\nA/B comparison failed: ${message}`;
  }

  // Format per-input results
  for (let i = 0; i < evaluation.inputs.length; i++) {
    const input = evaluation.inputs[i];
    const scoreA = input.version_a_scores.overall;
    const scoreB = input.version_b_scores.overall;
    const delta = input.overall_delta;
    const winner =
      input.outcome === 'proposed_wins'
        ? `v${versionB}`
        : input.outcome === 'current_wins'
          ? `v${versionA}`
          : 'TIE';

    output.push(
      `Input ${i + 1} (${input.selection_reason}):`,
    );
    output.push(
      `  v${versionA}: ${scoreA.toFixed(1)}   v${versionB}: ${scoreB.toFixed(1)}   delta: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}   Winner: ${winner}`,
    );

    // Per-dimension deltas
    const dimParts: string[] = [];
    for (const [dimName, dimDelta] of Object.entries(input.per_dimension_delta)) {
      dimParts.push(`${dimName} ${dimDelta >= 0 ? '+' : ''}${dimDelta.toFixed(1)}`);
    }
    if (dimParts.length > 0) {
      output.push(`  Per-dimension: ${dimParts.join(', ')}`);
    }

    output.push('');
  }

  // Aggregate
  const agg = evaluation.aggregate;
  output.push('\u2500'.repeat(47));
  output.push(
    `Aggregate: v${versionB} wins ${agg.proposed_wins}/${agg.total_inputs}, ` +
    `v${versionA} wins ${agg.current_wins}/${agg.total_inputs}, ` +
    `ties ${agg.ties}/${agg.total_inputs}`,
  );
  output.push(`Mean delta: ${agg.mean_delta >= 0 ? '+' : ''}${agg.mean_delta.toFixed(1)}`);
  output.push(`Verdict: ${agg.verdict.toUpperCase()}`);
  output.push('');
  output.push(`Evaluation saved: data/evaluations/manual-${evaluation.evaluation_id}.json`);

  return output.join('\n');
}

/**
 * Generate a UUID v4. Inline helper to avoid import issues.
 */
function crypto_randomUUID(): string {
  // Use the same approach as the rest of the codebase
  try {
    return require('crypto').randomUUID();
  } catch {
    // Fallback: timestamp-based pseudo-UUID
    const hex = Date.now().toString(16);
    return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-4000-8000-${hex}000000`.substring(0, 36);
  }
}

// ---------------------------------------------------------------------------
// Command: agent promote <name> <version>
// ---------------------------------------------------------------------------

/**
 * Execute the promote command: display review summary and trigger promotion.
 *
 * Triggers the Promoter.promote() workflow:
 *   1. Find the proposal for the given agent and version.
 *   2. Display the review summary (weakness report, meta-review, A/B results, diff).
 *   3. Execute promotion (in non-interactive mode; confirmation handled by caller).
 *
 * @param registry  The agent registry.
 * @param name      The agent name to promote.
 * @param version   The target version to promote.
 * @param ctx       Extended CLI context with promotion dependencies.
 * @returns         Formatted result string.
 */
export async function commandPromote(
  registry: IAgentRegistry,
  name: string,
  version: string,
  ctx: Partial<CliContext>,
): Promise<string> {
  const output: string[] = [];

  // Validate dependencies
  const promoter = ctx.promoter;
  const proposalStore = ctx.proposalStore;

  if (!promoter) {
    return 'Error: Promoter not available. Ensure the promotion subsystem is initialised.';
  }

  if (!proposalStore) {
    return 'Error: Proposal store not available. Ensure the improvement subsystem is initialised.';
  }

  // Find the proposal for this agent/version
  const proposals = proposalStore.getByAgent(name);
  const proposal = proposals.find(
    (p) => p.proposed_version === version,
  );

  if (!proposal) {
    return `Error: No proposal found for '${name}' version ${version}.`;
  }

  // Display review summary
  output.push(promoter.buildReviewSummary(proposal));
  output.push('');

  // Display confirmation prompt (in CLI output -- actual confirmation is handled by caller)
  output.push(`Promote ${name} to v${version}? [y/N]`);
  output.push('');

  // Execute promotion
  const result: PromotionResult = await promoter.promote(name, proposal.proposal_id);

  if (result.success) {
    output.push(`Successfully promoted ${name} to v${version}.`);
    output.push(`  Commit: ${result.commitHash}`);
  } else {
    output.push(`Promotion failed: ${result.error}`);
  }

  return output.join('\n');
}

// ---------------------------------------------------------------------------
// Command: agent reject <name> <version> --reason "<reason>"
// ---------------------------------------------------------------------------

/**
 * Execute the reject command: reject a proposed agent version.
 *
 * Triggers the Rejector.reject() workflow. Requires `--reason` flag.
 *
 * @param registry  The agent registry.
 * @param name      The agent name.
 * @param version   The version being rejected.
 * @param reason    The reason for rejection.
 * @param ctx       Extended CLI context with rejection dependencies.
 * @returns         Formatted result string.
 */
export function commandReject(
  registry: IAgentRegistry,
  name: string,
  version: string,
  reason: string,
  ctx: Partial<CliContext>,
): string {
  // Validate dependencies
  const rejector = ctx.rejector;
  const proposalStore = ctx.proposalStore;

  if (!rejector) {
    return 'Error: Rejector not available. Ensure the promotion subsystem is initialised.';
  }

  if (!proposalStore) {
    return 'Error: Proposal store not available. Ensure the improvement subsystem is initialised.';
  }

  // Find the proposal for this agent/version
  const proposals = proposalStore.getByAgent(name);
  const proposal = proposals.find(
    (p) => p.proposed_version === version,
  );

  if (!proposal) {
    return `Error: No proposal found for '${name}' version ${version}.`;
  }

  // Execute rejection
  const result: RejectionResult = rejector.reject(name, proposal.proposal_id, reason);

  if (result.success) {
    return `Proposal rejected for ${name} v${version}.\n  Reason: ${reason}`;
  } else {
    return `Rejection failed: ${result.error}`;
  }
}

// ---------------------------------------------------------------------------
// Command: agent accept <name>
// ---------------------------------------------------------------------------

/**
 * Accept a proposed new agent from `data/proposed-agents/`.
 *
 * Placeholder for PLAN-005-5 dynamic creation. Checks if a proposed
 * agent definition exists, displays its summary, and confirms acceptance.
 *
 * @param name  The proposed agent name.
 * @param ctx   Extended CLI context.
 * @returns     Formatted result string.
 */
export function commandAccept(
  name: string,
  ctx: Partial<CliContext>,
): string {
  const proposedDir = ctx.proposedAgentsDir ?? 'data/proposed-agents';
  // Use dynamic require to avoid top-level import side effects in test environments
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('path') as typeof import('path');

  const proposedFilePath = nodePath.resolve(proposedDir, `${name}.md`);

  if (!nodeFs.existsSync(proposedFilePath)) {
    return `Error: No proposed agent found with name '${name}' in ${proposedDir}.`;
  }

  // Read the proposed agent definition
  let content: string;
  try {
    content = nodeFs.readFileSync(proposedFilePath, 'utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: Failed to read proposed agent file: ${message}`;
  }

  // Display a summary of the proposed agent
  const lines: string[] = [];
  lines.push(`Proposed Agent: ${name}`);
  lines.push('\u2500'.repeat(40));

  // Extract the first few lines of the definition for a summary
  const defLines = content.split('\n');
  const previewLines = defLines.slice(0, 20);
  lines.push('Definition preview (first 20 lines):');
  for (const line of previewLines) {
    lines.push(`  ${line}`);
  }
  if (defLines.length > 20) {
    lines.push('  ...');
  }
  lines.push('');
  lines.push(`Accept proposed agent '${name}'? [y/N]`);
  lines.push('');
  lines.push('Note: Agent acceptance is a placeholder for PLAN-005-5 dynamic creation.');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Command: agent gaps
// ---------------------------------------------------------------------------

/**
 * List all detected domain gaps from `data/domain-gaps.jsonl`.
 *
 * Displays a formatted table with domain, status, closest agent,
 * similarity score, and detection date.
 *
 * @param ctx  Extended CLI context with gap detector.
 * @returns    Formatted gaps table.
 */
export function commandGaps(ctx: Partial<CliContext>): string {
  const gapDetector = ctx.gapDetector;

  if (!gapDetector) {
    return 'Error: Domain gap detector not available. Ensure the gap detection subsystem is initialised.';
  }

  const gaps = gapDetector.readAll();

  if (gaps.length === 0) {
    return 'No domain gaps detected.';
  }

  const lines: string[] = [];

  // Column widths
  const COL_DOMAIN = 21;
  const COL_STATUS = 27;
  const COL_AGENT = 18;
  const COL_SIM = 7;

  lines.push('DOMAIN GAPS');
  lines.push('\u2550'.repeat(56));

  const header = [
    pad('DOMAIN', COL_DOMAIN),
    pad('STATUS', COL_STATUS),
    pad('CLOSEST AGENT', COL_AGENT),
    pad('SIM', COL_SIM),
    'DETECTED',
  ].join('');
  lines.push(header);
  lines.push('\u2500'.repeat(56));

  // Count by status for the footer
  const statusCounts: Record<string, number> = {};

  for (const gap of gaps) {
    const domain = truncate(gap.task_domain, COL_DOMAIN - 1);
    const status = gap.status;
    const agent = truncate(gap.closest_agent ?? 'none', COL_AGENT - 1);
    const sim = gap.closest_similarity.toFixed(2);
    const detected = gap.detected_at.substring(0, 10); // YYYY-MM-DD

    lines.push(
      [
        pad(domain, COL_DOMAIN),
        pad(status, COL_STATUS),
        pad(agent, COL_AGENT),
        pad(sim, COL_SIM),
        detected,
      ].join(''),
    );

    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }

  lines.push('\u2500'.repeat(56));

  // Footer summary
  const statusParts = Object.entries(statusCounts)
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
  lines.push(`Total: ${gaps.length} gaps (${statusParts})`);

  return lines.join('\n');
}

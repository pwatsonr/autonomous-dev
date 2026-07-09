/**
 * `autonomous-dev deploy targets list` and
 * `autonomous-dev deploy run <service> --target <id-or-selector> [--dry-run] [--confirm]`
 * (issues #661, #662).
 *
 * ## Commands
 *
 * ### `deploy targets list [--json]`
 *
 * Lists all targets currently visible in the registry — statics first, then
 * provider-supplied targets in provider-registration order.  Because
 * `registry.list()` re-queries every registered `TargetProvider` on each
 * call, the output always reflects the live topology (invariant #674).
 *
 * Columns (human table): ID | NAME | KIND | ENV | CAPABILITIES | TAGS | SOURCE
 *
 * With `--json`: emits a JSON array of plain target objects on stdout.
 *
 * ### `deploy run <service> --target <id-or-selector> [--dry-run] [--confirm]`
 *
 * Resolves the target via `resolveTarget()` and either:
 *   - `--dry-run` (default-safe mode): calls `runPipeline({ dryRun: true })`,
 *     evaluates policy, and prints the resolved target, policy decision, and
 *     planned stages WITHOUT mutating anything. No backend methods are called.
 *   - `--confirm` (without `--dry-run`): runs the full staged deploy pipeline
 *     (policy-check → build → push → deploy → health-verify → auto-rollback)
 *     via `runPipeline()`. Emits stage events to stdout as they arrive.
 *     Returns exit code 0 on success, 1 on pipeline failure.
 *   - Without either flag: errors immediately with exit code 1 to prevent
 *     accidental deploys.
 *
 * `--target` accepts either:
 *   - an exact target id (`prod-node`)
 *   - a `key=value` selector token (`kind=swarm-node`, `env=prod`,
 *     `capability=gpu`, `tag.<k>=<v>`)
 *
 * ## Pattern notes
 *
 * - Follows `deploy_backends_command.ts` exactly: `register*Command(program)`
 *   finds or creates the top-level `deploy` commander group and attaches
 *   subcommands.
 * - Streams (`stdout`/`stderr`) are injected for testability.
 * - No process.exit() — callers throw (commander's `exitOverride()` converts
 *   them to exit codes).
 * - No static target list.  All target data comes from the live registry.
 *
 * Cross-reference: issues #660, #661, #662, #668, #674.
 *
 * @module intake/cli/deploy_targets_command
 */

import { Command } from 'commander';

import type { DeployTarget } from '../deploy/target-types';
import type { DeployTargetRegistry } from '../deploy/target-registry';
import { getDeployTargetRegistry } from '../deploy/target-registry';
import {
  resolveTarget,
  UnknownTargetError,
  AmbiguousTargetError,
  NoMatchingTargetError,
  NoDefaultTargetError,
} from '../deploy/target-resolver';
import type { TargetSelector } from '../deploy/target-types';
import {
  runPipeline,
  type PipelineRunOptions,
  type StageEvent,
  type PipelineRunResult,
} from '../deploy/pipeline-runner';
import type { PipelineBackend } from '../deploy/backend-types';
import type { PolicyDocument } from '../deploy/policy-types';

// ---------------------------------------------------------------------------
// Public stream/deps types
// ---------------------------------------------------------------------------

/** Injected streams for testability — defaults to process.stdout/stderr. */
export interface DeployTargetsStreams {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** Injected registry for testability. Defaults to the production singleton. */
export interface DeployTargetsOptions {
  registry?: DeployTargetRegistry;
  /** Optional policy document to evaluate before executing a real deploy. */
  policy?: PolicyDocument;
  /** TEST ONLY — override the backend used by `runPipeline`. */
  _backendOverride?: PipelineBackend;
}

// ---------------------------------------------------------------------------
// `deploy targets list` implementation
// ---------------------------------------------------------------------------

/**
 * Human-table rendering for `deploy targets list`.
 *
 * Column order: ID | NAME | KIND | ENV | CAPABILITIES | TAGS | SOURCE
 *
 * @param targets - Live target list from `registry.list()`.
 * @returns Multi-line table string ending with `\n`, or a no-results message.
 */
export function renderTargetsTable(targets: DeployTarget[]): string {
  if (targets.length === 0) return '(no targets registered)\n';

  const headers = ['ID', 'NAME', 'KIND', 'ENV', 'CAPABILITIES', 'TAGS', 'SOURCE'];

  const rows: string[][] = [headers];
  for (const t of targets) {
    rows.push([
      t.id,
      t.name,
      t.kind,
      t.env ?? '',
      t.capabilities.join(','),
      Object.entries(t.tags)
        .map(([k, v]) => `${k}=${v}`)
        .join(','),
      t.source,
    ]);
  }

  const widths = headers.map((_, col) =>
    Math.max(...rows.map((r) => (r[col] ?? '').length)),
  );

  const lines: string[] = [];
  for (const r of rows) {
    lines.push(r.map((cell, i) => (cell ?? '').padEnd(widths[i])).join(' | '));
  }
  return lines.join('\n') + '\n';
}

/**
 * Run `deploy targets list`.
 *
 * Queries the live registry on every invocation (invariant #674).
 *
 * @param opts    - `{ json }` flag.
 * @param deps    - Injected registry.
 * @param streams - Injected streams.
 * @returns Exit code (0 = success).
 */
export async function runDeployTargetsList(
  opts: { json?: boolean },
  deps: DeployTargetsOptions = {},
  streams: DeployTargetsStreams = {},
): Promise<number> {
  const stdout = streams.stdout ?? process.stdout;
  const registry = deps.registry ?? getDeployTargetRegistry();

  const targets = await registry.list();

  if (opts.json) {
    stdout.write(JSON.stringify({ targets }, null, 2) + '\n');
    return 0;
  }

  stdout.write(renderTargetsTable(targets));
  return 0;
}

// ---------------------------------------------------------------------------
// `--target` string parser
// ---------------------------------------------------------------------------

/**
 * Parse a `--target` string into either a raw id or a `TargetSelector`.
 *
 * Accepted forms:
 * - `<id>`            → `{ id: '<id>' }` (anything without `=`)
 * - `kind=<k>`        → `{ kind: '<k>' }`
 * - `env=<e>`         → `{ env: '<e>' }`
 * - `capability=<c>`  → `{ capability: '<c>' }`
 * - `tag.<key>=<val>` → `{ tag: { key: '<key>', value: '<val>' } }`
 *
 * Any other `key=value` without a recognised prefix is treated as a plain id
 * (backward-compatible; callers get the UnknownTargetError from the resolver
 * if the id is not found).
 *
 * @param raw - The raw `--target` argument string.
 * @returns `{ targetId }` when the string has no recognised selector prefix,
 *          `{ selector }` otherwise.
 */
export function parseTargetArg(
  raw: string,
): { targetId: string; selector?: undefined } | { selector: TargetSelector; targetId?: undefined } {
  if (!raw.includes('=')) {
    return { targetId: raw };
  }

  const eqIdx = raw.indexOf('=');
  const key = raw.slice(0, eqIdx);
  const value = raw.slice(eqIdx + 1);

  if (key === 'kind') return { selector: { kind: value } };
  if (key === 'env') return { selector: { env: value } };
  if (key === 'capability') return { selector: { capability: value } };
  if (key.startsWith('tag.')) {
    const tagKey = key.slice(4);
    return { selector: { tag: { key: tagKey, value } } };
  }

  // Unrecognised key=value — treat the whole string as a target id so the
  // error from the resolver is "Unknown target '...' " rather than a parse
  // error. This is the safest fallback for novel selector forms.
  return { targetId: raw };
}

// ---------------------------------------------------------------------------
// `deploy run <service> --target <id> [--dry-run] [--confirm]` implementation
// ---------------------------------------------------------------------------

/**
 * Options for `runDeployService`.
 */
export interface RunDeployServiceOptions {
  /** Service name (first positional argument). */
  service: string;
  /** Raw `--target` argument string (id or selector token). */
  targetRaw?: string;
  /** When true, print the plan and exit without mutating anything. */
  dryRun?: boolean;
  /**
   * When true (and `dryRun` is false), executes the real deploy pipeline.
   * Required to prevent accidental deploys — `deploy run` without `--confirm`
   * errors immediately with exit code 1.
   */
  confirm?: boolean;
  /** Injected registry for testability. */
  registry?: DeployTargetRegistry;
  /** Optional policy document to evaluate before deploying. */
  policy?: PolicyDocument;
  /**
   * Optional artifact metadata for the pipeline run.
   * Callers that do not supply this get a minimal default derived from
   * `service` so the pipeline context is always valid.
   */
  artifact?: {
    name: string;
    sourceDir?: string;
    tag?: string;
    meta?: Record<string, unknown>;
  };
  /** TEST ONLY — override the backend dispatched by `runPipeline`. */
  _backendOverride?: PipelineBackend;
}

/**
 * Render the dry-run plan for a target.
 *
 * Shows the resolved target in a human-readable format, listing all fields
 * that would be used by the deploy pipeline. When a `PipelineRunResult` is
 * provided (from `runPipeline({ dryRun: true })`), its planned stage list
 * and policy decision are included.
 *
 * @param service        - Service name.
 * @param target         - Resolved deploy target.
 * @param source         - Resolution source (for operator visibility).
 * @param pipelineResult - Optional dry-run pipeline result for stage detail.
 * @returns Multi-line plan string ending with `\n`.
 */
export function renderDryRunPlan(
  service: string,
  target: DeployTarget,
  source: string,
  pipelineResult?: PipelineRunResult,
): string {
  const lines: string[] = [];
  lines.push('Deploy plan (dry-run — no changes will be made)');
  lines.push('');
  lines.push(`  Service:      ${service}`);
  lines.push(`  Target id:    ${target.id}`);
  lines.push(`  Target name:  ${target.name}`);
  lines.push(`  Kind:         ${target.kind}`);
  lines.push(`  Provider:     ${target.provider}`);
  lines.push(`  Env:          ${target.env ?? '(not set)'}`);
  lines.push(`  Capabilities: ${target.capabilities.length > 0 ? target.capabilities.join(', ') : '(none)'}`);
  const tagEntries = Object.entries(target.tags);
  lines.push(`  Tags:         ${tagEntries.length > 0 ? tagEntries.map(([k, v]) => `${k}=${v}`).join(', ') : '(none)'}`);
  lines.push(`  Source:       ${target.source}`);
  lines.push(`  Resolved via: ${source}`);

  if (pipelineResult) {
    // Policy decision from the pipeline dry-run.
    const pd = pipelineResult.policyDecision;
    lines.push('');
    lines.push(`Policy decision: ${pd.allowed ? 'ALLOWED' : 'BLOCKED'}`);
    if (pd.violations.length > 0) {
      for (const v of pd.violations) {
        lines.push(`  [deny] ${v.message}`);
      }
    }
    if (pd.requiredApprovals.length > 0) {
      lines.push(`  Required approvals: ${pd.requiredApprovals.join(', ')}`);
    }

    lines.push('');
    lines.push('Stages that would execute:');
    for (let i = 0; i < pipelineResult.stages.length; i++) {
      const s = pipelineResult.stages[i];
      lines.push(`  ${i + 1}. [${s.stage}] → ${s.status}${s.message ? ` — ${s.message}` : ''}`);
    }
  } else {
    lines.push('');
    lines.push('Stages that would execute:');
    lines.push('  1. Safety gate check (approval / cost-cap)');
    lines.push('  2. Build artifact for service');
    lines.push(`  3. Deploy artifact to target '${target.id}' via backend '${target.provider}'`);
    lines.push('  4. Post-deploy health check');
  }

  lines.push('');
  lines.push('(Dry-run complete. No changes were made.)');
  return lines.join('\n') + '\n';
}

/**
 * Format a `StageEvent` as a human-readable line for CLI output.
 *
 * Emitted to stdout during a real pipeline run so operators see live progress.
 *
 * @param event - The stage event to format.
 * @returns A single log line (no trailing newline).
 */
export function formatStageEvent(event: StageEvent): string {
  const duration = event.durationMs !== undefined ? ` (${event.durationMs}ms)` : '';
  const msg = event.message ? ` — ${event.message}` : '';
  return `[${event.ts}] [${event.stage}] ${event.status.toUpperCase()}${duration}${msg}`;
}

/**
 * Render a final `PipelineRunResult` summary for CLI output.
 *
 * Shown after `runPipeline()` completes in the real (non-dry-run) path.
 *
 * @param result - The completed pipeline result.
 * @returns Multi-line summary string ending with `\n`.
 */
export function renderPipelineResult(result: PipelineRunResult): string {
  const lines: string[] = [];
  const statusLabel = result.status.toUpperCase();
  const total = `${result.totalDurationMs}ms`;
  lines.push('');
  lines.push(`Pipeline ${statusLabel} in ${total}`);
  lines.push(`  Run ID: ${result.runId}`);
  lines.push(`  Started: ${result.startedAt}`);
  lines.push('');
  lines.push('Stage summary:');
  for (const s of result.stages) {
    lines.push(
      `  [${s.stage.padEnd(14)}] ${s.status.toUpperCase().padEnd(8)} ${s.durationMs}ms${s.message ? ` — ${s.message}` : ''}`,
    );
  }
  if (result.deployResult) {
    lines.push('');
    lines.push(`Deploy result: ${result.deployResult.success ? 'success' : 'failed'}`);
    if (result.deployResult.message) {
      lines.push(`  ${result.deployResult.message}`);
    }
  }
  if (result.rollbackResult) {
    lines.push('');
    lines.push(`Rollback result: ${result.rollbackResult.success ? 'success' : 'failed'}`);
    if (result.rollbackResult.errors.length > 0) {
      for (const e of result.rollbackResult.errors) {
        lines.push(`  [error] ${e}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Run `deploy run <service> --target <id-or-selector> [--dry-run] [--confirm]`.
 *
 * Resolves the target, then:
 *   - `--dry-run`: calls `runPipeline({ dryRun: true })` — evaluates policy
 *     and emits planned stage events without executing any backend method.
 *     Prints the resolved target, policy decision, and planned stages.
 *   - `--confirm` (without `--dry-run`): executes the full staged deploy
 *     pipeline via `runPipeline()`. Stage events are emitted to stdout as
 *     they arrive. Returns exit code 0 on success, 1 on pipeline failure.
 *   - Without `--confirm` or `--dry-run`: errors immediately with exit code
 *     1 to prevent accidental deploys.
 *
 * @param opts    - Service + target options.
 * @param streams - Injected streams.
 * @returns Exit code (0 = success, 1 = error).
 */
export async function runDeployService(
  opts: RunDeployServiceOptions,
  streams: DeployTargetsStreams = {},
): Promise<number> {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;

  // ---- Parse --target -------------------------------------------------------
  let targetId: string | undefined;
  let selector: TargetSelector | undefined;

  if (opts.targetRaw !== undefined && opts.targetRaw.length > 0) {
    const parsed = parseTargetArg(opts.targetRaw);
    if ('targetId' in parsed && parsed.targetId !== undefined) {
      targetId = parsed.targetId;
    } else if ('selector' in parsed && parsed.selector !== undefined) {
      selector = parsed.selector;
    }
  }

  // ---- Resolve the target ---------------------------------------------------
  let resolved: Awaited<ReturnType<typeof resolveTarget>>;
  try {
    resolved = await resolveTarget({
      targetId,
      selector,
      registry: opts.registry,
    });
  } catch (err) {
    if (
      err instanceof UnknownTargetError ||
      err instanceof AmbiguousTargetError ||
      err instanceof NoMatchingTargetError ||
      err instanceof NoDefaultTargetError
    ) {
      stderr.write(`${(err as Error).message}\n`);
      return 1;
    }
    throw err;
  }

  const { target, source } = resolved;

  // ---- Build shared pipeline options ----------------------------------------
  const artifact = opts.artifact ?? { name: opts.service, meta: {} };
  const pipelineOpts: PipelineRunOptions = {
    target,
    service: opts.service,
    artifact,
    policy: opts.policy,
    _backendOverride: opts._backendOverride,
  };

  // ---- Dry-run --------------------------------------------------------------
  if (opts.dryRun) {
    const result = await runPipeline({ ...pipelineOpts, dryRun: true });
    stdout.write(renderDryRunPlan(opts.service, target, source, result));
    return 0;
  }

  // ---- Guard: require --confirm for a real deploy --------------------------
  if (!opts.confirm) {
    stderr.write(
      `deploy run: refusing to execute a real deploy without --confirm.\n` +
        `  Use --dry-run to preview the plan, or add --confirm to execute it.\n`,
    );
    return 1;
  }

  // ---- Real pipeline run ---------------------------------------------------
  stdout.write(`Deploying '${opts.service}' to target '${target.id}' (${target.name}) [via ${source}]\n`);

  const onStageEvent = (event: StageEvent): void => {
    stdout.write(formatStageEvent(event) + '\n');
  };

  const result = await runPipeline({ ...pipelineOpts, onStageEvent });
  stdout.write(renderPipelineResult(result));

  if (result.status === 'success') {
    return 0;
  }

  stderr.write(`Deploy failed: ${result.status}\n`);
  return 1;
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

/**
 * Register `deploy targets list` and `deploy run <service> --target ...` under
 * the top-level `deploy` commander group.
 *
 * If the `deploy` group does not yet exist it is created (same pattern as
 * `registerDeployBackendsCommand` and `registerDeployPlanCommand`).
 *
 * @param program - The top-level commander `Command`.
 * @param deps    - Injected registry for testability.
 * @param streams - Injected streams for testability.
 */
export function registerDeployTargetsCommand(
  program: Command,
  deps: DeployTargetsOptions = {},
  streams: DeployTargetsStreams = {},
): void {
  // Find or create the shared `deploy` command group.
  let deployGroup: Command | undefined = program.commands.find(
    (c: Command) => c.name() === 'deploy',
  );
  if (!deployGroup) {
    deployGroup = program
      .command('deploy')
      .description('Deployment operations')
      .exitOverride();
  }

  // ---- `deploy targets` subgroup ------------------------------------------
  const targetsGroup = deployGroup
    .command('targets')
    .description('Inspect deploy targets')
    .exitOverride();

  targetsGroup
    .command('list')
    .description(
      'List all registered deploy targets (always reflects live topology)',
    )
    .option('--json', 'Emit JSON instead of a human-readable table', false)
    .action(async (opts: Record<string, unknown>) => {
      const code = await runDeployTargetsList(
        { json: opts.json === true },
        deps,
        streams,
      );
      if (code !== 0) throw new Error('deploy targets list failed');
    });

  // ---- `deploy run <service> --target ...` ---------------------------------
  deployGroup
    .command('run')
    .description(
      'Deploy a service to a resolved target. Use --dry-run to preview; --confirm to execute.',
    )
    .argument('<service>', 'Service name to deploy')
    .option(
      '--target <id-or-selector>',
      'Target id or selector (kind=<k>, env=<e>, capability=<c>, tag.<key>=<val>)',
    )
    .option('--dry-run', 'Print the resolved target, policy decision, and planned stages; make no changes', false)
    .option('--confirm', 'Execute the real deploy pipeline (required without --dry-run)', false)
    .action(async (service: string, opts: Record<string, unknown>) => {
      const code = await runDeployService(
        {
          service,
          targetRaw: typeof opts.target === 'string' ? opts.target : undefined,
          dryRun: opts.dryRun === true,
          confirm: opts.confirm === true,
          registry: deps.registry,
          policy: deps.policy,
          _backendOverride: deps._backendOverride,
        },
        streams,
      );
      if (code !== 0) throw Object.assign(new Error('deploy run failed'), { exitCode: code });
    });
}

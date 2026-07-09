/**
 * `autonomous-dev deploy targets list` and
 * `autonomous-dev deploy <service> --target <id-or-selector> [--dry-run]`
 * (issue #661).
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
 * ### `deploy <service> --target <id-or-selector> [--dry-run]`
 *
 * Resolves the target via `resolveTarget()` and either:
 *   - `--dry-run` (default-safe mode): prints the resolved target and the
 *     deployment plan (what would happen) WITHOUT mutating anything.
 *   - without `--dry-run`: resolves the target, then hands off to the
 *     existing deploy pipeline.  For this issue, if full orchestration is not
 *     yet wired end-to-end, prints the resolved target and a message
 *     explaining the handoff point (issue #662) so the user gets useful
 *     feedback rather than silence.
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
 * Cross-reference: issues #660, #661, #674.
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
// `deploy <service> --target <id> [--dry-run]` implementation
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
  /** Injected registry for testability. */
  registry?: DeployTargetRegistry;
}

/**
 * Render the dry-run plan for a target.
 *
 * Shows the resolved target in a human-readable format, listing all fields
 * that would be used by the deploy pipeline.
 *
 * @param service - Service name.
 * @param target  - Resolved deploy target.
 * @param source  - Resolution source (for operator visibility).
 * @returns Multi-line plan string.
 */
export function renderDryRunPlan(
  service: string,
  target: DeployTarget,
  source: string,
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
  lines.push('');
  lines.push('Stages that would execute:');
  lines.push('  1. Safety gate check (approval / cost-cap)');
  lines.push('  2. Build artifact for service');
  lines.push(`  3. Deploy artifact to target '${target.id}' via backend '${target.provider}'`);
  lines.push('  4. Post-deploy health check');
  lines.push('');
  lines.push('(Dry-run complete. No changes were made.)');
  return lines.join('\n') + '\n';
}

/**
 * Run `deploy <service> --target <id-or-selector> [--dry-run]`.
 *
 * Resolves the target, then:
 *   - `--dry-run`: prints the plan and returns 0. No mutations.
 *   - Without `--dry-run`: resolves the target and reports the handoff to
 *     the deploy pipeline.  Full execution is wired in issue #662; this
 *     issue delivers the target-selection surface and dry-run, which are the
 *     user-facing "select where to deploy" capability.
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

  // ---- Dry-run --------------------------------------------------------------
  if (opts.dryRun) {
    stdout.write(renderDryRunPlan(opts.service, target, source));
    return 0;
  }

  // ---- Non-dry-run: resolved target + handoff note -------------------------
  // Full execution of the deploy pipeline is delivered by issue #662.
  // This issue (#661) delivers the user-facing target selection + dry-run.
  stdout.write(`Resolved target: ${target.id} (${target.name}) via ${source}\n`);
  stdout.write(`Deploying '${opts.service}' to target '${target.id}':\n`);
  stdout.write(`  Handoff to deploy pipeline is tracked in issue #662.\n`);
  stdout.write(`  (Use --dry-run to preview the plan without executing it.)\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

/**
 * Register `deploy targets list` and `deploy <service> --target ...` under
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

  // ---- `deploy <service> --target ...` ------------------------------------
  deployGroup
    .command('run')
    .description(
      'Deploy a service to a resolved target. Use --dry-run to preview without executing.',
    )
    .argument('<service>', 'Service name to deploy')
    .option(
      '--target <id-or-selector>',
      'Target id or selector (kind=<k>, env=<e>, capability=<c>, tag.<key>=<val>)',
    )
    .option('--dry-run', 'Print the resolved target and plan; make no changes', false)
    .action(async (service: string, opts: Record<string, unknown>) => {
      const code = await runDeployService(
        {
          service,
          targetRaw: typeof opts.target === 'string' ? opts.target : undefined,
          dryRun: opts.dryRun === true,
          registry: deps.registry,
        },
        streams,
      );
      if (code !== 0) throw Object.assign(new Error('deploy run failed'), { exitCode: code });
    });
}

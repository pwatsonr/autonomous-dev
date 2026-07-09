/**
 * `autonomous-dev deploy promote <service> --from <target> --to <target>
 *   [--artifact <ref>] [--checksum <sha256>] [--dry-run|--confirm]`
 * (issue #663).
 *
 * ## Command
 *
 * Promotes a pre-built artifact (same image / same digest — no rebuild) from
 * one deploy target to another, running deploy + health-verify on the
 * destination via the pipeline runner.  Policy for the DESTINATION target is
 * enforced.  Lineage (a `PromotionRecord`) is recorded on success.
 *
 * ```
 * deploy promote <service> \
 *   --from <source-target-id-or-selector> \
 *   --to   <dest-target-id-or-selector>   \
 *   --artifact <ref>                        \
 *   [--checksum <sha256>]                   \
 *   [--promoted-by <identity>]              \
 *   [--dry-run | --confirm]
 * ```
 *
 * - `--dry-run` (default-safe): evaluates policy + emits planned stages.
 *   No backend is called; no lineage entry is recorded.
 * - `--confirm` (required for real apply): runs the pipeline and records
 *   lineage.
 * - Without either flag: errors immediately (prevents accidental promotion).
 *
 * ## Pattern notes
 *
 * Follows `deploy_targets_command.ts` exactly: `registerDeployPromoteCommand`
 * finds or creates the top-level `deploy` commander group and attaches the
 * `promote` subcommand.
 *
 * Streams (`stdout`/`stderr`) are injected for testability.
 * No `process.exit()`.
 *
 * Cross-reference: issues #663, #662, #668, #674.
 *
 * @module intake/cli/deploy_promote_command
 */

import { Command } from 'commander';

import type { DeployTargetRegistry } from '../deploy/target-registry';
import { getDeployTargetRegistry } from '../deploy/target-registry';
import {
  resolveTarget,
  UnknownTargetError,
  AmbiguousTargetError,
  NoMatchingTargetError,
  NoDefaultTargetError,
} from '../deploy/target-resolver';
import { parseTargetArg } from './deploy_targets_command';
import {
  promote,
  getPromotionLineage,
  PromotionChecksumError,
  PromotionConfirmRequiredError,
} from '../deploy/promotion';
import type { PromoteOptions, PromotionRecord } from '../deploy/promotion';
import type { PipelineBackend } from '../deploy/backend-types';
import type { PolicyDocument } from '../deploy/policy-types';
import type { StageEvent } from '../deploy/pipeline-runner';

// ---------------------------------------------------------------------------
// Stream + deps types
// ---------------------------------------------------------------------------

/** Injected streams for testability. */
export interface DeployPromoteStreams {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** Injected deps for testability. */
export interface DeployPromoteOptions {
  registry?: DeployTargetRegistry;
  policy?: PolicyDocument;
  _backendOverride?: PipelineBackend;
}

// ---------------------------------------------------------------------------
// Promotion plan renderer
// ---------------------------------------------------------------------------

/**
 * Render a dry-run promotion plan summary.
 *
 * @param service     - Service being promoted.
 * @param artifactRef - The artifact reference being promoted.
 * @param fromId      - Source target id.
 * @param toId        - Destination target id.
 * @param toKind      - Destination target kind.
 * @param toEnv       - Destination target env.
 * @returns Multi-line plan string ending with `\n`.
 */
export function renderPromotionPlan(
  service: string,
  artifactRef: string,
  fromId: string,
  toId: string,
  toKind: string,
  toEnv: string | undefined,
): string {
  const lines: string[] = [];
  lines.push('Promotion plan (dry-run — no changes will be made)');
  lines.push('');
  lines.push(`  Service:           ${service}`);
  lines.push(`  Artifact:          ${artifactRef}`);
  lines.push(`  From target:       ${fromId}`);
  lines.push(`  To target:         ${toId}`);
  lines.push(`  To target kind:    ${toKind}`);
  lines.push(`  To target env:     ${toEnv ?? '(not set)'}`);
  lines.push('');
  lines.push('Stages that would execute on destination target:');
  lines.push('  1. [policy-check] → policy check for destination');
  lines.push('  2. [build]        → skipped (artifact pre-built)');
  lines.push('  3. [push]         → push to destination registry (if required)');
  lines.push(`  4. [deploy]       → deploy '${artifactRef}' to '${toId}'`);
  lines.push('  5. [health-verify]→ post-deploy health check');
  lines.push('');
  lines.push('(Dry-run complete. No changes were made. No lineage recorded.)');
  return lines.join('\n') + '\n';
}

/**
 * Render a promotion lineage record for CLI display.
 *
 * @param record - The completed promotion record.
 * @returns Multi-line summary string ending with `\n`.
 */
export function renderPromotionRecord(record: PromotionRecord): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('Promotion completed:');
  lines.push(`  Promotion ID:  ${record.promotionId}`);
  lines.push(`  Pipeline Run:  ${record.pipelineRunId}`);
  lines.push(`  Service:       ${record.service}`);
  lines.push(`  Artifact:      ${record.artifactRef.ref}`);
  lines.push(`  From target:   ${record.fromTargetId}`);
  lines.push(`  To target:     ${record.toTargetId}`);
  lines.push(`  Promoted by:   ${record.promotedBy}`);
  lines.push(`  Promoted at:   ${record.promotedAt}`);
  lines.push(`  Status:        ${record.pipelineStatus}`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// runDeployPromote implementation
// ---------------------------------------------------------------------------

/**
 * Options for `runDeployPromote`.
 */
export interface RunDeployPromoteOptions {
  /** Service name (first positional argument). */
  service: string;
  /** Raw `--from` target string (id or selector). */
  fromRaw: string;
  /** Raw `--to` target string (id or selector). */
  toRaw: string;
  /** Artifact reference to promote.  Defaults to `service` name when absent. */
  artifactRef?: string;
  /** Optional expected checksum for artifact integrity guard. */
  checksum?: string;
  /** Identity of who triggered the promotion. */
  promotedBy?: string;
  /** When true, print the plan and exit without mutating anything. */
  dryRun?: boolean;
  /** When true (and dryRun false), execute the real promotion. */
  confirm?: boolean;
  /** Injected registry for testability. */
  registry?: DeployTargetRegistry;
  /** Optional policy document for the destination target. */
  policy?: PolicyDocument;
  /** TEST ONLY */
  _backendOverride?: PipelineBackend;
}

/**
 * Run `deploy promote <service> --from <target> --to <target> ...`.
 *
 * @param opts    - Promote options.
 * @param streams - Injected streams.
 * @returns Exit code (0 = success, 1 = error).
 */
export async function runDeployPromote(
  opts: RunDeployPromoteOptions,
  streams: DeployPromoteStreams = {},
): Promise<number> {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  const registry = opts.registry ?? getDeployTargetRegistry();

  // ---- Resolve FROM target --------------------------------------------------
  const fromParsed = parseTargetArg(opts.fromRaw);
  let fromResolved: Awaited<ReturnType<typeof resolveTarget>>;
  try {
    fromResolved = await resolveTarget({
      targetId: 'targetId' in fromParsed ? fromParsed.targetId : undefined,
      selector: 'selector' in fromParsed ? fromParsed.selector : undefined,
      registry,
    });
  } catch (err) {
    if (
      err instanceof UnknownTargetError ||
      err instanceof AmbiguousTargetError ||
      err instanceof NoMatchingTargetError ||
      err instanceof NoDefaultTargetError
    ) {
      stderr.write(`--from: ${(err as Error).message}\n`);
      return 1;
    }
    throw err;
  }

  // ---- Resolve TO target ----------------------------------------------------
  const toParsed = parseTargetArg(opts.toRaw);
  let toResolved: Awaited<ReturnType<typeof resolveTarget>>;
  try {
    toResolved = await resolveTarget({
      targetId: 'targetId' in toParsed ? toParsed.targetId : undefined,
      selector: 'selector' in toParsed ? toParsed.selector : undefined,
      registry,
    });
  } catch (err) {
    if (
      err instanceof UnknownTargetError ||
      err instanceof AmbiguousTargetError ||
      err instanceof NoMatchingTargetError ||
      err instanceof NoDefaultTargetError
    ) {
      stderr.write(`--to: ${(err as Error).message}\n`);
      return 1;
    }
    throw err;
  }

  const fromTarget = fromResolved.target;
  const toTarget = toResolved.target;
  const artifactRef = opts.artifactRef ?? opts.service;

  const dryRun = opts.dryRun === true;

  // ---- Dry-run print plan (default-safe) ------------------------------------
  if (dryRun) {
    stdout.write(
      renderPromotionPlan(
        opts.service,
        artifactRef,
        fromTarget.id,
        toTarget.id,
        toTarget.kind,
        toTarget.env,
      ),
    );
    // Also run the pipeline in dry-run mode to surface policy decisions.
    try {
      await promote({
        service: opts.service,
        artifactRef: { ref: artifactRef, checksum: opts.checksum },
        fromTarget,
        toTarget,
        checksumExpected: opts.checksum,
        promotedBy: opts.promotedBy,
        policy: opts.policy,
        dryRun: true,
        confirm: undefined,
        onStageEvent: (event: StageEvent) => {
          stdout.write(`  [pipeline-dry-run] [${event.stage}] ${event.status}\n`);
        },
        _backendOverride: opts._backendOverride,
      });
    } catch (err) {
      if (err instanceof PromotionChecksumError) {
        stderr.write(`Checksum mismatch: ${(err as Error).message}\n`);
        return 1;
      }
      throw err;
    }
    return 0;
  }

  // ---- Guard: require --confirm for real promotion --------------------------
  if (!opts.confirm) {
    stderr.write(
      `deploy promote: refusing to execute a real promotion without --confirm.\n` +
        `  Use --dry-run to preview the plan, or add --confirm to execute it.\n`,
    );
    return 1;
  }

  // ---- Real promotion -------------------------------------------------------
  stdout.write(
    `Promoting '${opts.service}' artifact '${artifactRef}' from '${fromTarget.id}' to '${toTarget.id}'\n`,
  );

  const promoteOpts: PromoteOptions = {
    service: opts.service,
    artifactRef: { ref: artifactRef, checksum: opts.checksum },
    fromTarget,
    toTarget,
    checksumExpected: opts.checksum,
    promotedBy: opts.promotedBy,
    policy: opts.policy,
    dryRun: false,
    confirm: true,
    onStageEvent: (event: StageEvent) => {
      const duration = event.durationMs !== undefined ? ` (${event.durationMs}ms)` : '';
      const msg = event.message ? ` — ${event.message}` : '';
      stdout.write(
        `[${event.ts}] [${event.stage}] ${event.status.toUpperCase()}${duration}${msg}\n`,
      );
    },
    _backendOverride: opts._backendOverride,
  };

  let result: Awaited<ReturnType<typeof promote>>;
  try {
    result = await promote(promoteOpts);
  } catch (err) {
    if (err instanceof PromotionChecksumError) {
      stderr.write(`Checksum mismatch: ${(err as Error).message}\n`);
      return 1;
    }
    if (err instanceof PromotionConfirmRequiredError) {
      // Should not happen since we set confirm: true above, but be safe.
      stderr.write(`${(err as Error).message}\n`);
      return 1;
    }
    throw err;
  }

  const { record, pipelineResult } = result;

  if (pipelineResult.status === 'success') {
    if (record) {
      stdout.write(renderPromotionRecord(record));
    }
    return 0;
  }

  stderr.write(`Promotion failed: ${pipelineResult.status}\n`);
  return 1;
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

/**
 * Register `deploy promote <service> --from <target> --to <target> ...` under
 * the top-level `deploy` commander group.
 *
 * If the `deploy` group does not yet exist it is created (same pattern as
 * `registerDeployTargetsCommand`).
 *
 * @param program - The top-level commander `Command`.
 * @param deps    - Injected registry / policy for testability.
 * @param streams - Injected streams for testability.
 */
export function registerDeployPromoteCommand(
  program: Command,
  deps: DeployPromoteOptions = {},
  streams: DeployPromoteStreams = {},
): void {
  // Find or create the shared `deploy` command group.
  let deployGroup: Command | undefined = program.commands.find(
    (c: Command) => c.name() === 'deploy',
  );
  if (!deployGroup) {
    deployGroup = program.command('deploy').description('Deployment operations').exitOverride();
  }

  deployGroup
    .command('promote')
    .description('Promote a pre-built artifact from one target to another without rebuilding.')
    .argument('<service>', 'Service name to promote')
    .requiredOption('--from <target>', 'Source target id or selector (the artifact came FROM here)')
    .requiredOption('--to <target>', 'Destination target id or selector (promote TO here)')
    .option('--artifact <ref>', 'Artifact reference to promote (defaults to service name)')
    .option('--checksum <sha256>', 'Expected SHA-256 checksum for artifact integrity guard')
    .option('--promoted-by <identity>', 'Identity of who triggered the promotion', 'system')
    .option('--dry-run', 'Print the promotion plan and policy decision; make no changes', false)
    .option('--confirm', 'Execute the real promotion (required without --dry-run)', false)
    .action(async (service: string, opts: Record<string, unknown>) => {
      const code = await runDeployPromote(
        {
          service,
          fromRaw: String(opts.from),
          toRaw: String(opts.to),
          artifactRef: typeof opts.artifact === 'string' ? opts.artifact : undefined,
          checksum: typeof opts.checksum === 'string' ? opts.checksum : undefined,
          promotedBy: typeof opts.promotedBy === 'string' ? opts.promotedBy : undefined,
          dryRun: opts.dryRun === true,
          confirm: opts.confirm === true,
          registry: deps.registry,
          policy: deps.policy,
          _backendOverride: deps._backendOverride,
        },
        streams,
      );
      if (code !== 0) throw Object.assign(new Error('deploy promote failed'), { exitCode: code });
    });
}

// ---------------------------------------------------------------------------
// Re-export lineage query for portal / other consumers
// ---------------------------------------------------------------------------

export { getPromotionLineage };

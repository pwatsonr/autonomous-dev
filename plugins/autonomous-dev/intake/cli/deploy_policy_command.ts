/**
 * `autonomous-dev deploy policy check --service X --target Y` CLI command
 * (issues #668 + #669).
 *
 * Evaluates the active `PolicyDocument` against a deploy request and prints
 * the `PolicyDecision` in human-readable or JSON format.
 *
 * The command is PURELY evaluative — it never mutates any state. Useful for:
 *   - Operators checking whether a deploy would be permitted before triggering.
 *   - CI gates validating that the current policy allows a planned deploy.
 *   - Debugging why a deploy was blocked.
 *
 * ## Command: `deploy policy check --service <svc> --target <id-or-selector>`
 *
 * Options:
 *   - `--service <name>`  (required) — Service being deployed.
 *   - `--target <spec>`   (required) — Target id or selector token
 *                                      (same format as `deploy run --target`).
 *   - `--json`            (optional) — Emit the raw `PolicyDecision` as JSON.
 *   - `--now <epoch-ms>`  (optional) — Override the clock for
 *                                      `maintenance-window` rules (testing).
 *   - `--affected <n>`    (optional) — Override affected-targets count for
 *                                      `blast-radius` rules.
 *
 * Exit codes: 0 = allowed, 1 = denied or error.
 *
 * Cross-reference: issues #668, #669, #661, #674.
 *
 * @module intake/cli/deploy_policy_command
 */

import { Command } from 'commander';

import type { DeployTargetRegistry } from '../deploy/target-registry';
import { getDeployTargetRegistry } from '../deploy/target-registry';
import { resolveTarget, UnknownTargetError, AmbiguousTargetError, NoMatchingTargetError, NoDefaultTargetError } from '../deploy/target-resolver';
import { getActivePolicy } from '../deploy/policy-config';
import { evaluatePolicy } from '../deploy/policy-engine';
import type { PolicyDocument, PolicyDecision } from '../deploy/policy-types';
import type { TargetSelector } from '../deploy/target-types';
import { parseTargetArg } from './deploy_targets_command';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Injected streams for testability. */
export interface PolicyCheckStreams {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** Injected dependencies for testability. */
export interface PolicyCheckDeps {
  registry?: DeployTargetRegistry;
  /** Override the active policy (defaults to `getActivePolicy()`). */
  policy?: PolicyDocument;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render a `PolicyDecision` as a human-readable string.
 *
 * @param decision  - The decision to render.
 * @param service   - Service name (for context).
 * @param targetId  - Target id (for context).
 * @returns Multi-line string ending with `\n`.
 */
export function renderPolicyDecision(
  decision: PolicyDecision,
  service: string,
  targetId: string,
): string {
  const lines: string[] = [];

  lines.push(`Policy check: service='${service}' target='${targetId}'`);
  lines.push('');

  const status = decision.allowed ? 'ALLOWED' : 'DENIED';
  lines.push(`Result: ${status}`);

  if (decision.matchedRules.length > 0) {
    lines.push(`Matched rules: ${decision.matchedRules.join(', ')}`);
  } else {
    lines.push('Matched rules: (none — policy is empty or no rules matched this target)');
  }

  if (decision.requiredApprovals.length > 0) {
    lines.push(`Required approvals: ${decision.requiredApprovals.join(', ')}`);
  }

  if (decision.violations.length > 0) {
    lines.push('');
    lines.push('Violations:');
    for (const v of decision.violations) {
      lines.push(`  [${v.ruleId}] (${v.type}): ${v.message}`);
    }
  }

  lines.push('');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

/**
 * Options for `runPolicyCheck`.
 */
export interface RunPolicyCheckOptions {
  /** Service name. */
  service: string;
  /** Raw `--target` argument string (id or selector token). */
  targetRaw: string;
  /** Emit JSON output. */
  json?: boolean;
  /** Override clock (ms since epoch) for maintenance-window rules. */
  nowOverride?: number;
  /** Override affected-targets count for blast-radius rules. */
  affectedTargets?: number;
}

/**
 * Run `deploy policy check`.
 *
 * Resolves the target, evaluates the active policy, and prints the decision.
 *
 * @param opts    - Check options.
 * @param deps    - Injected registry and policy.
 * @param streams - Injected streams.
 * @returns Exit code: 0 = allowed, 1 = denied or error.
 */
export async function runPolicyCheck(
  opts: RunPolicyCheckOptions,
  deps: PolicyCheckDeps = {},
  streams: PolicyCheckStreams = {},
): Promise<number> {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  const registry = deps.registry ?? getDeployTargetRegistry();
  const policy = deps.policy ?? getActivePolicy();

  // ---- Parse --target ---------------------------------------------------------
  const parsed = parseTargetArg(opts.targetRaw);
  let targetId: string | undefined;
  let selector: TargetSelector | undefined;

  if ('targetId' in parsed && parsed.targetId !== undefined) {
    targetId = parsed.targetId;
  } else if ('selector' in parsed && parsed.selector !== undefined) {
    selector = parsed.selector;
  }

  // ---- Resolve the target -----------------------------------------------------
  let target: import('../deploy/target-types').DeployTarget;
  try {
    const resolved = await resolveTarget({ targetId, selector, registry });
    target = resolved.target;
  } catch (err) {
    if (
      err instanceof UnknownTargetError ||
      err instanceof AmbiguousTargetError ||
      err instanceof NoMatchingTargetError ||
      err instanceof NoDefaultTargetError
    ) {
      stderr.write(`Error: ${(err as Error).message}\n`);
      return 1;
    }
    throw err;
  }

  // ---- Build context ----------------------------------------------------------
  const context: NonNullable<import('../deploy/policy-types').PolicyRequest['context']> = {};
  if (opts.nowOverride !== undefined) context.now = opts.nowOverride;
  if (opts.affectedTargets !== undefined) context.affectedTargets = opts.affectedTargets;

  // ---- Evaluate ---------------------------------------------------------------
  const decision: PolicyDecision = evaluatePolicy(
    { service: opts.service, target, context },
    policy,
  );

  // ---- Output -----------------------------------------------------------------
  if (opts.json) {
    stdout.write(JSON.stringify({ service: opts.service, targetId: target.id, decision }, null, 2) + '\n');
  } else {
    stdout.write(renderPolicyDecision(decision, opts.service, target.id));
  }

  return decision.allowed ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

/**
 * Register `deploy policy check` under the top-level `deploy` commander group.
 *
 * Finds or creates the shared `deploy` group (same pattern as other deploy
 * subcommands), then adds a `policy` sub-group with a `check` command.
 *
 * @param program - The top-level commander `Command`.
 * @param deps    - Injected registry + policy for testability.
 * @param streams - Injected streams for testability.
 */
export function registerDeployPolicyCommand(
  program: Command,
  deps: PolicyCheckDeps = {},
  streams: PolicyCheckStreams = {},
): void {
  // Find or create the shared `deploy` command group.
  let deployGroup: Command | undefined = program.commands.find(
    (c: Command) => c.name() === 'deploy',
  );
  if (!deployGroup) {
    deployGroup = program.command('deploy').description('Deploy management commands');
  }

  // Find or create the `policy` sub-group under `deploy`.
  let policyGroup: Command | undefined = deployGroup.commands.find(
    (c: Command) => c.name() === 'policy',
  );
  if (!policyGroup) {
    policyGroup = deployGroup.command('policy').description('Deploy policy commands');
  }

  policyGroup
    .command('check')
    .description('Evaluate the active deploy policy for a service + target combination')
    .requiredOption('--service <name>', 'Service name to check')
    .requiredOption('--target <spec>', 'Target id or selector token (e.g., env=prod, kind=swarm-node)')
    .option('--json', 'Emit raw PolicyDecision JSON')
    .option('--now <epoch-ms>', 'Override clock for maintenance-window rules (milliseconds since epoch)', parseFloat)
    .option('--affected <n>', 'Override affected-targets count for blast-radius rules', parseInt)
    .action(async (cmdOpts: {
      service: string;
      target: string;
      json?: boolean;
      now?: number;
      affected?: number;
    }) => {
      const code = await runPolicyCheck(
        {
          service: cmdOpts.service,
          targetRaw: cmdOpts.target,
          json: cmdOpts.json,
          nowOverride: cmdOpts.now,
          affectedTargets: cmdOpts.affected,
        },
        deps,
        streams,
      );
      if (code !== 0) process.exitCode = code;
    });
}

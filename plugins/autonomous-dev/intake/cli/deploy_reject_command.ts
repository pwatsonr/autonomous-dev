/**
 * `autonomous-dev deploy reject <deployId> --reason <text>` (SPEC-023-2-04, Task 7).
 *
 * Wraps SPEC-023-2-03's `recordRejection()`. Reason is required (>= 5 chars).
 *
 * Exit codes match `deploy approve` per SPEC-023-2-04:
 *   0 = recorded; 1 = generic; 4 = state corrupt; 5 = deploy not found.
 *
 * @module intake/cli/deploy_reject_command
 */

import { Command } from 'commander';

import { ApprovalChainError } from '../deploy/errors';
import {
  loadApprovalState,
  recordRejection,
} from '../deploy/approval';
import {
  defaultIdentityResolver,
  type DeployApproveIdentity,
  type IdentityResolver,
} from './deploy_approve_command';
import type { ApprovalState } from '../deploy/approval-types';

export interface DeployRejectStreams {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface DeployRejectOptions {
  reason?: string;
  yes?: boolean;
  requestDir?: string;
}

const MIN_REASON_LEN = 5;

function renderSummary(state: ApprovalState): string {
  const lines: string[] = [];
  lines.push(`Deploy:        ${state.deployId}`);
  lines.push(`Environment:   ${state.envName}`);
  lines.push(`Requirement:   ${state.requirement}`);
  lines.push(`Decision:      ${state.decision}`);
  return lines.join('\n') + '\n';
}

export async function runDeployReject(
  deployId: string,
  options: DeployRejectOptions,
  streams: DeployRejectStreams = {},
  resolver: IdentityResolver = defaultIdentityResolver,
): Promise<number> {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  const requestDir = options.requestDir ?? process.cwd();

  if (!options.reason || options.reason.trim().length < MIN_REASON_LEN) {
    stderr.write(
      `--reason must be a non-empty string of at least ${MIN_REASON_LEN} characters\n`,
    );
    return 1;
  }

  let state: ApprovalState | null;
  try {
    state = await loadApprovalState(deployId, requestDir);
  } catch (err) {
    if (err instanceof ApprovalChainError) {
      stderr.write(`approval state corrupt: ${err.message}\n`);
      return 4;
    }
    throw err;
  }
  if (!state) {
    stderr.write(`deploy ${deployId} has no approval request on disk.\n`);
    return 5;
  }
  stdout.write(renderSummary(state));

  let identity: DeployApproveIdentity;
  try {
    identity = await resolver();
  } catch (err) {
    stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  try {
    await recordRejection({
      deployId,
      approver: identity.email,
      role: identity.role,
      reason: options.reason,
      requestDir,
    });
    stdout.write(`Deploy ${deployId} rejected. Reason persisted.\n`);
    return 0;
  } catch (err) {
    stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}

export function registerDeployRejectCommand(
  program: Command,
  streams: DeployRejectStreams = {},
  resolver: IdentityResolver = defaultIdentityResolver,
): void {
  let deployGroup: Command | undefined = program.commands.find(
    (c: Command) => c.name() === 'deploy',
  );
  if (!deployGroup) {
    deployGroup = program
      .command('deploy')
      .description('Deployment operations')
      .exitOverride();
  }
  deployGroup
    .command('reject')
    .description('Reject a pending deploy.')
    .argument('<deployId>', 'Deploy id to reject')
    .requiredOption('--reason <text>', 'Reason for rejection (>= 5 chars)')
    .option('--yes', 'Skip the interactive confirmation prompt', false)
    .option('--request-dir <path>', 'Override the request worktree directory')
    .action(async (deployId: string, opts: Record<string, unknown>) => {
      const code = await runDeployReject(
        deployId,
        {
          reason: typeof opts.reason === 'string' ? opts.reason : undefined,
          yes: opts.yes === true,
          requestDir: typeof opts.requestDir === 'string' ? opts.requestDir : undefined,
        },
        streams,
        resolver,
      );
      if (code !== 0) {
        throw Object.assign(new Error('deploy reject failed'), { exitCode: code });
      }
    });
}

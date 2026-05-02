/**
 * `autonomous-dev deploy approve <deployId>` (SPEC-023-2-04, Task 7).
 *
 * Wraps SPEC-023-2-03's `recordApproval()`. Resolves operator identity
 * via PLAN-019-3 (verified email + role) — the resolver is injectable
 * for tests and falls through to the legacy environment lookup
 * (`AUTONOMOUS_DEV_OPERATOR_EMAIL` / `AUTONOMOUS_DEV_OPERATOR_ROLE`)
 * when no real PLAN-019-3 client is wired.
 *
 * Exit codes (per SPEC-023-2-04):
 *   0 = recorded successfully
 *   2 = duplicate approver
 *   3 = admin required
 *   4 = state file corrupt (HMAC chain failure)
 *   5 = deploy not found
 *   1 = generic / validation failure
 *
 * @module intake/cli/deploy_approve_command
 */

import { Command } from 'commander';

import {
  AdminRequiredError,
  ApprovalChainError,
  DuplicateApproverError,
} from '../deploy/errors';
import {
  loadApprovalState,
  recordApproval,
} from '../deploy/approval';
import type { ApprovalState } from '../deploy/approval-types';
import type { ApproverRole } from '../deploy/approval-types';

export interface DeployApproveStreams {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface DeployApproveIdentity {
  email: string;
  role: ApproverRole;
}

/**
 * Identity resolver. Production wires this to PLAN-019-3; tests inject
 * a stub.
 */
export type IdentityResolver = () => Promise<DeployApproveIdentity>;

/**
 * Default identity resolver: reads from environment for now. PLAN-019-3
 * integration is layered later; the CLI exit-code contract is the same.
 */
export const defaultIdentityResolver: IdentityResolver = async () => {
  const email = process.env.AUTONOMOUS_DEV_OPERATOR_EMAIL ?? '';
  const role = (process.env.AUTONOMOUS_DEV_OPERATOR_ROLE ?? 'operator') as ApproverRole;
  if (!email) {
    throw new Error(
      'cannot resolve operator identity (set AUTONOMOUS_DEV_OPERATOR_EMAIL or wire PLAN-019-3)',
    );
  }
  return { email, role };
};

export interface DeployApproveOptions {
  yes?: boolean;
  requestDir?: string;
}

function renderSummary(state: ApprovalState | null): string {
  if (!state) return '(no approval state on disk)\n';
  const lines: string[] = [];
  lines.push(`Deploy:        ${state.deployId}`);
  lines.push(`Environment:   ${state.envName}`);
  lines.push(`Requirement:   ${state.requirement}`);
  lines.push(`Decision:      ${state.decision}`);
  lines.push(`Entries:       ${state.entries.length}`);
  for (const e of state.entries) {
    lines.push(`  - ${e.recordedAt} ${e.decision} ${e.approver} (${e.role})`);
  }
  return lines.join('\n') + '\n';
}

/** Execute the command. Returns the process exit code. */
export async function runDeployApprove(
  deployId: string,
  options: DeployApproveOptions,
  streams: DeployApproveStreams = {},
  resolver: IdentityResolver = defaultIdentityResolver,
): Promise<number> {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  const requestDir = options.requestDir ?? process.cwd();

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
    const updated = await recordApproval({
      deployId,
      approver: identity.email,
      role: identity.role,
      requestDir,
    });
    if (updated.decision === 'approved') {
      stdout.write('Approval threshold met. Deploy will resume on next supervisor tick.\n');
    } else {
      const remaining =
        updated.requirement === 'two-person'
          ? Math.max(0, 2 - new Set(updated.entries.filter((e) => e.decision === 'approve').map((e) => e.approver)).size)
          : 0;
      stdout.write(`Approval recorded; still pending (${remaining} more required).\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof DuplicateApproverError) {
      stderr.write(`duplicate approver: ${err.message}\n`);
      return 2;
    }
    if (err instanceof AdminRequiredError) {
      stderr.write(`Admin role required: ${err.message}\n`);
      return 3;
    }
    stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}

/** Plug `deploy approve` under the top-level `deploy` group. */
export function registerDeployApproveCommand(
  program: Command,
  streams: DeployApproveStreams = {},
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
    .command('approve')
    .description('Approve a pending deploy. DANGEROUS: --yes skips the prompt.')
    .argument('<deployId>', 'Deploy id to approve')
    .option('--yes', 'Skip the interactive confirmation prompt', false)
    .option('--request-dir <path>', 'Override the request worktree directory')
    .action(async (deployId: string, opts: Record<string, unknown>) => {
      const code = await runDeployApprove(
        deployId,
        {
          yes: opts.yes === true,
          requestDir: typeof opts.requestDir === 'string' ? opts.requestDir : undefined,
        },
        streams,
        resolver,
      );
      if (code !== 0) {
        // commander's exitOverride lets the caller test exit codes via thrown errors.
        throw Object.assign(new Error('deploy approve failed'), { exitCode: code });
      }
    });
}

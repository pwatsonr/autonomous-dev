/**
 * `autonomous-dev chains approve` subcommand (SPEC-022-2-04, Task 8).
 *
 * Operator-facing command that:
 *   1. Verifies the caller has admin authorization (delegated to the
 *      injectable `requireAdminAuth` helper — wired to PRD-009's authz
 *      engine in production, stubbed in tests).
 *   2. Locates the persisted chain state for the supplied artifact id.
 *   3. Writes the canonical `<artifact-path>.approved.json` sidecar
 *      marker via the same two-phase commit pattern as `StateStore`.
 *   4. Calls `executor.resume(chain_id)` to walk the remaining
 *      topological order; reports the resume outcome to stdout.
 *
 * Mirrors `chains_command.ts`: pure runner functions with injectable
 * dependencies for unit testability; a thin commander registration
 * wrapper at the bottom for the real adapter.
 *
 * @module cli/chains_approve_command
 */

import { Command } from 'commander';

import {
  StateStore,
  type ChainExecutor,
} from '../chains';
import type {
  ApprovalMarker,
  ChainPausedState,
} from '../chains/types';

/** Stream pair injected for testability — defaults to process.stdout/stderr. */
export interface ChainsApproveStreams {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/**
 * Locator for paused-chain state. The CLI accepts an artifact id; the
 * locator scans `<requestRoot>/.autonomous-dev/chains/*.state.json` and
 * returns the state whose `paused_at_artifact === artifactId`. Injected
 * for testability.
 */
export type LocateChainStateByArtifact = (
  artifactId: string,
) => Promise<ChainPausedState | null>;

/**
 * Admin-auth gate. Wired in production to PRD-009's authz engine; tests
 * inject a stub. The function MUST throw on failure (or reject the
 * Promise); successful auth returns void.
 */
export type RequireAdminAuth = () => Promise<void> | void;

export interface ChainsApproveDeps extends ChainsApproveStreams {
  /** Required: chain executor for `resume()`. */
  executor: ChainExecutor;
  /** Required: state-store used to write the approval marker. */
  stateStore: StateStore;
  /** Required: locate the persisted chain state by artifact id. */
  locateChainStateByArtifact: LocateChainStateByArtifact;
  /** Required: admin-auth gate. */
  requireAdminAuth: RequireAdminAuth;
  /** Operator identity stamped on the marker; defaults to $USER. */
  approvedByResolver?: () => string;
  /** Clock injection; defaults to `Date.now()`. */
  now?: () => Date;
}

export interface ChainsApproveArgs {
  artifactId: string;
  notes?: string;
}

/**
 * Run the approve flow. Returns the process exit code (0 on success).
 *
 * Errors are written to `stderr` and produce a non-zero exit code; the
 * function never throws so commander wrappers can rely on the return
 * value as the command's exit signal.
 */
export async function runChainsApprove(
  args: ChainsApproveArgs,
  deps: ChainsApproveDeps,
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  try {
    await deps.requireAdminAuth();
  } catch (err) {
    stderr.write(`auth failed: ${(err as Error).message}\n`);
    return 1;
  }
  let chainState: ChainPausedState | null;
  try {
    chainState = await deps.locateChainStateByArtifact(args.artifactId);
  } catch (err) {
    stderr.write(`failed to locate chain state: ${(err as Error).message}\n`);
    return 1;
  }
  if (!chainState) {
    stderr.write(`No paused chain found for artifact ${args.artifactId}\n`);
    return 1;
  }
  const approvedBy = deps.approvedByResolver
    ? deps.approvedByResolver()
    : process.env.USER ?? 'unknown';
  const now = deps.now ? deps.now() : new Date();
  const markerPath = StateStore.approvalMarkerPathFor(
    chainState.request_root,
    chainState.paused_at_artifact_type,
    chainState.paused_at_artifact,
  );
  const marker: ApprovalMarker = {
    chain_id: chainState.chain_id,
    artifact_id: chainState.paused_at_artifact,
    approved_by: approvedBy,
    approved_timestamp_iso: now.toISOString(),
    ...(args.notes !== undefined ? { notes: args.notes } : {}),
  };
  try {
    await deps.stateStore.writeApprovalMarker(markerPath, marker);
  } catch (err) {
    stderr.write(`failed to write approval marker: ${(err as Error).message}\n`);
    return 1;
  }
  let resumeResult;
  try {
    resumeResult = await deps.executor.resume(
      chainState.chain_id,
      chainState.request_root,
    );
  } catch (err) {
    stderr.write(`resume failed: ${(err as Error).message}\n`);
    return 1;
  }
  stdout.write(
    `Chain ${chainState.chain_id} resumed: outcome=${resumeResult.outcome}\n`,
  );
  return 0;
}

/**
 * Register `chains approve <artifact-id>` under an existing commander
 * `chains` group. The host program assembles the deps map (production
 * wiring lives in `cli_adapter.ts`).
 */
export function registerChainsApprove(
  chainsGroup: Command,
  depsFactory: () => ChainsApproveDeps,
): void {
  chainsGroup
    .command('approve <artifact-id>')
    .description('Approve a paused chain awaiting human review')
    .option('--notes <text>', 'Optional notes recorded on the marker')
    .action(async (artifactId: string, opts: Record<string, unknown>) => {
      const code = await runChainsApprove(
        {
          artifactId,
          ...(typeof opts.notes === 'string' ? { notes: opts.notes } : {}),
        },
        depsFactory(),
      );
      if (code !== 0) {
        throw new Error('chains approve failed');
      }
    });
}

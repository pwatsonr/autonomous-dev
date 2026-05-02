/**
 * `autonomous-dev chains reject` subcommand (SPEC-022-2-04, Task 8).
 *
 * Operator-facing command that:
 *   1. Verifies the caller has admin authorization.
 *   2. Locates the persisted chain state for the supplied artifact id.
 *   3. Writes the canonical `<artifact-path>.rejected.json` sidecar
 *      marker with the operator's reason.
 *   4. Deletes the chain state file (rejection is non-recoverable —
 *      operators who reject by mistake re-trigger the chain from
 *      scratch, per SPEC-022-2-04 notes).
 *
 * Mirrors `chains_approve_command.ts` style (snake_case file name,
 * pure runner with injectable deps, thin commander wrapper).
 *
 * @module cli/chains_reject_command
 */

import { Command } from 'commander';

import { StateStore } from '../chains';
import type {
  ChainPausedState,
  RejectionMarker,
} from '../chains/types';
import type {
  ChainsApproveStreams,
  LocateChainStateByArtifact,
  RequireAdminAuth,
} from './chains_approve_command';

export interface ChainsRejectDeps extends ChainsApproveStreams {
  stateStore: StateStore;
  locateChainStateByArtifact: LocateChainStateByArtifact;
  requireAdminAuth: RequireAdminAuth;
  rejectedByResolver?: () => string;
  now?: () => Date;
}

export interface ChainsRejectArgs {
  artifactId: string;
  reason: string;
}

export async function runChainsReject(
  args: ChainsRejectArgs,
  deps: ChainsRejectDeps,
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  if (!args.reason || args.reason.trim().length === 0) {
    stderr.write('--reason is required for chains reject\n');
    return 1;
  }
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
  const rejectedBy = deps.rejectedByResolver
    ? deps.rejectedByResolver()
    : process.env.USER ?? 'unknown';
  const now = deps.now ? deps.now() : new Date();
  const markerPath = StateStore.rejectionMarkerPathFor(
    chainState.request_root,
    chainState.paused_at_artifact_type,
    chainState.paused_at_artifact,
  );
  const marker: RejectionMarker = {
    chain_id: chainState.chain_id,
    artifact_id: chainState.paused_at_artifact,
    rejected_by: rejectedBy,
    rejected_timestamp_iso: now.toISOString(),
    reason: args.reason,
  };
  try {
    await deps.stateStore.writeRejectionMarker(markerPath, marker);
  } catch (err) {
    stderr.write(`failed to write rejection marker: ${(err as Error).message}\n`);
    return 1;
  }
  const statePath = StateStore.statePathFor(
    chainState.request_root,
    chainState.chain_id,
  );
  try {
    await deps.stateStore.deleteState(statePath);
  } catch (err) {
    stderr.write(`failed to delete chain state: ${(err as Error).message}\n`);
    return 1;
  }
  stdout.write(
    `Chain ${chainState.chain_id} rejected: reason="${args.reason}"\n`,
  );
  return 0;
}

export function registerChainsReject(
  chainsGroup: Command,
  depsFactory: () => ChainsRejectDeps,
): void {
  chainsGroup
    .command('reject <artifact-id>')
    .description('Reject a paused chain; cancels the chain permanently')
    .requiredOption('--reason <text>', 'Operator-supplied rejection reason')
    .action(async (artifactId: string, opts: Record<string, unknown>) => {
      const code = await runChainsReject(
        {
          artifactId,
          reason: typeof opts.reason === 'string' ? opts.reason : '',
        },
        depsFactory(),
      );
      if (code !== 0) {
        throw new Error('chains reject failed');
      }
    });
}

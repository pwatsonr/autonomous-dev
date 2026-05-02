/**
 * StateStore — two-phase-commit persistence for paused chains
 * (SPEC-022-2-03).
 *
 * Paused chains are persisted under
 * `<requestRoot>/.autonomous-dev/chains/<chain-id>.state.json` so an
 * operator running `chains approve` (SPEC-022-2-04) can resume them even
 * across daemon restarts. Approval markers are sibling sidecar files
 * `<artifact-path>.approved.json` (or `.rejected.json`) located next to
 * the persisted artifact under
 * `<requestRoot>/.autonomous-dev/artifacts/<type>/<scanId>.json`.
 *
 * The atomic-write pattern (write tmp → rename) mirrors `ArtifactRegistry`
 * and `intake/core/state_artifact.ts`: rename is atomic on POSIX, so
 * readers never observe a half-written file.
 *
 * @module intake/chains/state-store
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ApprovalMarker,
  ChainEscalationEvent,
  ChainPausedState,
  EscalationRouter,
  RejectionMarker,
} from './types';

/** Validates `<chain-id>.state.json` filename so loaders can't be tricked into reading attacker-controlled paths. */
const CHAIN_ID_RE = /^[a-zA-Z0-9._-]+$/;

export class StateStore {
  /**
   * Compute the on-disk path for a paused-chain state file.
   * Centralized so the executor + CLI agree on the location.
   */
  static statePathFor(requestRoot: string, chainId: string): string {
    if (!CHAIN_ID_RE.test(chainId)) {
      throw new Error(`invalid chainId for state path: '${chainId}'`);
    }
    return path.join(
      requestRoot,
      '.autonomous-dev',
      'chains',
      `${chainId}.state.json`,
    );
  }

  /**
   * Compute the on-disk path for the approval-marker sidecar of an
   * artifact. Sits next to the artifact JSON, with `.approved.json`
   * appended.
   */
  static approvalMarkerPathFor(
    requestRoot: string,
    artifactType: string,
    scanId: string,
  ): string {
    return path.join(
      requestRoot,
      '.autonomous-dev',
      'artifacts',
      artifactType,
      `${scanId}.json.approved.json`,
    );
  }

  /** Compute the on-disk path for the rejection-marker sidecar. */
  static rejectionMarkerPathFor(
    requestRoot: string,
    artifactType: string,
    scanId: string,
  ): string {
    return path.join(
      requestRoot,
      '.autonomous-dev',
      'artifacts',
      artifactType,
      `${scanId}.json.rejected.json`,
    );
  }

  /**
   * Two-phase commit: write to a temp file in the same directory then
   * atomically rename. Mode 0600 on the final file. mkdir -p the parent.
   *
   * On rename failure the temp file is unlinked best-effort.
   */
  async writeState(targetPath: string, state: ChainPausedState): Promise<void> {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
    const data = JSON.stringify(state, null, 2);
    await fs.writeFile(tmp, data, { encoding: 'utf-8', mode: 0o600 });
    try {
      await fs.rename(tmp, targetPath);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {/* best-effort */});
      throw err;
    }
    try {
      await fs.chmod(targetPath, 0o600);
    } catch {/* best-effort */}
  }

  /** Read a paused state file. Returns null on ENOENT. */
  async readState(targetPath: string): Promise<ChainPausedState | null> {
    let raw: string;
    try {
      raw = await fs.readFile(targetPath, 'utf-8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return null;
      throw err;
    }
    return JSON.parse(raw) as ChainPausedState;
  }

  /** Remove a paused state file. ENOENT is silently ignored. */
  async deleteState(targetPath: string): Promise<void> {
    await fs.unlink(targetPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }

  /**
   * Atomic write of an approval-marker sidecar. Same two-phase pattern.
   */
  async writeApprovalMarker(
    targetPath: string,
    marker: ApprovalMarker,
  ): Promise<void> {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
    const data = JSON.stringify(marker, null, 2);
    await fs.writeFile(tmp, data, { encoding: 'utf-8', mode: 0o600 });
    try {
      await fs.rename(tmp, targetPath);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {/* best-effort */});
      throw err;
    }
  }

  /** Atomic write of a rejection-marker sidecar. */
  async writeRejectionMarker(
    targetPath: string,
    marker: RejectionMarker,
  ): Promise<void> {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
    const data = JSON.stringify(marker, null, 2);
    await fs.writeFile(tmp, data, { encoding: 'utf-8', mode: 0o600 });
    try {
      await fs.rename(tmp, targetPath);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {/* best-effort */});
      throw err;
    }
  }

  /** Read a sidecar marker file. Returns null on ENOENT. */
  async readApprovalMarker(
    targetPath: string,
  ): Promise<ApprovalMarker | null> {
    let raw: string;
    try {
      raw = await fs.readFile(targetPath, 'utf-8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return null;
      throw err;
    }
    return JSON.parse(raw) as ApprovalMarker;
  }

  async readRejectionMarker(
    targetPath: string,
  ): Promise<RejectionMarker | null> {
    let raw: string;
    try {
      raw = await fs.readFile(targetPath, 'utf-8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return null;
      throw err;
    }
    return JSON.parse(raw) as RejectionMarker;
  }

  /** True if a regular file exists at `p`. */
  async fileExists(p: string): Promise<boolean> {
    try {
      const st = await fs.stat(p);
      return st.isFile();
    } catch {
      return false;
    }
  }
}

/**
 * On daemon startup, scan `<requestRoot>/.autonomous-dev/chains/` for
 * `*.state.json` files and re-emit one `chain-approval-pending` escalation
 * per file so operators see pending approvals after a restart.
 *
 * Returns the count of recovered states. Idempotent: re-emitting the same
 * `chain_id` is safe because the router dedups by `chain_id`.
 */
export async function recoverPending(
  requestRoot: string,
  router: EscalationRouter,
  store: StateStore = new StateStore(),
): Promise<number> {
  const stateDir = path.join(requestRoot, '.autonomous-dev', 'chains');
  let entries: string[];
  try {
    entries = await fs.readdir(stateDir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return 0;
    throw err;
  }
  let count = 0;
  for (const ent of entries) {
    if (!ent.endsWith('.state.json')) continue;
    const full = path.join(stateDir, ent);
    const state = await store.readState(full);
    if (!state) continue;
    const ev: ChainEscalationEvent = {
      kind: 'chain-approval-pending',
      chain_id: state.chain_id,
      artifact_id: state.paused_at_artifact,
      artifact_type: state.paused_at_artifact_type,
      paused_since: state.paused_timestamp_iso,
      request_id: state.request_id,
    };
    await router.notify(ev);
    count += 1;
  }
  return count;
}

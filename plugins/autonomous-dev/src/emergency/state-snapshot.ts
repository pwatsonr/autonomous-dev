/**
 * Pre-kill state capture and serialization (SPEC-009-4-2, Task 3).
 *
 * Captures the full system state at the moment of kill for forensic analysis.
 * The snapshot is taken BEFORE the abort signal is sent, ensuring a clean
 * record of the pre-kill state.
 *
 * State is read from the incremental state files written by the pipeline
 * orchestrator after each phase completion:
 *   - `.autonomous-dev/state/{requestId}/pipeline.json` -- pipeline position
 *   - `.autonomous-dev/workspaces/{requestId}/` -- generated artifacts
 *   - `.autonomous-dev/state/escalations/pending.json` -- pending escalations
 *   - Trust level is read from the pipeline state.
 *
 * Missing files never cause failures -- safe defaults are used instead.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { KillMode, StateSnapshot } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// KillMode and StateSnapshot are imported from ./types.

/** The persisted kill snapshot written to disk. */
export interface KillSnapshot {
  kill_mode: KillMode;
  issued_by: string;
  issued_at: string;
  total_active_requests: number;
  snapshots: StateSnapshot[];
}

/** Shape of the pipeline.json state file. */
interface PipelineStateFile {
  pipelinePhase?: string;
  phaseStatus?: string;
  trustLevel?: number;
}

/** Shape of the pending escalations file. */
interface PendingEscalationsFile {
  pending?: Array<{
    escalation_id: string;
    request_id: string;
  }>;
}

// ---------------------------------------------------------------------------
// Injectable filesystem interface (for testability)
// ---------------------------------------------------------------------------

/**
 * Minimal filesystem interface for reading state files and listing directories.
 * Defaults to Node's fs/promises at runtime. Injected in tests.
 */
export interface FileSystem {
  readFile(filePath: string, encoding: "utf-8"): Promise<string>;
  readdir(dirPath: string): Promise<string[]>;
  writeFile(filePath: string, content: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: boolean }): Promise<void>;
}

/** Default filesystem backed by Node's fs/promises. */
export const defaultFs: FileSystem = {
  readFile: (p, enc) => fs.readFile(p, enc),
  readdir: (p) => fs.readdir(p).then((entries) => entries.map(String)),
  writeFile: (p, c) => fs.writeFile(p, c, "utf-8"),
  rename: (o, n) => fs.rename(o, n),
  mkdir: (p, opts) => fs.mkdir(p, opts).then(() => undefined),
};

// ---------------------------------------------------------------------------
// StateSnapshotCapture
// ---------------------------------------------------------------------------

/**
 * Captures pre-kill state snapshots for all active requests.
 *
 * Reads from the incremental state files written by the pipeline orchestrator.
 * Missing files are handled gracefully with safe defaults so that the snapshot
 * never fails due to missing state.
 */
export class StateSnapshotCapture {
  private readonly fs: FileSystem;

  constructor(
    private readonly stateDir: string,
    fileSystem?: FileSystem,
  ) {
    this.fs = fileSystem ?? defaultFs;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Capture state for all active requests. Must complete in < 1 second
   * for up to 10 active requests.
   *
   * @param activeRequestIds IDs of all currently active requests.
   * @returns One StateSnapshot per request (order matches input).
   */
  captureAll(activeRequestIds: string[]): StateSnapshot[] {
    return activeRequestIds.map((id) => this.captureOne(id));
  }

  /**
   * Capture state for a single request.
   *
   * Algorithm (per spec):
   *   1. Read pipeline.json for pipeline position and phase status.
   *   2. List workspace directory for generated artifact paths.
   *   3. Read pending.json and filter for this request's pending escalations.
   *   4. Read trust level from pipeline state.
   *
   * If any file is missing, use safe defaults.
   */
  captureOne(requestId: string): StateSnapshot {
    // Read pipeline state synchronously-compatible (all fs ops are wrapped
    // in try/catch with defaults). We use synchronous capture via readFileSync
    // approach but since the interface is async, we do a sync-style capture
    // by pre-reading. For performance under the 1-second constraint, we use
    // sync reads internally.
    const pipelineState = this.readPipelineStateSafe(requestId);
    const artifacts = this.listArtifactsSafe(requestId);
    const pendingEscalationIds = this.readPendingEscalationsSafe(requestId);

    return {
      requestId,
      pipelinePhase: pipelineState.pipelinePhase ?? "unknown",
      phaseStatus: pipelineState.phaseStatus ?? "unknown",
      artifacts,
      pendingEscalationIds,
      trustLevel: pipelineState.trustLevel ?? 0,
    };
  }

  /**
   * Persist the kill snapshot to disk atomically (temp + rename).
   *
   * Written to: `{stateDir}/kill-snapshot-{timestamp}.json`
   *
   * @returns The absolute path of the persisted snapshot file.
   */
  async persistKillSnapshot(
    snapshots: StateSnapshot[],
    killMode: KillMode,
    issuedBy: string,
  ): Promise<string> {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-");
    const filename = `kill-snapshot-${timestamp}.json`;
    const targetPath = path.join(this.stateDir, filename);

    const killSnapshot: KillSnapshot = {
      kill_mode: killMode,
      issued_by: issuedBy,
      issued_at: now.toISOString(),
      total_active_requests: snapshots.length,
      snapshots,
    };

    const content = JSON.stringify(killSnapshot, null, 2);

    // Atomic write: write to temp file, then rename
    const tmpPath = `${targetPath}.${Date.now()}.tmp`;

    await this.fs.mkdir(path.dirname(targetPath), { recursive: true });
    await this.fs.writeFile(tmpPath, content);
    await this.fs.rename(tmpPath, targetPath);

    return targetPath;
  }

  // -------------------------------------------------------------------------
  // Private: safe readers with defaults
  // -------------------------------------------------------------------------

  /**
   * Read pipeline.json for a request. Returns safe defaults on any failure.
   */
  private readPipelineStateSafe(requestId: string): PipelineStateFile {
    const filePath = path.join(
      this.stateDir,
      requestId,
      "pipeline.json",
    );

    try {
      // Use synchronous read for sub-millisecond capture
      const fsSync = require("fs");
      const content = fsSync.readFileSync(filePath, "utf-8");
      return JSON.parse(content) as PipelineStateFile;
    } catch {
      return {};
    }
  }

  /**
   * List artifacts in a request's workspace. Returns empty array on failure.
   */
  private listArtifactsSafe(requestId: string): string[] {
    const workspacePath = path.join(
      this.stateDir,
      "..",
      "workspaces",
      requestId,
    );

    try {
      const fsSync = require("fs");
      return fsSync.readdirSync(workspacePath).map(String);
    } catch {
      return [];
    }
  }

  /**
   * Read pending escalations filtered for a specific request.
   * Returns empty array on failure.
   */
  private readPendingEscalationsSafe(requestId: string): string[] {
    const filePath = path.join(
      this.stateDir,
      "escalations",
      "pending.json",
    );

    try {
      const fsSync = require("fs");
      const content = fsSync.readFileSync(filePath, "utf-8");
      const data = JSON.parse(content) as PendingEscalationsFile;

      return (data.pending ?? [])
        .filter((e) => e.request_id === requestId)
        .map((e) => e.escalation_id);
    } catch {
      return [];
    }
  }
}

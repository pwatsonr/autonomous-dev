/**
 * Incremental pipeline state file management (SPEC-009-4-4, Task 7).
 *
 * Maintains pipeline state files after each phase completion so that the
 * kill switch can capture accurate snapshots without scanning the full
 * pipeline. State is written atomically (temp + fsync + rename) to ensure
 * consistency even during hard kills.
 *
 * File layout (TDD Section 3.3.1):
 *   .autonomous-dev/
 *     state/
 *       {request-id}/
 *         pipeline.json        -- Pipeline position, updated after each phase
 *       escalations/
 *         pending.json         -- Pending escalation list (managed by PLAN-009-2)
 *       kill-snapshot-{ts}.json -- Kill snapshots (managed by state-snapshot.ts)
 *     workspaces/
 *       {request-id}/          -- Generated artifacts (managed by pipeline)
 *     events.jsonl             -- Audit event log (managed by PLAN-009-5)
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Pipeline state written after each phase completion.
 * The state-snapshot module reads these files during kill to build snapshots.
 */
export interface PipelineState {
  requestId: string;
  currentPhase: string;
  phaseStatus: "running" | "completed" | "pending" | "failed";
  completedPhases: string[];
  trustLevel: number;
  lastUpdated: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Injectable filesystem interface (for testability)
// ---------------------------------------------------------------------------

/**
 * Minimal filesystem interface for state persistence.
 * Defaults to Node's fs at runtime. Injected in tests.
 */
export interface StatePersistenceFs {
  writeFileSync(filePath: string, content: string): void;
  renameSync(oldPath: string, newPath: string): void;
  fdatasyncSync?(fd: number): void;
  openSync?(filePath: string, flags: string): number;
  closeSync?(fd: number): void;
  mkdirSync(dirPath: string, options: { recursive: boolean }): void;
  readFileSync(filePath: string, encoding: "utf-8"): string;
  existsSync(filePath: string): boolean;
  rmSync?(filePath: string, options?: { recursive?: boolean; force?: boolean }): void;
}

/** Default filesystem backed by Node's fs. */
export const defaultStatePersistenceFs: StatePersistenceFs = {
  writeFileSync: (p, c) => fs.writeFileSync(p, c, "utf-8"),
  renameSync: (o, n) => fs.renameSync(o, n),
  fdatasyncSync: (fd) => fs.fdatasyncSync(fd),
  openSync: (p, f) => fs.openSync(p, f),
  closeSync: (fd) => fs.closeSync(fd),
  mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  existsSync: (p) => fs.existsSync(p),
  rmSync: (p, opts) => fs.rmSync(p, opts),
};

// ---------------------------------------------------------------------------
// StatePersistence
// ---------------------------------------------------------------------------

/**
 * Manages incremental pipeline state files.
 *
 * State is persisted after each phase completion so that the kill switch
 * snapshot capture can read the latest state without querying the pipeline.
 *
 * All writes are atomic: write to temp file, fsync, then rename.
 * This guarantees the state file is always in a consistent state.
 */
export class StatePersistence {
  private readonly fs: StatePersistenceFs;

  constructor(
    private readonly baseDir: string,
    fileSystem?: StatePersistenceFs,
  ) {
    this.fs = fileSystem ?? defaultStatePersistenceFs;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Write pipeline state after each phase completion.
   *
   * Called by the pipeline orchestrator after each phase completes.
   * Write is atomic: write to temp file, fsync, then rename.
   * If write fails, logs error but does not halt the pipeline.
   *
   * @param requestId  Unique identifier for the pipeline request.
   * @param state      Pipeline state to persist.
   */
  writePipelineState(requestId: string, state: PipelineState): void {
    const dir = path.join(this.baseDir, requestId);
    const targetPath = path.join(dir, "pipeline.json");

    try {
      this.fs.mkdirSync(dir, { recursive: true });
      this.atomicWrite(targetPath, JSON.stringify(state, null, 2));
    } catch (err) {
      // State loss is acceptable for a single phase -- log but don't halt
      console.error(
        `[StatePersistence] Failed to write pipeline state for ${requestId}:`,
        err,
      );
    }
  }

  /**
   * Write artifact manifest for a request.
   *
   * @param requestId  Unique identifier for the pipeline request.
   * @param artifacts  List of artifact paths.
   */
  writeArtifactManifest(requestId: string, artifacts: string[]): void {
    const dir = path.join(this.baseDir, requestId);
    const targetPath = path.join(dir, "artifacts.json");

    try {
      this.fs.mkdirSync(dir, { recursive: true });
      this.atomicWrite(targetPath, JSON.stringify({ artifacts }, null, 2));
    } catch (err) {
      console.error(
        `[StatePersistence] Failed to write artifact manifest for ${requestId}:`,
        err,
      );
    }
  }

  /**
   * Read pipeline state for a request.
   *
   * @param requestId  Unique identifier for the pipeline request.
   * @returns The pipeline state, or null if no state exists.
   */
  readPipelineState(requestId: string): PipelineState | null {
    const filePath = path.join(this.baseDir, requestId, "pipeline.json");

    try {
      const content = this.fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content) as PipelineState;
    } catch {
      return null;
    }
  }

  /**
   * Read artifact manifest for a request.
   *
   * @param requestId  Unique identifier for the pipeline request.
   * @returns List of artifact paths, or empty array if none.
   */
  readArtifactManifest(requestId: string): string[] {
    const filePath = path.join(this.baseDir, requestId, "artifacts.json");

    try {
      const content = this.fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(content) as { artifacts: string[] };
      return data.artifacts ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Clean up state files for a completed request.
   *
   * Removes the request's state directory and all contents.
   *
   * @param requestId  Unique identifier for the pipeline request.
   */
  cleanup(requestId: string): void {
    const dir = path.join(this.baseDir, requestId);

    try {
      if (this.fs.rmSync) {
        this.fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Cleanup failure is non-fatal
    }
  }

  // -------------------------------------------------------------------------
  // Private: atomic write
  // -------------------------------------------------------------------------

  /**
   * Atomic write: write to temp file, fsync, then rename.
   *
   * This ensures the target file is always in a consistent state.
   * If the process crashes during write, only the temp file is partial.
   * The rename is atomic on POSIX systems.
   */
  private atomicWrite(targetPath: string, content: string): void {
    const tmpPath = `${targetPath}.${Date.now()}.tmp`;

    // Write content to temp file
    this.fs.writeFileSync(tmpPath, content);

    // Fsync the temp file to ensure content is on disk
    if (this.fs.openSync && this.fs.fdatasyncSync && this.fs.closeSync) {
      try {
        const fd = this.fs.openSync(tmpPath, "r");
        this.fs.fdatasyncSync(fd);
        this.fs.closeSync(fd);
      } catch {
        // Fsync failure is non-fatal; rename will still work
      }
    }

    // Atomic rename
    this.fs.renameSync(tmpPath, targetPath);
  }
}

/**
 * Unit tests for StateSnapshotCapture (SPEC-009-4-2, Task 3).
 *
 * Test cases:
 *   1. Capture single request -- pipeline state file exists; correct phase and artifacts.
 *   2. Capture with missing pipeline file -- defaults used (unknown phase, empty artifacts).
 *   3. Capture multiple requests -- 3 active requests; captureAll returns 3 snapshots.
 *   4. Persist kill snapshot atomically -- file at expected path; content matches schema.
 *   5. Persist uses temp+rename -- verify no partial file visible during write.
 */

import * as path from "path";
import { StateSnapshotCapture } from "../state-snapshot";
import type { FileSystem, KillSnapshot } from "../state-snapshot";

// ---------------------------------------------------------------------------
// Mock filesystem
// ---------------------------------------------------------------------------

/**
 * Creates a mock filesystem backed by an in-memory Map.
 * Tracks write operations for verifying atomic write pattern.
 */
function createMockFs(files: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(files));
  const writeLog: Array<{ op: "writeFile" | "rename"; path: string; target?: string }> = [];
  const dirs: string[] = [];

  const mockFs: FileSystem = {
    readFile: jest.fn(async (filePath: string) => {
      const content = store.get(filePath);
      if (content === undefined) {
        const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return content;
    }),

    readdir: jest.fn(async (dirPath: string) => {
      const entries: string[] = [];
      for (const key of store.keys()) {
        if (key.startsWith(dirPath + "/")) {
          const relative = key.slice(dirPath.length + 1);
          // Only top-level entries (no further slashes)
          if (!relative.includes("/")) {
            entries.push(relative);
          }
        }
      }
      if (entries.length === 0 && !dirs.includes(dirPath)) {
        const err = new Error(`ENOENT: no such directory '${dirPath}'`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return entries;
    }),

    writeFile: jest.fn(async (filePath: string, content: string) => {
      writeLog.push({ op: "writeFile", path: filePath });
      store.set(filePath, content);
    }),

    rename: jest.fn(async (oldPath: string, newPath: string) => {
      writeLog.push({ op: "rename", path: oldPath, target: newPath });
      const content = store.get(oldPath);
      if (content !== undefined) {
        store.set(newPath, content);
        store.delete(oldPath);
      }
    }),

    mkdir: jest.fn(async (dirPath: string) => {
      dirs.push(dirPath);
    }),
  };

  return { mockFs, store, writeLog };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATE_DIR = "/project/.autonomous-dev/state";

function makePipelineJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pipelinePhase: "code_review",
    phaseStatus: "running",
    trustLevel: 2,
    ...overrides,
  });
}

function makePendingJson(
  entries: Array<{ escalation_id: string; request_id: string }>,
): string {
  return JSON.stringify({ pending: entries });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StateSnapshotCapture", () => {
  // We need to mock the synchronous fs calls used internally.
  // The captureOne method uses require("fs").readFileSync and readdirSync.
  let fsReadFileSync: jest.SpyInstance;
  let fsReaddirSync: jest.SpyInstance;

  beforeEach(() => {
    // Mock the synchronous fs methods used by captureOne
    const nodeFs = require("fs");
    fsReadFileSync = jest.spyOn(nodeFs, "readFileSync");
    fsReaddirSync = jest.spyOn(nodeFs, "readdirSync");
  });

  afterEach(() => {
    fsReadFileSync.mockRestore();
    fsReaddirSync.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Test 1: Capture single request
  // -----------------------------------------------------------------------

  it("captures a single request with correct phase, artifacts, and trust level", () => {
    const pipelinePath = path.join(STATE_DIR, "req-abc", "pipeline.json");
    const workspacePath = path.join(STATE_DIR, "..", "workspaces", "req-abc");
    const pendingPath = path.join(STATE_DIR, "escalations", "pending.json");

    fsReadFileSync.mockImplementation((filePath: string) => {
      if (filePath === pipelinePath) {
        return makePipelineJson();
      }
      if (filePath === pendingPath) {
        return makePendingJson([
          { escalation_id: "esc-20260408-005", request_id: "req-abc" },
          { escalation_id: "esc-20260408-006", request_id: "req-other" },
        ]);
      }
      throw new Error("ENOENT");
    });

    fsReaddirSync.mockImplementation((dirPath: string) => {
      if (dirPath === workspacePath) {
        return ["src/feature.ts", "src/feature.test.ts"];
      }
      throw new Error("ENOENT");
    });

    const capture = new StateSnapshotCapture(STATE_DIR);
    const snapshot = capture.captureOne("req-abc");

    expect(snapshot).toEqual({
      requestId: "req-abc",
      pipelinePhase: "code_review",
      phaseStatus: "running",
      artifacts: ["src/feature.ts", "src/feature.test.ts"],
      pendingEscalationIds: ["esc-20260408-005"],
      trustLevel: 2,
    });
  });

  // -----------------------------------------------------------------------
  // Test 2: Capture with missing pipeline file
  // -----------------------------------------------------------------------

  it("uses safe defaults when pipeline.json is missing", () => {
    fsReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    fsReaddirSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const capture = new StateSnapshotCapture(STATE_DIR);
    const snapshot = capture.captureOne("req-missing");

    expect(snapshot).toEqual({
      requestId: "req-missing",
      pipelinePhase: "unknown",
      phaseStatus: "unknown",
      artifacts: [],
      pendingEscalationIds: [],
      trustLevel: 0,
    });
  });

  // -----------------------------------------------------------------------
  // Test 3: Capture multiple requests
  // -----------------------------------------------------------------------

  it("captures all active requests via captureAll", () => {
    fsReadFileSync.mockImplementation((filePath: string) => {
      // Return different pipeline phases for each request
      if (filePath.includes("req-1/pipeline.json")) {
        return makePipelineJson({ pipelinePhase: "prd_approval", phaseStatus: "running", trustLevel: 1 });
      }
      if (filePath.includes("req-2/pipeline.json")) {
        return makePipelineJson({ pipelinePhase: "code_review", phaseStatus: "pending", trustLevel: 2 });
      }
      if (filePath.includes("req-3/pipeline.json")) {
        return makePipelineJson({ pipelinePhase: "deployment_approval", phaseStatus: "running", trustLevel: 3 });
      }
      if (filePath.includes("pending.json")) {
        return makePendingJson([]);
      }
      throw new Error("ENOENT");
    });

    fsReaddirSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const capture = new StateSnapshotCapture(STATE_DIR);
    const snapshots = capture.captureAll(["req-1", "req-2", "req-3"]);

    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]!.requestId).toBe("req-1");
    expect(snapshots[0]!.pipelinePhase).toBe("prd_approval");
    expect(snapshots[1]!.requestId).toBe("req-2");
    expect(snapshots[1]!.pipelinePhase).toBe("code_review");
    expect(snapshots[1]!.phaseStatus).toBe("pending");
    expect(snapshots[2]!.requestId).toBe("req-3");
    expect(snapshots[2]!.trustLevel).toBe(3);
  });

  // -----------------------------------------------------------------------
  // Test 4: Persist kill snapshot atomically
  // -----------------------------------------------------------------------

  it("persists kill snapshot to expected path with correct content", async () => {
    const { mockFs, store } = createMockFs();
    const capture = new StateSnapshotCapture(STATE_DIR, mockFs);

    const snapshots = [
      {
        requestId: "req-abc",
        pipelinePhase: "code_review",
        phaseStatus: "running",
        artifacts: ["src/feature.ts"],
        pendingEscalationIds: ["esc-20260408-005"],
        trustLevel: 2,
      },
    ];

    const snapshotPath = await capture.persistKillSnapshot(
      snapshots,
      "graceful",
      "user@example.com",
    );

    // Verify path format
    expect(snapshotPath).toMatch(
      /^.*\/\.autonomous-dev\/state\/kill-snapshot-.*\.json$/,
    );

    // Verify content was written and matches schema
    const content = store.get(snapshotPath);
    expect(content).toBeDefined();

    const parsed = JSON.parse(content!) as KillSnapshot;
    expect(parsed.kill_mode).toBe("graceful");
    expect(parsed.issued_by).toBe("user@example.com");
    expect(parsed.issued_at).toBeDefined();
    expect(parsed.total_active_requests).toBe(1);
    expect(parsed.snapshots).toHaveLength(1);
    expect(parsed.snapshots[0]!.requestId).toBe("req-abc");
    expect(parsed.snapshots[0]!.pipelinePhase).toBe("code_review");
    expect(parsed.snapshots[0]!.artifacts).toEqual(["src/feature.ts"]);
  });

  // -----------------------------------------------------------------------
  // Test 5: Persist uses temp+rename pattern
  // -----------------------------------------------------------------------

  it("uses temp+rename for atomic write", async () => {
    const { mockFs, writeLog } = createMockFs();
    const capture = new StateSnapshotCapture(STATE_DIR, mockFs);

    await capture.persistKillSnapshot([], "hard", "admin");

    // Verify write pattern: first a writeFile to a .tmp path, then a rename
    expect(writeLog.length).toBe(2);
    expect(writeLog[0]!.op).toBe("writeFile");
    expect(writeLog[0]!.path).toMatch(/\.tmp$/);
    expect(writeLog[1]!.op).toBe("rename");
    expect(writeLog[1]!.path).toMatch(/\.tmp$/);
    expect(writeLog[1]!.target).toMatch(/kill-snapshot-.*\.json$/);
    // The temp file path in rename matches the one used in writeFile
    expect(writeLog[1]!.path).toBe(writeLog[0]!.path);
  });
});

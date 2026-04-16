/**
 * Unit tests for StatePersistence (SPEC-009-4-4, Task 7).
 *
 * Test cases:
 *   1. Write and read pipeline state -- Write state for req-1; read returns same state.
 *   2. Read nonexistent request -- readPipelineState("unknown") returns null.
 *   3. Write is atomic -- Simulate crash during write (mock fs); verify no partial file.
 *   4. Write artifact manifest -- Write and read artifact list.
 *   5. Cleanup removes files -- Write state, cleanup, read returns null.
 *   6. Multiple requests coexist -- Write state for req-1 and req-2; each reads independently.
 */

import { StatePersistence } from "../state-persistence";
import type { PipelineState, StatePersistenceFs } from "../state-persistence";

// ---------------------------------------------------------------------------
// Mock filesystem
// ---------------------------------------------------------------------------

/**
 * Creates an in-memory mock filesystem for testing StatePersistence
 * without touching the real filesystem.
 */
function createMockFs(): {
  mockFs: StatePersistenceFs;
  store: Map<string, string>;
  dirs: Set<string>;
  writeLog: Array<{ op: string; path: string; target?: string }>;
} {
  const store = new Map<string, string>();
  const dirs = new Set<string>();
  const writeLog: Array<{ op: string; path: string; target?: string }> = [];

  const mockFs: StatePersistenceFs = {
    writeFileSync: jest.fn((filePath: string, content: string) => {
      writeLog.push({ op: "writeFile", path: filePath });
      store.set(filePath, content);
    }),

    renameSync: jest.fn((oldPath: string, newPath: string) => {
      writeLog.push({ op: "rename", path: oldPath, target: newPath });
      const content = store.get(oldPath);
      if (content !== undefined) {
        store.set(newPath, content);
        store.delete(oldPath);
      }
    }),

    fdatasyncSync: jest.fn(() => {}),
    openSync: jest.fn(() => 42),
    closeSync: jest.fn(() => {}),

    mkdirSync: jest.fn((dirPath: string) => {
      dirs.add(dirPath);
    }),

    readFileSync: jest.fn((filePath: string) => {
      const content = store.get(filePath);
      if (content === undefined) {
        const err = new Error(
          `ENOENT: no such file or directory, open '${filePath}'`,
        ) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return content;
    }),

    existsSync: jest.fn((filePath: string) => {
      return store.has(filePath);
    }),

    rmSync: jest.fn((dirPath: string) => {
      // Remove all keys that start with dirPath
      for (const key of store.keys()) {
        if (key.startsWith(dirPath)) {
          store.delete(key);
        }
      }
    }),
  };

  return { mockFs, store, dirs, writeLog };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_DIR = "/project/.autonomous-dev/state";

function makePipelineState(
  requestId: string,
  overrides: Partial<PipelineState> = {},
): PipelineState {
  return {
    requestId,
    currentPhase: "code_review",
    phaseStatus: "running",
    completedPhases: ["prd_approval", "tdd_approval"],
    trustLevel: 2,
    lastUpdated: "2026-04-08T10:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StatePersistence", () => {
  // -----------------------------------------------------------------------
  // Test 1: Write and read pipeline state
  // -----------------------------------------------------------------------

  it("writes and reads pipeline state for a request", () => {
    const { mockFs } = createMockFs();
    const persistence = new StatePersistence(BASE_DIR, mockFs);

    const state = makePipelineState("req-1");
    persistence.writePipelineState("req-1", state);

    const readState = persistence.readPipelineState("req-1");
    expect(readState).toEqual(state);
  });

  // -----------------------------------------------------------------------
  // Test 2: Read nonexistent request returns null
  // -----------------------------------------------------------------------

  it("returns null for nonexistent request", () => {
    const { mockFs } = createMockFs();
    const persistence = new StatePersistence(BASE_DIR, mockFs);

    const result = persistence.readPipelineState("unknown");
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Test 3: Write is atomic (temp + fsync + rename)
  // -----------------------------------------------------------------------

  it("writes atomically via temp file, fsync, and rename", () => {
    const { mockFs, writeLog } = createMockFs();
    const persistence = new StatePersistence(BASE_DIR, mockFs);

    const state = makePipelineState("req-1");
    persistence.writePipelineState("req-1", state);

    // Verify write pattern: writeFile to .tmp, then rename
    const writes = writeLog.filter(
      (e) => e.op === "writeFile" || e.op === "rename",
    );
    expect(writes.length).toBe(2);
    expect(writes[0]!.op).toBe("writeFile");
    expect(writes[0]!.path).toMatch(/\.tmp$/);
    expect(writes[1]!.op).toBe("rename");
    expect(writes[1]!.path).toBe(writes[0]!.path);
    expect(writes[1]!.target).toMatch(/pipeline\.json$/);

    // Verify fsync was called
    expect(mockFs.openSync).toHaveBeenCalled();
    expect(mockFs.fdatasyncSync).toHaveBeenCalled();
    expect(mockFs.closeSync).toHaveBeenCalled();
  });

  it("does not leave partial file on crash during write", () => {
    const { mockFs, store } = createMockFs();

    // Simulate crash: renameSync throws after writeFileSync succeeds
    (mockFs.renameSync as jest.Mock).mockImplementation(() => {
      throw new Error("Simulated crash during rename");
    });

    const persistence = new StatePersistence(BASE_DIR, mockFs);
    const state = makePipelineState("req-crash");

    // writePipelineState catches errors and logs them
    const consoleSpy = jest.spyOn(console, "error").mockImplementation();
    persistence.writePipelineState("req-crash", state);
    consoleSpy.mockRestore();

    // The final pipeline.json should NOT exist (only the .tmp file)
    const targetPath = `${BASE_DIR}/req-crash/pipeline.json`;
    expect(store.has(targetPath)).toBe(false);

    // The .tmp file is the only thing written
    const tmpFiles = Array.from(store.keys()).filter((k) =>
      k.endsWith(".tmp"),
    );
    expect(tmpFiles.length).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 4: Write and read artifact manifest
  // -----------------------------------------------------------------------

  it("writes and reads artifact manifest", () => {
    const { mockFs } = createMockFs();
    const persistence = new StatePersistence(BASE_DIR, mockFs);

    const artifacts = ["src/feature.ts", "src/feature.test.ts", "docs/api.md"];
    persistence.writeArtifactManifest("req-1", artifacts);

    const readArtifacts = persistence.readArtifactManifest("req-1");
    expect(readArtifacts).toEqual(artifacts);
  });

  it("returns empty array for nonexistent artifact manifest", () => {
    const { mockFs } = createMockFs();
    const persistence = new StatePersistence(BASE_DIR, mockFs);

    const result = persistence.readArtifactManifest("unknown");
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Test 5: Cleanup removes files
  // -----------------------------------------------------------------------

  it("cleanup removes all state files for a request", () => {
    const { mockFs } = createMockFs();
    const persistence = new StatePersistence(BASE_DIR, mockFs);

    // Write state and artifacts
    const state = makePipelineState("req-1");
    persistence.writePipelineState("req-1", state);
    persistence.writeArtifactManifest("req-1", ["src/feature.ts"]);

    // Verify they exist
    expect(persistence.readPipelineState("req-1")).not.toBeNull();
    expect(persistence.readArtifactManifest("req-1")).toHaveLength(1);

    // Cleanup
    persistence.cleanup("req-1");

    // Verify removed
    expect(persistence.readPipelineState("req-1")).toBeNull();
    expect(persistence.readArtifactManifest("req-1")).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Test 6: Multiple requests coexist
  // -----------------------------------------------------------------------

  it("maintains independent state for multiple requests", () => {
    const { mockFs } = createMockFs();
    const persistence = new StatePersistence(BASE_DIR, mockFs);

    const state1 = makePipelineState("req-1", {
      currentPhase: "prd_approval",
      trustLevel: 1,
    });
    const state2 = makePipelineState("req-2", {
      currentPhase: "code_review",
      trustLevel: 3,
    });

    persistence.writePipelineState("req-1", state1);
    persistence.writePipelineState("req-2", state2);

    // Each reads independently
    const read1 = persistence.readPipelineState("req-1");
    const read2 = persistence.readPipelineState("req-2");

    expect(read1).toEqual(state1);
    expect(read2).toEqual(state2);
    expect(read1!.currentPhase).toBe("prd_approval");
    expect(read2!.currentPhase).toBe("code_review");
  });

  // -----------------------------------------------------------------------
  // Additional: Pipeline state is readable immediately after write
  // -----------------------------------------------------------------------

  it("state is readable immediately after write (no caching delays)", () => {
    const { mockFs } = createMockFs();
    const persistence = new StatePersistence(BASE_DIR, mockFs);

    const state = makePipelineState("req-1");
    persistence.writePipelineState("req-1", state);

    // Immediately readable
    const readState = persistence.readPipelineState("req-1");
    expect(readState).toEqual(state);

    // Update and verify immediate read of updated value
    const updatedState = makePipelineState("req-1", {
      currentPhase: "deployment",
      phaseStatus: "completed",
      completedPhases: ["prd_approval", "tdd_approval", "code_review"],
    });
    persistence.writePipelineState("req-1", updatedState);

    const readUpdated = persistence.readPipelineState("req-1");
    expect(readUpdated).toEqual(updatedState);
    expect(readUpdated!.currentPhase).toBe("deployment");
  });

  // -----------------------------------------------------------------------
  // Additional: State files follow TDD Section 3.3.1 layout
  // -----------------------------------------------------------------------

  it("creates state files in the correct directory structure", () => {
    const { mockFs, dirs } = createMockFs();
    const persistence = new StatePersistence(BASE_DIR, mockFs);

    persistence.writePipelineState(
      "req-abc",
      makePipelineState("req-abc"),
    );

    // Directory created: {baseDir}/{requestId}
    expect(dirs.has(`${BASE_DIR}/req-abc`)).toBe(true);

    // mkdirSync was called with recursive: true
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      `${BASE_DIR}/req-abc`,
      { recursive: true },
    );
  });

  // -----------------------------------------------------------------------
  // Additional: Write failure does not throw
  // -----------------------------------------------------------------------

  it("does not throw on write failure (logs error)", () => {
    const { mockFs } = createMockFs();

    // Make writeFileSync throw
    (mockFs.writeFileSync as jest.Mock).mockImplementation(() => {
      throw new Error("Disk full");
    });

    const persistence = new StatePersistence(BASE_DIR, mockFs);
    const consoleSpy = jest.spyOn(console, "error").mockImplementation();

    // Should not throw
    expect(() =>
      persistence.writePipelineState("req-1", makePipelineState("req-1")),
    ).not.toThrow();

    // Error was logged
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to write pipeline state for req-1"),
      expect.any(Error),
    );

    consoleSpy.mockRestore();
  });
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  EscalationIdGenerator,
  EscalationFormatter,
  redactSecrets,
  sanitizePath,
  generateSummary,
} from "../../src/escalation/formatter";
import type { FormatterInput } from "../../src/escalation/types";
import type { EscalationMessage } from "../../src/escalation/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory for test state files. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "esc-formatter-test-"));
}

/** Create a state file path inside a fresh temp directory. */
function makeTempStatePath(): string {
  const dir = makeTempDir();
  return path.join(dir, "escalation-counter.json");
}

/** A fixed date string for deterministic ID generation. */
const FIXED_DATE = "20260408";

/** A date provider that always returns the fixed date. */
const fixedDateProvider = (): string => FIXED_DATE;

/** Build a FormatterInput with sensible defaults, overridden by `overrides`. */
function makeInput(overrides: Partial<FormatterInput> = {}): FormatterInput {
  return {
    requestId: "req-001",
    repository: "my-repo",
    pipelinePhase: "code_review",
    escalationType: "technical",
    urgency: "soon",
    failureReason: "TypeScript compilation error in module X",
    options: [
      { option_id: "opt-1", label: "Retry", action: "retry" },
      { option_id: "opt-2", label: "Skip", action: "skip" },
    ],
    retryCount: 1,
    pipelineBehavior: "pause_at_boundary",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EscalationIdGenerator tests
// ---------------------------------------------------------------------------

describe("EscalationIdGenerator", () => {
  // -------------------------------------------------------------------------
  // Test Case 1: ID format
  // -------------------------------------------------------------------------
  test("next() returns string matching /^esc-\\d{8}-\\d{3,}$/", () => {
    const statePath = makeTempStatePath();
    const gen = new EscalationIdGenerator(statePath, fixedDateProvider);

    const id = gen.next();

    expect(id).toMatch(/^esc-\d{8}-\d{3,}$/);
  });

  // -------------------------------------------------------------------------
  // Test Case 2: ID monotonic
  // -------------------------------------------------------------------------
  test("calling next() three times returns 001, 002, 003", () => {
    const statePath = makeTempStatePath();
    const gen = new EscalationIdGenerator(statePath, fixedDateProvider);

    expect(gen.next()).toBe(`esc-${FIXED_DATE}-001`);
    expect(gen.next()).toBe(`esc-${FIXED_DATE}-002`);
    expect(gen.next()).toBe(`esc-${FIXED_DATE}-003`);
  });

  // -------------------------------------------------------------------------
  // Test Case 3: ID counter persists across restarts
  // -------------------------------------------------------------------------
  test("counter persists across generator instances", () => {
    const statePath = makeTempStatePath();

    // First instance: generate 2 IDs
    const gen1 = new EscalationIdGenerator(statePath, fixedDateProvider);
    gen1.next(); // 001
    gen1.next(); // 002

    // Second instance: should resume from 002
    const gen2 = new EscalationIdGenerator(statePath, fixedDateProvider);
    const id = gen2.next();

    expect(id).toBe(`esc-${FIXED_DATE}-003`);
  });

  // -------------------------------------------------------------------------
  // Test Case 4: ID date reset
  // -------------------------------------------------------------------------
  test("counter resets to 001 on date change", () => {
    const statePath = makeTempStatePath();
    let currentDate = "20260408";

    const gen = new EscalationIdGenerator(
      statePath,
      () => currentDate,
    );

    gen.next(); // 20260408-001
    gen.next(); // 20260408-002

    // Simulate date change
    currentDate = "20260409";

    const id = gen.next();
    expect(id).toBe("esc-20260409-001");
  });

  // -------------------------------------------------------------------------
  // Counter > 999 still works (zero-padded to at least 3)
  // -------------------------------------------------------------------------
  test("counter above 999 is not truncated", () => {
    const statePath = makeTempStatePath();

    // Seed the persisted state with counter at 999
    const dir = path.dirname(statePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({ date: FIXED_DATE, counter: 999 }),
    );

    const gen = new EscalationIdGenerator(statePath, fixedDateProvider);
    const id = gen.next();

    expect(id).toBe(`esc-${FIXED_DATE}-1000`);
  });
});

// ---------------------------------------------------------------------------
// EscalationFormatter tests
// ---------------------------------------------------------------------------

describe("EscalationFormatter", () => {
  let statePath: string;

  beforeEach(() => {
    statePath = makeTempStatePath();
  });

  /** Create a formatter with the given verbosity mode. */
  function createFormatter(
    verbosity: "terse" | "standard" | "verbose",
    workspaceRoot = "/Users/dev/workspace/repo",
  ): EscalationFormatter {
    const gen = new EscalationIdGenerator(statePath, fixedDateProvider);
    return new EscalationFormatter(gen, verbosity, workspaceRoot);
  }

  // -------------------------------------------------------------------------
  // Test Case 5: Terse mode omits pipeline_phase
  // -------------------------------------------------------------------------
  test("terse mode omits pipeline_phase", () => {
    const formatter = createFormatter("terse");
    const result = formatter.format(makeInput());

    expect(result).not.toHaveProperty("pipeline_phase");
  });

  // -------------------------------------------------------------------------
  // Test Case 6: Terse mode includes summary and options
  // -------------------------------------------------------------------------
  test("terse mode includes summary and options", () => {
    const formatter = createFormatter("terse");
    const result = formatter.format(makeInput());

    expect(result.summary).toBeDefined();
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.options).toBeDefined();
    expect(result.options.length).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Terse mode omits failure_reason, retry_count, artifacts, technical_details, cost_impact
  // -------------------------------------------------------------------------
  test("terse mode omits failure_reason, retry_count, cost_impact", () => {
    const formatter = createFormatter("terse");
    const result = formatter.format(
      makeInput({
        costImpact: {
          estimated_cost: 100,
          currency: "USD",
          threshold_exceeded: true,
        },
      }),
    );

    expect(result).not.toHaveProperty("failure_reason");
    expect(result).not.toHaveProperty("retry_count");
    expect(result).not.toHaveProperty("cost_impact");
    expect(result).not.toHaveProperty("technical_details");
    expect(result).not.toHaveProperty("artifacts");
  });

  // -------------------------------------------------------------------------
  // Terse mode keeps required identifiers
  // -------------------------------------------------------------------------
  test("terse mode keeps schema_version, escalation_id, timestamp, request_id, repository, escalation_type, urgency", () => {
    const formatter = createFormatter("terse");
    const result = formatter.format(makeInput());

    expect(result.schema_version).toBe("v1");
    expect(result.escalation_id).toMatch(/^esc-\d{8}-\d{3,}$/);
    expect(result.timestamp).toBeDefined();
    expect(result.request_id).toBe("req-001");
    expect(result.repository).toBe("my-repo");
    expect(result.escalation_type).toBe("technical");
    expect(result.urgency).toBe("soon");
  });

  // -------------------------------------------------------------------------
  // Test Case 7: Standard mode includes failure_reason
  // -------------------------------------------------------------------------
  test("standard mode includes failure_reason", () => {
    const formatter = createFormatter("standard");
    const result = formatter.format(makeInput());

    expect(result.failure_reason).toBeDefined();
    expect(result.failure_reason.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Standard mode includes pipeline_phase, retry_count
  // -------------------------------------------------------------------------
  test("standard mode includes pipeline_phase and retry_count", () => {
    const formatter = createFormatter("standard");
    const result = formatter.format(makeInput());

    expect(result.pipeline_phase).toBe("code_review");
    expect(result.retry_count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Standard mode includes artifacts (path only)
  // -------------------------------------------------------------------------
  test("standard mode includes artifacts with path only (no summary)", () => {
    const formatter = createFormatter("standard");
    const result = formatter.format(
      makeInput({
        artifacts: [
          {
            type: "log",
            path: "/Users/dev/workspace/repo/logs/build.log",
            summary: "Build output",
          },
        ],
      }),
    );

    expect(result.artifacts).toBeDefined();
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts![0].path).toBe("logs/build.log");
    expect(result.artifacts![0]).not.toHaveProperty("summary");
  });

  // -------------------------------------------------------------------------
  // Standard mode includes cost_impact if present
  // -------------------------------------------------------------------------
  test("standard mode includes cost_impact when present", () => {
    const formatter = createFormatter("standard");
    const cost = {
      estimated_cost: 50,
      currency: "USD",
      threshold_exceeded: false,
    };
    const result = formatter.format(makeInput({ costImpact: cost }));

    expect(result.cost_impact).toBeDefined();
    expect(result.cost_impact!.estimated_cost).toBe(50);
  });

  // -------------------------------------------------------------------------
  // Standard mode omits technical_details
  // -------------------------------------------------------------------------
  test("standard mode omits technical_details", () => {
    const formatter = createFormatter("standard");
    const result = formatter.format(
      makeInput({ technicalDetails: "Extended stack trace..." }),
    );

    expect(result).not.toHaveProperty("technical_details");
  });

  // -------------------------------------------------------------------------
  // Test Case 8: Verbose mode includes technical_details
  // -------------------------------------------------------------------------
  test("verbose mode includes technical_details", () => {
    const formatter = createFormatter("verbose");
    const result = formatter.format(
      makeInput({ technicalDetails: "Extended stack trace at src/foo.ts:42" }),
    );

    expect(result.technical_details).toBeDefined();
    expect(result.technical_details).toContain("src/foo.ts:42");
  });

  // -------------------------------------------------------------------------
  // Verbose mode includes full artifact data (path + summary)
  // -------------------------------------------------------------------------
  test("verbose mode includes artifacts with path and summary", () => {
    const formatter = createFormatter("verbose");
    const result = formatter.format(
      makeInput({
        artifacts: [
          {
            type: "log",
            path: "/Users/dev/workspace/repo/logs/build.log",
            summary: "Build output",
          },
        ],
      }),
    );

    expect(result.artifacts).toBeDefined();
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts![0].path).toBe("logs/build.log");
    expect(result.artifacts![0].summary).toBe("Build output");
  });

  // -------------------------------------------------------------------------
  // Verbose mode includes option descriptions
  // -------------------------------------------------------------------------
  test("verbose mode includes option descriptions", () => {
    const formatter = createFormatter("verbose");
    const result = formatter.format(
      makeInput({
        options: [
          {
            option_id: "opt-1",
            label: "Retry",
            action: "retry",
            description: "Retry the failed operation",
          },
          {
            option_id: "opt-2",
            label: "Skip",
            action: "skip",
            description: "Skip and continue",
          },
        ],
      }),
    );

    expect(result.options[0].description).toBe("Retry the failed operation");
    expect(result.options[1].description).toBe("Skip and continue");
  });

  // -------------------------------------------------------------------------
  // Test Case 9: Summary truncation
  // -------------------------------------------------------------------------
  test("summary is truncated to 200 chars with '...' suffix", () => {
    const formatter = createFormatter("standard");
    const longReason = "A".repeat(300);
    const result = formatter.format(makeInput({ failureReason: longReason }));

    expect(result.summary.length).toBeLessThanOrEqual(200);
    expect(result.summary.endsWith("...")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test Case 10: Secret redaction in summary
  // -------------------------------------------------------------------------
  test("secret values are redacted from summary", () => {
    const formatter = createFormatter("standard");
    const result = formatter.format(
      makeInput({ failureReason: "Failed: api_key=sk-12345abc" }),
    );

    expect(result.summary).not.toContain("sk-12345abc");
    expect(result.summary).toContain("[REDACTED]");
  });

  // -------------------------------------------------------------------------
  // Test Case 11: Secret redaction in failure_reason
  // -------------------------------------------------------------------------
  test("secret values are redacted from failure_reason", () => {
    const formatter = createFormatter("standard");
    const result = formatter.format(
      makeInput({
        failureReason:
          "Connection string: connection_string=postgres://user:pass@host",
      }),
    );

    expect(result.failure_reason).not.toContain("postgres://user:pass@host");
    expect(result.failure_reason).toContain("[REDACTED]");
  });

  // -------------------------------------------------------------------------
  // Test Case 12: Secret redaction in option labels
  // -------------------------------------------------------------------------
  test("secret values are redacted from option labels", () => {
    const formatter = createFormatter("standard");
    const result = formatter.format(
      makeInput({
        options: [
          {
            option_id: "opt-1",
            label: "Use token=abc123 for retry",
            action: "retry",
          },
          { option_id: "opt-2", label: "Skip", action: "skip" },
        ],
      }),
    );

    expect(result.options[0].label).not.toContain("abc123");
    expect(result.options[0].label).toContain("[REDACTED]");
  });

  // -------------------------------------------------------------------------
  // Test Case 13: Technical details may reference file paths
  // -------------------------------------------------------------------------
  test("technical_details with file paths are NOT redacted", () => {
    const formatter = createFormatter("verbose");
    const result = formatter.format(
      makeInput({ technicalDetails: "Error at src/foo.ts:42" }),
    );

    expect(result.technical_details).toBe("Error at src/foo.ts:42");
  });

  // -------------------------------------------------------------------------
  // Test Case 14: Path sanitization
  // -------------------------------------------------------------------------
  test("artifact paths are sanitized to workspace-relative", () => {
    const formatter = createFormatter("verbose", "/Users/dev/workspace/repo");
    const result = formatter.format(
      makeInput({
        artifacts: [
          {
            type: "log",
            path: "/Users/dev/workspace/repo/src/main.ts",
          },
        ],
      }),
    );

    expect(result.artifacts![0].path).toBe("src/main.ts");
  });

  // -------------------------------------------------------------------------
  // Path sanitization: non-matching path returned as-is
  // -------------------------------------------------------------------------
  test("artifact paths outside workspace are returned as-is", () => {
    const formatter = createFormatter("verbose", "/Users/dev/workspace/repo");
    const result = formatter.format(
      makeInput({
        artifacts: [
          {
            type: "log",
            path: "/other/location/file.ts",
          },
        ],
      }),
    );

    expect(result.artifacts![0].path).toBe("/other/location/file.ts");
  });

  // -------------------------------------------------------------------------
  // Test Case 15: JSON round-trip
  // -------------------------------------------------------------------------
  test("JSON.parse(JSON.stringify(formatted)) deep-equals the original", () => {
    const formatter = createFormatter("verbose");
    const result = formatter.format(
      makeInput({
        technicalDetails: "Stack trace here",
        artifacts: [
          {
            type: "log",
            path: "/Users/dev/workspace/repo/logs/build.log",
            summary: "Build output",
          },
        ],
        costImpact: {
          estimated_cost: 12.5,
          currency: "USD",
          threshold_exceeded: false,
          budget_remaining: 87.5,
        },
        previousEscalationId: "esc-20260407-005",
      }),
    );

    const roundTripped = JSON.parse(JSON.stringify(result));
    expect(roundTripped).toEqual(result);
  });

  // -------------------------------------------------------------------------
  // Test Case 16: Re-escalation links
  // -------------------------------------------------------------------------
  test("previous_escalation_id appears when provided", () => {
    const formatter = createFormatter("standard");
    const result = formatter.format(
      makeInput({ previousEscalationId: "esc-20260407-005" }),
    );

    expect(result.previous_escalation_id).toBe("esc-20260407-005");
  });

  // -------------------------------------------------------------------------
  // previous_escalation_id absent when not provided
  // -------------------------------------------------------------------------
  test("previous_escalation_id absent when not provided", () => {
    const formatter = createFormatter("standard");
    const result = formatter.format(makeInput());

    expect(result).not.toHaveProperty("previous_escalation_id");
  });

  // -------------------------------------------------------------------------
  // Test Case 17: Options require at least 2
  // -------------------------------------------------------------------------
  test("formatter throws if fewer than 2 options provided", () => {
    const formatter = createFormatter("standard");

    expect(() =>
      formatter.format(
        makeInput({
          options: [{ option_id: "opt-1", label: "Retry", action: "retry" }],
        }),
      ),
    ).toThrow("Escalation requires at least 2 options, got 1");
  });

  test("formatter throws with 0 options", () => {
    const formatter = createFormatter("standard");

    expect(() => formatter.format(makeInput({ options: [] }))).toThrow(
      "Escalation requires at least 2 options, got 0",
    );
  });

  // -------------------------------------------------------------------------
  // All three modes produce valid EscalationMessage (AC 8)
  // -------------------------------------------------------------------------
  test("all verbosity modes produce messages with schema_version v1", () => {
    for (const verbosity of ["terse", "standard", "verbose"] as const) {
      const formatter = createFormatter(verbosity);
      const result = formatter.format(makeInput());

      expect(result.schema_version).toBe("v1");
      expect(result.escalation_id).toMatch(/^esc-\d{8}-\d{3,}$/);
      expect(result.timestamp).toBeDefined();
      expect(result.request_id).toBe("req-001");
      expect(result.repository).toBe("my-repo");
      expect(result.escalation_type).toBe("technical");
      expect(result.urgency).toBe("soon");
      expect(result.summary).toBeDefined();
      expect(result.options.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests for exported helpers
// ---------------------------------------------------------------------------

describe("redactSecrets", () => {
  test("redacts api_key=value", () => {
    expect(redactSecrets("Failed: api_key=sk-12345abc")).toBe(
      "Failed: [REDACTED]",
    );
  });

  test("redacts token=value", () => {
    expect(redactSecrets("Use token=abc123 for auth")).toBe(
      "Use [REDACTED] for auth",
    );
  });

  test("redacts password=value", () => {
    expect(redactSecrets("password=hunter2")).toBe("[REDACTED]");
  });

  test("redacts connection_string=value", () => {
    expect(
      redactSecrets("connection_string=postgres://user:pass@host"),
    ).toBe("[REDACTED]");
  });

  test("redacts secret: value (colon separator)", () => {
    expect(redactSecrets("secret: mysecretvalue")).toBe("[REDACTED]");
  });

  test("does not redact normal text", () => {
    expect(redactSecrets("Error at src/foo.ts:42")).toBe(
      "Error at src/foo.ts:42",
    );
  });

  test("handles multiple secrets", () => {
    const input = "api_key=abc123 and token=xyz789";
    const result = redactSecrets(input);
    expect(result).not.toContain("abc123");
    expect(result).not.toContain("xyz789");
    expect(result).toContain("[REDACTED]");
  });
});

describe("sanitizePath", () => {
  test("strips workspace root prefix", () => {
    expect(
      sanitizePath(
        "/Users/dev/workspace/repo/src/main.ts",
        "/Users/dev/workspace/repo",
      ),
    ).toBe("src/main.ts");
  });

  test("returns path as-is when workspace root does not match", () => {
    expect(
      sanitizePath("/other/location/file.ts", "/Users/dev/workspace/repo"),
    ).toBe("/other/location/file.ts");
  });

  test("strips leading slash after workspace root removal", () => {
    expect(
      sanitizePath(
        "/Users/dev/workspace/repo/file.ts",
        "/Users/dev/workspace/repo",
      ),
    ).toBe("file.ts");
  });
});

describe("generateSummary", () => {
  test("produces summary with correct pattern", () => {
    const summary = generateSummary("technical", "code_review", "Build failed");
    expect(summary).toBe("[technical] code_review: Build failed");
  });

  test("truncates to 200 chars with '...' suffix", () => {
    const longReason = "A".repeat(300);
    const summary = generateSummary("technical", "code_review", longReason);
    expect(summary.length).toBe(200);
    expect(summary.endsWith("...")).toBe(true);
  });

  test("does not truncate short summaries", () => {
    const summary = generateSummary("technical", "build", "Compile error");
    expect(summary).toBe("[technical] build: Compile error");
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary.endsWith("...")).toBe(false);
  });
});

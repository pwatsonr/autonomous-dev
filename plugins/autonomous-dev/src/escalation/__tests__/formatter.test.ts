/**
 * Unit tests for EscalationFormatter and EscalationIdGenerator (SPEC-009-2-2).
 *
 * Tests cover:
 *   - ID format, monotonic increments, persistence, and date reset
 *   - Terse / standard / verbose verbosity modes
 *   - Summary truncation to 200 characters
 *   - Secret redaction in summary, failure_reason, and option labels
 *   - Path sanitization for artifacts
 *   - JSON round-trip fidelity
 *   - Re-escalation linking
 *   - Minimum 2 options enforcement
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  EscalationIdGenerator,
  EscalationFormatter,
  redactSecrets,
  sanitizePath,
} from "../formatter";
import type { FormatterInput, EscalationOption } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "esc-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const FIXED_DATE = "20260408";

function makeInput(overrides: Partial<FormatterInput> = {}): FormatterInput {
  return {
    requestId: "req-1",
    repository: "my-repo",
    pipelinePhase: "code_review",
    escalationType: "quality",
    urgency: "soon",
    failureReason: "Code review failed after 3 attempts",
    options: [
      { option_id: "opt-1", label: "Review again", action: "retry" },
      { option_id: "opt-2", label: "Accept as-is", action: "accept" },
    ],
    retryCount: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EscalationIdGenerator Tests
// ---------------------------------------------------------------------------

describe("EscalationIdGenerator", () => {
  // Test Case 1: ID format
  test("next() returns string matching esc-YYYYMMDD-NNN format", () => {
    const statePath = path.join(tmpDir, "counter.json");
    const gen = new EscalationIdGenerator(statePath, () => FIXED_DATE);
    const id = gen.next();

    expect(id).toMatch(/^esc-\d{8}-\d{3,}$/);
  });

  // Test Case 2: ID monotonic
  test("calling next() three times returns sequential IDs", () => {
    const statePath = path.join(tmpDir, "counter.json");
    const gen = new EscalationIdGenerator(statePath, () => FIXED_DATE);

    expect(gen.next()).toBe("esc-20260408-001");
    expect(gen.next()).toBe("esc-20260408-002");
    expect(gen.next()).toBe("esc-20260408-003");
  });

  // Test Case 3: ID counter persists across instances
  test("counter persists across generator instances", () => {
    const statePath = path.join(tmpDir, "counter.json");

    const gen1 = new EscalationIdGenerator(statePath, () => FIXED_DATE);
    gen1.next(); // 001
    gen1.next(); // 002

    const gen2 = new EscalationIdGenerator(statePath, () => FIXED_DATE);
    expect(gen2.next()).toBe("esc-20260408-003");
  });

  // Test Case 4: ID date reset
  test("counter resets on date change", () => {
    const statePath = path.join(tmpDir, "counter.json");

    let currentDate = "20260408";
    const dateProvider = () => currentDate;

    const gen = new EscalationIdGenerator(statePath, dateProvider);
    gen.next(); // 001
    gen.next(); // 002

    // Simulate date change
    currentDate = "20260409";
    expect(gen.next()).toBe("esc-20260409-001");
  });

  // Additional: supports more than 3 digits
  test("supports counter values above 999", () => {
    const statePath = path.join(tmpDir, "counter.json");
    // Pre-seed the counter state
    fs.writeFileSync(
      statePath,
      JSON.stringify({ date: FIXED_DATE, counter: 999 }),
    );

    const gen = new EscalationIdGenerator(statePath, () => FIXED_DATE);
    expect(gen.next()).toBe("esc-20260408-1000");
  });
});

// ---------------------------------------------------------------------------
// EscalationFormatter Tests
// ---------------------------------------------------------------------------

describe("EscalationFormatter", () => {
  function createFormatter(
    verbosity: "terse" | "standard" | "verbose" = "standard",
  ) {
    const statePath = path.join(tmpDir, "counter.json");
    const idGen = new EscalationIdGenerator(statePath, () => FIXED_DATE);
    return new EscalationFormatter(idGen, verbosity);
  }

  // Test Case 5: Terse mode omits pipeline_phase
  test("terse mode omits pipeline_phase", () => {
    const formatter = createFormatter("terse");
    const msg = formatter.format(makeInput());

    expect(msg).not.toHaveProperty("pipeline_phase");
  });

  // Test Case 6: Terse mode includes summary and options
  test("terse mode includes summary and options", () => {
    const formatter = createFormatter("terse");
    const msg = formatter.format(makeInput());

    expect(msg.summary).toBeDefined();
    expect(msg.options).toBeDefined();
    expect(msg.options.length).toBeGreaterThanOrEqual(2);
  });

  // Test Case 7: Standard mode includes failure_reason
  test("standard mode includes failure_reason", () => {
    const formatter = createFormatter("standard");
    const msg = formatter.format(makeInput());

    expect(msg.failure_reason).toBeDefined();
    expect(msg.failure_reason).toContain("Code review failed");
  });

  // Test Case 8: Verbose mode includes technical_details
  test("verbose mode includes technical_details when provided", () => {
    const formatter = createFormatter("verbose");
    const msg = formatter.format(
      makeInput({
        technicalDetails: "Error at src/foo.ts:42",
      }),
    );

    expect(msg.technical_details).toBe("Error at src/foo.ts:42");
  });

  // Test Case 9: Summary truncation
  test("summary is truncated to 200 characters with ... suffix", () => {
    const formatter = createFormatter("standard");
    const longReason = "A".repeat(300);
    const msg = formatter.format(makeInput({ failureReason: longReason }));

    expect(msg.summary.length).toBeLessThanOrEqual(200);
    expect(msg.summary).toMatch(/\.\.\.$/);
  });

  // Test Case 10: Secret redaction in summary
  test("secret values are redacted from summary", () => {
    const formatter = createFormatter("standard");
    const msg = formatter.format(
      makeInput({
        failureReason: "Failed: api_key=sk-12345abc",
      }),
    );

    expect(msg.summary).not.toContain("sk-12345abc");
    expect(msg.summary).toContain("[REDACTED]");
  });

  // Test Case 11: Secret redaction in failure_reason
  test("secret values are redacted from failure_reason", () => {
    const formatter = createFormatter("standard");
    const msg = formatter.format(
      makeInput({
        failureReason: "Connection string: password=super_secret_123",
      }),
    );

    expect(msg.failure_reason).not.toContain("super_secret_123");
    expect(msg.failure_reason).toContain("[REDACTED]");
  });

  // Test Case 12: Secret redaction in option labels
  test("secret values are redacted from option labels", () => {
    const formatter = createFormatter("standard");
    const msg = formatter.format(
      makeInput({
        options: [
          { option_id: "opt-1", label: "Use token=abc123 to retry", action: "retry" },
          { option_id: "opt-2", label: "Skip", action: "skip" },
        ],
      }),
    );

    expect(msg.options[0].label).not.toContain("abc123");
    expect(msg.options[0].label).toContain("[REDACTED]");
  });

  // Test Case 13: Technical details preserve file paths
  test("technical_details with file path is NOT redacted", () => {
    const formatter = createFormatter("verbose");
    const msg = formatter.format(
      makeInput({
        technicalDetails: "Error at src/foo.ts:42",
      }),
    );

    expect(msg.technical_details).toBe("Error at src/foo.ts:42");
  });

  // Test Case 14: Path sanitization
  test("artifact paths are sanitized to workspace-relative", () => {
    const statePath = path.join(tmpDir, "counter.json");
    const idGen = new EscalationIdGenerator(statePath, () => FIXED_DATE);
    const formatter = new EscalationFormatter(
      idGen,
      "standard",
      "/Users/dev/workspace/repo",
    );

    const msg = formatter.format(
      makeInput({
        artifacts: [
          {
            type: "log",
            path: "/Users/dev/workspace/repo/src/main.ts",
          },
        ],
      }),
    );

    expect(msg.artifacts).toBeDefined();
    expect(msg.artifacts![0].path).toBe("src/main.ts");
  });

  // Test Case 15: JSON round-trip
  test("message round-trips through JSON serialization", () => {
    const formatter = createFormatter("standard");
    const msg = formatter.format(makeInput());

    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(roundTripped).toEqual(msg);
  });

  // Test Case 16: Re-escalation links
  test("previousEscalationId appears in output when provided", () => {
    const formatter = createFormatter("standard");
    const msg = formatter.format(
      makeInput({
        previousEscalationId: "esc-20260407-005",
      }),
    );

    expect(msg.previous_escalation_id).toBe("esc-20260407-005");
  });

  // Test Case 17: Options require at least 2
  test("formatter throws if fewer than 2 options provided", () => {
    const formatter = createFormatter("standard");

    expect(() =>
      formatter.format(
        makeInput({
          options: [{ option_id: "opt-1", label: "Only one", action: "one" }],
        }),
      ),
    ).toThrow(/at least 2 options/);
  });

  // Additional: terse mode does not include failure_reason or retry_count
  test("terse mode omits failure_reason and retry_count", () => {
    const formatter = createFormatter("terse");
    const msg = formatter.format(makeInput());

    expect(msg).not.toHaveProperty("failure_reason");
    expect(msg).not.toHaveProperty("retry_count");
  });

  // Additional: verbose mode includes artifact summary
  test("verbose mode includes artifact summary", () => {
    const formatter = createFormatter("verbose");
    const msg = formatter.format(
      makeInput({
        artifacts: [
          {
            type: "report",
            path: "reports/review.md",
            summary: "3 issues found",
          },
        ],
      }),
    );

    expect(msg.artifacts).toBeDefined();
    expect(msg.artifacts![0].summary).toBe("3 issues found");
  });
});

// ---------------------------------------------------------------------------
// Standalone function tests
// ---------------------------------------------------------------------------

describe("redactSecrets", () => {
  test("redacts api_key patterns", () => {
    expect(redactSecrets("api_key=sk-12345")).toContain("[REDACTED]");
  });

  test("redacts password patterns", () => {
    expect(redactSecrets("password: hunter2")).toContain("[REDACTED]");
  });

  test("redacts token patterns", () => {
    expect(redactSecrets("token=ghp_abc123")).toContain("[REDACTED]");
  });

  test("leaves non-secret text alone", () => {
    expect(redactSecrets("Normal error message")).toBe("Normal error message");
  });
});

describe("sanitizePath", () => {
  test("strips workspace root prefix", () => {
    expect(
      sanitizePath("/Users/dev/repo/src/file.ts", "/Users/dev/repo"),
    ).toBe("src/file.ts");
  });

  test("returns path unchanged when not under workspace root", () => {
    expect(
      sanitizePath("/other/path/file.ts", "/Users/dev/repo"),
    ).toBe("/other/path/file.ts");
  });
});

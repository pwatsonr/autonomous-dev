/**
 * Escalation message formatter (SPEC-009-2-2).
 *
 * Constructs v1 JSON schema-compliant escalation messages with three
 * verbosity modes (terse, standard, verbose). Generates unique escalation
 * IDs, enforces security constraints (no raw secrets in human-facing
 * fields), and sanitizes file paths for external delivery.
 *
 * This is the serialization boundary between the internal failure context
 * and the structured message delivered to humans.
 */

import * as fs from "fs";
import * as path from "path";
import type {
  EscalationMessage,
  EscalationOption,
  EscalationArtifact,
  FormatterInput,
} from "./types";

// ---------------------------------------------------------------------------
// Secret detection
// ---------------------------------------------------------------------------

/**
 * Regex to detect secret-like patterns in text.
 * Matches api_key=..., token=..., password=..., secret=...,
 * credential=..., connection_string=..., and similar.
 */
const SECRET_PATTERN =
  /(?:api[_-]?key|token|password|secret|credential|connection[_-]?string)\s*[:=]\s*\S+/gi;

/**
 * Replace secret-like patterns in text with [REDACTED].
 */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, "[REDACTED]");
}

// ---------------------------------------------------------------------------
// Path sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize an absolute path to a workspace-relative path.
 *
 * If the path starts with the workspace root, strip the prefix.
 * Otherwise, return the path unchanged.
 */
export function sanitizePath(
  absolutePath: string,
  workspaceRoot: string,
): string {
  if (absolutePath.startsWith(workspaceRoot)) {
    return absolutePath.slice(workspaceRoot.length).replace(/^\//, "");
  }
  return absolutePath;
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

const MAX_SUMMARY_LENGTH = 200;

/**
 * Generate a summary string from the escalation context.
 * Pattern: "[{escalation_type}] {pipeline_phase}: {truncated_failure_reason}"
 * Truncated to 200 chars with "..." suffix if needed.
 */
export function generateSummary(
  escalationType: string,
  pipelinePhase: string,
  failureReason: string,
): string {
  const prefix = `[${escalationType}] ${pipelinePhase}: `;
  const full = prefix + failureReason;

  if (full.length <= MAX_SUMMARY_LENGTH) {
    return full;
  }

  return full.slice(0, MAX_SUMMARY_LENGTH - 3) + "...";
}

// ---------------------------------------------------------------------------
// Escalation ID Generator
// ---------------------------------------------------------------------------

/** Persisted counter state shape. */
interface CounterState {
  date: string;
  counter: number;
}

/**
 * Generates unique escalation IDs in format: esc-YYYYMMDD-NNN
 *
 * Counter is persisted to disk at `statePath` and resets daily.
 * Supports more than 3 digits but is zero-padded to at least 3.
 *
 * On construction, loads persisted state. If the persisted date matches
 * today, resumes the counter. Otherwise resets to 0 (next call yields 001).
 */
export class EscalationIdGenerator {
  private currentDate: string;
  private counter: number;

  /**
   * @param statePath     Path to the JSON file storing counter state.
   *                      The file is created (along with parent dirs) if absent.
   * @param dateProvider  Optional function returning the current UTC date
   *                      as YYYYMMDD. Defaults to the real clock. Exposed
   *                      for deterministic testing of date-rollover scenarios.
   */
  constructor(
    private readonly statePath: string,
    private readonly dateProvider: () => string = getUtcDateString,
  ) {
    const today = this.dateProvider();
    const persisted = this.loadState();

    if (persisted !== null && persisted.date === today) {
      this.currentDate = persisted.date;
      this.counter = persisted.counter;
    } else {
      this.currentDate = today;
      this.counter = 0;
    }
  }

  /**
   * Return the next unique escalation ID and persist the counter.
   */
  next(): string {
    const today = this.dateProvider();

    // Reset counter on date rollover
    if (today !== this.currentDate) {
      this.currentDate = today;
      this.counter = 0;
    }

    this.counter += 1;
    this.persistState();

    const paddedCounter = String(this.counter).padStart(3, "0");
    return `esc-${this.currentDate}-${paddedCounter}`;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Load counter state from the persisted file, or null if unavailable. */
  private loadState(): CounterState | null {
    try {
      const raw = fs.readFileSync(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as CounterState;
      if (
        typeof parsed.date === "string" &&
        typeof parsed.counter === "number"
      ) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Persist current counter state to disk. */
  private persistState(): void {
    const state: CounterState = {
      date: this.currentDate,
      counter: this.counter,
    };
    const dir = path.dirname(this.statePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(state), "utf-8");
    } catch {
      // Best-effort persistence; in-memory state remains correct
    }
  }
}

/**
 * Return the current UTC date as a YYYYMMDD string.
 */
function getUtcDateString(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/**
 * Constructs v1 JSON schema-compliant escalation messages.
 *
 * Three verbosity modes control which fields are populated:
 *   - terse: summary, options (labels only), and required identifiers
 *   - standard: all required fields per the specification
 *   - verbose: includes technical_details and full artifact data
 */
export class EscalationFormatter {
  /**
   * @param idGenerator    Provides unique escalation IDs.
   * @param verbosity      Controls how much detail is included.
   * @param workspaceRoot  Root path for artifact path sanitization.
   *                       Defaults to process.cwd().
   */
  constructor(
    private readonly idGenerator: EscalationIdGenerator,
    private readonly verbosity: "terse" | "standard" | "verbose",
    private readonly workspaceRoot: string = process.cwd(),
  ) {}

  /**
   * Format a pipeline failure into a v1 EscalationMessage.
   *
   * @param input  All data needed to construct the message.
   * @returns A fully populated EscalationMessage.
   * @throws Error if fewer than 2 options are provided.
   */
  format(input: FormatterInput): EscalationMessage {
    // Enforce minimum 2 options
    if (input.options.length < 2) {
      throw new Error(
        `Escalation requires at least 2 options, got ${input.options.length}`,
      );
    }

    const escalationId = this.idGenerator.next();
    const timestamp = new Date().toISOString();
    const summary = redactSecrets(
      generateSummary(
        input.escalationType,
        input.pipelinePhase,
        input.failureReason,
      ),
    );

    // Build message per verbosity mode
    switch (this.verbosity) {
      case "terse":
        return this.buildTerse(input, escalationId, timestamp, summary);
      case "standard":
        return this.buildStandard(input, escalationId, timestamp, summary);
      case "verbose":
        return this.buildVerbose(input, escalationId, timestamp, summary);
    }
  }

  // -------------------------------------------------------------------------
  // Verbosity builders
  // -------------------------------------------------------------------------

  /**
   * Terse mode: summary, options (label only), required identifiers.
   * Omits: pipeline_phase, failure_reason, artifacts, technical_details,
   *        retry_count, cost_impact.
   */
  private buildTerse(
    input: FormatterInput,
    escalationId: string,
    timestamp: string,
    summary: string,
  ): EscalationMessage {
    const msg: Record<string, unknown> = {
      schema_version: "v1",
      escalation_id: escalationId,
      timestamp,
      request_id: input.requestId,
      repository: input.repository,
      escalation_type: input.escalationType,
      urgency: input.urgency,
      summary,
      options: input.options.map((opt) => ({
        option_id: opt.option_id,
        label: redactSecrets(opt.label),
        action: opt.action,
      })),
    };

    if (input.previousEscalationId != null) {
      msg.previous_escalation_id = input.previousEscalationId;
    }

    return msg as unknown as EscalationMessage;
  }

  /**
   * Standard mode: pipeline_phase, failure_reason, retry_count,
   * artifacts (path only), cost_impact if present.
   * Omits: technical_details.
   */
  private buildStandard(
    input: FormatterInput,
    escalationId: string,
    timestamp: string,
    summary: string,
  ): EscalationMessage {
    const msg: Record<string, unknown> = {
      schema_version: "v1",
      escalation_id: escalationId,
      timestamp,
      request_id: input.requestId,
      repository: input.repository,
      pipeline_phase: input.pipelinePhase,
      escalation_type: input.escalationType,
      urgency: input.urgency,
      summary,
      failure_reason: redactSecrets(input.failureReason),
      options: input.options.map((opt) => ({
        option_id: opt.option_id,
        label: redactSecrets(opt.label),
        action: opt.action,
      })),
      retry_count: input.retryCount,
    };

    // Artifacts: path only
    if (input.artifacts != null && input.artifacts.length > 0) {
      msg.artifacts = input.artifacts.map((a) => ({
        type: a.type,
        path: sanitizePath(a.path, this.workspaceRoot),
      }));
    }

    // Cost impact if present
    if (input.costImpact != null) {
      msg.cost_impact = { ...input.costImpact };
    }

    if (input.previousEscalationId != null) {
      msg.previous_escalation_id = input.previousEscalationId;
    }

    return msg as unknown as EscalationMessage;
  }

  /**
   * Verbose mode: includes technical_details, full artifacts (path + summary),
   * option descriptions, cost_impact.
   */
  private buildVerbose(
    input: FormatterInput,
    escalationId: string,
    timestamp: string,
    summary: string,
  ): EscalationMessage {
    const msg: Record<string, unknown> = {
      schema_version: "v1",
      escalation_id: escalationId,
      timestamp,
      request_id: input.requestId,
      repository: input.repository,
      pipeline_phase: input.pipelinePhase,
      escalation_type: input.escalationType,
      urgency: input.urgency,
      summary,
      failure_reason: redactSecrets(input.failureReason),
      options: input.options.map((opt) => {
        const o: EscalationOption = {
          option_id: opt.option_id,
          label: redactSecrets(opt.label),
          action: opt.action,
        };
        if (opt.description != null) {
          o.description = opt.description;
        }
        return o;
      }),
      retry_count: input.retryCount,
    };

    // Technical details (redact secrets but keep file paths)
    if (input.technicalDetails != null) {
      msg.technical_details = redactSecrets(input.technicalDetails);
    }

    // Artifacts: path + summary
    if (input.artifacts != null && input.artifacts.length > 0) {
      msg.artifacts = input.artifacts.map((a) => {
        const artifact: EscalationArtifact = {
          type: a.type,
          path: sanitizePath(a.path, this.workspaceRoot),
        };
        if (a.summary != null) {
          artifact.summary = a.summary;
        }
        return artifact;
      });
    }

    // Cost impact if present
    if (input.costImpact != null) {
      msg.cost_impact = { ...input.costImpact };
    }

    if (input.previousEscalationId != null) {
      msg.previous_escalation_id = input.previousEscalationId;
    }

    return msg as unknown as EscalationMessage;
  }
}

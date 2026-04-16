/**
 * Type definitions for the escalation subsystem.
 *
 * Defines the v1 JSON schema type, escalation types, urgency levels,
 * routing configuration, and all supporting interfaces used by the
 * escalation classifier, router, and delivery components.
 *
 * Based on SPEC-009-2-1 (TDD Section 3.2.2).
 */

// ---------------------------------------------------------------------------
// Core type unions
// ---------------------------------------------------------------------------

/** The 6 escalation categories that classify every pipeline failure. */
export type EscalationType =
  | "product"
  | "technical"
  | "infrastructure"
  | "security"
  | "cost"
  | "quality";

/** How urgently a human must respond to the escalation. */
export type EscalationUrgency = "immediate" | "soon" | "informational";

/** What happens when a human does not respond within the timeout window. */
export type TimeoutBehavior = "pause" | "retry" | "skip" | "cancel";

/** Routing complexity mode: default uses a single target, advanced routes per-type. */
export type RoutingMode = "default" | "advanced";

// ---------------------------------------------------------------------------
// v1 JSON schema -- EscalationMessage
// ---------------------------------------------------------------------------

/**
 * The canonical escalation message (v1 JSON schema).
 *
 * Every pipeline failure that requires human attention is serialized
 * into this structure before delivery.
 */
export interface EscalationMessage {
  /** Schema version identifier. Always "v1" for this release. */
  schema_version: "v1";

  /** Unique escalation identifier. Format: esc-YYYYMMDD-NNN */
  escalation_id: string;

  /** ISO 8601 timestamp of when the escalation was created. */
  timestamp: string;

  /** Correlation ID linking back to the originating pipeline request. */
  request_id: string;

  /** Repository where the failure occurred. */
  repository: string;

  /** Pipeline phase that triggered the escalation. */
  pipeline_phase: string;

  /** Classified type of escalation. */
  escalation_type: EscalationType;

  /** How urgently a human must respond. */
  urgency: EscalationUrgency;

  /** Human-readable summary, max 200 characters. */
  summary: string;

  /** Detailed explanation of the failure. */
  failure_reason: string;

  /** Available response options. At least 2 must be provided. */
  options: EscalationOption[];

  /** Relevant artifacts (logs, diffs, reports, screenshots). */
  artifacts?: EscalationArtifact[];

  /** Extended technical details, populated only in verbose mode. */
  technical_details?: string;

  /** Links to a prior escalation when this is a re-escalation. */
  previous_escalation_id?: string;

  /** Number of times this failure has been retried. */
  retry_count: number;

  /** Cost impact data, present when the failure has cost implications. */
  cost_impact?: CostImpact;
}

// ---------------------------------------------------------------------------
// Supporting interfaces
// ---------------------------------------------------------------------------

/** A single response option presented to the human in an escalation. */
export interface EscalationOption {
  /** Unique option identifier. Format: opt-N */
  option_id: string;

  /** Human-readable label for the option. */
  label: string;

  /** Machine-readable action type. */
  action: string;

  /** Extended description, populated only in verbose mode. */
  description?: string;
}

/** An artifact attached to an escalation for additional context. */
export interface EscalationArtifact {
  /** The kind of artifact. */
  type: "log" | "diff" | "report" | "screenshot";

  /** Workspace-relative path to the artifact. */
  path: string;

  /** Optional human-readable summary of the artifact contents. */
  summary?: string;
}

/** Cost impact data included when a failure has financial implications. */
export interface CostImpact {
  /** Estimated cost of the action or failure. */
  estimated_cost: number;

  /** Currency code (e.g. "USD"). */
  currency: string;

  /** Whether the estimated cost exceeds the configured threshold. */
  threshold_exceeded: boolean;

  /** Remaining budget after the estimated cost, if known. */
  budget_remaining?: number;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** A delivery target for escalation messages. */
export interface RoutingTarget {
  /** Unique identifier for the target. */
  target_id: string;

  /** Human-readable display name. */
  display_name: string;

  /** Delivery channel identifier (e.g. "slack", "email", "cli"). */
  channel: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Top-level escalation subsystem configuration. */
export interface EscalationConfig {
  /** Routing configuration. */
  routing: {
    /** Whether to use a single default target or per-type advanced routing. */
    mode: RoutingMode;

    /** The default routing target used in "default" mode. */
    default_target: RoutingTarget;

    /** Per-type routing overrides, used only in "advanced" mode. */
    advanced?: Record<
      EscalationType,
      {
        primary: RoutingTarget;
        secondary?: RoutingTarget;
        timeout_minutes: number;
        timeout_behavior: TimeoutBehavior;
      }
    >;
  };

  /** How much detail to include in escalation messages. */
  verbosity: "terse" | "standard" | "verbose";

  /** Maximum number of retries before escalation is forced. */
  retry_budget: number;
}

// ---------------------------------------------------------------------------
// Pipeline behavior (TDD Section 3.2.1)
// ---------------------------------------------------------------------------

/**
 * Pipeline behavior enum that the caller (pipeline orchestrator) acts on
 * after `raise()` returns. Determines how the pipeline should respond
 * to the escalation.
 */
export type PipelineBehavior =
  | "halt_immediately"       // security: stop all execution now
  | "pause_immediately"      // infrastructure: stop at current point
  | "pause_before_incurring" // cost: stop before the costly operation
  | "pause_at_boundary";     // product/technical/quality: stop at next gate

// ---------------------------------------------------------------------------
// Resolved route (output of RoutingEngine)
// ---------------------------------------------------------------------------

/** A fully resolved routing decision including fallback chain. */
export interface ResolvedRoute {
  primary: RoutingTarget;
  secondary?: RoutingTarget;
  timeoutMinutes: number;
  timeoutBehavior: TimeoutBehavior;
}

// ---------------------------------------------------------------------------
// Chain state (managed by EscalationChainManager)
// ---------------------------------------------------------------------------

/** Tracks the lifecycle state of an escalation chain. */
export interface ChainState {
  escalationId: string;
  requestId: string;
  status:
    | "primary_dispatched"
    | "secondary_dispatched"
    | "timeout_behavior_applied"
    | "resolved"
    | "cancelled";
  primaryTarget: RoutingTarget;
  secondaryTarget?: RoutingTarget;
  primaryDispatchedAt: Date;
  secondaryDispatchedAt?: Date;
  timeoutBehavior: TimeoutBehavior;
  timeoutMinutes: number;
}

// ---------------------------------------------------------------------------
// Request context (input to EscalationEngine.raise())
// ---------------------------------------------------------------------------

/** Context about the pipeline request that triggered the escalation. */
export interface RequestContext {
  requestId: string;
  repository: string;
  pipelinePhase: string;
  previousEscalationId?: string;
  retryCount: number;
}

// ---------------------------------------------------------------------------
// Formatter input
// ---------------------------------------------------------------------------

/** All data needed by the formatter to build an EscalationMessage. */
export interface FormatterInput {
  requestId: string;
  repository: string;
  pipelinePhase: string;
  escalationType: EscalationType;
  urgency: EscalationUrgency;
  failureReason: string;
  options: EscalationOption[];
  artifacts?: EscalationArtifact[];
  technicalDetails?: string;
  previousEscalationId?: string;
  retryCount: number;
  costImpact?: CostImpact;
}

// ---------------------------------------------------------------------------
// Escalation result (returned by EscalationEngine.raise())
// ---------------------------------------------------------------------------

/**
 * The result of raising an escalation. Wraps the formatted message with
 * the pipeline behavior that the caller should enforce.
 */
export interface EscalationResult {
  message: EscalationMessage;
  pipelineBehavior: PipelineBehavior;
}

// ---------------------------------------------------------------------------
// Injectable interfaces
// ---------------------------------------------------------------------------

/** Opaque timer handle returned by Timer.setTimeout. */
export type TimerHandle = unknown;

/** Injectable timer interface for deterministic testing. */
export interface Timer {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Delivery adapter for sending escalation messages to humans. */
export interface DeliveryAdapter {
  deliver(message: EscalationMessage, target: RoutingTarget): Promise<void>;
}

/**
 * Audit trail for recording escalation events.
 *
 * Compatible with the trust subsystem's AuditTrail interface.
 */
export interface AuditTrail {
  append(event: {
    event_type: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Config provider
// ---------------------------------------------------------------------------

/**
 * Abstraction over the raw config source for the escalation section.
 */
export interface ConfigProvider {
  getEscalationSection(): Record<string, unknown> | undefined | null;
}

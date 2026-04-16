/**
 * Core type definitions for the trust subsystem.
 *
 * Defines the vocabulary shared across all trust-related subsystems:
 * TrustLevel, PipelineGate, GateAuthority, TrustConfig, and supporting
 * interfaces for change requests, scoring (Phase 3), and configuration.
 *
 * Based on SPEC-009-1-1 (TDD-009 Section 3.1).
 */

// ---------------------------------------------------------------------------
// Core type unions
// ---------------------------------------------------------------------------

/** Trust levels: 0 = no trust (all human), 3 = full trust (all system except security). */
export type TrustLevel = 0 | 1 | 2 | 3;

/** Valid TrustLevel values for runtime validation. */
export const TRUST_LEVELS: readonly TrustLevel[] = [0, 1, 2, 3] as const;

/** The 7 pipeline gates that can require approval. */
export type PipelineGate =
  | "prd_approval"
  | "code_review"
  | "test_review"
  | "deployment_approval"
  | "security_review"
  | "cost_approval"
  | "quality_gate";

/** Authority for a gate check: human must approve, or system auto-approves. */
export type GateAuthority = "human" | "system";

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Returns true if `value` is a valid TrustLevel (0, 1, 2, or 3). */
export function isTrustLevel(value: unknown): value is TrustLevel {
  return (
    typeof value === "number" &&
    (TRUST_LEVELS as readonly number[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Trust level change requests
// ---------------------------------------------------------------------------

export interface TrustLevelChangeRequest {
  requestId: string;
  fromLevel: TrustLevel;
  toLevel: TrustLevel;
  requestedBy: string;
  requestedAt: Date;
  reason: string;
  status: "pending" | "applied" | "rejected";
}

// Phase 3 forward-compatible interface -- no scoring logic implemented yet
export interface TrustScore {
  repositoryId: string;
  currentLevel: TrustLevel;
  score: number; // 0.0 - 1.0, used in Phase 3 for promotion/demotion
  lastUpdated: Date;
  factors: TrustScoreFactor[];
}

export interface TrustScoreFactor {
  name: string;
  weight: number;
  value: number;
}

export interface TrustConfig {
  system_default_level: TrustLevel;
  repositories: Record<string, RepositoryTrustConfig>;
  auto_demotion: AutoDemotionConfig;
  promotion: PromotionConfig;
}

export interface RepositoryTrustConfig {
  default_level: TrustLevel;
}

export interface AutoDemotionConfig {
  enabled: boolean;
  failure_threshold: number;
  window_hours: number;
}

export interface PromotionConfig {
  require_human_approval: true; // Immutable -- always true
  min_successful_runs: number;
  cooldown_hours: number;
}

export interface GateCheckResult {
  gate: PipelineGate;
  authority: GateAuthority;
  effectiveLevel: TrustLevel;
  pendingChangeApplied: boolean;
  securityOverrideRejected: boolean;
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

/** A single audit event emitted by the trust subsystem. */
export interface AuditEvent {
  type: string;
  timestamp: string;
  [key: string]: unknown;
}

/**
 * Minimal audit trail interface used by trust subsystem components.
 * Implementations may write to JSONL, database, or in-memory store.
 */
export interface AuditTrail {
  /** Append an audit event to the trail. */
  append(event: AuditEvent): void;
}

// ---------------------------------------------------------------------------
// Pending change (used by TrustChangeManager)
// ---------------------------------------------------------------------------

export interface PendingChange {
  requestId: string;
  fromLevel: TrustLevel;
  toLevel: TrustLevel;
  status: "pending" | "awaiting_confirmation";
  requestedBy: string;
  requestedAt: Date;
  reason: string;
}

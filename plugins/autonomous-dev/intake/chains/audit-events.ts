/**
 * Chain audit event-type registry (SPEC-022-3-03).
 *
 * Pure declarations: no runtime behavior, no I/O. The map binds each
 * `ChainEventType` to its canonical payload shape so the executor and
 * the writer share a single source of truth (and TypeScript can catch
 * drift at compile time).
 *
 * Distinct from PLAN-019-4's hook-audit event types (which are emitted
 * per-hook by the trust pipeline) — the chain log is a separate file
 * with its own HMAC chain. Cross-correlation (when needed) is left to
 * future tooling.
 *
 * @module intake/chains/audit-events
 */

export type ChainEventType =
  | 'chain_started'
  | 'plugin_invoked'
  | 'plugin_completed'
  | 'plugin_failed'
  | 'artifact_emitted'
  | 'approval_requested'
  | 'approval_granted'
  | 'approval_rejected'
  | 'chain_completed'
  | 'chain_failed';

export interface ChainEventPayloads {
  chain_started: {
    chain_id: string;
    /** Stable name (or topology fingerprint) for this chain definition. */
    chain_name: string;
    /** Triggering plugin id (the seed producer). */
    trigger: string;
    /** All plugin ids in topological order. */
    plugins: string[];
  };
  plugin_invoked: {
    chain_id: string;
    plugin_id: string;
    /** 1-based step index in the chain. */
    step: number;
    /** Artifact types this plugin consumes (manifest-declared). */
    consumes: string[];
  };
  plugin_completed: {
    chain_id: string;
    plugin_id: string;
    step: number;
    duration_ms: number;
  };
  plugin_failed: {
    chain_id: string;
    plugin_id: string;
    step: number;
    error_code: string;
    error_message: string;
  };
  artifact_emitted: {
    chain_id: string;
    producer_plugin_id: string;
    artifact_type: string;
    artifact_id: string;
    /**
     * True iff the artifact carries a `_chain_signature` field
     * (privileged-chain Ed25519 — SPEC-022-3-02). False otherwise.
     */
    signed: boolean;
  };
  approval_requested: {
    chain_id: string;
    /** Stable id of the gate (artifact id of the requires_approval payload). */
    gate_id: string;
    requested_by: string;
    reason: string;
  };
  approval_granted: {
    chain_id: string;
    gate_id: string;
    granted_by: string;
  };
  approval_rejected: {
    chain_id: string;
    gate_id: string;
    rejected_by: string;
    reason: string;
  };
  chain_completed: {
    chain_id: string;
    duration_ms: number;
    /** Number of audit entries emitted for this chain (incl. self). */
    entries: number;
  };
  chain_failed: {
    chain_id: string;
    duration_ms: number;
    /** Stage at which the chain failed: 'seed', 'plugin', 'persist', etc. */
    failure_stage: string;
    error_code: string;
  };
}

/**
 * Wire shape of an emitted entry. Mirrors the on-disk JSONL line.
 */
export interface ChainAuditEntry<
  T extends ChainEventType = ChainEventType,
> {
  ts: string;
  type: T;
  chain_id: string;
  payload: ChainEventPayloads[T];
  /** base64 HMAC of the previous entry; '' for the first entry. */
  prev_hmac: string;
  /** base64 HMAC over canonicalJSON({ts, type, chain_id, payload, prev_hmac}). */
  hmac: string;
}

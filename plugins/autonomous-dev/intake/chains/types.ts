/**
 * Shared types for the chain layer (SPEC-022-1-02 onward).
 *
 * Pure declarations: no runtime behavior, no I/O. Consumed by
 * `ArtifactRegistry` (SPEC-022-1-02), `DependencyGraph` (SPEC-022-1-03),
 * and `ChainExecutor` (SPEC-022-1-04).
 *
 * @module intake/chains/types
 */

/**
 * Pointer to a previously-produced artifact, e.g. when a code-patches
 * artifact references the security-findings artifact it was derived from.
 */
export interface ArtifactRef {
  artifact_type: string;
  scan_id: string;
}

/**
 * Result of `ArtifactRegistry.validate()`.
 *
 * Distinct from the executor's `ValidationResult` (in `intake/hooks/types.ts`)
 * — that one carries hook-validation metadata (timing, direction, schema
 * version fallbacks). This one is purely about artifact-payload schema
 * conformance.
 */
export interface ChainValidationResult {
  isValid: boolean;
  errors: ChainValidationError[];
}

/**
 * One validation failure from the artifact registry.
 *
 * Distinct from the hook-validation `ValidationError` shape so the chain
 * layer is independent of the hook layer.
 */
export interface ChainValidationError {
  /** JSON Pointer into the payload (e.g. `/findings/0/severity`). */
  pointer: string;
  /** Human-readable failure message. */
  message: string;
  /** AJV keyword that failed (e.g. `enum`, `required`). */
  keyword?: string;
}

/**
 * Record returned by `ArtifactRegistry.persist()`.
 *
 * `payload` is the same object the caller passed in (no deep copy); callers
 * who need an immutable view should `structuredClone` it.
 */
export interface ArtifactRecord {
  artifactType: string;
  /** Producer's declared schema_version (informational, may be '?'). */
  schemaVersion: string;
  /** Absolute path to the persisted JSON file. */
  filePath: string;
  payload: unknown;
}

/**
 * Persisted snapshot of a chain that paused waiting for operator approval
 * (SPEC-022-2-03). Written via two-phase commit to
 * `<requestRoot>/.autonomous-dev/chains/<chain-id>.state.json`.
 */
export interface ChainPausedState {
  chain_id: string;
  /** Plugin id that produced the requires_approval artifact. */
  paused_at_plugin: string;
  /** Artifact id (scanId) that is awaiting approval. */
  paused_at_artifact: string;
  /** Artifact type of the paused-at artifact (used to locate the on-disk file). */
  paused_at_artifact_type: string;
  /** Triggering plugin id (so resume() knows the seed scope). */
  triggering_plugin: string;
  /** Remaining plugins still to run after approval (in topological order). */
  remaining_order: string[];
  /** Refs to artifacts persisted before the pause point. */
  artifacts_so_far: ArtifactRef[];
  request_id: string;
  request_root: string;
  paused_timestamp_iso: string;
}

/**
 * Marker file written by `chains approve` (SPEC-022-2-04) and read by
 * `executor.resume()` (SPEC-022-2-03). Sidecar pattern preserves the
 * original artifact bytes for any future signature-verification flow.
 */
export interface ApprovalMarker {
  chain_id: string;
  artifact_id: string;
  approved_by: string;
  approved_timestamp_iso: string;
  notes?: string;
}

/**
 * Marker file written by `chains reject` (SPEC-022-2-04). Distinct from
 * `ApprovalMarker` so the resume path can detect rejection cleanly.
 */
export interface RejectionMarker {
  chain_id: string;
  artifact_id: string;
  rejected_by: string;
  rejected_timestamp_iso: string;
  reason: string;
}

/**
 * Escalation event surfaced via the chain runtime when a chain pauses for
 * approval (SPEC-022-2-03) or completes / fails (SPEC-022-2-04 telemetry).
 *
 * The minimal `EscalationRouter` shape this engine consumes is:
 *   { notify(ev: ChainEscalationEvent): Promise<void> | void }
 * Implementations live elsewhere (PLAN-009 router on prod, in-test stubs in
 * SPEC-022-2-05).
 */
export interface ChainEscalationEvent {
  kind: 'chain-approval-pending';
  chain_id: string;
  artifact_id: string;
  artifact_type: string;
  paused_since: string;
  request_id: string;
}

/** Minimal escalation router interface consumed by ChainExecutor. */
export interface EscalationRouter {
  notify(ev: ChainEscalationEvent): Promise<void> | void;
}

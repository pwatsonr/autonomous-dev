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

// ---------------------------------------------------------------------------
// SPEC-022-3-01: strict-schema consumer boundary + capability scope
// ---------------------------------------------------------------------------

/**
 * Pointer to a consumer plugin's declared inbound capabilities.
 *
 * Built by the executor (or test harness) from the trusted plugin manifest;
 * NEVER supplied by the plugin code itself. The `consumes[]` list is the
 * authoritative source of which artifact types this plugin is permitted to
 * read AND which schema_version the consumer expects to bind to.
 */
export interface ConsumerPluginRef {
  pluginId: string;
  consumes: Array<{
    artifact_type: string;
    /** Semver pattern (e.g. `1.0`, `1.x`). Drives strict-schema lookup. */
    schema_version: string;
    optional?: boolean;
  }>;
}

/**
 * Return shape of `ArtifactRegistry.read()` (SPEC-022-3-01).
 *
 * `payload` is the consumer's view AFTER strict-schema stripping
 * (`removeAdditional: 'all'`), so any field not declared in the consumer's
 * declared `schema_version` is gone. `schema_version` is the CONSUMER's
 * declared version, not the producer's, because that is the contract the
 * consumer is bound to.
 *
 * SPEC-022-3-02 layers HMAC + Ed25519 verification before this point and
 * sanitization after; both reuse this shape.
 */
export interface ValidatedArtifact {
  artifact_type: string;
  schema_version: string;
  payload: Record<string, unknown>;
  producer_plugin_id: string;
  produced_at: string;
}

/**
 * Raised when a plugin attempts to read an artifact_type not declared in
 * its `consumes[]` (SPEC-022-3-01). This is the capability scope check.
 */
export class CapabilityError extends Error {
  readonly code = 'CAPABILITY_DENIED';
  constructor(
    public readonly pluginId: string,
    public readonly artifactType: string,
  ) {
    super(
      `Plugin '${pluginId}' attempted to read artifact_type '${artifactType}' which is not in its declared consumes[].`,
    );
    this.name = 'CapabilityError';
  }
}

/**
 * Raised when a strict-schema validation against the CONSUMER's declared
 * version fails (SPEC-022-3-01). Distinct from `ChainValidationResult` (a
 * value-typed result of the older non-strict `validate()` API) so the
 * read pipeline can `throw`/`catch` it cleanly.
 */
export class SchemaValidationError extends Error {
  readonly code = 'SCHEMA_VALIDATION_FAILED';
  constructor(
    public readonly artifactType: string,
    public readonly schemaVersion: string,
    public readonly errors: unknown[],
  ) {
    super(
      `Artifact ${artifactType}@${schemaVersion} failed strict-schema validation`,
    );
    this.name = 'SchemaValidationError';
  }
}

/**
 * Raised when the schema cache cannot resolve a schema for the
 * `(artifactType, schemaVersion)` pair (SPEC-022-3-01).
 */
export class SchemaNotFoundError extends Error {
  readonly code = 'SCHEMA_NOT_FOUND';
  constructor(
    public readonly artifactType: string,
    public readonly schemaVersion: string,
  ) {
    super(`No schema registered for ${artifactType}@${schemaVersion}`);
    this.name = 'SchemaNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// SPEC-022-3-02: HMAC + Ed25519 signing + sanitization errors
// ---------------------------------------------------------------------------

/**
 * Raised when an artifact on disk has no `_chain_hmac` field. Either the
 * artifact pre-dates SPEC-022-3-02 or it was written by a producer that
 * bypassed `ArtifactRegistry.persist()`.
 */
export class ArtifactUnsignedError extends Error {
  readonly code = 'ARTIFACT_UNSIGNED';
  constructor(
    public readonly artifactType: string,
    public readonly artifactId: string,
  ) {
    super(`Artifact ${artifactType}/${artifactId} has no _chain_hmac (unsigned)`);
    this.name = 'ArtifactUnsignedError';
  }
}

/**
 * Raised when the HMAC over the artifact envelope does not match the
 * stored `_chain_hmac`. Indicates tampering at rest or in transit.
 */
export class ArtifactTamperedError extends Error {
  readonly code = 'ARTIFACT_TAMPERED';
  constructor(
    public readonly artifactType: string,
    public readonly artifactId: string,
  ) {
    super(
      `Artifact ${artifactType}/${artifactId} HMAC mismatch (tampered or wrong key)`,
    );
    this.name = 'ArtifactTamperedError';
  }
}

/**
 * Privileged-chain Ed25519 verification failures. The `reason` field
 * distinguishes the three failure modes a privileged consumer may see.
 */
export class PrivilegedSignatureError extends Error {
  readonly code = 'PRIVILEGED_SIGNATURE_FAILED';
  constructor(
    public readonly artifactType: string,
    public readonly artifactId: string,
    public readonly reason: 'missing' | 'invalid' | 'unknown_producer',
  ) {
    super(
      `Artifact ${artifactType}/${artifactId} privileged signature ${reason}`,
    );
    this.name = 'PrivilegedSignatureError';
  }
}

/**
 * Raised by the artifact sanitizer when a string field violates a
 * format-driven content rule (path traversal, non-https URI, shell
 * metacharacter in a default-deny field).
 */
export class SanitizationError extends Error {
  readonly code = 'SANITIZATION_FAILED';
  constructor(
    public readonly artifactType: string,
    public readonly fieldPath: string,
    public readonly rule:
      | 'path-traversal'
      | 'absolute-path-outside-worktree'
      | 'non-https-uri'
      | 'shell-metacharacter',
    public readonly offendingValue: string,
  ) {
    super(
      `Artifact ${artifactType} field '${fieldPath}' violated ${rule}: ${truncate(offendingValue, 80)}`,
    );
    this.name = 'SanitizationError';
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

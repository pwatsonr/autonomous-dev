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

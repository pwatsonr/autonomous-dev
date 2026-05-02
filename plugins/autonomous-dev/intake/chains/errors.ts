/**
 * Chain error hierarchy (SPEC-022-2-01 onward).
 *
 * Each error subclass extends `ChainError` and carries the structured
 * fields needed for the chain-runtime telemetry envelope, the failure-mode
 * resolver (SPEC-022-2-02), and the operator-facing CLI surface
 * (SPEC-022-2-04).
 *
 * `toJSON()` is provided so `JSON.stringify(err)` emits all custom fields
 * (Error subclasses serialize to `{}` by default).
 *
 * @module intake/chains/errors
 */

/**
 * Base class for every chain-layer error. Distinct from `CycleError`
 * (which lives in cycle-error.ts and predates this hierarchy) so the
 * dependency-graph layer remains independent of resource-limit semantics.
 */
export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainError';
  }

  /** Default serialization includes name + message; subclasses override. */
  toJSON(): Record<string, unknown> {
    return { name: this.name, message: this.message };
  }
}

/**
 * Raised when a plugin invocation exceeds its per-plugin timeout
 * (SPEC-022-2-01).
 */
export class PluginTimeoutError extends ChainError {
  constructor(
    public readonly plugin_id: string,
    public readonly timeout_ms: number,
    public readonly chain_id: string,
  ) {
    super(
      `Plugin "${plugin_id}" exceeded ${timeout_ms}ms timeout in chain ${chain_id}`,
    );
    this.name = 'PluginTimeoutError';
  }

  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      plugin_id: this.plugin_id,
      timeout_ms: this.timeout_ms,
      chain_id: this.chain_id,
    };
  }
}

/**
 * Raised before chain execution when the topological-sort length exceeds
 * `chains.max_length` (SPEC-022-2-02).
 */
export class ChainTooLongError extends ChainError {
  public readonly chain_path: readonly string[];
  constructor(chain_path: readonly string[], public readonly max_length: number) {
    super(
      `Chain length ${chain_path.length} exceeds max_length=${max_length}: ${chain_path.join(' -> ')}`,
    );
    this.name = 'ChainTooLongError';
    this.chain_path = Object.freeze([...chain_path]);
  }

  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      chain_path: [...this.chain_path],
      max_length: this.max_length,
    };
  }
}

/**
 * Raised inside `ArtifactRegistry.persist()` when the JSON-serialized
 * artifact size exceeds `chains.max_artifact_size_mb` (SPEC-022-2-02).
 */
export class ArtifactTooLargeError extends ChainError {
  constructor(
    public readonly artifact_id: string,
    public readonly producer_id: string,
    public readonly size_bytes: number,
    public readonly max_bytes: number,
  ) {
    super(
      `Artifact ${artifact_id} from ${producer_id} is ${size_bytes}B, exceeds cap ${max_bytes}B`,
    );
    this.name = 'ArtifactTooLargeError';
  }

  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      artifact_id: this.artifact_id,
      producer_id: this.producer_id,
      size_bytes: this.size_bytes,
      max_bytes: this.max_bytes,
    };
  }
}

/**
 * Raised at the executor entry point when starting the chain would push
 * the active-chain counter past `chains.max_concurrent_chains`
 * (SPEC-022-2-02).
 */
export class ConcurrentChainLimitError extends ChainError {
  constructor(
    public readonly active_count: number,
    public readonly cap: number,
  ) {
    super(`Cannot start chain: ${active_count} chains active, cap=${cap}`);
    this.name = 'ConcurrentChainLimitError';
  }

  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      active_count: this.active_count,
      cap: this.cap,
    };
  }
}

/**
 * Raised when `TrustValidator.isTrusted()` returns `{trusted: false}` for
 * a plugin in the chain (SPEC-022-2-04).
 */
export class TrustValidationError extends ChainError {
  constructor(
    public readonly plugin_id: string,
    public readonly reason: string,
  ) {
    super(`Plugin "${plugin_id}" failed trust validation: ${reason}`);
    this.name = 'TrustValidationError';
  }

  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      plugin_id: this.plugin_id,
      reason: this.reason,
    };
  }
}

/**
 * Raised before chain execution when the chain consumes a
 * `requires_approval` artifact but no allowlist entry in
 * `extensions.privileged_chains` matches the producer/consumer pair
 * (SPEC-022-2-04).
 */
export class PrivilegedChainNotAllowedError extends ChainError {
  public readonly plugin_ids: readonly string[];
  public readonly versions: readonly string[];
  constructor(plugin_ids: readonly string[], versions: readonly string[]) {
    super(
      `Privileged chain not in allowlist: ${plugin_ids.join(' -> ')}`,
    );
    this.name = 'PrivilegedChainNotAllowedError';
    this.plugin_ids = Object.freeze([...plugin_ids]);
    this.versions = Object.freeze([...versions]);
  }

  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      plugin_ids: [...this.plugin_ids],
      versions: [...this.versions],
    };
  }
}

/**
 * Raised by `executor.resume()` when no state file exists for the
 * supplied chain id (SPEC-022-2-03).
 */
export class ChainStateMissingError extends ChainError {
  constructor(public readonly chain_id: string) {
    super(`No paused state found for chain ${chain_id}`);
    this.name = 'ChainStateMissingError';
  }

  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      chain_id: this.chain_id,
    };
  }
}

/**
 * Raised by `executor.resume()` when the `.approved.json` marker for
 * the paused-at artifact is missing (SPEC-022-2-03).
 */
export class ChainNotApprovedError extends ChainError {
  constructor(
    public readonly chain_id: string,
    public readonly artifact_id: string,
  ) {
    super(
      `Chain ${chain_id} cannot resume: artifact ${artifact_id} not approved`,
    );
    this.name = 'ChainNotApprovedError';
  }

  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      chain_id: this.chain_id,
      artifact_id: this.artifact_id,
    };
  }
}

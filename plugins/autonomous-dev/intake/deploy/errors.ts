/**
 * Deploy-layer error hierarchy (PLAN-023-1).
 *
 * Mirrors the structural conventions of `intake/chains/errors.ts`: a
 * common `DeployError` base whose `toJSON()` emits the structured fields
 * needed for telemetry and operator-facing CLI output, plus targeted
 * subclasses for the specific failure modes the registry, parameter
 * validator, signer, and backends raise.
 *
 * @module intake/deploy/errors
 */

/** Base class for every deploy-layer error. */
export class DeployError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeployError';
  }

  /** Default serialization includes name + message; subclasses override. */
  toJSON(): Record<string, unknown> {
    return { name: this.name, message: this.message };
  }
}

/** Raised by `validateParameters` when one or more values fail validation. */
export class ParameterValidationError extends DeployError {
  public readonly errors: readonly { key: string; message: string }[];
  constructor(errors: readonly { key: string; message: string }[]) {
    super(
      `parameter validation failed: ${errors
        .map((e) => `${e.key}: ${e.message}`)
        .join('; ')}`,
    );
    this.name = 'ParameterValidationError';
    this.errors = Object.freeze([...errors]);
  }
  override toJSON(): Record<string, unknown> {
    return { name: this.name, message: this.message, errors: [...this.errors] };
  }
}

/** Raised by `verifyDeploymentRecord` when the record's HMAC does not match. */
export class DeploymentRecordVerificationError extends DeployError {
  constructor(public readonly deployId: string, reason: string) {
    super(`deployment record ${deployId} failed verification: ${reason}`);
    this.name = 'DeploymentRecordVerificationError';
  }
  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      deployId: this.deployId,
    };
  }
}

/** Raised by `loadDeployKey` when the on-disk key file has insecure perms. */
export class InsecureKeyPermissionsError extends DeployError {
  constructor(public readonly keyPath: string, public readonly mode: number) {
    super(
      `deploy key at ${keyPath} has insecure permissions: 0o${mode.toString(
        8,
      )} (expected 0o600)`,
    );
    this.name = 'InsecureKeyPermissionsError';
  }
  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      keyPath: this.keyPath,
      mode: this.mode,
    };
  }
}

/** Raised by `BackendRegistry.get` when no backend is registered under `name`. */
export class BackendNotFoundError extends DeployError {
  constructor(public readonly backendName: string) {
    super(`backend not registered: ${backendName}`);
    this.name = 'BackendNotFoundError';
  }
  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      backendName: this.backendName,
    };
  }
}

/**
 * Raised by `loadConfig` when `deploy.yaml` exists but is malformed or
 * fails JSON-Schema validation (SPEC-023-2-01).
 */
export class ConfigValidationError extends DeployError {
  public readonly errors: readonly { pointer: string; message: string }[];
  constructor(
    message: string,
    public readonly configPath: string,
    public readonly line: number | null,
    errors: readonly { pointer: string; message: string }[],
  ) {
    super(message);
    this.name = 'ConfigValidationError';
    this.errors = Object.freeze([...errors]);
  }
  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      configPath: this.configPath,
      line: this.line,
      errors: [...this.errors],
    };
  }
}

/**
 * Raised by `resolveEnvironment` when the requested env is not declared
 * in the loaded `DeployConfig` (SPEC-023-2-01).
 */
export class UnknownEnvironmentError extends DeployError {
  constructor(
    public readonly envName: string,
    public readonly available: readonly string[],
  ) {
    super(
      `unknown environment '${envName}'; available: ${available.join(', ') || '(none)'}`,
    );
    this.name = 'UnknownEnvironmentError';
  }
  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      envName: this.envName,
      available: [...this.available],
    };
  }
}

/**
 * Raised by `BackendSelector` when the chosen backend name is not
 * registered (SPEC-023-2-02). Carries the available list so the error
 * is actionable.
 */
export class UnknownBackendError extends DeployError {
  constructor(
    public readonly requested: string,
    public readonly available: readonly string[],
  ) {
    super(
      `Backend '${requested}' is not registered. Available: ${available.join(', ') || '(none)'}`,
    );
    this.name = 'UnknownBackendError';
  }
  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      requested: this.requested,
      available: [...this.available],
    };
  }
}

/**
 * Raised when an approval-state file's HMAC chain does not verify
 * (SPEC-023-2-03 tamper detection).
 */
export class ApprovalChainError extends DeployError {
  constructor(
    public readonly deployId: string,
    public readonly entryIndex: number,
    reason: string,
  ) {
    super(
      `approval chain verification failed for deploy ${deployId} at entry ${entryIndex}: ${reason}`,
    );
    this.name = 'ApprovalChainError';
  }
  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      deployId: this.deployId,
      entryIndex: this.entryIndex,
    };
  }
}

/** Raised when the same approver attempts to record two approvals on a two-person gate. */
export class DuplicateApproverError extends DeployError {
  constructor(public readonly deployId: string, public readonly approver: string) {
    super(
      `approver '${approver}' has already recorded a decision for deploy ${deployId}`,
    );
    this.name = 'DuplicateApproverError';
  }
  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      deployId: this.deployId,
      approver: this.approver,
    };
  }
}

/** Raised when an `approval: "admin"` requirement gets an operator-role approve. */
export class AdminRequiredError extends DeployError {
  constructor(public readonly deployId: string, public readonly approver: string) {
    super(
      `deploy ${deployId} requires admin role; approver '${approver}' has insufficient role`,
    );
    this.name = 'AdminRequiredError';
  }
  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      deployId: this.deployId,
      approver: this.approver,
    };
  }
}

/** Raised when the per-env cost cap is exceeded (SPEC-023-2-04). */
export class CostCapExceededError extends DeployError {
  constructor(public readonly reason: string) {
    super(`cost cap exceeded: ${reason}`);
    this.name = 'CostCapExceededError';
  }
  override toJSON(): Record<string, unknown> {
    return { name: this.name, message: this.message, reason: this.reason };
  }
}

/** Raised by external-tool wrappers (`runTool`) on non-zero exit. */
export class ExternalToolError extends DeployError {
  constructor(
    public readonly cmd: string,
    public readonly args: readonly string[],
    public readonly exitCode: number,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(
      `${cmd} ${args.join(' ')} exited with code ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
    this.name = 'ExternalToolError';
  }
  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      cmd: this.cmd,
      args: [...this.args],
      exitCode: this.exitCode,
      stdout: this.stdout,
      stderr: this.stderr,
    };
  }
}

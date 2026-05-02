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

/**
 * Translate AWS SDK errors into structured `CloudDeployError` codes
 * (SPEC-024-1-02 §"Error mapping"). Centralised so every helper
 * (`ecr-builder`, `ecs-deployer`, `health-checker`) reports identical
 * codes for the same SDK error class.
 *
 * @module @autonomous-dev/deploy-aws/error-mapper
 */

import { CloudDeployError } from '../../autonomous-dev/intake/deploy/errors';

/** AWS SDK errors expose `name` (or `Code`) plus optional `$metadata`. */
interface AwsSdkLikeError {
  name?: string;
  Code?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
  code?: string;
}

/**
 * Translate `err` into a categorised `CloudDeployError`. Always returns
 * a fresh error with `cause` set to the original.
 */
export function mapAwsError(err: unknown, operation: string): CloudDeployError {
  const e = err as AwsSdkLikeError;
  const name = e?.name ?? e?.Code ?? '';
  const message = e?.message ?? String(err);

  if (
    name === 'AccessDeniedException' ||
    name === 'UnauthorizedOperation' ||
    name === 'InvalidSignatureException' ||
    name === 'ExpiredTokenException'
  ) {
    return new CloudDeployError('AUTH_FAILED', 'aws', operation, false, message, err);
  }
  if (name === 'ThrottlingException' || name === 'RequestLimitExceeded' || name === 'TooManyRequestsException') {
    return new CloudDeployError('RATE_LIMIT', 'aws', operation, true, message, err);
  }
  if (name === 'ServiceQuotaExceededException' || name === 'LimitExceededException') {
    return new CloudDeployError('QUOTA_EXCEEDED', 'aws', operation, true, message, err);
  }
  if (
    name === 'ResourceNotFoundException' ||
    name === 'ServiceNotFoundException' ||
    name === 'ClusterNotFoundException' ||
    name === 'TargetGroupNotFoundException' ||
    name === 'RepositoryNotFoundException'
  ) {
    return new CloudDeployError('NOT_FOUND', 'aws', operation, false, message, err);
  }
  const errno = e?.code;
  if (errno === 'ETIMEDOUT' || errno === 'ECONNRESET' || errno === 'ENOTFOUND' || errno === 'ECONNREFUSED') {
    return new CloudDeployError('NETWORK', 'aws', operation, true, message, err);
  }
  return new CloudDeployError('UNKNOWN', 'aws', operation, false, message, err);
}

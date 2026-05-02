/**
 * Translate Azure SDK errors into structured `CloudDeployError` codes
 * (SPEC-024-1-03 §"Error mapping"). Centralised so every helper
 * (`acr-builder`, `container-apps-deployer`, `front-door-health-prober`)
 * reports identical codes for the same SDK error class.
 *
 * @module @autonomous-dev/deploy-azure/error-mapper
 */

import { CloudDeployError } from '../../autonomous-dev/intake/deploy/errors';

interface AzureSdkLikeError {
  code?: string;
  name?: string;
  statusCode?: number;
  message?: string;
}

/** Map an Azure SDK error onto a categorised `CloudDeployError`. */
export function mapAzureError(err: unknown, operation: string): CloudDeployError {
  const e = err as AzureSdkLikeError;
  const code = e?.code ?? e?.name ?? '';
  const status = e?.statusCode ?? 0;
  const message = e?.message ?? String(err);

  if (
    code === 'AuthenticationFailed' ||
    code === 'InvalidAuthenticationToken' ||
    code === 'ExpiredAuthenticationToken' ||
    status === 401 ||
    status === 403
  ) {
    return new CloudDeployError('AUTH_FAILED', 'azure', operation, false, message, err);
  }
  if (code === 'Throttled' || code === 'TooManyRequests' || status === 429) {
    return new CloudDeployError('RATE_LIMIT', 'azure', operation, true, message, err);
  }
  if (code === 'QuotaExceeded' || code === 'SubscriptionQuotaReached') {
    return new CloudDeployError('QUOTA_EXCEEDED', 'azure', operation, true, message, err);
  }
  if (code === 'ResourceNotFound' || status === 404) {
    return new CloudDeployError('NOT_FOUND', 'azure', operation, false, message, err);
  }
  if (code === 'Conflict' || status === 409) {
    return new CloudDeployError('RESOURCE_CONFLICT', 'azure', operation, false, message, err);
  }
  const errno = (err as { code?: string })?.code;
  if (errno === 'ETIMEDOUT' || errno === 'ECONNRESET' || errno === 'ENOTFOUND' || errno === 'ECONNREFUSED') {
    return new CloudDeployError('NETWORK', 'azure', operation, true, message, err);
  }
  return new CloudDeployError('UNKNOWN', 'azure', operation, false, message, err);
}

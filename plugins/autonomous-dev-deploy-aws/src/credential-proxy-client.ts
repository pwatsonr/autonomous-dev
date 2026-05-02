/**
 * AWS-side `CredentialProxy` consumer wrapper (SPEC-024-1-02).
 *
 * Converts a `ScopedCredential` returned by the proxy into the SDK
 * options object every `@aws-sdk/client-*` constructor accepts:
 * `{ credentials: { accessKeyId, secretAccessKey, sessionToken } }`.
 *
 * Centralised so AWSBackend never touches credential fields directly.
 *
 * @module @autonomous-dev/deploy-aws/credential-proxy-client
 */

import type {
  CredentialProxy,
  ResourceScope,
  ScopedCredential,
} from '../../autonomous-dev/intake/deploy/credential-proxy-types';

/**
 * Subset of the `@aws-sdk/types` `Credentials` shape relevant here.
 * Defined inline so this module does not depend on the AWS SDK at
 * compile time (the SDKs live in this plugin's own node_modules).
 */
export interface AwsSdkCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** AWS SDK client-options object accepted by every `@aws-sdk/client-*`. */
export interface AwsClientOptions {
  region: string;
  credentials: AwsSdkCredentials;
}

/**
 * Build AWS SDK client options from a proxy-issued credential.
 * Throws when `cred.awsCredentials` is unset.
 */
export function toAwsClientOptions(
  cred: ScopedCredential,
  region: string,
): AwsClientOptions {
  if (cred.cloud !== 'aws') {
    throw new Error(`toAwsClientOptions: expected cloud=aws, got ${cred.cloud}`);
  }
  const aws = cred.awsCredentials;
  if (!aws) {
    throw new Error('toAwsClientOptions: cred.awsCredentials is missing');
  }
  return {
    region,
    credentials: {
      accessKeyId: aws.accessKeyId,
      secretAccessKey: aws.secretAccessKey,
      sessionToken: aws.sessionToken,
    },
  };
}

/** Convenience: acquire + convert in one call. */
export async function acquireAwsClientOptions(
  proxy: CredentialProxy,
  operationName: string,
  scope: ResourceScope,
  region: string,
): Promise<{ cred: ScopedCredential; clientOptions: AwsClientOptions }> {
  const cred = await proxy.acquire('aws', operationName, scope);
  return { cred, clientOptions: toAwsClientOptions(cred, region) };
}

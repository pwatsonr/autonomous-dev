/**
 * `awsPolicyFor` — pure (operation, scope) → IAM policy generator
 * (SPEC-024-2-02).
 *
 * Defense-in-depth note: this generator emits the inline session policy
 * passed to STS `AssumeRole`. STS evaluates it as the **upper bound** on
 * what the assumed role can do. Widening this output by mistake widens
 * the credential's reach. The snapshot tests in
 * `tests/cred-proxy/__snapshots__/aws-policies.snap` lock in the exact
 * policy shape so any diff in this file fails CI without an explicit
 * snapshot regeneration.
 *
 * @module intake/cred-proxy/scopers/aws-policy-for
 */

import { AWS_OPERATIONS } from './operation-catalog';

export interface IamPolicy {
  Version: '2012-10-17';
  Statement: Array<{
    Effect: 'Allow';
    Action: readonly string[];
    Resource: string;
  }>;
}

/**
 * Build the inline session policy for one operation. Throws when the
 * operation is unknown OR a required scope key is missing/empty.
 */
export function awsPolicyFor(
  operation: string,
  scope: Record<string, string>,
): IamPolicy {
  const spec = AWS_OPERATIONS[operation];
  if (!spec) {
    throw new Error(`unknown AWS operation: ${operation}`);
  }
  for (const key of spec.requiredScopeKeys) {
    if (!scope[key]) {
      throw new Error(
        `missing required scope key '${key}' for ${operation}`,
      );
    }
  }
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: spec.actions,
        Resource: spec.resourceArn(scope),
      },
    ],
  };
}

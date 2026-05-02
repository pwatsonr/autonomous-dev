/**
 * In-memory identity helper for SPEC-023-2 tests. Forges PLAN-019-3
 * approver identities without booting the real verifier.
 *
 * @module tests/deploy/helpers/test-identity
 */

import type { ApproverRole } from '../../../intake/deploy/approval-types';

export interface TestApprover {
  email: string;
  role: ApproverRole;
}

export function makeApprover(email: string, role: ApproverRole): TestApprover {
  return { email, role };
}

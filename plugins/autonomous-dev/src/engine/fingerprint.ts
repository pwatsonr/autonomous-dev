/**
 * SHA-256 fingerprint generation (SPEC-007-3-3, Task 6).
 *
 * Produces a deterministic hex fingerprint from the structural components
 * of a candidate observation:
 *
 *   `service | error_class | endpoint | error_code | normalized_top_3_stack_frames`
 *
 * The fingerprint is used by the deduplication engine to identify
 * duplicate observations across runs.
 */

import { createHash } from 'crypto';

import type { CandidateObservation } from './types';
import { normalizeStackTrace, extractStackTrace } from './stack-normalizer';

// ---------------------------------------------------------------------------
// Fingerprint generation
// ---------------------------------------------------------------------------

/**
 * Generates a SHA-256 hex fingerprint for a candidate observation.
 *
 * Components are joined with `|` and hashed in the following order:
 *   1. `service`          -- e.g., "api-gateway"
 *   2. `error_class`      -- e.g., "ConnectionPoolExhausted" (default: "unknown")
 *   3. `endpoint`         -- e.g., "/api/v2/orders" (default: "*")
 *   4. `error_code`       -- e.g., "503" (default: "")
 *   5. `normalizedStack`  -- Top 3 normalized stack frames (default: "")
 *
 * @returns 64-character lowercase hex SHA-256 digest
 */
export function generateFingerprint(candidate: CandidateObservation): string {
  const normalizedStack =
    candidate.log_samples.length > 0
      ? normalizeStackTrace(extractStackTrace(candidate.log_samples))
      : '';

  const components = [
    candidate.service,
    candidate.error_class ?? 'unknown',
    candidate.endpoint ?? '*',
    String(candidate.error_code ?? ''),
    normalizedStack,
  ].join('|');

  return createHash('sha256').update(components).digest('hex');
}

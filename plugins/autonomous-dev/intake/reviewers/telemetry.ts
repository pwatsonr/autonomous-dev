/**
 * Reviewer telemetry emission (SPEC-020-2-04, Task 9).
 *
 * Wraps the TDD-007 metrics pipeline with a fire-and-forget envelope so
 * the runner is never blocked by metrics I/O and never crashes when the
 * pipeline is unavailable.
 *
 * Payload shape (locked by SPEC-020-2-04 — exactly six fields):
 *   { reviewer, request_id, gate, score, verdict, duration_ms }
 *
 * `error_message` is intentionally omitted even on ERROR verdicts:
 * errors may contain repo paths or token snippets in pathological
 * cases. Detailed error info goes to the per-reviewer `findings` object
 * stored in the gate-output file (gated by repo permissions).
 *
 * @module intake/reviewers/telemetry
 */

import type { ReviewerVerdict } from './types';

/**
 * Telemetry log entry shape. Lock contract for downstream consumers
 * (dashboards, alert rules) — extra fields would break parsers and
 * are deliberately disallowed (`extras` removed even at the type
 * level).
 */
export interface ReviewerInvocationLog {
  reviewer: string;
  request_id: string;
  gate: string;
  score: number | null;
  verdict: ReviewerVerdict;
  duration_ms: number;
}

/**
 * Optional metrics-client surface. Production wires this to TDD-007's
 * MetricsClient. Tests inject a recording mock. When unset (undefined),
 * `emitReviewerInvocation` becomes a no-op so the runner remains usable
 * in environments without the metrics pipeline (e.g., unit tests, ad-hoc
 * CLI runs).
 */
export interface ReviewerMetricsClient {
  emit(channel: string, payload: ReviewerInvocationLog): Promise<void> | void;
}

const TELEMETRY_CHANNEL = 'reviewer.invocation';

let activeClient: ReviewerMetricsClient | undefined;

/**
 * Wire (or replace) the active metrics client. Called once at process
 * boot by the orchestrator wiring; tests call this in beforeEach to
 * install a mock and in afterEach to clear it.
 */
export function setReviewerMetricsClient(client: ReviewerMetricsClient | undefined): void {
  activeClient = client;
}

/** Test/diagnostic accessor; production code should not rely on this. */
export function getReviewerMetricsClient(): ReviewerMetricsClient | undefined {
  return activeClient;
}

/**
 * Emit one reviewer-invocation log entry.
 *
 * Fire-and-forget contract:
 *   - Never throws.
 *   - Never blocks the caller (uses queueMicrotask to defer the
 *     underlying emit so even a sync metrics implementation does
 *     not block the runner's hot path).
 *   - A pipeline failure is swallowed silently. If observability of
 *     telemetry-failures is needed in the future, that should hook
 *     into the metrics pipeline itself, not the runner.
 *
 * Idempotency for `(reviewer, request_id, gate)` triples is the
 * metrics pipeline's responsibility; this function does not dedupe.
 */
export function emitReviewerInvocation(log: ReviewerInvocationLog): void {
  const client = activeClient;
  if (client === undefined) return;
  // Defer to the next microtask so a synchronous client cannot block
  // the runner's per-reviewer wrap-up.
  queueMicrotask(() => {
    try {
      const result = client.emit(TELEMETRY_CHANNEL, log);
      if (result instanceof Promise) {
        result.catch(() => {
          // Swallow: telemetry failures must not affect reviewer flow.
        });
      }
    } catch {
      // Swallow synchronous throws too.
    }
  });
}

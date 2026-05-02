/**
 * Cost-ledger entry / aggregate types (SPEC-023-3-03).
 *
 * Distinct from `intake/deploy/cost-cap.ts` which carries the per-env,
 * per-request `CostLedger` JSON used by SPEC-023-2-04. This module owns
 * the daily/monthly HMAC-chained NDJSON ledger stored at
 * `~/.autonomous-dev/deploy-cost-ledger.jsonl` (TDD-023 §14). Both
 * subsystems coexist and are checked in series by the deploy entrypoint.
 *
 * Cross-reference: TDD-023 §14, SPEC-023-3-03.
 *
 * @module intake/deploy/cost-ledger-types
 */

/** Number of zero-hex chars used for the genesis `prev_hmac`. */
export const GENESIS_PREV_HMAC = '0'.repeat(64);

/**
 * One line in `deploy-cost-ledger.jsonl`. The HMAC is computed over
 * `prev_hmac || canonicalJSON(entry without `hmac`)` per the audit-writer
 * pattern (PLAN-019-4); see `cost-ledger.ts` for the algorithm.
 */
export interface CostLedgerEntry {
  /** ULID of the deploy this entry belongs to. */
  deployId: string;
  /** Environment name (e.g., "prod", "stage"). */
  env: string;
  /** Backend name (matches `BackendMetadata.name`). */
  backend: string;
  /** Pre-deploy estimate in USD. Required on every entry. */
  estimated_cost_usd: number;
  /** Post-deploy actual in USD. Present on follow-up reconciliation entries. */
  actual_cost_usd?: number;
  /** ISO 8601 timestamp with millisecond precision. */
  timestamp: string;
  /** Hex of prior entry's hmac (or 64 zero hex chars for the genesis entry). */
  prev_hmac: string;
  /** HMAC-SHA256 of `prev_hmac || canonicalJSON(entry without `hmac`)`. */
  hmac: string;
}

/** Result of `CostLedger.aggregate(...)`. */
export interface DailyAggregate {
  /** Sum of `estimated_cost_usd` for entries inside the window. */
  totalEstimated: number;
  /** Sum of `actual_cost_usd` (when present) for entries inside the window. */
  totalActual: number;
  /** Sum of estimated for deploys whose actuals have NOT been reconciled. */
  openEstimates: number;
  /** Per-environment totals (estimated + actual reconciled). */
  byEnv: Record<string, number>;
  /** Per-backend totals (estimated + actual reconciled). */
  byBackend: Record<string, number>;
  /** Number of distinct deploy ids inside the window. */
  entryCount: number;
}

/** Window selector accepted by `CostLedger.aggregate(...)`. */
export type AggregateWindow = 'day' | 'month';

/**
 * Single-use admin override for the 110% threshold. Tokens are written
 * by an admin into `~/.autonomous-dev/deploy-cap-overrides.json`; this
 * spec only consumes them.
 */
export interface AdminOverrideRecord {
  actor: string;
  deployId: string;
  /** ISO 8601 expiry (UTC). */
  expires_at: string;
}

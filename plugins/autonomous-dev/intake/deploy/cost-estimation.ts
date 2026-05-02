/**
 * Shared cost-estimation types (SPEC-024-3-03).
 *
 * The four cloud backends (AWS, GCP, Azure, K8s) implement
 * `CostEstimator<P>` against their own deploy-parameter shape. The
 * deploy orchestrator and `deploy estimate` CLI consume the resulting
 * `EstimateResult`.
 *
 * @module intake/deploy/cost-estimation
 */

/** One row of an estimate's breakdown — operator-facing detail. */
export interface LineItem {
  /** Human label, e.g. "Fargate vCPU-hours". */
  label: string;
  /** Quantity, e.g. 1.0. */
  quantity: number;
  /** Unit, e.g. "vCPU-hour". */
  unit: string;
  /** USD price per unit. */
  unit_price_usd: number;
  /** Pre-computed subtotal: quantity * unit_price_usd, included for
   *  audit-trail clarity (no divergence between `breakdown` and the total). */
  subtotal_usd: number;
}

/**
 * Full estimate shape returned by every cloud backend's
 * `estimateDeployCost`. `confidence` ∈ [0,1]: 1.0 = fixed-price model,
 * 0.0 = no idea (K8s clusters). The total MUST equal the sum of
 * `breakdown[*].subtotal_usd`.
 */
export interface EstimateResult {
  estimated_cost_usd: number;
  currency: 'USD';
  breakdown: LineItem[];
  confidence: number;
  notes?: string;
}

/** Generic cost-estimator contract; `P` is the backend's params shape. */
export interface CostEstimator<P> {
  estimateDeployCost(params: P): Promise<EstimateResult>;
}

/**
 * Build a `LineItem` and compute its subtotal in one call. Avoids the
 * arithmetic-divergence class of bug where `subtotal` is hand-computed
 * differently from the formula in the heuristic.
 */
export function lineItem(
  label: string,
  quantity: number,
  unit: string,
  unitPriceUsd: number,
): LineItem {
  return {
    label,
    quantity,
    unit,
    unit_price_usd: unitPriceUsd,
    subtotal_usd: quantity * unitPriceUsd,
  };
}

/** Sum the subtotals of a breakdown. */
export function sumBreakdown(breakdown: LineItem[]): number {
  let total = 0;
  for (const item of breakdown) total += item.subtotal_usd;
  return total;
}

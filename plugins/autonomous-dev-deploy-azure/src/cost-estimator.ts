/**
 * Azure Container Apps cost estimator (SPEC-024-3-03).
 *
 * Mirrors the GCP shape with Azure pricing constants.
 * Confidence 0.6 — request volume is operator-supplied.
 *
 * @module @autonomous-dev/deploy-azure/cost-estimator
 */

import {
  type CostEstimator,
  type EstimateResult,
  lineItem,
  sumBreakdown,
} from '../../autonomous-dev/intake/deploy/cost-estimation';
import {
  type AzureEstimateParams,
  PRICING,
} from '../../autonomous-dev/intake/deploy/pricing-fixtures';

export class AzureCostEstimator implements CostEstimator<AzureEstimateParams> {
  async estimateDeployCost(params: AzureEstimateParams): Promise<EstimateResult> {
    const p = PRICING.azure;
    const requestsM = params.expected_requests / 1_000_000;
    const breakdown = [
      lineItem(
        'Container Apps requests',
        requestsM,
        'million-requests',
        p.container_apps_request_per_million_usd,
      ),
      lineItem(
        'Container Apps vCPU-seconds',
        params.vcpu * params.vcpu_seconds,
        'vCPU-second',
        p.container_apps_vcpu_second_usd,
      ),
      lineItem(
        'Container Apps memory GiB-seconds',
        params.gib * params.gib_seconds,
        'GiB-second',
        p.container_apps_gib_second_usd,
      ),
    ];
    return {
      estimated_cost_usd: sumBreakdown(breakdown),
      currency: 'USD',
      breakdown,
      confidence: 0.6,
      notes: 'Excludes data transfer; consumption-plan only.',
    };
  }
}

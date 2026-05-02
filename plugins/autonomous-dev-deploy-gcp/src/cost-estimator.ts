/**
 * GCP Cloud Run cost estimator (SPEC-024-3-03).
 *
 * Confidence 0.65 — request volume is operator-supplied; the free tier
 * (2M requests/month) is not subtracted; assumes always-on.
 *
 * @module @autonomous-dev/deploy-gcp/cost-estimator
 */

import {
  type CostEstimator,
  type EstimateResult,
  lineItem,
  sumBreakdown,
} from '../../autonomous-dev/intake/deploy/cost-estimation';
import {
  type GcpEstimateParams,
  PRICING,
} from '../../autonomous-dev/intake/deploy/pricing-fixtures';

export class GcpCostEstimator implements CostEstimator<GcpEstimateParams> {
  async estimateDeployCost(params: GcpEstimateParams): Promise<EstimateResult> {
    const p = PRICING.gcp;
    const requestsM = params.expected_requests / 1_000_000;
    const breakdown = [
      lineItem(
        'Cloud Run requests',
        requestsM,
        'million-requests',
        p.cloud_run_request_per_million_usd,
      ),
      lineItem(
        'Cloud Run vCPU-seconds',
        params.vcpu * params.vcpu_seconds,
        'vCPU-second',
        p.cloud_run_vcpu_second_usd,
      ),
      lineItem(
        'Cloud Run memory GiB-seconds',
        params.gib * params.gib_seconds,
        'GiB-second',
        p.cloud_run_gib_second_usd,
      ),
    ];
    return {
      estimated_cost_usd: sumBreakdown(breakdown),
      currency: 'USD',
      breakdown,
      confidence: 0.65,
      notes: 'Free tier (2M requests/month) not subtracted; assumes always-on.',
    };
  }
}

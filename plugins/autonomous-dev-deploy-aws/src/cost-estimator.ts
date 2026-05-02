/**
 * AWS cost estimator (SPEC-024-3-03).
 *
 * Heuristic:
 *   fargate_cost = tasks * vcpu * vcpu_hours * fargate_vcpu_hour_usd
 *                + tasks * memory_gb * vcpu_hours * fargate_gb_hour_usd
 *   ecr_cost     = image_size_gb * ecr_storage_gb_month_usd * (run_hours / 730)
 *
 * Confidence 0.85 — Fargate is fixed-price but data transfer / NAT /
 * CloudWatch are unmodeled; per-second billing rounds up.
 *
 * @module @autonomous-dev/deploy-aws/cost-estimator
 */

import {
  type CostEstimator,
  type EstimateResult,
  lineItem,
  sumBreakdown,
} from '../../autonomous-dev/intake/deploy/cost-estimation';
import {
  type AwsEstimateParams,
  PRICING,
} from '../../autonomous-dev/intake/deploy/pricing-fixtures';

export class AwsCostEstimator implements CostEstimator<AwsEstimateParams> {
  async estimateDeployCost(params: AwsEstimateParams): Promise<EstimateResult> {
    const p = PRICING.aws;
    const vcpuHours = params.tasks * params.vcpu * params.vcpu_hours;
    const memHours = params.tasks * params.memory_gb * params.vcpu_hours;
    const ecrMonthFraction = params.run_hours / 730;
    const breakdown = [
      lineItem('Fargate vCPU-hours', vcpuHours, 'vCPU-hour', p.fargate_vcpu_hour_usd),
      lineItem('Fargate memory GB-hours', memHours, 'GB-hour', p.fargate_gb_hour_usd),
      lineItem(
        'ECR storage (prorated)',
        params.image_size_gb * ecrMonthFraction,
        'GB-month',
        p.ecr_storage_gb_month_usd,
      ),
    ];
    return {
      estimated_cost_usd: sumBreakdown(breakdown),
      currency: 'USD',
      breakdown,
      confidence: 0.85,
      notes: 'Excludes data transfer, NAT Gateway, and CloudWatch.',
    };
  }
}

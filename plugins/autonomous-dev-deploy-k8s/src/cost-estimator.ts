/**
 * Kubernetes cost estimator (SPEC-024-3-03).
 *
 * Always returns $0 with confidence 0.0 — cluster billing is the
 * operator's concern; per-deploy K8s cost is structurally unestimable
 * without cluster context (separate tooling such as Kubecost handles it).
 *
 * @module @autonomous-dev/deploy-k8s/cost-estimator
 */

import {
  type CostEstimator,
  type EstimateResult,
} from '../../autonomous-dev/intake/deploy/cost-estimation';
import type { K8sEstimateParams } from '../../autonomous-dev/intake/deploy/pricing-fixtures';

export class K8sCostEstimator implements CostEstimator<K8sEstimateParams> {
  async estimateDeployCost(_params: K8sEstimateParams): Promise<EstimateResult> {
    return {
      estimated_cost_usd: 0.0,
      currency: 'USD',
      breakdown: [],
      confidence: 0.0,
      notes: "Cluster billing is the operator's responsibility; per-deploy cost is not estimated.",
    };
  }
}

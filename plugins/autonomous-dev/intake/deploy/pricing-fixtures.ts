/**
 * Static USD pricing fixtures for cloud-backend cost estimation
 * (SPEC-024-3-03).
 *
 * Captured from each cloud's public pricing page on the date noted in
 * `captured_on`. Stale fixtures will produce stale estimates — accepted
 * trade-off because cost estimates are best-effort by design (PLAN-024-3
 * risks table) and the per-backend `confidence` field signals the
 * approximation to operators. A future enhancement may pull live pricing
 * from each cloud's pricing API (out of scope for v1).
 *
 * Every entry MUST include `source_url` and `captured_on` for auditability
 * — SPEC-024-3-04 enforces this with a regex test.
 *
 * @module intake/deploy/pricing-fixtures
 */

export const PRICING = {
  aws: {
    fargate_vcpu_hour_usd: 0.04048,
    fargate_gb_hour_usd: 0.004445,
    ecr_storage_gb_month_usd: 0.10,
    source_url: 'https://aws.amazon.com/fargate/pricing/',
    captured_on: '2026-04-29',
  },
  gcp: {
    cloud_run_request_per_million_usd: 0.40,
    cloud_run_vcpu_second_usd: 0.000024,
    cloud_run_gib_second_usd: 0.0000025,
    source_url: 'https://cloud.google.com/run/pricing',
    captured_on: '2026-04-29',
  },
  azure: {
    container_apps_vcpu_second_usd: 0.000024,
    container_apps_gib_second_usd: 0.000003,
    container_apps_request_per_million_usd: 0.40,
    source_url: 'https://azure.microsoft.com/pricing/details/container-apps/',
    captured_on: '2026-04-29',
  },
} as const;

/** AWS Fargate / ECR estimate-input parameters. */
export interface AwsEstimateParams {
  /** Number of ECS tasks. */
  tasks: number;
  /** vCPU per task. */
  vcpu: number;
  /** Memory GiB per task. */
  memory_gb: number;
  /** Run-hours billed for vCPU/memory. */
  vcpu_hours: number;
  /** Image size in GB stored in ECR. */
  image_size_gb: number;
  /** Total run-hours for ECR storage proration. */
  run_hours: number;
}

/** GCP Cloud Run estimate-input parameters. */
export interface GcpEstimateParams {
  expected_requests: number;
  vcpu: number;
  /** vCPU-seconds (sum across the deploy window). */
  vcpu_seconds: number;
  gib: number;
  /** GiB-seconds. */
  gib_seconds: number;
}

/** Azure Container Apps estimate-input parameters (mirrors GCP). */
export interface AzureEstimateParams {
  expected_requests: number;
  vcpu: number;
  vcpu_seconds: number;
  gib: number;
  gib_seconds: number;
}

/** K8s deploy params; cluster cost is the operator's concern. */
export interface K8sEstimateParams {
  /** Free-form; backend ignores it and always returns $0 with confidence 0. */
  [k: string]: unknown;
}

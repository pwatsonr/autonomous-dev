# autonomous-dev-deploy-aws

## Overview

This plugin adds an `aws` deployment backend to `autonomous-dev`, targeting Amazon Elastic Container Registry (image build) and Amazon Elastic Container Service on Fargate (service update + ALB-based health). It registers as `BackendCapability: 'aws-ecs-fargate'` and works with the credential-proxy delivered by PLAN-024-2.

## Prerequisites

- An AWS account. Note the 12-digit account ID.
- An ECR repository created in the target region.
- An ECS cluster + service running on Fargate.
- An Application Load Balancer (ALB) with a target group attached to the service.
- An IAM role for the credential proxy (PLAN-024-2) with `ecr:PutImage`, `ecs:UpdateService`, `ecs:RegisterTaskDefinition`, `elasticloadbalancing:DescribeTargetHealth`, and `iam:PassRole` to the task / execution roles.
- Region must be one of the supported set in this plugin's `plugin.json` `regions_supported` array.

## Install

```
claude plugin install autonomous-dev-deploy-aws
```

Verify the install:

```
deploy backends list
```

The output must include a row for `aws` with `supportedTargets: aws-ecs-fargate`.

## Configuration

| Parameter | Type | Required | Default | Allowed values |
|-----------|------|----------|---------|----------------|
| `account_id` | string | yes | — | exactly 12 digits |
| `region` | enum | yes | — | one of `AWS_REGIONS` (e.g., `us-east-1`) |
| `cluster_name` | string | yes | — | identifier |
| `service_name` | string | yes | — | identifier |
| `ecr_repo` | string | yes | — | identifier |
| `task_family` | string | yes | — | identifier |
| `target_group_arn` | string | yes | — | shell-safe arg (full ARN) |
| `health_timeout_seconds` | number | no | `180` | 10 .. 600 |
| `desired_count` | number | no | `1` | 1 .. 100 |

## Configuration example

```yaml
backend: aws
environment: prod
parameters:
  account_id: "123456789012"
  region: us-east-1
  cluster_name: prod-cluster
  service_name: api
  ecr_repo: api
  task_family: api-task
  target_group_arn: arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/api-tg/abc123
  desired_count: 2
  health_timeout_seconds: 180
```

## Helper agent

This plugin ships a read-only reviewer agent (`aws-deploy-expert`) the daemon can consult before deploy. Run it manually with:

```
claude agent aws-deploy-expert --input deploy.yaml
```

The agent walks an IAM / ECS / ALB / ECR / networking / cost checklist and emits a markdown report. It cannot modify files or shell out.

## Troubleshooting

### `AccessDeniedException: ECR PutImage`

**Cause**: the STS principal returned by the credential proxy is not in the ECR repository's policy, or the policy denies `ecr:PutImage`.

**Resolution**:
1. Run `aws ecr get-repository-policy --repository-name <ecr_repo> --region <region>`.
2. Confirm the proxy's role/principal appears in `Statement[].Principal.AWS`.
3. If absent, update the repo policy to allow `ecr:PutImage` for the proxy principal.
4. Re-run the build; the proxy fetches fresh creds carrying the updated permission.

### `service stuck deploying` (ECS describe-services shows `(reason RESOURCE:...)`)

**Cause**: ECS cannot place tasks because of capacity, networking, or security-group constraints.

**Resolution**:
1. Run `aws ecs describe-services --cluster <cluster_name> --services <service_name> --region <region>`.
2. Inspect `events[]`; common reasons: `RESOURCE:NETWORK_INTERFACE`, `RESOURCE:CPU`, `RESOURCE:MEMORY`.
3. For network-interface exhaustion, increase the subnet's available IPs or move to a larger CIDR.
4. For CPU/memory shortage, raise the Fargate ceiling on the cluster or right-size the task definition.

### `target health: unhealthy` (ALB target group reports unhealthy targets)

**Cause**: ALB health-check path does not match the container's health endpoint, or the security group blocks the ALB.

**Resolution**:
1. Run `aws elbv2 describe-target-health --target-group-arn <target_group_arn> --region <region>`.
2. Confirm the health-check path on the target group matches the container's actual health route.
3. Verify the task's security group allows inbound from the ALB's SG on the container port.
4. Re-deploy; targets should transition to `healthy` within `health_timeout_seconds`.

### `task fails with image pull` (CannotPullContainerError)

**Cause**: the ECS task's execution role lacks `ecr:GetAuthorizationToken` or `ecr:BatchGetImage` on the source repository.

**Resolution**:
1. Identify the execution role on the task definition: `executionRoleArn`.
2. Attach the AWS-managed policy `AmazonECSTaskExecutionRolePolicy` (covers ECR pull + CloudWatch Logs).
3. Re-deploy the service; the next task pulls successfully.

### `circuit breaker trips, no rollback`

**Cause**: ECS deployment configuration has the circuit breaker enabled but `rollback: false` (or no previous task definition exists).

**Resolution**:
1. Inspect `aws ecs describe-services ... | jq '.services[0].deploymentConfiguration'`.
2. Confirm `deploymentCircuitBreaker.enable: true` AND `deploymentCircuitBreaker.rollback: true`.
3. If `rollback: false`, update the service: `aws ecs update-service --deployment-configuration 'deploymentCircuitBreaker={enable=true,rollback=true}'`.
4. Future failed deploys auto-rollback to the previous task definition.

## Release-time manual smoke checklist

CI integration tests (`.github/workflows/cloud-integration.yml`) cover the AWS lifecycle against LocalStack. LocalStack only partially simulates ALB target health, so a release-time manual smoke against a real AWS account is recommended before each minor-version bump (`deploy plan --env staging --backend aws --dry-run` followed by a guarded `deploy run --env staging`).

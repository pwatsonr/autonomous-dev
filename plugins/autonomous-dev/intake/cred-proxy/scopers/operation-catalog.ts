/**
 * Operation catalog — single source of truth for "what permissions does
 * each declared operation require" (SPEC-024-2-02 + SPEC-024-2-03).
 *
 * Keeping this file purely declarative (no I/O, no SDK imports) lets the
 * snapshot tests for `awsPolicyFor` and the K8s Role rules treat it as
 * data and detect any accidental scope-widening on PR diff.
 *
 * Adding a new operation is a one-liner per provider PLUS a new snapshot
 * test entry. The PR template (separate, ops concern) reminds
 * contributors to regenerate snapshots.
 *
 * @module intake/cred-proxy/scopers/operation-catalog
 */

// ---------------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------------

export interface AwsOperationSpec {
  /** IAM actions that the inline session policy will allow. */
  readonly actions: readonly string[];
  /** Build the resource ARN from scope keys. */
  readonly resourceArn: (scope: Record<string, string>) => string;
  /** Validated by `awsPolicyFor` before scoping. */
  readonly requiredScopeKeys: readonly string[];
}

export const AWS_OPERATIONS: Readonly<Record<string, AwsOperationSpec>> = {
  'ECS:UpdateService': {
    actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
    resourceArn: (s) =>
      `arn:aws:ecs:${s.region}:${s.account}:service/${s.cluster}/${s.service}`,
    requiredScopeKeys: ['region', 'account', 'cluster', 'service'],
  },
  'Lambda:UpdateFunctionCode': {
    actions: ['lambda:UpdateFunctionCode', 'lambda:GetFunction'],
    resourceArn: (s) =>
      `arn:aws:lambda:${s.region}:${s.account}:function:${s.functionName}`,
    requiredScopeKeys: ['region', 'account', 'functionName'],
  },
  'S3:PutObject': {
    actions: ['s3:PutObject'],
    resourceArn: (s) => `arn:aws:s3:::${s.bucket}/${s.key}`,
    requiredScopeKeys: ['bucket', 'key'],
  },
  'ECR:PushImage': {
    actions: [
      'ecr:GetAuthorizationToken',
      'ecr:BatchCheckLayerAvailability',
      'ecr:InitiateLayerUpload',
      'ecr:UploadLayerPart',
      'ecr:CompleteLayerUpload',
      'ecr:PutImage',
    ],
    resourceArn: (s) =>
      `arn:aws:ecr:${s.region}:${s.account}:repository/${s.repository}`,
    requiredScopeKeys: ['region', 'account', 'repository'],
  },
  'CloudWatchLogs:PutLogEvents': {
    actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
    resourceArn: (s) =>
      `arn:aws:logs:${s.region}:${s.account}:log-group:${s.logGroup}:log-stream:*`,
    requiredScopeKeys: ['region', 'account', 'logGroup'],
  },
  'ELBv2:DescribeTargetHealth': {
    actions: ['elasticloadbalancing:DescribeTargetHealth'],
    resourceArn: (s) =>
      `arn:aws:elasticloadbalancing:${s.region}:${s.account}:targetgroup/${s.targetGroup}/${s.targetGroupId}`,
    requiredScopeKeys: ['region', 'account', 'targetGroup', 'targetGroupId'],
  },
};

// ---------------------------------------------------------------------------
// GCP
// ---------------------------------------------------------------------------

export type GcpResourceType = 'service' | 'bucket' | 'project';

export interface GcpOperationSpec {
  readonly role: string;
  readonly resourceType: GcpResourceType;
  readonly resourcePath: (scope: Record<string, string>) => string;
  readonly requiredScopeKeys: readonly string[];
}

export const GCP_OPERATIONS: Readonly<Record<string, GcpOperationSpec>> = {
  'Run.Deploy': {
    role: 'roles/run.developer',
    resourceType: 'service',
    resourcePath: (s) =>
      `projects/${s.project}/locations/${s.location}/services/${s.service}`,
    requiredScopeKeys: ['project', 'location', 'service'],
  },
  'Storage.Upload': {
    role: 'roles/storage.objectCreator',
    resourceType: 'bucket',
    resourcePath: (s) => `projects/_/buckets/${s.bucket}`,
    requiredScopeKeys: ['bucket'],
  },
};

// ---------------------------------------------------------------------------
// Azure (SPEC-024-2-03 fills this in; declared here so the catalog stays
// one file)
// ---------------------------------------------------------------------------

export interface AzureOperationSpec {
  /**
   * Built-in or custom Azure RBAC role definition ID. Full path:
   * `/subscriptions/.../providers/Microsoft.Authorization/roleDefinitions/<guid>`.
   */
  readonly roleDefinitionId: string;
  /** ARM resource scope path. */
  readonly resourceScope: (scope: Record<string, string>) => string;
  readonly requiredScopeKeys: readonly string[];
}

export const AZURE_OPERATIONS: Readonly<Record<string, AzureOperationSpec>> = {
  'ContainerApps.Deploy': {
    // Built-in "Contributor" role; production deployments should replace
    // this with a custom role definition limited to ContainerApps verbs.
    roleDefinitionId:
      '/providers/Microsoft.Authorization/roleDefinitions/b24988ac-6180-42a0-ab88-20f7382dd24c',
    resourceScope: (s) =>
      `/subscriptions/${s.subscriptionId}/resourceGroups/${s.resourceGroup}/providers/Microsoft.App/containerApps/${s.appName}`,
    requiredScopeKeys: ['subscriptionId', 'resourceGroup', 'appName'],
  },
};

// ---------------------------------------------------------------------------
// Kubernetes (SPEC-024-2-03 fills this in)
// ---------------------------------------------------------------------------

export interface K8sOperationSpec {
  /**
   * PolicyRules embedded in the per-issuance Role. Mirrors the K8s
   * rbacv1 Rule shape — kept structural so the spec doesn't need a full
   * `@kubernetes/client-node` import here.
   */
  readonly rules: ReadonlyArray<{
    readonly apiGroups: readonly string[];
    readonly resources: readonly string[];
    readonly verbs: readonly string[];
    readonly resourceNames?: readonly string[];
  }>;
  readonly requiredScopeKeys: readonly string[];
}

export const K8S_OPERATIONS: Readonly<Record<string, K8sOperationSpec>> = {
  deploy: {
    rules: [
      {
        apiGroups: ['apps'],
        resources: ['deployments'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      {
        apiGroups: [''],
        resources: ['services', 'configmaps'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      {
        apiGroups: [''],
        resources: ['pods'],
        verbs: ['get', 'list', 'watch'],
      },
    ],
    requiredScopeKeys: ['cluster', 'namespace'],
  },
};

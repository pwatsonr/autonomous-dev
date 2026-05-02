/**
 * Pure kubeconfig builder (SPEC-024-2-03).
 *
 * The K8s ecosystem expects kubeconfig in YAML. The shape is fixed enough
 * that a string template avoids a runtime YAML dependency. The snapshot
 * test in `tests/cred-proxy/test-kubeconfig-builder.test.ts` locks the
 * format — any change to the YAML triggers a clear diff, since kubeconfig
 * consumers downstream depend on shape stability.
 *
 * @module intake/cred-proxy/scopers/kubeconfig-builder
 */

export interface KubeconfigInputs {
  readonly clusterName: string;
  readonly serverUrl: string;
  readonly caCertBase64: string;
  readonly namespace: string;
  readonly serviceAccountName: string;
  readonly token: string;
}

/**
 * Build a single-cluster, single-context kubeconfig. Output ends with a
 * trailing newline (POSIX file convention). Inputs are interpolated as-is
 * — the K8s scoper is responsible for shape validation.
 */
export function buildKubeconfig(i: KubeconfigInputs): string {
  return [
    'apiVersion: v1',
    'kind: Config',
    `current-context: ${i.clusterName}-cred-proxy`,
    'clusters:',
    `- name: ${i.clusterName}`,
    '  cluster:',
    `    server: ${i.serverUrl}`,
    `    certificate-authority-data: ${i.caCertBase64}`,
    'users:',
    `- name: ${i.serviceAccountName}`,
    '  user:',
    `    token: ${i.token}`,
    'contexts:',
    `- name: ${i.clusterName}-cred-proxy`,
    '  context:',
    `    cluster: ${i.clusterName}`,
    `    user: ${i.serviceAccountName}`,
    `    namespace: ${i.namespace}`,
    '',
  ].join('\n');
}

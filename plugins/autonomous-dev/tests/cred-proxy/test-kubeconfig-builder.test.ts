/**
 * Snapshot test for `buildKubeconfig` (SPEC-024-2-03).
 *
 * Locks the YAML format. K8s tooling depends on shape stability — any
 * intentional change MUST regenerate the snapshot AND justify the diff.
 */

import { buildKubeconfig } from '../../intake/cred-proxy/scopers/kubeconfig-builder';

describe('buildKubeconfig', () => {
  it('snapshots the full kubeconfig YAML', () => {
    expect(
      buildKubeconfig({
        clusterName: 'c',
        serverUrl: 'https://example/',
        caCertBase64: 'AAA=',
        namespace: 'n',
        serviceAccountName: 'sa',
        token: 'tok',
      }),
    ).toMatchSnapshot();
  });

  it('contains every input value verbatim', () => {
    const out = buildKubeconfig({
      clusterName: 'c1',
      serverUrl: 'https://api.k8s.example:6443',
      caCertBase64: 'BASE64CADATA==',
      namespace: 'app-ns',
      serviceAccountName: 'cred-proxy-deploy-abcd1234',
      token: 'eyJ.tok',
    });
    expect(out).toContain('c1');
    expect(out).toContain('https://api.k8s.example:6443');
    expect(out).toContain('BASE64CADATA==');
    expect(out).toContain('app-ns');
    expect(out).toContain('cred-proxy-deploy-abcd1234');
    expect(out).toContain('eyJ.tok');
  });

  it('ends with a trailing newline (POSIX convention)', () => {
    const out = buildKubeconfig({
      clusterName: 'x',
      serverUrl: 'https://x',
      caCertBase64: '',
      namespace: 'y',
      serviceAccountName: 'z',
      token: 't',
    });
    expect(out.endsWith('\n')).toBe(true);
  });

  it('current-context references cluster name', () => {
    const out = buildKubeconfig({
      clusterName: 'prod',
      serverUrl: 'https://x',
      caCertBase64: '',
      namespace: 'y',
      serviceAccountName: 'z',
      token: 't',
    });
    expect(out).toContain('current-context: prod-cred-proxy');
  });
});

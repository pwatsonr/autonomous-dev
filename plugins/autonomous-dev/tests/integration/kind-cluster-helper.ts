/**
 * kind-cluster-helper — start / destroy a kind (Kubernetes-in-Docker)
 * cluster for the cred-proxy K8s scope-enforcement integration test
 * (SPEC-024-2-05).
 *
 * The helper is intentionally synchronous around `child_process.execSync`
 * because (a) test orchestration is sequential, (b) `kind create cluster`
 * itself blocks until the API server is healthy, and (c) failure to spin
 * up MUST surface as a thrown error before any test runs.
 *
 * The kindest/node image is pinned to `v1.27.3` so the test is
 * deterministic across runner upgrades. Bumping is a quarterly hygiene
 * task documented in `docs/testing/kind-setup.md`.
 *
 * @module tests/integration/kind-cluster-helper
 */

import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const KIND_NODE_IMAGE = 'kindest/node:v1.27.3';

export interface KindCluster {
  /** Cluster name as registered with kind (no `kind-` prefix). */
  readonly name: string;
  /** Path to the per-cluster kubeconfig file. */
  readonly kubeconfigPath: string;
  /** Best-effort destroy: idempotent, swallows errors. */
  destroy(): void;
}

/**
 * Returns true when the `kind` binary is on PATH. Used by the
 * integration test to decide whether to skip itself.
 */
export function hasKind(): boolean {
  try {
    const result = spawnSync('kind', ['--version'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Create a fresh kind cluster and write its kubeconfig to a temp file.
 * Throws if `kind` is not on PATH or `kind create cluster` fails.
 *
 * The cluster name embeds `Date.now()` so back-to-back runs cannot
 * collide. The caller MUST `cluster.destroy()` in `afterAll` (best-effort
 * cleanup; idempotent).
 */
export function startKindCluster(
  name = `cred-proxy-${Date.now()}`,
): KindCluster {
  if (!hasKind()) {
    throw new Error(
      'kind binary not on PATH; run `brew install kind` or see ' +
        'docs/testing/kind-setup.md',
    );
  }
  // `--wait 60s` blocks until the control-plane node reports Ready.
  execSync(
    `kind create cluster --name ${name} --image ${KIND_NODE_IMAGE} --wait 60s`,
    { stdio: 'inherit' },
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kind-kc-'));
  const kc = path.join(tmp, 'kubeconfig');
  // Capture the kubeconfig to a dedicated file rather than relying on the
  // host's default ~/.kube/config (avoids clobbering developer state).
  const fd = fs.openSync(kc, 'w');
  try {
    execSync(`kind get kubeconfig --name ${name}`, {
      stdio: ['ignore', fd, 'inherit'],
    });
  } finally {
    fs.closeSync(fd);
  }
  return {
    name,
    kubeconfigPath: kc,
    destroy: () => {
      try {
        execSync(`kind delete cluster --name ${name}`, { stdio: 'ignore' });
      } catch {
        // best-effort
      }
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

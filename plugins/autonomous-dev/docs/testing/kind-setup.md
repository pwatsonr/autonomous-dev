# Running the cred-proxy kind integration test

## Why kind

The kind-based integration test under
`tests/integration/test-cred-proxy-scope.test.ts` is the **only** place
in PLAN-024-2 that proves K8s scope enforcement works at the cluster
level rather than just at the proxy level. It plays out a real attack
scenario: a backend acquires a kubeconfig scoped to namespace `ns-a`,
attempts a deploy in `ns-b`, and the K8s API server MUST respond `403`.
A green test guarantees the scoper's RoleBinding actually binds to the
target namespace; a red test signals a scoping bug that mocks alone
could miss.

AWS, GCP, and Azure have no comparable offline emulator. They are
covered by SDK-mock unit tests plus manual smoke tests at release time.

## Install kind

| Platform   | Command                                             |
|------------|-----------------------------------------------------|
| macOS      | `brew install kind`                                 |
| Linux      | `go install sigs.k8s.io/kind@v0.23.0`               |
| Windows    | See https://kind.sigs.k8s.io/docs/user/quick-start/ |
| All        | Or download the binary from the kind releases page  |

The CI workflow pins `kind` to `v0.23.0`. Local versions ≥ `0.20.0` are
expected to work, but if you see "image not found" errors, match the CI
pin.

## Docker requirement

kind launches each cluster as a Docker container. You need Docker
Desktop (macOS / Windows) or Docker Engine (Linux). Verify the daemon
is running:

```sh
docker info
```

If the command errors with `Cannot connect to the Docker daemon`, start
Docker Desktop or `sudo systemctl start docker` (Linux).

## Run locally

From `plugins/autonomous-dev/`:

```sh
RUN_KIND_TESTS=1 npm run test:kind
```

The first run pulls the `kindest/node:v1.27.3` image (~300 MB) and
takes ~90 seconds. Subsequent runs reuse the cached image and complete
in ~60-90 seconds total: cluster spin-up (~60s), three test cases
(~10-20s combined), tear-down (~10s).

Without `RUN_KIND_TESTS=1` the test self-skips (a single `it.skip`
records the intent in the test report).

## Troubleshooting

- **"kind binary not on PATH"** — install kind (see above) and verify
  with `kind --version`.
- **"image pull failed"** — the kindest/node image fetch can hit
  network limits; retry once. If it still fails, run
  `docker pull kindest/node:v1.27.3` manually first.
- **"namespace already exists"** — a stale prior cluster is still
  running. List clusters with `kind get clusters`, then
  `kind delete cluster --name <prefix>` for the offending entry. The
  test's afterAll is best-effort; a SIGKILL'd run can leave clusters
  behind.
- **"context deadline exceeded"** — Docker memory pressure. Bump Docker
  Desktop's memory limit to at least 4 GiB or close other containers.

## Bumping the kindest/node image

Edit `KIND_NODE_IMAGE` in `tests/integration/kind-cluster-helper.ts`.
Quarterly bump as part of dependency hygiene. The image must support
the TokenRequest API (≥ K8s 1.22).

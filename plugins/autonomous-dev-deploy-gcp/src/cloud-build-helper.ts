/**
 * Cloud Build helpers (SPEC-024-1-02).
 *
 * Wraps the structural shape of `@google-cloud/cloudbuild`'s
 * `CloudBuildClient` so `GCPBackend.build()` can submit a build and poll
 * its status without depending on the SDK at compile time. The SDK lives
 * in `plugins/autonomous-dev-deploy-gcp/node_modules`; this wrapper takes
 * a duck-typed client so unit tests can inject a hand-rolled mock.
 *
 * Polls every 10 seconds up to 30 minutes (configurable via opts), per
 * TDD-024 §6.1. Translates Cloud Build status enums into typed errors
 * via `CloudDeployError`.
 *
 * @module @autonomous-dev/deploy-gcp/cloud-build-helper
 */

import { CloudDeployError } from '../../autonomous-dev/intake/deploy/errors';

/**
 * Cloud Build operation/status enum subset we care about. Values match
 * the proto enum strings the v1 client returns.
 */
export type CloudBuildStatus =
  | 'STATUS_UNKNOWN'
  | 'QUEUED'
  | 'WORKING'
  | 'SUCCESS'
  | 'FAILURE'
  | 'INTERNAL_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'EXPIRED';

/** Subset of the `Build` message fields used by this module. */
export interface CloudBuildBuild {
  id?: string | null;
  status?: CloudBuildStatus | null;
  results?: {
    images?: ReadonlyArray<{
      name?: string | null;
      digest?: string | null;
    }>;
  } | null;
  statusDetail?: string | null;
}

/**
 * Structural subset of `CloudBuildClient` used here. The real client
 * returns gax-style `[response, ...]` tuples; we wrap to keep call sites
 * tidy.
 */
export interface CloudBuildLikeClient {
  createBuild(req: {
    projectId: string;
    build: Record<string, unknown>;
  }): Promise<readonly [unknown, unknown, unknown] | unknown>;
  getBuild(req: {
    projectId: string;
    id: string;
  }): Promise<readonly [CloudBuildBuild, unknown, unknown] | CloudBuildBuild>;
}

/** Options for `submitBuild`. */
export interface SubmitBuildOptions {
  projectId: string;
  imageUri: string;
  /** Absolute path to the source repo (becomes Cloud Build source). */
  repoPath: string;
  /** Override poll interval (ms). Default 10_000. */
  pollIntervalMs?: number;
  /** Overall poll deadline (ms). Default 30 min. */
  timeoutMs?: number;
  /** Test seam: replace the wall-clock waiter. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: clock for deadline math. */
  now?: () => number;
}

/** Outcome of a successful build poll loop. */
export interface SubmitBuildResult {
  buildId: string;
  imageUri: string;
  digest: string;
}

const DEFAULT_POLL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Submit a Cloud Build that produces a single Docker image at
 * `opts.imageUri`. Polls until terminal; throws `CloudDeployError` on
 * non-success.
 */
export async function submitBuild(
  client: CloudBuildLikeClient,
  opts: SubmitBuildOptions,
): Promise<SubmitBuildResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const buildSpec = {
    source: {
      // Source-less submission: backend has already pushed source storage
      // out-of-band OR Cloud Build picks up the trigger's bound repo. For
      // SPEC-024-1-02 the backend only constructs the build spec; real
      // source resolution lives in PLAN-024-1's followup tasks (see
      // TDD-024 §6.1 "Cloud Build trigger" path).
    },
    steps: [
      {
        name: 'gcr.io/cloud-builders/docker',
        args: ['build', '-t', opts.imageUri, '.'],
      },
      {
        name: 'gcr.io/cloud-builders/docker',
        args: ['push', opts.imageUri],
      },
    ],
    images: [opts.imageUri],
  };

  let createResp: unknown;
  try {
    createResp = await client.createBuild({
      projectId: opts.projectId,
      build: buildSpec,
    });
  } catch (err) {
    throw mapGcpError(err, 'CloudBuild:CreateBuild');
  }

  const buildId = extractBuildId(createResp);
  if (!buildId) {
    throw new CloudDeployError(
      'BUILD_FAILED',
      'gcp',
      'CloudBuild:CreateBuild',
      false,
      'Cloud Build createBuild response did not include a build id',
    );
  }

  const start = now();
  while (true) {
    let raw: unknown;
    try {
      raw = await client.getBuild({ projectId: opts.projectId, id: buildId });
    } catch (err) {
      throw mapGcpError(err, 'CloudBuild:GetBuild');
    }
    const build = unwrapBuild(raw);
    const status = build.status ?? 'STATUS_UNKNOWN';
    if (status === 'SUCCESS') {
      const digest = pickImageDigest(build);
      if (!digest) {
        throw new CloudDeployError(
          'BUILD_FAILED',
          'gcp',
          'CloudBuild:GetBuild',
          false,
          `Cloud Build ${buildId} succeeded but produced no image digest`,
        );
      }
      return { buildId, imageUri: opts.imageUri, digest };
    }
    if (
      status === 'FAILURE' ||
      status === 'CANCELLED' ||
      status === 'TIMEOUT' ||
      status === 'EXPIRED' ||
      status === 'INTERNAL_ERROR'
    ) {
      throw new CloudDeployError(
        'BUILD_FAILED',
        'gcp',
        'CloudBuild:GetBuild',
        status === 'INTERNAL_ERROR',
        `Cloud Build ${buildId} terminated with status ${status}: ${build.statusDetail ?? '(no detail)'}`,
      );
    }
    if (now() - start > timeoutMs) {
      throw new CloudDeployError(
        'BUILD_FAILED',
        'gcp',
        'CloudBuild:GetBuild',
        true,
        `Cloud Build ${buildId} did not reach a terminal status within ${timeoutMs}ms (last=${status})`,
      );
    }
    await sleep(pollMs);
  }
}

/**
 * Translate a Cloud Build SDK error into a categorised
 * `CloudDeployError`. Exported for use by `backend.ts` for non-build
 * operations too.
 */
export function mapGcpError(err: unknown, operation: string): CloudDeployError {
  const e = err as { code?: number | string; message?: string };
  const message = e?.message ?? String(err);
  // gRPC status codes the @google-cloud/* libs surface as `code: number`.
  // 7 = PERMISSION_DENIED, 8 = RESOURCE_EXHAUSTED, 14 = UNAVAILABLE,
  // 4 = DEADLINE_EXCEEDED, 16 = UNAUTHENTICATED.
  if (e?.code === 7 || e?.code === 'PERMISSION_DENIED' || e?.code === 16 || e?.code === 'UNAUTHENTICATED') {
    return new CloudDeployError('AUTH_FAILED', 'gcp', operation, false, message, err);
  }
  if (e?.code === 8 || e?.code === 'RESOURCE_EXHAUSTED') {
    return new CloudDeployError('QUOTA_EXCEEDED', 'gcp', operation, true, message, err);
  }
  if (e?.code === 14 || e?.code === 'UNAVAILABLE' || e?.code === 4 || e?.code === 'DEADLINE_EXCEEDED') {
    return new CloudDeployError('NETWORK', 'gcp', operation, true, message, err);
  }
  if (e?.code === 5 || e?.code === 'NOT_FOUND') {
    return new CloudDeployError('NOT_FOUND', 'gcp', operation, false, message, err);
  }
  return new CloudDeployError('UNKNOWN', 'gcp', operation, false, message, err);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractBuildId(resp: unknown): string | null {
  // The createBuild response is `[longRunningOperation, metadata, ...]`
  // where the metadata contains `build.id`. We walk it defensively.
  const tuple = Array.isArray(resp) ? resp : [resp];
  for (const item of tuple) {
    const id = pickBuildId(item);
    if (id) return id;
  }
  return null;
}

function pickBuildId(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  if (typeof obj.id === 'string' && obj.id.length > 0) return obj.id;
  if (obj.metadata && typeof obj.metadata === 'object') {
    const meta = obj.metadata as { build?: { id?: string } };
    if (meta.build && typeof meta.build.id === 'string') return meta.build.id;
  }
  if (obj.build && typeof obj.build === 'object') {
    const b = obj.build as { id?: string };
    if (typeof b.id === 'string') return b.id;
  }
  return null;
}

function unwrapBuild(raw: unknown): CloudBuildBuild {
  if (Array.isArray(raw)) {
    return (raw[0] as CloudBuildBuild) ?? {};
  }
  return (raw as CloudBuildBuild) ?? {};
}

function pickImageDigest(build: CloudBuildBuild): string | null {
  const images = build.results?.images;
  if (!images || images.length === 0) return null;
  const digest = images[0]?.digest;
  return typeof digest === 'string' && digest.length > 0 ? digest : null;
}

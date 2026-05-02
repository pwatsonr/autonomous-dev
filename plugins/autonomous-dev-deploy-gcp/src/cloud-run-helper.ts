/**
 * Cloud Run helpers (SPEC-024-1-02).
 *
 * Wraps the structural shape of `@google-cloud/run`'s `ServicesClient` so
 * `GCPBackend.deploy()` / `.healthCheck()` / `.rollback()` can operate
 * without depending on the SDK at compile time. The unit tests in this
 * package inject a hand-rolled mock that satisfies
 * `CloudRunLikeClient`.
 *
 * Health probing uses Node 20's global `fetch`. Rollback identifies the
 * previous revision via `listRevisions` ordered by `createTime` desc.
 *
 * @module @autonomous-dev/deploy-gcp/cloud-run-helper
 */

import { CloudDeployError } from '../../autonomous-dev/intake/deploy/errors';
import { mapGcpError } from './cloud-build-helper';

/** Subset of the `Service` message used here. */
export interface CloudRunService {
  name?: string | null;
  uri?: string | null;
  uid?: string | null;
  latestReadyRevision?: string | null;
  template?: {
    containers?: ReadonlyArray<{
      image?: string | null;
      resources?: Record<string, unknown> | null;
      ports?: ReadonlyArray<{ containerPort?: number | null }> | null;
    }>;
  } | null;
  traffic?: ReadonlyArray<{
    revision?: string | null;
    percent?: number | null;
  }> | null;
}

/** Subset of the `Revision` message used here. */
export interface CloudRunRevision {
  name?: string | null;
  createTime?: string | null;
  containers?: ReadonlyArray<{ image?: string | null }> | null;
}

/** Structural subset of `ServicesClient`. */
export interface CloudRunLikeClient {
  replaceService(req: {
    name: string;
    service: CloudRunService;
  }): Promise<readonly [CloudRunService, unknown, unknown] | CloudRunService>;
  updateService(req: {
    name: string;
    service: CloudRunService;
  }): Promise<readonly [CloudRunService, unknown, unknown] | CloudRunService>;
  listRevisions(req: {
    parent: string;
  }): Promise<readonly [readonly CloudRunRevision[], unknown, unknown] | readonly CloudRunRevision[]>;
}

/** Options for `deployRevision`. */
export interface DeployRevisionOptions {
  serviceFqn: string; // projects/{p}/locations/{r}/services/{s}
  imageUri: string;
  cpu: string;
  memoryMib: number;
  containerPort?: number;
}

/** Result of `deployRevision`. */
export interface DeployRevisionResult {
  /** Fully-qualified service name from the response. */
  serviceFqn: string;
  /** Cloud Run external URL. */
  serviceUrl: string;
  /** New revision's name (latestReadyRevision after replace). */
  revisionName: string;
}

/** Replace the service template with a single-container deploy. */
export async function deployRevision(
  client: CloudRunLikeClient,
  opts: DeployRevisionOptions,
): Promise<DeployRevisionResult> {
  const service: CloudRunService = {
    name: opts.serviceFqn,
    template: {
      containers: [
        {
          image: opts.imageUri,
          resources: { limits: { cpu: opts.cpu, memory: `${opts.memoryMib}Mi` } },
          ports: [{ containerPort: opts.containerPort ?? 8080 }],
        },
      ],
    },
  };
  let raw: unknown;
  try {
    raw = await client.replaceService({ name: opts.serviceFqn, service });
  } catch (err) {
    throw mapGcpError(err, 'Run:ReplaceService');
  }
  const updated = unwrapService(raw);
  const url = updated.uri;
  const revision = updated.latestReadyRevision;
  if (!url) {
    throw new CloudDeployError(
      'DEPLOY_FAILED',
      'gcp',
      'Run:ReplaceService',
      false,
      `Cloud Run replaceService for ${opts.serviceFqn} did not return a service URL`,
    );
  }
  if (!revision) {
    throw new CloudDeployError(
      'DEPLOY_FAILED',
      'gcp',
      'Run:ReplaceService',
      false,
      `Cloud Run replaceService for ${opts.serviceFqn} did not return latestReadyRevision`,
    );
  }
  return {
    serviceFqn: updated.name ?? opts.serviceFqn,
    serviceUrl: url,
    revisionName: revision,
  };
}

/** Options for `pollHealth`. */
export interface PollHealthOptions {
  serviceUrl: string;
  healthPath: string;
  /** Total wallclock budget. */
  timeoutSeconds: number;
  /** Retry interval between probes. Default 5s. */
  intervalMs?: number;
  /** Test seam: replace `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam: replace `Date.now`. */
  now?: () => number;
  /** Test seam: replace `setTimeout`-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Cap on `checks` length retained in the result. Default 5. */
  maxChecks?: number;
}

/** Single probe outcome retained in `HealthStatus.checks`. */
export interface HealthProbe {
  name: string;
  passed: boolean;
  message?: string;
}

/** Result of `pollHealth` shaped to map directly to `HealthStatus`. */
export interface PollHealthResult {
  healthy: boolean;
  checks: HealthProbe[];
  unhealthyReason?: string;
}

/** Poll `${serviceUrl}${healthPath}` until 2xx or timeout. */
export async function pollHealth(opts: PollHealthOptions): Promise<PollHealthResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const interval = opts.intervalMs ?? 5_000;
  const maxChecks = opts.maxChecks ?? 5;
  const deadline = now() + opts.timeoutSeconds * 1000;

  const url = joinUrl(opts.serviceUrl, opts.healthPath);
  const probes: HealthProbe[] = [];

  while (true) {
    const probe = await singleProbe(fetchImpl, url);
    probes.push(probe);
    if (probes.length > maxChecks) probes.shift();
    if (probe.passed) {
      return { healthy: true, checks: probes };
    }
    if (now() >= deadline) {
      return {
        healthy: false,
        checks: probes,
        unhealthyReason: probe.message ?? 'health-timeout',
      };
    }
    await sleep(interval);
  }
}

async function singleProbe(fetchImpl: typeof fetch, url: string): Promise<HealthProbe> {
  try {
    const res = await fetchImpl(url);
    const ok = res.status >= 200 && res.status < 300;
    return {
      name: `GET ${url}`,
      passed: ok,
      message: ok ? `${res.status}` : `non-2xx ${res.status}`,
    };
  } catch (err) {
    return {
      name: `GET ${url}`,
      passed: false,
      message: (err as Error).message ?? 'fetch-error',
    };
  }
}

/** Options for `rollbackToRevision`. */
export interface RollbackOptions {
  serviceFqn: string;
  /** Revision name we just deployed (we want the one prior). */
  currentRevisionName: string;
}

/** Result of `rollbackToRevision`. */
export interface RollbackInfo {
  /** Restored revision name. */
  previousRevisionName: string;
  /** Image URI from that revision (becomes restoredArtifactId). */
  previousImageUri: string;
}

/**
 * Find the revision created immediately before `currentRevisionName` and
 * shift 100% of traffic to it.
 */
export async function rollbackToRevision(
  client: CloudRunLikeClient,
  opts: RollbackOptions,
): Promise<RollbackInfo> {
  let listed: readonly CloudRunRevision[];
  try {
    const raw = await client.listRevisions({ parent: opts.serviceFqn });
    listed = unwrapRevisions(raw);
  } catch (err) {
    throw mapGcpError(err, 'Run:ListRevisions');
  }
  const sorted = [...listed].sort((a, b) => {
    const ta = a.createTime ? Date.parse(a.createTime) : 0;
    const tb = b.createTime ? Date.parse(b.createTime) : 0;
    return tb - ta;
  });
  const idx = sorted.findIndex((r) => r.name === opts.currentRevisionName);
  const previous = idx >= 0 ? sorted[idx + 1] : sorted[1];
  if (!previous?.name) {
    throw new CloudDeployError(
      'ROLLBACK_FAILED',
      'gcp',
      'Run:ListRevisions',
      false,
      `no previous revision available for ${opts.serviceFqn}`,
    );
  }
  const update: CloudRunService = {
    name: opts.serviceFqn,
    traffic: [{ revision: previous.name, percent: 100 }],
  };
  try {
    await client.updateService({ name: opts.serviceFqn, service: update });
  } catch (err) {
    throw mapGcpError(err, 'Run:UpdateService');
  }
  return {
    previousRevisionName: previous.name,
    previousImageUri: previous.containers?.[0]?.image ?? '',
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unwrapService(raw: unknown): CloudRunService {
  if (Array.isArray(raw)) return (raw[0] as CloudRunService) ?? {};
  return (raw as CloudRunService) ?? {};
}

function unwrapRevisions(raw: unknown): readonly CloudRunRevision[] {
  if (Array.isArray(raw)) {
    if (raw.length > 0 && Array.isArray(raw[0])) {
      return raw[0] as readonly CloudRunRevision[];
    }
    return raw as readonly CloudRunRevision[];
  }
  return [];
}

function joinUrl(base: string, path: string): string {
  if (!path) return base;
  if (base.endsWith('/') && path.startsWith('/')) return base + path.slice(1);
  if (!base.endsWith('/') && !path.startsWith('/')) return `${base}/${path}`;
  return base + path;
}

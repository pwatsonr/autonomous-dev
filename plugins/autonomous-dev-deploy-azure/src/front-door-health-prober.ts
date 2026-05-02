/**
 * Azure Front Door / Container App health prober (SPEC-024-1-03
 * §"front-door-health-prober.ts").
 *
 * No Front Door SDK call required — the probe is just an HTTP GET against
 * the Front Door endpoint URL (or the Container App's own ingress FQDN
 * when no Front Door is configured). Polls every 5s up to a caller-
 * supplied timeout; first 2xx wins.
 *
 * @module @autonomous-dev/deploy-azure/front-door-health-prober
 */

/** Per-probe entry recorded by `pollEndpointHealth`. */
export interface ProbeCheck {
  name: string;
  passed: boolean;
  message?: string;
}

/** Result returned by `pollEndpointHealth`. */
export interface PollEndpointHealthResult {
  healthy: boolean;
  checks: ProbeCheck[];
  unhealthyReason?: string;
}

/** Options for `pollEndpointHealth`. */
export interface PollEndpointHealthOptions {
  /** Fully-qualified URL to GET (e.g., `https://app.azurefd.net/health`). */
  url: string;
  /** Inclusive timeout. */
  timeoutSeconds: number;
  /** Test seam — replace `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam — deterministic clock. */
  now?: () => number;
  /** Test seam — replace setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Override poll interval (default: 5000ms). */
  pollIntervalMs?: number;
}

const DEFAULT_POLL_MS = 5_000;
/** Cap how many probe entries we keep so the record stays small. */
const MAX_CHECKS = 5;

/**
 * Poll an HTTP endpoint until it returns 2xx or `timeoutSeconds` elapses.
 * Returns the last 5 probe entries (newest-last).
 */
export async function pollEndpointHealth(
  opts: PollEndpointHealthOptions,
): Promise<PollEndpointHealthResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;

  const start = now();
  const deadline = start + opts.timeoutSeconds * 1000;
  const checks: ProbeCheck[] = [];
  let lastReason = 'no-response';

  while (true) {
    let passed = false;
    let message = '';
    try {
      const resp = await fetchImpl(opts.url, { method: 'GET' });
      passed = resp.status >= 200 && resp.status < 300;
      message = `HTTP ${resp.status}`;
      if (!passed) lastReason = `http-${resp.status}`;
    } catch (err) {
      passed = false;
      message = (err as Error).message ?? String(err);
      lastReason = 'fetch-error';
    }
    checks.push({ name: 'GET ' + opts.url, passed, message });
    if (checks.length > MAX_CHECKS) checks.shift();
    if (passed) {
      return { healthy: true, checks };
    }
    if (now() >= deadline) {
      return { healthy: false, checks, unhealthyReason: lastReason };
    }
    await sleep(pollMs);
  }
}

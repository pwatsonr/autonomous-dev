/**
 * Chain telemetry emission (SPEC-022-2-04).
 *
 * The chain executor calls `emitChainTelemetry()` exactly once per chain
 * invocation in a `finally` block so both successful and failed chains are
 * observable downstream. Mirrors the fire-and-forget semantics of
 * `intake/reviewers/telemetry.ts`: the emitter never throws and never
 * blocks the caller.
 *
 * @module intake/chains/telemetry-emitter
 */

/** Coarse-grained chain disposition surfaced to the metrics pipeline. */
export type ChainTelemetryOutcome =
  | 'success'
  | 'failed'
  | 'paused'
  | 'blocked'
  | 'rejected';

/**
 * Per-chain telemetry envelope. Field order matches SPEC-022-2-04 §
 * "Telemetry Emission" verbatim so dashboards and alert rules built
 * against the spec parse the event without translation.
 */
export interface ChainTelemetryEvent {
  event: 'chain.completed';
  chain_id: string;
  request_id: string;
  /** Plugin ids in invocation order (producers before consumers). */
  plugins: string[];
  duration_ms: number;
  artifacts: Array<{
    id: string;
    type: string;
    size_bytes: number;
    requires_approval: boolean;
  }>;
  outcome: ChainTelemetryOutcome;
  /** Present iff `outcome` is not `success` and not `paused`. */
  error_type?: string;
}

/** Minimal metrics-client surface; production wires this to TDD-007. */
export interface ChainMetricsClient {
  emit(channel: string, payload: ChainTelemetryEvent): Promise<void> | void;
}

const TELEMETRY_CHANNEL = 'chain.completed';

let activeClient: ChainMetricsClient | undefined;

/**
 * Wire (or replace) the active chain-metrics client. Called once at boot
 * by the orchestrator wiring; tests call this in beforeEach to install a
 * recording mock and in afterEach to clear it.
 */
export function setChainMetricsClient(client: ChainMetricsClient | undefined): void {
  activeClient = client;
}

/** Test/diagnostic accessor; production code should not rely on this. */
export function getChainMetricsClient(): ChainMetricsClient | undefined {
  return activeClient;
}

/**
 * Emit one chain-telemetry event.
 *
 * Fire-and-forget contract:
 *   - Never throws (sync OR async).
 *   - Defers to `queueMicrotask` so a synchronous client cannot block the
 *     executor's hot path.
 *   - When no client is wired the call is a no-op so chains run cleanly
 *     under unit tests.
 */
export function emitChainTelemetry(event: ChainTelemetryEvent): void {
  const client = activeClient;
  if (client === undefined) return;
  queueMicrotask(() => {
    try {
      const result = client.emit(TELEMETRY_CHANNEL, event);
      if (result instanceof Promise) {
        result.catch(() => {
          // Swallow: telemetry failures must not affect chain flow.
        });
      }
    } catch {
      // Swallow synchronous throws too.
    }
  });
}

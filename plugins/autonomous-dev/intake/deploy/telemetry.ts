/**
 * Deploy telemetry emission (SPEC-023-2-04, extended in SPEC-023-3-02).
 *
 * Thin wrapper modelled on `intake/reviewers/telemetry.ts`:
 *   - fire-and-forget (never throws, never blocks)
 *   - sink injectable for tests via `setDeployMetricsClient`
 *   - locked event shapes:
 *       * DeployInitEvent / DeployCompletionEvent (orchestrator events,
 *         SPEC-023-2-04)
 *       * DeployLogEvent (per-line forwarding from `DeployLogger`,
 *         SPEC-023-3-02)
 *
 * @module intake/deploy/telemetry
 */

import type { DeployTelemetryAdapter } from './logger';
import type { ApprovalLevel } from './types-config';
import type { SelectionSource } from './selector';

export interface DeployInitEvent {
  type: 'deploy.init';
  requestId: string;
  envName: string;
  selectedBackend: string;
  source: SelectionSource;
  approvalRequirement: ApprovalLevel;
  costEstimate: number;
  ts: string;
}

export interface DeployCompletionEvent {
  type: 'deploy.completion';
  requestId: string;
  envName: string;
  selectedBackend: string;
  outcome: 'success' | 'failure' | 'rejected' | 'cost-cap-exceeded' | 'paused';
  durationMs: number | null;
  actualCostUsd: number;
  reason?: string;
  ts: string;
}

/**
 * Per-LogLine forwarding from `DeployLogger` (SPEC-023-3-02). Emitted on
 * every `info`/`warn`/`error` line (NOT `debug`). Mirrors the shape the
 * adapter receives via `DeployTelemetryAdapter.emit`.
 */
export interface DeployLogEvent {
  type: 'deploy.log';
  deployId: string;
  env: string;
  backend: string;
  name: string;
  timestamp: string;
  fields: Record<string, unknown>;
}

export type DeployEvent =
  | DeployInitEvent
  | DeployCompletionEvent
  | DeployLogEvent;

export interface DeployMetricsClient {
  emit(channel: string, payload: DeployEvent): Promise<void> | void;
}

const CHANNEL_INIT = 'deploy.init';
const CHANNEL_COMPLETION = 'deploy.completion';
const CHANNEL_LOG = 'deploy.log';

let activeClient: DeployMetricsClient | undefined;

export function setDeployMetricsClient(client: DeployMetricsClient | undefined): void {
  activeClient = client;
}
export function getDeployMetricsClient(): DeployMetricsClient | undefined {
  return activeClient;
}
export function resetDeployMetricsClient(): void {
  activeClient = undefined;
}

function emit(channel: string, ev: DeployEvent): void {
  const client = activeClient;
  if (client === undefined) return;
  queueMicrotask(() => {
    try {
      const result = client.emit(channel, ev);
      if (result instanceof Promise) {
        result.catch(() => undefined);
      }
    } catch {
      // Telemetry failures must never poison the deploy flow.
    }
  });
}

export function emitDeployInit(ev: DeployInitEvent): void {
  emit(CHANNEL_INIT, ev);
}
export function emitDeployCompletion(ev: DeployCompletionEvent): void {
  emit(CHANNEL_COMPLETION, ev);
}

/**
 * Forward one `DeployLogger` line to the active metrics client. Called
 * by `DeployTelemetry.emit` for every `info`/`warn`/`error` line.
 */
export function emitDeployLog(ev: DeployLogEvent): void {
  emit(CHANNEL_LOG, ev);
}

/**
 * Bridge `DeployLogger` ⇄ TDD-007 metrics. The logger calls
 * `adapter.emit({...})` synchronously after each successful disk write;
 * the adapter forwards to whatever `setDeployMetricsClient` was wired up
 * with at process start.
 *
 * Construct with no arguments for the production path (uses the active
 * client). Tests can pass a one-shot client via the constructor for
 * isolation.
 */
export class DeployTelemetry implements DeployTelemetryAdapter {
  private readonly oneShotClient?: DeployMetricsClient;

  constructor(client?: DeployMetricsClient) {
    this.oneShotClient = client;
  }

  emit(event: {
    deployId: string;
    env: string;
    backend: string;
    name: string;
    timestamp: string;
    fields: Record<string, unknown>;
  }): void {
    const payload: DeployLogEvent = {
      type: 'deploy.log',
      deployId: event.deployId,
      env: event.env,
      backend: event.backend,
      name: event.name,
      timestamp: event.timestamp,
      fields: event.fields,
    };
    if (this.oneShotClient) {
      // Test-mode shortcut — bypass the global active client.
      queueMicrotask(() => {
        try {
          const result = this.oneShotClient!.emit(CHANNEL_LOG, payload);
          if (result instanceof Promise) result.catch(() => undefined);
        } catch {
          /* swallow */
        }
      });
      return;
    }
    emitDeployLog(payload);
  }
}

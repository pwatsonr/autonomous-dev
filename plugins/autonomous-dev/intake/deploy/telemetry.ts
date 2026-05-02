/**
 * Deploy telemetry emission (SPEC-023-2-04).
 *
 * Thin wrapper modelled on `intake/reviewers/telemetry.ts`:
 *   - fire-and-forget (never throws, never blocks)
 *   - sink injectable for tests via `setDeployMetricsClient`
 *   - locked event shape (DeployInitEvent / DeployCompletionEvent)
 *
 * @module intake/deploy/telemetry
 */

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

export type DeployEvent = DeployInitEvent | DeployCompletionEvent;

export interface DeployMetricsClient {
  emit(channel: string, payload: DeployEvent): Promise<void> | void;
}

const CHANNEL_INIT = 'deploy.init';
const CHANNEL_COMPLETION = 'deploy.completion';

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

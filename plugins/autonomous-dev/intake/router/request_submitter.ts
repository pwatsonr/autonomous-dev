/**
 * Producer-side bridge from the intake-router into the two-phase commit
 * `submitRequest` (SPEC-012-1-02 §"Request Submission").
 *
 * Responsibilities:
 *  - Build the initial state via `buildInitialState`.
 *  - Invoke `submitRequest` (SPEC-012-1-01).
 *  - On success: emit `request.submitted` on the typed event bus exactly
 *    once.
 *  - On failure: log a structured error at the appropriate level; NEVER
 *    emit `request.submitted`.
 *
 * The router intentionally does NOT retry — retry policy belongs to the
 * caller (e.g., the adapter that surfaced the original input).
 *
 * @module router/request_submitter
 */

import {
  type HandoffOptions,
  type HandoffResult,
  type SubmitRequest,
  submitRequest,
} from '../core/handoff_manager';
import type { TypedEventBus } from '../events/event_bus';

// ---------------------------------------------------------------------------
// Event-bus injection
// ---------------------------------------------------------------------------

/**
 * Optional event bus for surfacing router-level events. In production this
 * is the intake layer's singleton TypedEventBus; tests inject a mock.
 *
 * The bus is intentionally kept narrow — the only events this module emits
 * are `request.submitted` and `request.cancelled`. Both ride the existing
 * `intake` channel as discriminated `{type: ...}` objects so they do NOT
 * require an extension to `EventMap`.
 */
let injectedBus: TypedEventBus | null = null;

/**
 * Test/integration override: install a typed event bus. Pass `null` to
 * clear (the module then emits to console.log for forensics).
 */
export function setEventBusForRouter(bus: TypedEventBus | null): void {
  injectedBus = bus;
}

/**
 * Internal: emit a router event. We use the existing `intake` channel
 * with a custom shape (`{type: 'request_submitted', ...}`). If no bus is
 * injected, falls back to a structured console log so operators still
 * see the event in daemon logs.
 */
function emitRouterEvent(payload: { type: string } & Record<string, unknown>): void {
  if (injectedBus) {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    void (injectedBus as any).emit('intake', payload);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return;
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event: `router.${payload.type}`, ...payload }));
}

// ---------------------------------------------------------------------------
// submitFromRouter
// ---------------------------------------------------------------------------

/**
 * Producer-side entry point for the intake router.
 *
 * Behaviour matrix (SPEC-012-1-02 §"Request Submission"):
 *   - ok: true                       → emit `request.submitted` once.
 *   - ok: false, recoverable: true   → log warn; NO event emitted.
 *   - ok: false, recoverable: false  → log error; NO event emitted.
 */
export async function submitFromRouter(
  req: SubmitRequest,
  opts?: HandoffOptions,
): Promise<HandoffResult> {
  const result = await submitRequest(req, opts);

  if (result.ok) {
    emitRouterEvent({
      type: 'request_submitted',
      requestId: result.requestId,
      source: req.source,
      committedAt: result.committedAt,
    });
    return result;
  }

  // Failure path: log without emitting.
  const level = result.recoverable ? 'warn' : 'error';
  // eslint-disable-next-line no-console
  console[level === 'warn' ? 'warn' : 'error'](
    JSON.stringify({
      event: 'router.submit_failed',
      requestId: result.requestId,
      failureMode: result.failureMode,
      recoverable: result.recoverable,
      error: result.error,
    }),
  );
  return result;
}

// ---------------------------------------------------------------------------
// emitRequestCancelled (used by handoff_manager.cancelRequest)
// ---------------------------------------------------------------------------

/**
 * Emit `request.cancelled` AFTER the cancel rename has succeeded.
 * Wired from `handoff_manager.cancelRequest` via lazy `require` to avoid a
 * circular dependency at module load.
 */
export function emitRequestCancelled(requestId: string, reason?: string): void {
  emitRouterEvent({
    type: 'request_cancelled',
    requestId,
    reason: reason ?? null,
  });
}

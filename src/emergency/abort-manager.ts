/**
 * Global and per-request AbortController manager for the emergency subsystem.
 *
 * The AbortManager is the bridge between the kill switch and pipeline
 * executors. Executors register to receive an AbortSignal that fires when
 * either the global kill switch is activated OR their specific request is
 * cancelled. The composite signal pattern ensures a single signal check
 * covers both cases.
 *
 * Lifecycle:
 *   1. Pipeline executor calls `registerRequest(id)` and gets a signal.
 *   2. Executor periodically checks `signal.aborted` at phase boundaries.
 *   3. On normal completion, executor calls `deregisterRequest(id)`.
 *   4. On kill/cancel, the signal fires and the executor tears down.
 *   5. After re-enable, `reset()` creates a fresh global controller.
 *
 * Based on SPEC-009-4-1 (TDD Section 3.3).
 */

import type { AbortReason } from "./types";

// ---------------------------------------------------------------------------
// Composite signal helper
// ---------------------------------------------------------------------------

/**
 * Create an AbortSignal that aborts when EITHER the global signal OR the
 * per-request signal is aborted.
 *
 * Implementation: derives a third AbortController that listens to both
 * parent signals. If either parent is already aborted at construction
 * time, the composite is aborted immediately.
 */
function createCompositeSignal(
  global: AbortSignal,
  request: AbortSignal,
): AbortSignal {
  const composite = new AbortController();

  const onAbort = () => composite.abort();
  global.addEventListener("abort", onAbort, { once: true });
  request.addEventListener("abort", onAbort, { once: true });

  // If either is already aborted, abort immediately
  if (global.aborted || request.aborted) {
    composite.abort();
  }

  return composite.signal;
}

// ---------------------------------------------------------------------------
// AbortManager
// ---------------------------------------------------------------------------

/**
 * Manages a global AbortController and per-request AbortControllers.
 *
 * Every registered request receives a composite signal derived from the
 * global controller and its own controller. Aborting the global controller
 * (via `abortAll`) cascades to every active request. Aborting a single
 * request's controller (via `abortRequest`) affects only that request.
 */
export class AbortManager {
  private globalController: AbortController;
  private requestControllers: Map<string, AbortController>;

  constructor() {
    this.globalController = new AbortController();
    this.requestControllers = new Map();
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register a pipeline request and receive a composite AbortSignal.
   *
   * If the system is currently halted (global signal already aborted),
   * the returned signal will be pre-aborted, preventing new work from
   * starting.
   *
   * @param requestId  Unique identifier for the pipeline request.
   * @returns A composite AbortSignal that fires on global OR per-request abort.
   */
  registerRequest(requestId: string): AbortSignal {
    const requestController = new AbortController();
    this.requestControllers.set(requestId, requestController);

    return createCompositeSignal(
      this.globalController.signal,
      requestController.signal,
    );
  }

  /**
   * Deregister a request that completed normally.
   *
   * Removes the per-request controller from the map without triggering
   * an abort. The previously returned signal remains in whatever state
   * it was in (not aborted if the request completed normally).
   *
   * @param requestId  The request to deregister.
   */
  deregisterRequest(requestId: string): void {
    this.requestControllers.delete(requestId);
  }

  // -------------------------------------------------------------------------
  // Abort operations
  // -------------------------------------------------------------------------

  /**
   * Abort every registered request by aborting the global controller.
   *
   * All composite signals derived from the global controller will fire.
   * The per-request controllers are NOT cleared -- snapshots may still
   * need to reference them.
   *
   * Calling this multiple times is idempotent: the global controller
   * only aborts once and subsequent calls are no-ops.
   *
   * @param reason  The abort reason propagated to signal listeners.
   */
  abortAll(reason: AbortReason): void {
    if (!this.globalController.signal.aborted) {
      this.globalController.abort(reason);
    }
  }

  /**
   * Abort a single request without affecting others.
   *
   * If the requestId is not registered, this is a silent no-op.
   *
   * @param requestId  The request to abort.
   * @param reason     The abort reason propagated to signal listeners.
   */
  abortRequest(requestId: string, reason: AbortReason): void {
    const controller = this.requestControllers.get(requestId);
    if (controller && !controller.signal.aborted) {
      controller.abort(reason);
    }
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  /**
   * Get the IDs of all currently registered (active) requests.
   *
   * @returns Array of request IDs in insertion order.
   */
  getActiveRequestIds(): string[] {
    return Array.from(this.requestControllers.keys());
  }

  /**
   * Check whether the global signal has been aborted.
   *
   * @returns `true` if `abortAll` has been called and the system is halted.
   */
  isAborted(): boolean {
    return this.globalController.signal.aborted;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Reset the manager to a clean state after the system is re-enabled.
   *
   * Creates a fresh global AbortController and clears the per-request
   * controller map. New registrations will receive non-aborted signals.
   */
  reset(): void {
    this.globalController = new AbortController();
    this.requestControllers.clear();
  }
}

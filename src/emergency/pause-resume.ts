/**
 * Pause/Resume controller for lighter-weight execution control (SPEC-009-4-3, Task 6).
 *
 * Provides a reversible stop mechanism that does NOT trigger the HALTED state
 * gate. Unlike kill, pause:
 *   - Stops execution at the next phase boundary (not at atomic boundary).
 *   - Does NOT capture state snapshots.
 *   - Does NOT cancel pending escalations.
 *   - Does NOT require human re-enable ceremony (just `/resume`).
 *   - Supports both global and per-request scope.
 *
 * Pause signals are conveyed through the abort mechanism with a "PAUSE" reason.
 * Pipeline executors should check the abort reason to distinguish between
 * PAUSE (stop and wait) and KILL_* (stop permanently).
 *
 * Audit events: `pause_issued` and `resume_issued`.
 */

import type { AbortManagerPort, AuditTrail } from "./kill-switch";
import type { PauseResumeResult } from "./types";

// ---------------------------------------------------------------------------
// PauseResumeController
// ---------------------------------------------------------------------------

/**
 * Controls pause and resume of pipeline execution.
 *
 * Internal state:
 *   - `pausedRequests: Set<string>` tracks individually paused requests.
 *   - `globallyPaused: boolean` tracks the global pause flag.
 *
 * All dependencies are constructor-injected for testability.
 */
export class PauseResumeController {
  private pausedRequests: Set<string> = new Set();
  private globallyPaused: boolean = false;

  constructor(
    private readonly abortManager: AbortManagerPort,
    private readonly auditTrail: AuditTrail,
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Pause all pipelines (global) or a specific request.
   *
   * Global pause:
   *   - Sets `globallyPaused = true`.
   *   - Sends PAUSE abort signal to all active requests.
   *   - Affected requests = all active request IDs.
   *
   * Per-request pause:
   *   - Adds the request to `pausedRequests`.
   *   - Sends PAUSE abort signal to only that request.
   *   - Affected requests = [requestId].
   *
   * @param issuedBy   Identity of the person/system issuing the pause.
   * @param requestId  Optional: pause only this request. Omit for global pause.
   * @returns PauseResumeResult describing what was paused.
   */
  pause(issuedBy: string, requestId?: string): PauseResumeResult {
    const issuedAt = new Date();

    if (requestId !== undefined) {
      // Per-request pause
      this.pausedRequests.add(requestId);
      this.abortManager.abortRequest(requestId, "PAUSE");

      const result: PauseResumeResult = {
        requestId,
        action: "paused",
        issuedBy,
        issuedAt,
        affectedRequests: [requestId],
      };

      this.auditTrail.append({
        event_type: "pause_issued",
        payload: {
          issuedBy,
          requestId,
          scope: "request",
          affectedRequests: [requestId],
        },
      });

      return result;
    }

    // Global pause
    this.globallyPaused = true;
    const activeIds = this.abortManager.getActiveRequestIds();
    this.abortManager.abortAll("PAUSE");

    const result: PauseResumeResult = {
      action: "paused",
      issuedBy,
      issuedAt,
      affectedRequests: activeIds,
    };

    this.auditTrail.append({
      event_type: "pause_issued",
      payload: {
        issuedBy,
        scope: "global",
        affectedRequests: activeIds,
      },
    });

    return result;
  }

  /**
   * Resume paused pipelines (global) or a specific request.
   *
   * Global resume:
   *   - Sets `globallyPaused = false`.
   *   - Resets the abort manager so executors can re-register with fresh signals.
   *   - Affected requests = all active request IDs at time of resume.
   *
   * Per-request resume:
   *   - Removes the request from `pausedRequests`.
   *   - Affected requests = [requestId].
   *
   * @param issuedBy   Identity of the person/system issuing the resume.
   * @param requestId  Optional: resume only this request. Omit for global resume.
   * @returns PauseResumeResult describing what was resumed.
   */
  resume(issuedBy: string, requestId?: string): PauseResumeResult {
    const issuedAt = new Date();

    if (requestId !== undefined) {
      // Per-request resume
      this.pausedRequests.delete(requestId);

      const result: PauseResumeResult = {
        requestId,
        action: "resumed",
        issuedBy,
        issuedAt,
        affectedRequests: [requestId],
      };

      this.auditTrail.append({
        event_type: "resume_issued",
        payload: {
          issuedBy,
          requestId,
          scope: "request",
          affectedRequests: [requestId],
        },
      });

      return result;
    }

    // Global resume
    this.globallyPaused = false;
    const activeIds = this.abortManager.getActiveRequestIds();
    this.abortManager.reset();

    const result: PauseResumeResult = {
      action: "resumed",
      issuedBy,
      issuedAt,
      affectedRequests: activeIds,
    };

    this.auditTrail.append({
      event_type: "resume_issued",
      payload: {
        issuedBy,
        scope: "global",
        affectedRequests: activeIds,
      },
    });

    return result;
  }

  /**
   * Check if a specific request is paused.
   *
   * A request is considered paused if:
   *   - It is in the `pausedRequests` set (individually paused), OR
   *   - The system is globally paused.
   *
   * @param requestId  The request to check.
   * @returns `true` if the request is paused.
   */
  isPaused(requestId: string): boolean {
    return this.globallyPaused || this.pausedRequests.has(requestId);
  }

  /**
   * Check if all pipelines are globally paused.
   *
   * @returns `true` if a global pause is active.
   */
  isGloballyPaused(): boolean {
    return this.globallyPaused;
  }
}

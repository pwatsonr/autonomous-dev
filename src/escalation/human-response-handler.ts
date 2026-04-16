/**
 * Human Response Handler Facade (SPEC-009-3-4, Task 8).
 *
 * Orchestrates the full parse -> validate -> resolve -> resume flow for
 * human responses to escalations. This is the single entry point that
 * callers use to process a human's response to a pending escalation.
 *
 * Error feedback messages are human-readable and actionable:
 *
 *   Error Code                  | Message
 *   --------------------------- | -----------------------------------------------
 *   ESCALATION_NOT_FOUND        | Escalation {id} not found. It may have been resolved or expired.
 *   ESCALATION_ALREADY_RESOLVED | Escalation {id} has already been resolved.
 *   INVALID_OPTION_ID           | Option {id} is not valid. Available options: {list}
 *   UNKNOWN_DELEGATE_TARGET     | Target {target} is not recognized. Known targets: {list}
 *   REQUEST_CANCELLED           | Request has been cancelled. No action can be taken.
 *   RESUME_FAILED               | Failed to resume pipeline: {error}. Please try again.
 */

import type { ResponseParser } from "./response-parser";
import type { ResponseValidator, EscalationStore } from "./response-validator";
import type { ActionResolver } from "./action-resolver";
import type { PipelineResumptionCoordinator, ResumeResult } from "./pipeline-resumption";
import type { ReEscalationManager } from "./re-escalation-manager";
import type { AuditTrail } from "./types";
import type { ResolvedAction, ResponseValidationError } from "./response-types";

// ---------------------------------------------------------------------------
// HandleResult type
// ---------------------------------------------------------------------------

/** Result of handling a human response to an escalation. */
export type HandleResult =
  | { success: true; action: ResolvedAction; resumeResult: ResumeResult }
  | { success: false; error: ResponseValidationError };

// ---------------------------------------------------------------------------
// Error message builders (Error Feedback Message Table)
// ---------------------------------------------------------------------------

/**
 * Build a human-readable error from a ResponseValidationError.
 *
 * Maps error codes to the message templates defined in the spec.
 */
function buildErrorMessage(error: ResponseValidationError): ResponseValidationError {
  // The validator already provides messages, but we ensure they conform
  // to the spec's error feedback table format. Return as-is since the
  // validator messages are already human-readable and actionable.
  return error;
}

// ---------------------------------------------------------------------------
// HumanResponseHandler
// ---------------------------------------------------------------------------

/**
 * Facade that orchestrates the full human response handling flow.
 *
 * All dependencies are constructor-injected for testability.
 */
export class HumanResponseHandler {
  constructor(
    private readonly parser: ResponseParser,
    private readonly validator: ResponseValidator,
    private readonly actionResolver: ActionResolver,
    private readonly resumption: PipelineResumptionCoordinator,
    private readonly reEscalation: ReEscalationManager,
    private readonly auditTrail: AuditTrail,
    private readonly escalationStore: EscalationStore,
  ) {}

  /**
   * Handle a raw human response to an escalation.
   *
   * Algorithm:
   *   1. Parse raw input into a typed response.
   *   2. If parse fails, return structured error.
   *   3. Validate the parsed response for actionability.
   *   4. If validation fails, return structured error.
   *   5. Look up the stored escalation.
   *   6. Resolve the validated response into a pipeline action.
   *   7. Emit `escalation_response_received` audit event.
   *   8. Resume (or terminate) the pipeline.
   *   9. If resumption fails, return RESUME_FAILED error.
   *  10. Return success with action and resume result.
   *
   * @param rawInput      The raw input string from the human.
   * @param escalationId  The escalation this response is for.
   * @param responder     Who provided the response (user ID or name).
   * @returns A HandleResult indicating success or failure.
   */
  handleResponse(
    rawInput: string,
    escalationId: string,
    responder: string,
  ): HandleResult {
    // Step 1: Parse
    const parseResult = this.parser.parse(rawInput, escalationId, responder);

    // Step 2: Parse failure
    if (!parseResult.success) {
      return { success: false, error: buildErrorMessage(parseResult.error) };
    }

    // Step 3: Validate
    const validationResult = this.validator.validate(parseResult.response);

    // Step 4: Validation failure
    if (!validationResult.valid) {
      return { success: false, error: buildErrorMessage(validationResult.error) };
    }

    // Step 5: Look up stored escalation
    const escalation = this.escalationStore.getEscalation(escalationId);
    if (!escalation) {
      return {
        success: false,
        error: {
          code: "ESCALATION_NOT_FOUND",
          message: `Escalation ${escalationId} not found. It may have been resolved or expired.`,
        },
      };
    }

    // Step 6: Resolve action
    const action = this.actionResolver.resolve(
      validationResult.response,
      escalation,
    );

    // Step 7: Emit audit event before resumption attempt
    void this.auditTrail.append({
      event_type: "escalation_response_received",
      payload: {
        escalation_id: escalationId,
        responder,
        response_type: validationResult.response.response_type,
        action: action.action,
      },
    });

    // Step 8: Resume pipeline
    const resumeResult = this.resumption.resume(escalation, action, responder);

    // Step 9: Resumption failure -- escalation remains active for retry
    if (!resumeResult.success) {
      return {
        success: false,
        error: {
          code: "RESUME_FAILED",
          message: `Failed to resume pipeline: ${resumeResult.error}. Please try again.`,
        },
      };
    }

    // Step 10: Success
    return { success: true, action, resumeResult };
  }
}

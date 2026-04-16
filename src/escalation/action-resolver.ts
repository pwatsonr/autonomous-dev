/**
 * Action Resolver for the escalation subsystem (SPEC-009-3-2, Task 4).
 *
 * Maps a validated EscalationResponse to one of 5 pipeline actions
 * (the ResolvedAction discriminated union). The mapping depends on the
 * response type and, for option responses, on the option's `action` field
 * from the stored escalation.
 *
 * Mapping rules:
 *
 *   Response Type | Option Action                     | Resolved Action
 *   ------------- | --------------------------------- | -------------------------
 *   option        | "approve"                         | { action: "approve" }
 *   option        | "retry" / "retry_with_changes"    | { action: "retry_with_changes", guidance }
 *   option        | "cancel" / "reject"               | { action: "cancel" }
 *   option        | "override"                        | { action: "override_proceed", justification }
 *   option        | "approve_with_conditions"         | { action: "retry_with_changes", guidance }
 *   freetext      | (always)                          | { action: "retry_with_changes", guidance }
 *   delegate      | (always)                          | { action: "delegate", target }
 *
 * Key distinction: `approve` and `override_proceed` both allow the pipeline
 * to continue, but `override_proceed` is logged as a `human_override` audit
 * event. It is used when the human explicitly overrides a system recommendation.
 */

import type { EscalationResponse, ResolvedAction } from "./response-types";
import type { StoredEscalation } from "./response-validator";

// ---------------------------------------------------------------------------
// ActionResolver
// ---------------------------------------------------------------------------

/**
 * Resolves a validated human response into a concrete pipeline action.
 *
 * This class is stateless and safe to share across concurrent calls.
 */
export class ActionResolver {
  /**
   * Map a validated response to a resolved pipeline action.
   *
   * @param response   The validated human response.
   * @param escalation The stored escalation record (needed to look up the
   *                   selected option's `action` field for option responses).
   * @returns The resolved action for the pipeline resumption coordinator.
   * @throws Error if the response type is "option" and the option ID cannot
   *         be found in the escalation's options (should not happen after
   *         validation, but guard defensively).
   */
  resolve(response: EscalationResponse, escalation: StoredEscalation): ResolvedAction {
    switch (response.response_type) {
      case "option":
        return this.resolveOptionResponse(response, escalation);

      case "freetext":
        return {
          action: "retry_with_changes",
          guidance: response.freetext ?? "",
        };

      case "delegate":
        return {
          action: "delegate",
          target: response.delegate_target ?? "",
        };

      default: {
        // Exhaustiveness guard -- should never be reached with valid input
        const _exhaustive: never = response.response_type;
        throw new Error(`Unknown response type: ${_exhaustive}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve an option response by looking up the option's `action` field
   * in the stored escalation and mapping it to the appropriate ResolvedAction.
   */
  private resolveOptionResponse(
    response: EscalationResponse,
    escalation: StoredEscalation,
  ): ResolvedAction {
    const option = escalation.options.find(
      (opt) => opt.option_id === response.option_id,
    );

    if (!option) {
      throw new Error(
        `Option "${response.option_id}" not found in escalation "${escalation.escalationId}". ` +
          `This should not happen after validation.`,
      );
    }

    switch (option.action) {
      case "approve":
        return { action: "approve" };

      case "retry":
      case "retry_with_changes":
        return {
          action: "retry_with_changes",
          guidance: option.description ?? "",
        };

      case "cancel":
      case "reject":
        return { action: "cancel" };

      case "override":
        return {
          action: "override_proceed",
          justification: option.description ?? "No justification provided",
        };

      case "approve_with_conditions":
        return {
          action: "retry_with_changes",
          guidance: option.description ?? "",
        };

      default:
        // Unknown option action -- treat as retry_with_changes with guidance
        // from description. This provides a sensible fallback for future
        // option actions without breaking existing behavior.
        return {
          action: "retry_with_changes",
          guidance: option.description ?? "",
        };
    }
  }
}

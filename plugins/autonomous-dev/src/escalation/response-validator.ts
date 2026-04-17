/**
 * Response Validator for the escalation subsystem (SPEC-009-3-1, Task 3).
 *
 * Validates that a parsed EscalationResponse is actionable by checking:
 *
 *   1. Escalation exists in the store
 *   2. Escalation status is "pending"
 *   3. Request has not been cancelled via kill switch
 *   4. (option) The selected option_id is valid
 *   5. (delegate) The delegate_target is a known routing target
 *   6. (freetext) The freetext is non-empty after trim
 *
 * Checks are evaluated in order; the first failure short-circuits.
 */

import type { EscalationConfig, EscalationOption } from "./types";
import type { EscalationResponse, ValidationResult, ResponseValidationError } from "./response-types";

// ---------------------------------------------------------------------------
// Dependency interfaces
// ---------------------------------------------------------------------------

/** Minimal interface for querying escalation state. */
export interface EscalationStore {
  getEscalation(escalationId: string): StoredEscalation | null;
}

/** A stored escalation record with its current status and options. */
export interface StoredEscalation {
  escalationId: string;
  requestId: string;
  status: "pending" | "resolved" | "cancelled";
  options: EscalationOption[];
  /** The pipeline gate that triggered this escalation. */
  gate?: string;
}

/** Minimal interface for kill switch queries. */
export interface KillSwitchQuery {
  isRequestCancelled(requestId: string): boolean;
}

// ---------------------------------------------------------------------------
// ResponseValidator
// ---------------------------------------------------------------------------

/**
 * Validates that a parsed response is actionable given the current system state.
 */
export class ResponseValidator {
  constructor(
    private readonly escalationStore: EscalationStore,
    private readonly routingConfig: EscalationConfig,
    private readonly killSwitch: KillSwitchQuery,
  ) {}

  /**
   * Validate an EscalationResponse for actionability.
   *
   * @param response  The parsed response to validate.
   * @returns A ValidationResult indicating success or the first validation error.
   */
  validate(response: EscalationResponse): ValidationResult {
    // 1. Escalation exists
    const escalation = this.escalationStore.getEscalation(response.escalation_id);
    if (escalation === null) {
      return {
        valid: false,
        error: {
          code: "ESCALATION_NOT_FOUND",
          message: `Escalation "${response.escalation_id}" not found.`,
        },
      };
    }

    // 2. Escalation is pending
    if (escalation.status !== "pending") {
      return {
        valid: false,
        error: {
          code: "ESCALATION_ALREADY_RESOLVED",
          message: `Escalation "${response.escalation_id}" is already ${escalation.status}.`,
        },
      };
    }

    // 3. Request not cancelled via kill switch
    if (this.killSwitch.isRequestCancelled(escalation.requestId)) {
      return {
        valid: false,
        error: {
          code: "REQUEST_CANCELLED",
          message: `Request "${escalation.requestId}" has been cancelled.`,
        },
      };
    }

    // 4. Option response: option_id must exist in escalation's options
    if (response.response_type === "option") {
      const validOptionIds = escalation.options.map((o) => o.option_id);
      if (!response.option_id || !validOptionIds.includes(response.option_id)) {
        return {
          valid: false,
          error: {
            code: "INVALID_OPTION_ID",
            message: `Option "${response.option_id}" is not a valid option for escalation "${response.escalation_id}".`,
            availableOptions: escalation.options,
          },
        };
      }
    }

    // 5. Delegate response: delegate_target must be a known routing target
    if (response.response_type === "delegate") {
      const knownTargets = this.extractKnownTargets();
      if (!response.delegate_target || !knownTargets.includes(response.delegate_target)) {
        return {
          valid: false,
          error: {
            code: "UNKNOWN_DELEGATE_TARGET",
            message: `Delegate target "${response.delegate_target}" is not a known routing target.`,
            knownTargets,
          },
        };
      }
    }

    // 6. Freetext response: must be non-empty after trim
    if (response.response_type === "freetext") {
      if (!response.freetext || response.freetext.trim().length === 0) {
        return {
          valid: false,
          error: {
            code: "INVALID_OPTION_ID",
            message: "Empty free-text response not allowed",
          },
        };
      }
    }

    // All checks passed
    return { valid: true, response };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Extract all known routing target IDs from the escalation config.
   *
   * Includes the default target and all primary/secondary targets from
   * advanced routing configuration.
   */
  private extractKnownTargets(): string[] {
    const targets = new Set<string>();

    // Default target
    targets.add(this.routingConfig.routing.default_target.target_id);

    // Advanced routing targets
    if (this.routingConfig.routing.advanced) {
      for (const entry of Object.values(this.routingConfig.routing.advanced)) {
        targets.add(entry.primary.target_id);
        if (entry.secondary) {
          targets.add(entry.secondary.target_id);
        }
      }
    }

    return Array.from(targets);
  }
}

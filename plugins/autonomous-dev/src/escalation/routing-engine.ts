/**
 * Routing Engine for the escalation subsystem.
 *
 * Resolves escalation types to concrete routing targets with timeout
 * configuration. Supports two modes:
 *
 * - **default**: All escalation types route to `config.routing.default_target`
 *   with a 60-minute timeout and "pause" timeout behavior.
 * - **advanced**: Each escalation type can have a dedicated primary target,
 *   optional secondary target, custom timeout, and custom timeout behavior.
 *   Types without explicit config fall back to `default_target`.
 *
 * Security invariant: `security` escalation type always forces
 * `timeoutBehavior = "pause"` regardless of what the config says.
 *
 * Based on SPEC-009-2-3 (TDD-009 Sections 3.2, 3.3).
 */

import type {
  EscalationConfig,
  EscalationType,
  ResolvedRoute,
  TimeoutBehavior,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout (minutes) when no advanced config overrides it. */
const DEFAULT_TIMEOUT_MINUTES = 60;

/** Default timeout behavior when no advanced config overrides it. */
const DEFAULT_TIMEOUT_BEHAVIOR: TimeoutBehavior = "pause";

// ---------------------------------------------------------------------------
// RoutingEngine
// ---------------------------------------------------------------------------

/**
 * Determines the human target for each escalation type.
 *
 * All dependencies are provided via the constructor -- no singletons.
 *
 * @param config           The escalation config (routing section is used).
 * @param knownTargetIds   Optional set of target IDs that are considered
 *                         "known" / reachable. When provided, any resolved
 *                         primary target whose `target_id` is not in this set
 *                         will be replaced with `default_target` and a
 *                         warning will be logged. When omitted, all targets
 *                         are assumed to be valid.
 */
export class RoutingEngine {
  private readonly knownTargetIds: Set<string> | null;

  constructor(
    private readonly config: EscalationConfig,
    knownTargetIds?: string[],
  ) {
    this.knownTargetIds = knownTargetIds
      ? new Set(knownTargetIds)
      : null;
  }

  /**
   * Resolve the routing for a given escalation type.
   *
   * Algorithm (per SPEC-009-2-3):
   *
   * 1. If `mode === "default"`: return default_target with default timeout.
   * 2. If `mode === "advanced"`:
   *    a. Look up `config.routing.advanced[escalationType]`.
   *    b. If found: use the configured primary, secondary, timeout, behavior.
   *    c. If NOT found: fall back to default_target, log warning.
   * 3. If the resolved primary target is unknown: fall back to default_target.
   * 4. Security invariant: force `timeoutBehavior = "pause"`.
   */
  resolveRouting(escalationType: EscalationType): ResolvedRoute {
    let route: ResolvedRoute;

    if (this.config.routing.mode === "default") {
      route = this.resolveDefault();
    } else {
      route = this.resolveAdvanced(escalationType);
    }

    // Step 3: Unknown primary target falls back to default_target
    if (this.knownTargetIds !== null && !this.knownTargetIds.has(route.primary.target_id)) {
      console.warn(
        `[RoutingEngine] Primary target "${route.primary.target_id}" is not a known target. ` +
          `Falling back to default_target "${this.config.routing.default_target.target_id}".`,
      );
      route = {
        ...route,
        primary: this.config.routing.default_target,
      };
    }

    // Step 4: Security invariant -- always force pause
    if (escalationType === "security") {
      if (route.timeoutBehavior !== "pause") {
        console.warn(
          `[RoutingEngine] Security escalation timeout behavior forced to "pause" ` +
            `(was "${route.timeoutBehavior}").`,
        );
      }
      route = {
        ...route,
        timeoutBehavior: "pause",
      };
    }

    return route;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Resolve using default mode: single target for all types. */
  private resolveDefault(): ResolvedRoute {
    return {
      primary: this.config.routing.default_target,
      secondary: undefined,
      timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
      timeoutBehavior: DEFAULT_TIMEOUT_BEHAVIOR,
    };
  }

  /** Resolve using advanced mode: per-type lookup with fallback. */
  private resolveAdvanced(escalationType: EscalationType): ResolvedRoute {
    const advancedConfig = this.config.routing.advanced;

    if (!advancedConfig || !(escalationType in advancedConfig)) {
      // Type not configured in advanced mode -- fall back to default_target
      console.warn(
        `[RoutingEngine] No advanced routing config for escalation type "${escalationType}". ` +
          `Falling back to default_target "${this.config.routing.default_target.target_id}".`,
      );
      return {
        primary: this.config.routing.default_target,
        secondary: undefined,
        timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
        timeoutBehavior: DEFAULT_TIMEOUT_BEHAVIOR,
      };
    }

    const entry = advancedConfig[escalationType];
    return {
      primary: entry.primary,
      secondary: entry.secondary,
      timeoutMinutes: entry.timeout_minutes,
      timeoutBehavior: entry.timeout_behavior,
    };
  }
}

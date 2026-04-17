/**
 * Escalation Configuration Loader (SPEC-009-2-4, Task 7).
 *
 * Parses and validates the `escalation:` YAML section from the plugin
 * config system. Supports the same ConfigProvider abstraction used by
 * the trust subsystem.
 *
 * Validation rules:
 *   - routing.mode must be "default" or "advanced" (invalid -> "default")
 *   - routing.default_target must be present with target_id and channel
 *     (missing -> fatal error, system cannot start)
 *   - routing.advanced per-type entries:
 *       - timeout_minutes must be positive integer (default: 60)
 *       - timeout_behavior must be one of 4 valid values (default: "pause")
 *   - Security invariant: routing.advanced.security.timeout_behavior is
 *     forced to "pause" regardless of config value
 *   - verbosity must be "terse" | "standard" | "verbose" (default: "standard")
 *   - retry_budget must be positive integer (default: 3)
 */

import type {
  ConfigProvider,
  EscalationConfig,
  EscalationType,
  RoutingMode,
  RoutingTarget,
  TimeoutBehavior,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_ROUTING_MODES: ReadonlySet<string> = new Set(["default", "advanced"]);
const VALID_TIMEOUT_BEHAVIORS: ReadonlySet<string> = new Set([
  "pause",
  "retry",
  "skip",
  "cancel",
]);
const VALID_VERBOSITY_LEVELS: ReadonlySet<string> = new Set([
  "terse",
  "standard",
  "verbose",
]);
const ESCALATION_TYPES: readonly EscalationType[] = [
  "product",
  "technical",
  "infrastructure",
  "security",
  "cost",
  "quality",
];
const DEFAULT_TIMEOUT_MINUTES = 60;
const DEFAULT_TIMEOUT_BEHAVIOR: TimeoutBehavior = "pause";
const DEFAULT_VERBOSITY: EscalationConfig["verbosity"] = "standard";
const DEFAULT_RETRY_BUDGET = 3;

// ---------------------------------------------------------------------------
// EscalationConfigLoader
// ---------------------------------------------------------------------------

/**
 * Loads, validates, and returns the escalation configuration.
 *
 * Unlike the trust config loader, this does not support hot-reload --
 * the escalation config is loaded once at engine creation time. If
 * hot-reload is needed in the future, the same pattern as
 * TrustConfigLoader can be adopted.
 */
export class EscalationConfigLoader {
  constructor(private readonly configProvider: ConfigProvider) {}

  /**
   * Parse and validate the escalation config from the config provider.
   *
   * @returns The validated EscalationConfig.
   * @throws Error if routing.default_target is missing (fatal).
   */
  load(): EscalationConfig {
    const raw = this.configProvider.getEscalationSection();

    if (raw === undefined || raw === null || typeof raw !== "object") {
      throw new Error(
        "[EscalationConfigLoader] Escalation config section is missing or invalid. " +
          "The system cannot start without a valid escalation config.",
      );
    }

    return this.validate(raw);
  }

  // -------------------------------------------------------------------------
  // Private validation
  // -------------------------------------------------------------------------

  private validate(raw: Record<string, unknown>): EscalationConfig {
    const routing = this.validateRouting(raw.routing);
    const verbosity = this.validateVerbosity(raw.verbosity);
    const retryBudget = this.validateRetryBudget(raw.retry_budget);

    return { routing, verbosity, retry_budget: retryBudget };
  }

  // -------------------------------------------------------------------------
  // Routing validation
  // -------------------------------------------------------------------------

  private validateRouting(
    value: unknown,
  ): EscalationConfig["routing"] {
    if (value === undefined || value === null || typeof value !== "object") {
      throw new Error(
        "[EscalationConfigLoader] routing section is missing or invalid. " +
          "The system cannot start without routing configuration.",
      );
    }

    const raw = value as Record<string, unknown>;

    // Validate mode
    let mode: RoutingMode = "default";
    if (typeof raw.mode === "string" && VALID_ROUTING_MODES.has(raw.mode)) {
      mode = raw.mode as RoutingMode;
    } else if (raw.mode !== undefined) {
      console.warn(
        `[EscalationConfigLoader] Invalid routing.mode: ${JSON.stringify(raw.mode)}. ` +
          `Falling back to "default".`,
      );
    }

    // Validate default_target (REQUIRED -- fatal if missing)
    const defaultTarget = this.validateDefaultTarget(raw.default_target);

    // Validate advanced config (optional)
    const advanced =
      mode === "advanced" ? this.validateAdvanced(raw.advanced) : undefined;

    return { mode, default_target: defaultTarget, advanced };
  }

  private validateDefaultTarget(value: unknown): RoutingTarget {
    if (value === undefined || value === null || typeof value !== "object") {
      throw new Error(
        "[EscalationConfigLoader] routing.default_target is missing. " +
          "The system cannot start without a default routing target.",
      );
    }

    const raw = value as Record<string, unknown>;

    if (typeof raw.target_id !== "string" || raw.target_id.length === 0) {
      throw new Error(
        "[EscalationConfigLoader] routing.default_target.target_id is missing or empty. " +
          "The system cannot start without a valid default routing target.",
      );
    }

    if (typeof raw.channel !== "string" || raw.channel.length === 0) {
      throw new Error(
        "[EscalationConfigLoader] routing.default_target.channel is missing or empty. " +
          "The system cannot start without a valid default routing target.",
      );
    }

    return {
      target_id: raw.target_id,
      display_name:
        typeof raw.display_name === "string" ? raw.display_name : raw.target_id,
      channel: raw.channel,
    };
  }

  private validateAdvanced(
    value: unknown,
  ): EscalationConfig["routing"]["advanced"] | undefined {
    if (value === undefined || value === null || typeof value !== "object") {
      return undefined;
    }

    const raw = value as Record<string, unknown>;
    const result: Record<
      EscalationType,
      {
        primary: RoutingTarget;
        secondary?: RoutingTarget;
        timeout_minutes: number;
        timeout_behavior: TimeoutBehavior;
      }
    > = {} as any;

    for (const typeName of ESCALATION_TYPES) {
      const entry = raw[typeName];
      if (entry === undefined || entry === null || typeof entry !== "object") {
        continue;
      }

      const rawEntry = entry as Record<string, unknown>;

      // Primary target (required for the entry)
      if (
        rawEntry.primary === undefined ||
        rawEntry.primary === null ||
        typeof rawEntry.primary !== "object"
      ) {
        console.warn(
          `[EscalationConfigLoader] routing.advanced.${typeName}.primary is missing. Skipping.`,
        );
        continue;
      }

      const primaryRaw = rawEntry.primary as Record<string, unknown>;
      if (
        typeof primaryRaw.target_id !== "string" ||
        typeof primaryRaw.channel !== "string"
      ) {
        console.warn(
          `[EscalationConfigLoader] routing.advanced.${typeName}.primary is invalid. Skipping.`,
        );
        continue;
      }

      const primary: RoutingTarget = {
        target_id: primaryRaw.target_id,
        display_name:
          typeof primaryRaw.display_name === "string"
            ? primaryRaw.display_name
            : primaryRaw.target_id,
        channel: primaryRaw.channel,
      };

      // Secondary target (optional)
      let secondary: RoutingTarget | undefined;
      if (
        rawEntry.secondary != null &&
        typeof rawEntry.secondary === "object"
      ) {
        const secRaw = rawEntry.secondary as Record<string, unknown>;
        if (
          typeof secRaw.target_id === "string" &&
          typeof secRaw.channel === "string"
        ) {
          secondary = {
            target_id: secRaw.target_id,
            display_name:
              typeof secRaw.display_name === "string"
                ? secRaw.display_name
                : secRaw.target_id,
            channel: secRaw.channel,
          };
        }
      }

      // timeout_minutes (positive integer, default: 60)
      let timeoutMinutes = DEFAULT_TIMEOUT_MINUTES;
      if (
        typeof rawEntry.timeout_minutes === "number" &&
        Number.isInteger(rawEntry.timeout_minutes) &&
        rawEntry.timeout_minutes > 0
      ) {
        timeoutMinutes = rawEntry.timeout_minutes;
      } else if (rawEntry.timeout_minutes !== undefined) {
        console.warn(
          `[EscalationConfigLoader] routing.advanced.${typeName}.timeout_minutes is invalid. ` +
            `Using default ${DEFAULT_TIMEOUT_MINUTES}.`,
        );
      }

      // timeout_behavior (one of 4 valid values, default: "pause")
      let timeoutBehavior: TimeoutBehavior = DEFAULT_TIMEOUT_BEHAVIOR;
      if (
        typeof rawEntry.timeout_behavior === "string" &&
        VALID_TIMEOUT_BEHAVIORS.has(rawEntry.timeout_behavior)
      ) {
        timeoutBehavior = rawEntry.timeout_behavior as TimeoutBehavior;
      } else if (rawEntry.timeout_behavior !== undefined) {
        console.warn(
          `[EscalationConfigLoader] routing.advanced.${typeName}.timeout_behavior is invalid. ` +
            `Using default "${DEFAULT_TIMEOUT_BEHAVIOR}".`,
        );
      }

      // Security invariant: force timeout_behavior to "pause" for security type
      if (typeName === "security" && timeoutBehavior !== "pause") {
        console.warn(
          `[EscalationConfigLoader] routing.advanced.security.timeout_behavior ` +
            `is forced to "pause" (was "${timeoutBehavior}"). ` +
            `Security escalations must always pause on timeout.`,
        );
        timeoutBehavior = "pause";
      }

      result[typeName] = {
        primary,
        secondary,
        timeout_minutes: timeoutMinutes,
        timeout_behavior: timeoutBehavior,
      };
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Scalar validation
  // -------------------------------------------------------------------------

  private validateVerbosity(
    value: unknown,
  ): EscalationConfig["verbosity"] {
    if (typeof value === "string" && VALID_VERBOSITY_LEVELS.has(value)) {
      return value as EscalationConfig["verbosity"];
    }

    if (value !== undefined) {
      console.warn(
        `[EscalationConfigLoader] Invalid verbosity: ${JSON.stringify(value)}. ` +
          `Falling back to "${DEFAULT_VERBOSITY}".`,
      );
    }

    return DEFAULT_VERBOSITY;
  }

  private validateRetryBudget(value: unknown): number {
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value > 0
    ) {
      return value;
    }

    if (value !== undefined) {
      console.warn(
        `[EscalationConfigLoader] Invalid retry_budget: ${JSON.stringify(value)}. ` +
          `Using default ${DEFAULT_RETRY_BUDGET}.`,
      );
    }

    return DEFAULT_RETRY_BUDGET;
  }
}

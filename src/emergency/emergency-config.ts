/**
 * Emergency configuration loader and validator (SPEC-009-4-3, Task 8).
 *
 * Loads and validates emergency configuration. Enforces two critical rules:
 *   1. `kill_default_mode` must be "graceful" or "hard"; invalid values
 *      fall back to "graceful".
 *   2. `restart_requires_human` is IMMUTABLE: always `true`. If the config
 *      source sets it to `false`, the loader logs an error and forces `true`.
 *      There is no code path that allows the system to re-enable without
 *      human action.
 */

import type { KillMode } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Validated emergency configuration.
 *
 * Note: `restart_requires_human` is typed as the literal `true` --
 * it can never be `false`.
 */
export interface EmergencyConfig {
  kill_default_mode: KillMode;
  restart_requires_human: true;
}

/**
 * Raw configuration input before validation.
 * All fields are optional and may contain invalid values.
 */
export interface RawEmergencyConfig {
  kill_default_mode?: unknown;
  restart_requires_human?: unknown;
}

/**
 * Provides raw configuration data from whatever backing store
 * (YAML file, environment, etc.).
 */
export interface ConfigProvider {
  /** Returns the raw emergency config section, or undefined if not present. */
  getEmergencyConfig(): RawEmergencyConfig | undefined;
}

/**
 * Logger interface for reporting config validation issues.
 */
export interface ConfigLogger {
  error(message: string): void;
  warn(message: string): void;
}

// ---------------------------------------------------------------------------
// Default logger (console)
// ---------------------------------------------------------------------------

const defaultLogger: ConfigLogger = {
  error: (msg) => console.error(`[emergency-config] ${msg}`),
  warn: (msg) => console.warn(`[emergency-config] ${msg}`),
};

// ---------------------------------------------------------------------------
// Valid kill modes
// ---------------------------------------------------------------------------

const VALID_KILL_MODES: readonly KillMode[] = ["graceful", "hard"] as const;

// ---------------------------------------------------------------------------
// EmergencyConfigLoader
// ---------------------------------------------------------------------------

/**
 * Loads and validates emergency configuration from a config provider.
 *
 * Validation rules:
 *   - `kill_default_mode`: must be "graceful" or "hard". Any other value
 *     (including missing) defaults to "graceful" with a warning.
 *   - `restart_requires_human`: always forced to `true`. If the config
 *     explicitly sets `false`, an error is logged and the value is
 *     overridden to `true`.
 */
export class EmergencyConfigLoader {
  constructor(
    private readonly configProvider: ConfigProvider,
    private readonly logger: ConfigLogger = defaultLogger,
  ) {}

  /**
   * Load and validate the emergency configuration.
   *
   * @returns A fully validated EmergencyConfig. Never throws --
   *          invalid values are replaced with safe defaults.
   */
  load(): EmergencyConfig {
    const raw = this.configProvider.getEmergencyConfig() ?? {};

    return {
      kill_default_mode: this.validateKillDefaultMode(raw.kill_default_mode),
      restart_requires_human: this.enforceRestartRequiresHuman(
        raw.restart_requires_human,
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Private validators
  // -------------------------------------------------------------------------

  /**
   * Validate and coerce `kill_default_mode`.
   *
   * @returns A valid KillMode, defaulting to "graceful" on invalid input.
   */
  private validateKillDefaultMode(value: unknown): KillMode {
    if (
      typeof value === "string" &&
      VALID_KILL_MODES.includes(value as KillMode)
    ) {
      return value as KillMode;
    }

    if (value !== undefined && value !== null) {
      this.logger.warn(
        `Invalid kill_default_mode "${String(value)}". Must be "graceful" or "hard". Falling back to "graceful".`,
      );
    }

    return "graceful";
  }

  /**
   * Enforce `restart_requires_human` is always `true`.
   *
   * If the config explicitly sets it to `false`, log an error and
   * force it to `true`. This is a safety-critical invariant.
   *
   * @returns Always `true`.
   */
  private enforceRestartRequiresHuman(value: unknown): true {
    if (value === false) {
      this.logger.error(
        "restart_requires_human cannot be set to false. This is an immutable safety constraint. Forcing to true.",
      );
    }

    return true;
  }
}

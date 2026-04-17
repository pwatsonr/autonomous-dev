/**
 * Trust Configuration Loader (SPEC-009-1-2, Task 6).
 *
 * Parses and validates the `trust:` YAML section from the plugin config
 * system. Supports hot-reload: when the config source changes, the loader
 * re-parses and re-validates the config, retaining the previous valid config
 * if the new config is invalid (snapshot semantics at gate boundaries).
 *
 * Validation rules:
 *   - system_default_level must be 0, 1, 2, or 3 (fallback: 1)
 *   - repositories.<repo>.default_level must be 0, 1, 2, or 3 (invalid entries skipped)
 *   - promotion.require_human_approval must be true (forced to true if false)
 *   - auto_demotion.failure_threshold must be a positive integer (default: 3)
 *   - auto_demotion.window_hours must be a positive number (default: 24)
 */

import type { TrustConfig, TrustLevel, RepositoryTrustConfig } from "./types";
import { isTrustLevel } from "./types";

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

/**
 * Default TrustConfig returned when no configuration is present or when
 * the entire trust section is missing/invalid.
 */
export const DEFAULT_TRUST_CONFIG: Readonly<TrustConfig> = {
  system_default_level: 1,
  repositories: {},
  auto_demotion: { enabled: false, failure_threshold: 3, window_hours: 24 },
  promotion: {
    require_human_approval: true,
    min_successful_runs: 10,
    cooldown_hours: 72,
  },
};

// ---------------------------------------------------------------------------
// ConfigProvider interface
// ---------------------------------------------------------------------------

/**
 * Abstraction over the raw config source. Implementations might read from
 * a YAML file, an in-memory object, or the plugin config system.
 */
export interface ConfigProvider {
  /**
   * Return the raw `trust:` section of the config as a plain object,
   * or undefined/null if the section is absent.
   */
  getTrustSection(): Record<string, unknown> | undefined | null;

  /**
   * Subscribe to config change notifications. The callback is invoked
   * whenever the underlying config source changes (e.g., YAML file modified).
   * Returns an unsubscribe function.
   */
  onConfigChange(callback: () => void): () => void;
}

// ---------------------------------------------------------------------------
// TrustConfigLoader
// ---------------------------------------------------------------------------

/**
 * Loads, validates, and caches the trust configuration. Supports hot-reload
 * via the ConfigProvider's change notification mechanism.
 *
 * When a change is detected:
 *   1. Re-parse and re-validate the new config.
 *   2. If valid, store as the new current config.
 *   3. If invalid, retain the previous valid config and log an error.
 *   4. The new config is not "applied" until the next gate check calls `load()`.
 */
export class TrustConfigLoader {
  private currentConfig: TrustConfig = { ...DEFAULT_TRUST_CONFIG };
  private hasLoadedOnce = false;
  private unsubscribe: (() => void) | null = null;
  private changeCallbacks: Array<() => void> = [];

  constructor(private readonly configProvider: ConfigProvider) {
    // Subscribe to config changes for hot-reload
    this.unsubscribe = this.configProvider.onConfigChange(() => {
      this.handleConfigChange();
    });
  }

  /**
   * Parse and validate the trust config from the config provider.
   *
   * Returns the validated TrustConfig. If the raw config is missing or
   * entirely invalid, returns DEFAULT_TRUST_CONFIG. Individual invalid
   * fields fall back to their defaults.
   */
  load(): TrustConfig {
    const raw = this.configProvider.getTrustSection();

    if (raw === undefined || raw === null || typeof raw !== "object") {
      if (!this.hasLoadedOnce) {
        this.currentConfig = { ...DEFAULT_TRUST_CONFIG };
        this.hasLoadedOnce = true;
      }
      return this.currentConfig;
    }

    const validated = this.validate(raw);
    this.currentConfig = validated;
    this.hasLoadedOnce = true;
    return validated;
  }

  /**
   * Register a callback to be invoked when the config changes (hot-reload).
   * Returns an unsubscribe function.
   */
  onConfigChange(callback: () => void): () => void {
    this.changeCallbacks.push(callback);
    return () => {
      const idx = this.changeCallbacks.indexOf(callback);
      if (idx >= 0) {
        this.changeCallbacks.splice(idx, 1);
      }
    };
  }

  /**
   * Clean up subscriptions.
   */
  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.changeCallbacks = [];
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Handle a config change notification from the provider.
   *
   * Re-parses and re-validates the config. If invalid, retains the previous
   * valid config and logs an error.
   */
  private handleConfigChange(): void {
    const raw = this.configProvider.getTrustSection();

    if (raw === undefined || raw === null || typeof raw !== "object") {
      // New config is absent/invalid -- retain previous
      console.error(
        "[TrustConfigLoader] Config change detected but trust section is missing or invalid. Retaining previous config.",
      );
      return;
    }

    try {
      const validated = this.validate(raw);
      this.currentConfig = validated;
      // Notify subscribers
      for (const cb of this.changeCallbacks) {
        cb();
      }
    } catch (err) {
      console.error(
        "[TrustConfigLoader] Config change detected but validation failed. Retaining previous config.",
        err,
      );
    }
  }

  /**
   * Validate a raw trust config object and return a clean TrustConfig.
   *
   * Invalid individual fields are replaced with defaults; invalid repository
   * entries are skipped. The immutable require_human_approval field is forced
   * to true if set to false.
   */
  private validate(raw: Record<string, unknown>): TrustConfig {
    const config: TrustConfig = { ...DEFAULT_TRUST_CONFIG };

    // -- system_default_level --
    config.system_default_level = this.validateSystemDefaultLevel(
      raw.system_default_level,
    );

    // -- repositories --
    config.repositories = this.validateRepositories(raw.repositories);

    // -- auto_demotion --
    config.auto_demotion = this.validateAutoDemotion(raw.auto_demotion);

    // -- promotion --
    config.promotion = this.validatePromotion(raw.promotion);

    return config;
  }

  /**
   * Validate system_default_level. Must be 0, 1, 2, or 3.
   * Invalid values fall back to 1 with a logged warning.
   */
  private validateSystemDefaultLevel(value: unknown): TrustLevel {
    if (isTrustLevel(value)) {
      return value;
    }

    if (value !== undefined) {
      console.warn(
        `[TrustConfigLoader] Invalid system_default_level: ${JSON.stringify(value)}. Falling back to 1.`,
      );
    }

    return 1;
  }

  /**
   * Validate the repositories map. Each entry must have a valid default_level.
   * Invalid entries are skipped with a warning; valid entries are preserved.
   */
  private validateRepositories(
    value: unknown,
  ): Record<string, RepositoryTrustConfig> {
    if (value === undefined || value === null || typeof value !== "object") {
      return {};
    }

    const repos: Record<string, RepositoryTrustConfig> = {};
    const rawRepos = value as Record<string, unknown>;

    for (const [repoId, repoConfig] of Object.entries(rawRepos)) {
      if (
        repoConfig === null ||
        repoConfig === undefined ||
        typeof repoConfig !== "object"
      ) {
        console.warn(
          `[TrustConfigLoader] Invalid repository config for "${repoId}". Skipping.`,
        );
        continue;
      }

      const rawRepo = repoConfig as Record<string, unknown>;
      const level = rawRepo.default_level;

      if (isTrustLevel(level)) {
        repos[repoId] = { default_level: level };
      } else {
        console.warn(
          `[TrustConfigLoader] Invalid default_level for repository "${repoId}": ${JSON.stringify(level)}. Skipping.`,
        );
      }
    }

    return repos;
  }

  /**
   * Validate auto_demotion settings.
   * - failure_threshold must be a positive integer (default: 3)
   * - window_hours must be a positive number (default: 24)
   */
  private validateAutoDemotion(
    value: unknown,
  ): TrustConfig["auto_demotion"] {
    const defaults = DEFAULT_TRUST_CONFIG.auto_demotion;

    if (value === undefined || value === null || typeof value !== "object") {
      return { ...defaults };
    }

    const raw = value as Record<string, unknown>;

    const enabled =
      typeof raw.enabled === "boolean" ? raw.enabled : defaults.enabled;

    let failureThreshold = defaults.failure_threshold;
    if (
      typeof raw.failure_threshold === "number" &&
      Number.isInteger(raw.failure_threshold) &&
      raw.failure_threshold > 0
    ) {
      failureThreshold = raw.failure_threshold;
    } else if (raw.failure_threshold !== undefined) {
      console.warn(
        `[TrustConfigLoader] Invalid auto_demotion.failure_threshold: ${JSON.stringify(raw.failure_threshold)}. Using default ${defaults.failure_threshold}.`,
      );
    }

    let windowHours = defaults.window_hours;
    if (typeof raw.window_hours === "number" && raw.window_hours > 0) {
      windowHours = raw.window_hours;
    } else if (raw.window_hours !== undefined) {
      console.warn(
        `[TrustConfigLoader] Invalid auto_demotion.window_hours: ${JSON.stringify(raw.window_hours)}. Using default ${defaults.window_hours}.`,
      );
    }

    return { enabled, failure_threshold: failureThreshold, window_hours: windowHours };
  }

  /**
   * Validate promotion settings.
   * - require_human_approval is immutable: if set to false, force to true
   *   and log an error.
   * - min_successful_runs must be a positive integer (default: 10).
   * - cooldown_hours must be a positive number (default: 72).
   */
  private validatePromotion(value: unknown): TrustConfig["promotion"] {
    const defaults = DEFAULT_TRUST_CONFIG.promotion;

    if (value === undefined || value === null || typeof value !== "object") {
      return { ...defaults };
    }

    const raw = value as Record<string, unknown>;

    // require_human_approval is immutable -- always true
    if (raw.require_human_approval === false) {
      console.error(
        "[TrustConfigLoader] promotion.require_human_approval cannot be set to false. Forcing to true.",
      );
    }

    let minSuccessfulRuns = defaults.min_successful_runs;
    if (
      typeof raw.min_successful_runs === "number" &&
      Number.isInteger(raw.min_successful_runs) &&
      raw.min_successful_runs > 0
    ) {
      minSuccessfulRuns = raw.min_successful_runs;
    } else if (raw.min_successful_runs !== undefined) {
      console.warn(
        `[TrustConfigLoader] Invalid promotion.min_successful_runs: ${JSON.stringify(raw.min_successful_runs)}. Using default ${defaults.min_successful_runs}.`,
      );
    }

    let cooldownHours = defaults.cooldown_hours;
    if (typeof raw.cooldown_hours === "number" && raw.cooldown_hours > 0) {
      cooldownHours = raw.cooldown_hours;
    } else if (raw.cooldown_hours !== undefined) {
      console.warn(
        `[TrustConfigLoader] Invalid promotion.cooldown_hours: ${JSON.stringify(raw.cooldown_hours)}. Using default ${defaults.cooldown_hours}.`,
      );
    }

    return {
      require_human_approval: true,
      min_successful_runs: minSuccessfulRuns,
      cooldown_hours: cooldownHours,
    };
  }
}

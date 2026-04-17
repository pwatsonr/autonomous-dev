import {
  TrustConfigLoader,
  DEFAULT_TRUST_CONFIG,
} from "../../src/trust/trust-config";
import type { ConfigProvider } from "../../src/trust/trust-config";
import type { TrustConfig } from "../../src/trust/types";

// ---------------------------------------------------------------------------
// Mock ConfigProvider
// ---------------------------------------------------------------------------

/**
 * In-memory ConfigProvider for testing. Allows setting raw trust section
 * data and triggering change notifications.
 */
class MockConfigProvider implements ConfigProvider {
  private trustSection: Record<string, unknown> | undefined | null = undefined;
  private listeners: Array<() => void> = [];

  setTrustSection(section: Record<string, unknown> | undefined | null): void {
    this.trustSection = section;
  }

  getTrustSection(): Record<string, unknown> | undefined | null {
    return this.trustSection;
  }

  onConfigChange(callback: () => void): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx >= 0) {
        this.listeners.splice(idx, 1);
      }
    };
  }

  /** Simulate a config file change. */
  triggerChange(): void {
    for (const cb of this.listeners) {
      cb();
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TrustConfigLoader", () => {
  let provider: MockConfigProvider;
  let loader: TrustConfigLoader;

  beforeEach(() => {
    provider = new MockConfigProvider();
    loader = new TrustConfigLoader(provider);
  });

  afterEach(() => {
    loader.destroy();
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test Case 6: Valid full config loads correctly
  // -------------------------------------------------------------------------
  test("valid full config loads correctly", () => {
    provider.setTrustSection({
      system_default_level: 2,
      repositories: {
        "repo-a": { default_level: 3 },
        "repo-b": { default_level: 0 },
      },
      auto_demotion: {
        enabled: true,
        failure_threshold: 5,
        window_hours: 48,
      },
      promotion: {
        require_human_approval: true,
        min_successful_runs: 20,
        cooldown_hours: 96,
      },
    });

    const config = loader.load();

    expect(config.system_default_level).toBe(2);
    expect(config.repositories["repo-a"]).toEqual({ default_level: 3 });
    expect(config.repositories["repo-b"]).toEqual({ default_level: 0 });
    expect(config.auto_demotion).toEqual({
      enabled: true,
      failure_threshold: 5,
      window_hours: 48,
    });
    expect(config.promotion).toEqual({
      require_human_approval: true,
      min_successful_runs: 20,
      cooldown_hours: 96,
    });
  });

  // -------------------------------------------------------------------------
  // Test Case 7: Missing trust section returns DEFAULT_TRUST_CONFIG
  // -------------------------------------------------------------------------
  test("missing trust section returns default config", () => {
    provider.setTrustSection(undefined);
    const config = loader.load();
    expect(config).toEqual(DEFAULT_TRUST_CONFIG);
  });

  test("null trust section returns default config", () => {
    provider.setTrustSection(null);
    const config = loader.load();
    expect(config).toEqual(DEFAULT_TRUST_CONFIG);
  });

  // -------------------------------------------------------------------------
  // Test Case 8: Invalid system_default_level = 5 falls back to 1
  // -------------------------------------------------------------------------
  test("invalid system_default_level = 5 falls back to 1 with warning", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    provider.setTrustSection({ system_default_level: 5 });
    const config = loader.load();

    expect(config.system_default_level).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid system_default_level"),
    );
  });

  // -------------------------------------------------------------------------
  // Test Case 9: Invalid system_default_level = "high" falls back to 1
  // -------------------------------------------------------------------------
  test('invalid system_default_level = "high" falls back to 1 with warning', () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    provider.setTrustSection({ system_default_level: "high" });
    const config = loader.load();

    expect(config.system_default_level).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid system_default_level"),
    );
  });

  // -------------------------------------------------------------------------
  // Test Case 10: Invalid repo level -- repo entry skipped, others intact
  // -------------------------------------------------------------------------
  test("invalid repo default_level is skipped; other repos still load", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    provider.setTrustSection({
      system_default_level: 1,
      repositories: {
        "good-repo": { default_level: 2 },
        "bad-repo": { default_level: 99 },
        "also-good": { default_level: 0 },
      },
    });

    const config = loader.load();

    expect(config.repositories["good-repo"]).toEqual({ default_level: 2 });
    expect(config.repositories["also-good"]).toEqual({ default_level: 0 });
    expect(config.repositories["bad-repo"]).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid default_level for repository "bad-repo"'),
    );
  });

  // -------------------------------------------------------------------------
  // Test Case 11: require_human_approval set to false is forced to true
  // -------------------------------------------------------------------------
  test("require_human_approval set to false is forced to true with error", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation();

    provider.setTrustSection({
      system_default_level: 1,
      promotion: {
        require_human_approval: false,
        min_successful_runs: 10,
        cooldown_hours: 72,
      },
    });

    const config = loader.load();

    expect(config.promotion.require_human_approval).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "promotion.require_human_approval cannot be set to false",
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Test Case 12: Partial config -- missing fields filled with defaults
  // -------------------------------------------------------------------------
  test("partial config fills missing fields with defaults", () => {
    provider.setTrustSection({
      system_default_level: 3,
    });

    const config = loader.load();

    expect(config.system_default_level).toBe(3);
    expect(config.repositories).toEqual({});
    expect(config.auto_demotion).toEqual(DEFAULT_TRUST_CONFIG.auto_demotion);
    expect(config.promotion).toEqual(DEFAULT_TRUST_CONFIG.promotion);
  });

  test("partial auto_demotion uses defaults for missing fields", () => {
    provider.setTrustSection({
      system_default_level: 1,
      auto_demotion: { enabled: true },
    });

    const config = loader.load();

    expect(config.auto_demotion.enabled).toBe(true);
    expect(config.auto_demotion.failure_threshold).toBe(3);
    expect(config.auto_demotion.window_hours).toBe(24);
  });

  test("partial promotion uses defaults for missing fields", () => {
    provider.setTrustSection({
      system_default_level: 1,
      promotion: { cooldown_hours: 48 },
    });

    const config = loader.load();

    expect(config.promotion.require_human_approval).toBe(true);
    expect(config.promotion.min_successful_runs).toBe(10);
    expect(config.promotion.cooldown_hours).toBe(48);
  });

  // -------------------------------------------------------------------------
  // Test Case 13: Hot-reload -- valid new config returned on next load
  // -------------------------------------------------------------------------
  test("hot-reload: valid new config is applied after change", () => {
    provider.setTrustSection({ system_default_level: 1 });
    const config1 = loader.load();
    expect(config1.system_default_level).toBe(1);

    // Change config and trigger reload
    provider.setTrustSection({ system_default_level: 3 });
    provider.triggerChange();

    const config2 = loader.load();
    expect(config2.system_default_level).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Test Case 14: Hot-reload -- invalid new config retains previous
  // -------------------------------------------------------------------------
  test("hot-reload: invalid new config retains previous valid config", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation();

    // Load valid config first
    provider.setTrustSection({
      system_default_level: 2,
      repositories: { "repo-a": { default_level: 3 } },
    });
    const config1 = loader.load();
    expect(config1.system_default_level).toBe(2);

    // Set invalid config (null) and trigger change
    provider.setTrustSection(null);
    provider.triggerChange();

    // Previous config should be retained
    const config2 = loader.load();
    expect(config2.system_default_level).toBe(2);
    expect(config2.repositories["repo-a"]).toEqual({ default_level: 3 });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Retaining previous config"),
    );
  });

  // -------------------------------------------------------------------------
  // Additional validation edge cases
  // -------------------------------------------------------------------------

  test("invalid system_default_level = -1 falls back to 1", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    provider.setTrustSection({ system_default_level: -1 });
    const config = loader.load();

    expect(config.system_default_level).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  test("system_default_level = 0 is valid (falsy but legal)", () => {
    provider.setTrustSection({ system_default_level: 0 });
    const config = loader.load();

    expect(config.system_default_level).toBe(0);
  });

  test("invalid auto_demotion.failure_threshold uses default", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    provider.setTrustSection({
      system_default_level: 1,
      auto_demotion: { enabled: true, failure_threshold: -5, window_hours: 24 },
    });

    const config = loader.load();

    expect(config.auto_demotion.failure_threshold).toBe(3);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid auto_demotion.failure_threshold"),
    );
  });

  test("invalid auto_demotion.failure_threshold (non-integer) uses default", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    provider.setTrustSection({
      system_default_level: 1,
      auto_demotion: { enabled: true, failure_threshold: 2.5, window_hours: 24 },
    });

    const config = loader.load();

    expect(config.auto_demotion.failure_threshold).toBe(3);
    expect(warnSpy).toHaveBeenCalled();
  });

  test("invalid auto_demotion.window_hours uses default", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    provider.setTrustSection({
      system_default_level: 1,
      auto_demotion: { enabled: true, failure_threshold: 3, window_hours: 0 },
    });

    const config = loader.load();

    expect(config.auto_demotion.window_hours).toBe(24);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid auto_demotion.window_hours"),
    );
  });

  test("invalid repository config (non-object) is skipped", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    provider.setTrustSection({
      system_default_level: 1,
      repositories: {
        "good-repo": { default_level: 2 },
        "bad-repo": "not-an-object",
      },
    });

    const config = loader.load();

    expect(config.repositories["good-repo"]).toEqual({ default_level: 2 });
    expect(config.repositories["bad-repo"]).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid repository config for "bad-repo"'),
    );
  });

  test("onConfigChange callback is fired on valid hot-reload", () => {
    const callback = jest.fn();
    loader.onConfigChange(callback);

    provider.setTrustSection({ system_default_level: 1 });
    loader.load();

    provider.setTrustSection({ system_default_level: 2 });
    provider.triggerChange();

    expect(callback).toHaveBeenCalledTimes(1);
  });

  test("onConfigChange callback is NOT fired on invalid hot-reload", () => {
    jest.spyOn(console, "error").mockImplementation();
    const callback = jest.fn();
    loader.onConfigChange(callback);

    provider.setTrustSection({ system_default_level: 1 });
    loader.load();

    provider.setTrustSection(null);
    provider.triggerChange();

    expect(callback).not.toHaveBeenCalled();
  });

  test("unsubscribing onConfigChange stops callback", () => {
    const callback = jest.fn();
    const unsub = loader.onConfigChange(callback);
    unsub();

    provider.setTrustSection({ system_default_level: 2 });
    provider.triggerChange();

    expect(callback).not.toHaveBeenCalled();
  });

  test("destroy cleans up subscriptions", () => {
    const callback = jest.fn();
    loader.onConfigChange(callback);
    loader.destroy();

    provider.setTrustSection({ system_default_level: 2 });
    provider.triggerChange();

    expect(callback).not.toHaveBeenCalled();
  });

  test("DEFAULT_TRUST_CONFIG has expected shape", () => {
    expect(DEFAULT_TRUST_CONFIG).toEqual({
      system_default_level: 1,
      repositories: {},
      auto_demotion: { enabled: false, failure_threshold: 3, window_hours: 24 },
      promotion: {
        require_human_approval: true,
        min_successful_runs: 10,
        cooldown_hours: 72,
      },
    });
  });

  test("hot-reload: change callbacks get latest config via load()", () => {
    let capturedConfig: TrustConfig | null = null;

    loader.onConfigChange(() => {
      capturedConfig = loader.load();
    });

    provider.setTrustSection({ system_default_level: 1 });
    loader.load();

    provider.setTrustSection({ system_default_level: 3 });
    provider.triggerChange();

    expect(capturedConfig).not.toBeNull();
    expect(capturedConfig!.system_default_level).toBe(3);
  });

  test("multiple load() calls without changes return consistent config", () => {
    provider.setTrustSection({ system_default_level: 2 });

    const config1 = loader.load();
    const config2 = loader.load();

    expect(config1).toEqual(config2);
    expect(config1.system_default_level).toBe(2);
  });
});

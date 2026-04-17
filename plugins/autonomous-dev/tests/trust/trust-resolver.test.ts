import { TrustResolver } from "../../src/trust/trust-resolver";
import type { TrustResolutionContext } from "../../src/trust/trust-resolver";
import type { TrustConfig } from "../../src/trust/types";
import { DEFAULT_TRUST_CONFIG } from "../../src/trust/trust-config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a TrustConfig with overrides from the defaults. */
function makeConfig(overrides: Partial<TrustConfig> = {}): TrustConfig {
  return { ...DEFAULT_TRUST_CONFIG, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TrustResolver", () => {
  let resolver: TrustResolver;

  beforeEach(() => {
    resolver = new TrustResolver();
  });

  // -------------------------------------------------------------------------
  // Test Case 1: Per-request override takes precedence
  // -------------------------------------------------------------------------
  test("per-request override takes precedence over repo and system defaults", () => {
    const config = makeConfig({
      system_default_level: 0,
      repositories: {
        "repo-a": { default_level: 0 },
      },
    });

    const context: TrustResolutionContext = {
      requestOverride: 3,
      repositoryId: "repo-a",
    };

    expect(resolver.resolve(context, config)).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Test Case 2: Per-repo default used when no override
  // -------------------------------------------------------------------------
  test("per-repo default used when no per-request override", () => {
    const config = makeConfig({
      system_default_level: 0,
      repositories: {
        "repo-a": { default_level: 2 },
      },
    });

    const context: TrustResolutionContext = {
      repositoryId: "repo-a",
    };

    expect(resolver.resolve(context, config)).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Test Case 3: System default used when no repo config
  // -------------------------------------------------------------------------
  test("system default used when no repo config exists", () => {
    const config = makeConfig({
      system_default_level: 2,
      repositories: {},
    });

    const context: TrustResolutionContext = {
      repositoryId: "unknown-repo",
    };

    expect(resolver.resolve(context, config)).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Test Case 4: Hardcoded L1 fallback
  // -------------------------------------------------------------------------
  test("returns L1 when no configuration is present at all", () => {
    // Use a config with invalid system_default_level to force fallback
    const emptyConfig: TrustConfig = {
      system_default_level: 99 as any, // Invalid, will fail isTrustLevel
      repositories: {},
      auto_demotion: { enabled: false, failure_threshold: 3, window_hours: 24 },
      promotion: {
        require_human_approval: true,
        min_successful_runs: 10,
        cooldown_hours: 72,
      },
    };

    const context: TrustResolutionContext = {
      repositoryId: "x",
    };

    expect(resolver.resolve(context, emptyConfig)).toBe(1);
  });

  test("returns L1 with DEFAULT_TRUST_CONFIG (system_default_level is 1)", () => {
    const context: TrustResolutionContext = {
      repositoryId: "x",
    };

    // DEFAULT_TRUST_CONFIG has system_default_level: 1
    expect(resolver.resolve(context, DEFAULT_TRUST_CONFIG)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test Case 5: No caching between calls
  // -------------------------------------------------------------------------
  test("no caching -- changing config between calls reflects in second result", () => {
    const context: TrustResolutionContext = {
      repositoryId: "repo-a",
    };

    const config1 = makeConfig({
      system_default_level: 0,
      repositories: { "repo-a": { default_level: 2 } },
    });

    const config2 = makeConfig({
      system_default_level: 0,
      repositories: { "repo-a": { default_level: 3 } },
    });

    expect(resolver.resolve(context, config1)).toBe(2);
    expect(resolver.resolve(context, config2)).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  test("per-request override of 0 is respected (falsy but valid)", () => {
    const config = makeConfig({
      system_default_level: 3,
      repositories: {
        "repo-a": { default_level: 3 },
      },
    });

    const context: TrustResolutionContext = {
      requestOverride: 0,
      repositoryId: "repo-a",
    };

    expect(resolver.resolve(context, config)).toBe(0);
  });

  test("per-repo default of 0 is respected (falsy but valid)", () => {
    const config = makeConfig({
      system_default_level: 3,
      repositories: {
        "repo-a": { default_level: 0 },
      },
    });

    const context: TrustResolutionContext = {
      repositoryId: "repo-a",
    };

    expect(resolver.resolve(context, config)).toBe(0);
  });

  test("system default of 0 is respected (falsy but valid)", () => {
    const config = makeConfig({
      system_default_level: 0,
    });

    const context: TrustResolutionContext = {
      repositoryId: "unknown",
    };

    expect(resolver.resolve(context, config)).toBe(0);
  });

  test("falls through from request to repo when override is undefined", () => {
    const config = makeConfig({
      system_default_level: 0,
      repositories: {
        "my-repo": { default_level: 1 },
      },
    });

    const context: TrustResolutionContext = {
      requestOverride: undefined,
      repositoryId: "my-repo",
    };

    expect(resolver.resolve(context, config)).toBe(1);
  });

  test("falls through all tiers when repo not in config", () => {
    const config = makeConfig({
      system_default_level: 3,
      repositories: {
        "other-repo": { default_level: 0 },
      },
    });

    const context: TrustResolutionContext = {
      repositoryId: "not-in-config",
    };

    expect(resolver.resolve(context, config)).toBe(3);
  });

  test("each trust level (0-3) can be returned as per-request override", () => {
    const config = makeConfig({ system_default_level: 1 });

    for (const level of [0, 1, 2, 3] as const) {
      const context: TrustResolutionContext = {
        requestOverride: level,
        repositoryId: "any",
      };
      expect(resolver.resolve(context, config)).toBe(level);
    }
  });
});

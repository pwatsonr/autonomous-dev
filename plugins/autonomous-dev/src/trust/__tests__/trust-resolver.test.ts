/**
 * Unit tests for TrustResolver (SPEC-009-1-4 cross-ref to SPEC-009-1-2).
 *
 * Covers the three-tier resolution hierarchy:
 *   1. Per-request override (highest priority)
 *   2. Per-repo default
 *   3. System global default
 *   4. Hardcoded fallback to L1
 */

import { TrustResolver } from "../trust-resolver";
import type { TrustResolutionContext } from "../trust-resolver";
import type { TrustConfig } from "../types";
import { DEFAULT_TRUST_CONFIG } from "../trust-config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

  test("per-request override takes precedence over repo and system defaults", () => {
    const config = makeConfig({
      system_default_level: 0,
      repositories: { "repo-a": { default_level: 0 } },
    });

    const context: TrustResolutionContext = {
      requestId: "req-1",
      requestOverride: 3,
      repositoryId: "repo-a",
    };

    expect(resolver.resolve(context, config)).toBe(3);
  });

  test("per-repo default used when no per-request override", () => {
    const config = makeConfig({
      system_default_level: 0,
      repositories: { "repo-a": { default_level: 2 } },
    });

    const context: TrustResolutionContext = {
      requestId: "req-1",
      repositoryId: "repo-a",
    };

    expect(resolver.resolve(context, config)).toBe(2);
  });

  test("system default used when no repo config exists", () => {
    const config = makeConfig({
      system_default_level: 2,
      repositories: {},
    });

    const context: TrustResolutionContext = {
      requestId: "req-1",
      repositoryId: "unknown-repo",
    };

    expect(resolver.resolve(context, config)).toBe(2);
  });

  test("returns L1 when no valid configuration is present", () => {
    const emptyConfig: TrustConfig = {
      system_default_level: 99 as any,
      repositories: {},
      auto_demotion: { enabled: false, failure_threshold: 3, window_hours: 24 },
      promotion: {
        require_human_approval: true,
        min_successful_runs: 10,
        cooldown_hours: 72,
      },
    };

    const context: TrustResolutionContext = {
      requestId: "req-1",
      repositoryId: "x",
    };

    expect(resolver.resolve(context, emptyConfig)).toBe(1);
  });

  test("no caching -- changing config between calls reflects in second result", () => {
    const context: TrustResolutionContext = {
      requestId: "req-1",
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

  test("per-request override of 0 is respected (falsy but valid)", () => {
    const config = makeConfig({
      system_default_level: 3,
      repositories: { "repo-a": { default_level: 3 } },
    });

    const context: TrustResolutionContext = {
      requestId: "req-1",
      requestOverride: 0,
      repositoryId: "repo-a",
    };

    expect(resolver.resolve(context, config)).toBe(0);
  });

  test("each trust level (0-3) can be returned as per-request override", () => {
    const config = makeConfig({ system_default_level: 1 });

    for (const level of [0, 1, 2, 3] as const) {
      const context: TrustResolutionContext = {
        requestId: "req-1",
        requestOverride: level,
        repositoryId: "any",
      };
      expect(resolver.resolve(context, config)).toBe(level);
    }
  });
});

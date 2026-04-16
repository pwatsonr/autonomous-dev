/**
 * Trust Level Resolver (SPEC-009-1-2, Task 3).
 *
 * Implements three-tier trust level resolution:
 *   1. Per-request override (highest priority)
 *   2. Per-repo default
 *   3. System global default
 *   4. Hardcoded fallback to L1
 *
 * Resolution is stateless and per-invocation -- the resolver does not cache
 * results across gate checks. This ensures that config hot-reload and
 * mid-pipeline trust changes take effect at the next gate boundary.
 */

import type { TrustLevel, TrustConfig } from "./types";
import { isTrustLevel } from "./types";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Context for a single trust level resolution.
 */
export interface TrustResolutionContext {
  /** Unique request identifier, used to track pending trust changes. */
  requestId: string;
  /** Per-request trust level override. */
  requestOverride?: TrustLevel;
  /** Repository identifier used to look up per-repo config. */
  repositoryId: string;
}

// ---------------------------------------------------------------------------
// TrustResolver
// ---------------------------------------------------------------------------

/**
 * Resolves the effective trust level for a given gate check using the
 * three-tier hierarchy: per-request > per-repo > system default > L1 fallback.
 *
 * The resolver is stateless; every call to `resolve()` evaluates the
 * hierarchy from scratch against the provided config. This guarantees that
 * config hot-reload and mid-pipeline changes take effect at the next gate
 * boundary without stale caches.
 */
export class TrustResolver {
  /**
   * Resolve the effective trust level.
   *
   * Algorithm:
   *   1. If `context.requestOverride` is defined and is a valid TrustLevel
   *      (0-3), return it.
   *   2. Else if `config.repositories[context.repositoryId]?.default_level`
   *      is defined, return it.
   *   3. Else if `config.system_default_level` is defined, return it.
   *   4. Else return 1 (L1 hardcoded fallback).
   */
  resolve(context: TrustResolutionContext, config: TrustConfig): TrustLevel {
    // Tier 1: per-request override
    if (
      context.requestOverride !== undefined &&
      isTrustLevel(context.requestOverride)
    ) {
      return context.requestOverride;
    }

    // Tier 2: per-repo default
    const repoConfig = config.repositories[context.repositoryId];
    if (repoConfig !== undefined && isTrustLevel(repoConfig.default_level)) {
      return repoConfig.default_level;
    }

    // Tier 3: system global default
    if (isTrustLevel(config.system_default_level)) {
      return config.system_default_level;
    }

    // Tier 4: hardcoded fallback
    return 1;
  }
}

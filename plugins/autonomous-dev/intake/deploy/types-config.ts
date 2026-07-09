/**
 * Deploy-config TypeScript types mirroring `schemas/deploy-config-v1.json`
 * (SPEC-023-2-01) and `schemas/deploy-config-v2.json` (issues #658 + #659).
 *
 * Cross-reference: TDD-023 §9 (config shape), issues #658, #659.
 *
 * These types describe the YAML at `<repo>/.autonomous-dev/deploy.yaml`
 * AFTER YAML parsing but BEFORE schema validation. The resolver narrows
 * to `DeployConfig` only after `validateConfig()` succeeds.
 *
 * @module intake/deploy/types-config
 */

import type { DeployTarget } from './target-types';

/** Approval gate level required before backend invocation. */
export type ApprovalLevel = 'none' | 'single' | 'two-person' | 'admin';

/** Per-environment block under `environments[<name>]`. */
export interface EnvironmentConfig {
  /** Backend name as registered in BackendRegistry. */
  backend: string;
  /** Environment-specific parameters (shallow-merged over repo defaults). */
  parameters?: Record<string, unknown>;
  /** Required approval level. */
  approval: ApprovalLevel;
  /** Per-deploy daily cost cap in USD. 0 means no cap. */
  cost_cap_usd: number;
  /** Optional source environment name (out of scope for PLAN-023-2 logic). */
  auto_promote_from?: string;
}

/** Top-level shape of `deploy.yaml`. */
export interface DeployConfig {
  /** Schema version literal — `"1.0"` (v1) or `"2.0"` (v2 with targets). */
  version: '1.0' | '2.0';
  /** Backend used when an env does not declare one. */
  default_backend?: string;
  /** Repo-level parameters applied beneath every env. */
  parameters?: Record<string, unknown>;
  /** Map of environment name -> environment block. */
  environments: Record<string, EnvironmentConfig>;
  /**
   * Optional array of statically-declared deploy targets (issues #658 + #659).
   *
   * Introduced in v2 of the config schema. Absent or empty in v1 configs —
   * callers must treat this as optional to maintain backward compatibility.
   * Targets declared here are loaded into `DeployTargetRegistry` by
   * `loadConfigTargets()` at startup.
   *
   * Dynamic targets (from homelab plugin providers, etc.) are registered
   * separately via `DeployTargetRegistry.registerProvider()` and are NOT
   * listed here (invariant #674).
   */
  targets?: DeployTarget[];
}

// Re-export so callers can import DeployTarget from this module alongside
// DeployConfig without needing to know the internal module split.
export type { DeployTarget } from './target-types';

/**
 * Output of `resolveEnvironment`. Stable contract consumed by the backend
 * selector (SPEC-023-2-02), the approval state machine (SPEC-023-2-03),
 * the cost-cap pre-check (SPEC-023-2-04), and `deploy plan` (SPEC-023-2-04).
 */
export interface ResolvedEnvironment {
  /** Environment name (e.g., "dev", "staging", "prod" or custom). */
  envName: string;
  /** Resolved backend name (post-inheritance, pre-selector override). */
  backend: string;
  /** Merged parameters: repo defaults <- env-specific. */
  parameters: Record<string, unknown>;
  /** Approval requirement. */
  approval: ApprovalLevel;
  /** Per-env daily cost cap in USD. 0 means no cap. */
  costCapUsd: number;
  /** Optional source env for promotion (informational only here). */
  autoPromoteFrom: string | null;
  /** Where the resolution came from. `"fallback"` when no config exists. */
  source: 'deploy.yaml' | 'fallback';
  /** Absolute path to `deploy.yaml`, or null when fallback. */
  configPath: string | null;
}

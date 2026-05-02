/**
 * Hook engine foundation types (SPEC-019-1-01, Tasks 1-2).
 *
 * Pure declarations: no runtime behavior, no I/O, no class instances. These
 * are the canonical shapes consumed by every other piece of the hook engine
 * (discovery, registry, executor, reload-controller, IPC).
 *
 * - `HookPoint` — the 10 lifecycle points the daemon emits.
 * - `FailureMode` — how the executor reacts to a hook returning non-OK.
 * - `Capability` — closed-world flag set requested by hooks; future sandbox.
 * - `HookEntry` — one hook inside a manifest's `hooks[]` array.
 * - `HookManifest` — the parsed shape of a plugin's `hooks.json`.
 *
 * Spec: TDD-019 §9 (hook-point catalog) and §13.1 (manifest fields).
 *
 * @module intake/hooks/types
 */

/**
 * The 10 hook points the autonomous-dev daemon emits.
 *
 * String values match the kebab-case names in TDD-019 §9 so they round-trip
 * through JSON without translation. These are stable identifiers — adding a
 * new hook point requires bumping the manifest schema version.
 *
 * See TDD-019 §9 for the canonical catalog and lifecycle semantics.
 */
export enum HookPoint {
  IntakePreValidate = 'intake-pre-validate',
  PrdPreAuthor = 'prd-pre-author',
  TddPreAuthor = 'tdd-pre-author',
  CodePreWrite = 'code-pre-write',
  CodePostWrite = 'code-post-write',
  ReviewPreScore = 'review-pre-score',
  ReviewPostScore = 'review-post-score',
  DeployPre = 'deploy-pre',
  DeployPost = 'deploy-post',
  RuleEvaluation = 'rule-evaluation',
}

/** All HookPoint string values, in declaration order. */
export const HOOK_POINTS: readonly HookPoint[] = [
  HookPoint.IntakePreValidate,
  HookPoint.PrdPreAuthor,
  HookPoint.TddPreAuthor,
  HookPoint.CodePreWrite,
  HookPoint.CodePostWrite,
  HookPoint.ReviewPreScore,
  HookPoint.ReviewPostScore,
  HookPoint.DeployPre,
  HookPoint.DeployPost,
  HookPoint.RuleEvaluation,
] as const;

/**
 * Type guard for HookPoint values.
 *
 * Returns true iff `value` is one of the HookPoint enum string values.
 */
export function isValidHookPoint(value: string): value is HookPoint {
  return Object.values(HookPoint).includes(value as HookPoint);
}

/**
 * Behavior when a hook returns a non-OK result or throws.
 *
 * NOTE: PLAN-019-1's executor is "fail open" — every hook is effectively
 * `warn`-mode regardless of declared `failure_mode`. PLAN-019-4 introduces
 * the gating logic that makes `block` actually halt the lifecycle stage.
 */
export enum FailureMode {
  /** Halt the lifecycle stage. Honored once PLAN-019-4 lands. */
  Block = 'block',
  /** Log the failure and continue. */
  Warn = 'warn',
  /** Silently continue. */
  Ignore = 'ignore',
}

/**
 * Capability flags requested by a hook.
 *
 * Closed-world set so the type checker can flag typos in plugin authors'
 * manifests. New capabilities require a schema bump (`hook-manifest-v2.json`).
 * Enforcement lands in PLAN-019-3/4's sandbox layer.
 */
export type Capability =
  | 'filesystem-write'
  | 'network'
  | 'child-processes'
  | 'privileged-env';

/** All known Capability strings, in canonical order. */
export const CAPABILITIES: readonly Capability[] = [
  'filesystem-write',
  'network',
  'child-processes',
  'privileged-env',
] as const;

/**
 * One hook entry inside a plugin's `hooks.json` `hooks[]` array.
 *
 * See TDD-019 §13.1 for field-level documentation.
 */
export interface HookEntry {
  /** Stable identifier within the plugin (kebab-case). */
  id: string;
  /** Which lifecycle point this hook attaches to. */
  hook_point: HookPoint;
  /** Path relative to plugin root, e.g. `./hooks/validate.js`. */
  entry_point: string;
  /** Higher numbers run first. Stable sort preserves insertion order on ties. */
  priority: number;
  /** Behavior on hook failure. */
  failure_mode: FailureMode;
  /** Optional reviewer-slot binding (semantics in PLAN-019-4). */
  reviewer_slot?: string;
  /** Other plugin ids this hook depends on. Resolved by PLAN-019-3/4. */
  dependencies?: string[];
  /** Capabilities the hook requests; sandbox enforces in a future plan. */
  capabilities?: Capability[];
}

/**
 * Parsed plugin manifest (`hooks.json`).
 *
 * Produced by `PluginDiscovery.parseManifest` after JSON parsing and schema
 * validation. See TDD-019 §13.1 for canonical field semantics.
 */
export interface HookManifest {
  /** Globally unique plugin id (kebab-case). */
  id: string;
  /** Human-readable plugin name. */
  name: string;
  /** Semver string, e.g. `1.2.3`. */
  version: string;
  /** Hooks declared by this plugin. May be empty. */
  hooks: HookEntry[];
}

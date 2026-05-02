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

// ---------------------------------------------------------------------------
// SPEC-019-2-01: Validation pipeline types
// ---------------------------------------------------------------------------

/**
 * Single AJV error entry, normalized to the shape the pipeline emits.
 *
 * Mirrors AJV's ErrorObject minus the dialect-specific fields the pipeline
 * does not surface. `params` is preserved (post-redaction) so structured
 * downstream consumers can still introspect what failed.
 */
export interface ValidationError {
  /** JSON Pointer–style path into the validated payload. */
  instancePath: string;
  /** Human-readable failure message (post-redaction). */
  message: string;
  /** Schema-keyword–specific parameters (post-redaction). */
  params?: Record<string, unknown>;
}

/**
 * Result of one `validateHookInput` / `validateHookOutput` call.
 *
 * SPEC-019-2-01 acceptance: every field is populated for both success and
 * failure paths. `sanitizedOutput` equals the deep-copied (and possibly
 * defaults-filled / extras-stripped) payload on success; on failure it is
 * the same deep copy in whatever state AJV left it.
 */
export interface ValidationResult<T = unknown> {
  /** True iff the payload satisfied the schema. */
  isValid: boolean;
  /** Sanitized payload (extras stripped via removeAdditional). */
  sanitizedOutput: T;
  /** Structured AJV errors, or [] on success. */
  errors: ValidationError[];
  /** Non-fatal warnings (e.g., schema version fallback). */
  warnings: string[];
  /** Wall-clock duration of the validate call in milliseconds. */
  validationTime: number;
  /** Hook point this validation was for (echoed back for audit logging). */
  hookPoint: string;
  /** Resolved schema version actually used (may differ from requested if fallback occurred). */
  schemaVersion: string;
  /** Direction: 'input' or 'output'. */
  direction: 'input' | 'output';
}

/** Logger contract used by ValidationPipeline. Mirrors the console subset we need. */
export interface ValidationLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/** Constructor options for ValidationPipeline. */
export interface ValidationPipelineOptions {
  /** Absolute path to the schemas root. Default: `${pluginRoot}/schemas/hooks`. */
  schemasRoot: string;
  /** Optional logger; defaults to console. */
  logger?: ValidationLogger;
  /** Stats rolling-window size (SPEC-019-2-03). Default: 1000. */
  statsWindowSize?: number;
}

/** Cache key shape used internally by ValidationPipeline. */
export type SchemaCacheKey = `${string}:${string}:${'input' | 'output'}`;

// ---------------------------------------------------------------------------
// SPEC-019-2-04: Executor wiring types
// ---------------------------------------------------------------------------

/**
 * Non-fatal warning surfaced from the executor when a hook's input/output
 * validation produced advisory messages (e.g., schema version fallback).
 */
export interface ExecutorWarning {
  /** Plugin owning the hook. */
  pluginId: string;
  /** Hook id within the plugin. */
  hookId: string;
  /** Lifecycle point. */
  point: string;
  /** Direction the warning came from. */
  direction: 'input' | 'output';
  /** Human-readable message. */
  message: string;
}

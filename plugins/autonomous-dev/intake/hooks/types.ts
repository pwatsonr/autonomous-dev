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
  /**
   * Optional reviewer-slot binding.
   *
   * - String form (back-compat with PLAN-019-1 manifests): names a slot.
   *   Treated as opaque by the registry's reviewer-slot index — it does
   *   NOT map to a `ReviewGate` and is ignored by `getReviewersForGate`.
   * - Object form (SPEC-019-4-01): rich `ReviewerSlot` declaration listing
   *   one or more `review_gates`. Hooks declared with this form ARE indexed
   *   under each declared gate and discoverable via
   *   `HookRegistry.getReviewersForGate(gate)`.
   */
  reviewer_slot?: string | ReviewerSlot;
  /** Other plugin ids this hook depends on. Resolved by PLAN-019-3/4. */
  dependencies?: string[];
  /** Capabilities the hook requests; sandbox enforces in a future plan. */
  capabilities?: Capability[];
  /**
   * SPEC-019-3-03: when true, the hook may spawn child processes. Triggers
   * the meta-reviewer audit per TDD-019 §10.3 condition #5.
   */
  allow_child_processes?: boolean;
}

/**
 * Parsed plugin manifest (`hooks.json`).
 *
 * Produced by `PluginDiscovery.parseManifest` after JSON parsing and schema
 * validation. See TDD-019 §13.1 for canonical field semantics.
 *
 * SPEC-019-3-01 / -02 / -03 add the optional trust-pipeline fields
 * (`reviewer_slots`, `capabilities`, `filesystem_write_paths`). They are
 * additive — older manifests without them validate cleanly against
 * `hook-manifest-v1.json` and are treated as "no privileged surface" by
 * the trust validator.
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
  /**
   * Reviewer slots this plugin claims at the manifest level. Distinct from
   * the per-hook `reviewer_slot` field — those bind a single hook entry to
   * a slot, while this lists every slot the plugin participates in for
   * trust-policy purposes (SPEC-019-3-02 strict-mode privileged-reviewer
   * arm).
   */
  reviewer_slots?: string[];
  /**
   * Top-level capability claims aggregated across the plugin. The trust
   * validator's meta-review trigger (SPEC-019-3-03) consults this list.
   */
  capabilities?: ReadonlyArray<Capability | string>;
  /**
   * Filesystem paths the plugin declares it writes to. Used by the
   * meta-review trigger to decide whether the plugin needs `agent-meta-reviewer`.
   * Paths beginning with `/tmp/` are exempt.
   */
  filesystem_write_paths?: string[];
  /**
   * SPEC-022-1-01: Artifact types this plugin emits. Optional in v2 manifests.
   * v1 manifests without this field validate cleanly. See TDD-022 §5.
   */
  produces?: ProducesDeclaration[];
  /**
   * SPEC-022-1-01: Artifact types this plugin requires upstream. Optional in
   * v2 manifests. v1 manifests without this field validate cleanly. See
   * TDD-022 §5.
   */
  consumes?: ConsumesDeclaration[];
}

// ---------------------------------------------------------------------------
// SPEC-022-1-01: Plugin chaining — produces/consumes declarations.
// ---------------------------------------------------------------------------

/**
 * Declaration that a plugin emits an artifact of a given type/version.
 *
 * See TDD-022 §5 (manifest extension catalog).
 */
export interface ProducesDeclaration {
  /** Kebab-case artifact identifier, e.g. 'security-findings'. */
  artifact_type: string;
  /** Producer's exact MAJOR.MINOR (or MAJOR.MINOR.PATCH), e.g. '1.0'. */
  schema_version: string;
  /** Wire format on disk. */
  format: 'json' | 'yaml' | 'text';
  /** Free-form documentation string. */
  description?: string;
  /**
   * SPEC-022-2-01: Per-plugin override for `chains.per_plugin_timeout_seconds`.
   * Optional; when absent the global default applies.
   */
  timeout_seconds?: number;
  /**
   * SPEC-022-2-02: Failure-mode for downstream consumers when this
   * producer fails. Default `warn`.
   */
  on_failure?: ChainFailureMode;
  /**
   * SPEC-022-2-03: When true, the executor pauses the chain after this
   * artifact is produced and awaits operator approval before resuming.
   */
  requires_approval?: boolean;
}

/**
 * Failure-mode triggered when a chain plugin fails.
 *
 * - `block`: halt the entire chain and propagate the error.
 * - `warn`: log + skip downstream consumers (default; PLAN-022-1 behavior).
 * - `ignore`: continue invoking downstream regardless.
 *
 * SPEC-022-2-02.
 */
export type ChainFailureMode = 'block' | 'warn' | 'ignore';

/**
 * Declaration that a plugin requires an artifact of a given type/version
 * from some upstream producer.
 *
 * See TDD-022 §5 (manifest extension catalog).
 */
export interface ConsumesDeclaration {
  /** Kebab-case artifact identifier. */
  artifact_type: string;
  /**
   * Caret-allowed range, e.g. '^1.0' (any 1.x.y producer) or exact '1.0'.
   * Patch versions are ignored for compat (artifacts evolve at MAJOR.MINOR).
   */
  schema_version: string;
  /**
   * If true, missing producer does NOT reject this plugin at orphan-check
   * time. Default false. Used for progressive adoption.
   */
  optional?: boolean;
  /** Free-form documentation string. */
  description?: string;
  /**
   * SPEC-022-2-02: Failure-mode triggered when the upstream producer
   * fails. Used as fallback when the producer omits `produces.on_failure`.
   * Default `warn`.
   */
  on_failure?: ChainFailureMode;
  /**
   * SPEC-022-2-04: If true, this consume edge participates in a
   * privileged chain. Operators must allowlist the producer/consumer
   * pair via `extensions.privileged_chains`.
   */
  requires_approval?: boolean;
}

// ---------------------------------------------------------------------------
// SPEC-019-3-01: Extensions / trust-pipeline types
// ---------------------------------------------------------------------------

/**
 * Three trust-policy modes per TDD-019 §10.1.
 *
 * - `allowlist` — explicit operator opt-in only. Signature ignored.
 * - `permissive` — trust by default; if `signature_verification: true`,
 *   gate on signature.
 * - `strict` — allowlist AND signature both required; reviewer slots
 *   constrained to `privileged_reviewers`.
 */
export type TrustMode = 'allowlist' | 'permissive' | 'strict';

/**
 * The `extensions` section of `~/.claude/autonomous-dev.json`. See
 * `schemas/autonomous-dev-config.schema.json` for canonical defaults.
 */
export interface ExtensionsConfig {
  allowlist: string[];
  privileged_reviewers: string[];
  trust_mode: TrustMode;
  signature_verification: boolean;
  auto_update_allowed: boolean;
  max_plugins_per_hook_point: number;
  global_resource_limits: {
    max_total_memory_mb: number;
    max_concurrent_executions: number;
    max_execution_time_seconds: number;
  };
}

/**
 * The verdict returned by `TrustValidator.validatePlugin` and each step
 * method. `requiresMetaReview` is set when the plugin matched any
 * meta-review trigger condition (SPEC-019-3-03), regardless of the
 * verdict's pass/fail. `metaReviewVerdict` is populated only when a
 * meta-review actually ran (or a cached verdict was returned).
 */
export interface TrustVerdict {
  trusted: boolean;
  reason?: string;
  requiresMetaReview: boolean;
  metaReviewVerdict?: { pass: boolean; findings: string[] };
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

// ---------------------------------------------------------------------------
// SPEC-019-4-01: Reviewer-slot type system
// ---------------------------------------------------------------------------

/**
 * Review gates a `ReviewerSlot` may participate in.
 *
 * - `code-review`, `security-review`: PRD-004 review pipeline.
 * - `document-review-prd`, `document-review-tdd`, `document-review-plan`,
 *   `document-review-spec`: PLAN-017-2 document-cascade gates (declared
 *   here ahead of consumers to avoid a follow-up type-system bump).
 *
 * Cross-reference: TDD-019 §11.1.
 *
 * NB: intentionally a string union (not a TypeScript `enum`) so it is
 * JSON-serializable in plugin manifests with no runtime conversion.
 */
export type ReviewGate =
  | 'code-review'
  | 'security-review'
  | 'document-review-prd'
  | 'document-review-tdd'
  | 'document-review-plan'
  | 'document-review-spec';

/** All ReviewGate string values, in declaration order. */
export const REVIEW_GATES: readonly ReviewGate[] = [
  'code-review',
  'security-review',
  'document-review-prd',
  'document-review-tdd',
  'document-review-plan',
  'document-review-spec',
] as const;

/** Type guard for ReviewGate string values. */
export function isReviewGate(value: string): value is ReviewGate {
  return (REVIEW_GATES as readonly string[]).includes(value);
}

/** Verdict outcome categories used by reviewer slots. Cross-reference: TDD-019 §11.2. */
export type VerdictKind = 'APPROVE' | 'CONCERNS' | 'REQUEST_CHANGES';

/**
 * One finding produced by a reviewer slot. Cross-reference: TDD-019 §11.2.
 *
 * `id` is intended for de-duplication of identical findings reported by
 * different reviewers in the same gate aggregation.
 */
export interface Finding {
  /** Stable identifier for de-duplication across reviewers. */
  id: string;
  severity: 'info' | 'warn' | 'error' | 'critical';
  message: string;
  /** Optional file:line pointer for code/document review surfaces. */
  location?: string;
}

/**
 * Single reviewer's verdict on a review-gate input.
 *
 * Cross-reference: TDD-019 §11.3 (fingerprinting) and §11.4 (audit metadata).
 *
 * The `fingerprint` field is populated by SPEC-019-4-02 / `fingerprint.ts`;
 * pre-fingerprint construction sites set it to the empty string and the
 * aggregator stamps the canonical SHA-256 value before the verdict escapes.
 */
export interface Verdict {
  verdict: VerdictKind;
  /** Score in [0, 100]; the gate aggregator weights/thresholds these. */
  score: number;
  findings: Finding[];
  /** SHA-256 fingerprint per TDD §11.3. Empty string before fingerprinting. */
  fingerprint: string;
  /** Plugin identity stamped per TDD §11.4. */
  plugin_id: string;
  plugin_version: string;
  agent_name: string;
}

/**
 * Reviewer-slot declaration on a hook entry.
 *
 * When present (object form on `HookEntry.reviewer_slot`), the hook is also
 * indexed by review gate in the registry and discoverable via
 * `HookRegistry.getReviewersForGate(gate)`.
 *
 * Cross-reference: TDD-019 §11.1 (verbatim shape).
 */
export interface ReviewerSlot {
  /** Name of the agent registered via PLAN-005 to perform the review. */
  agent_name: string;
  /** Gates this reviewer participates in (must contain ≥1 entry). */
  review_gates: ReviewGate[];
  /** Free-form domain tags (e.g. 'rust', 'k8s-yaml') for routing. */
  expertise_domains: string[];
  /**
   * Per-reviewer minimum score to count as an APPROVE. The gate aggregator
   * may use this in addition to the gate-level minimum threshold.
   */
  minimum_threshold: number;
  /**
   * Optional fingerprint format hint. SPEC-019-4-02 currently ignores this
   * and uses the canonical SHA-256 format from TDD §11.3.
   */
  fingerprint_format?: 'sha256-canonical-json';
}

/** Type guard: returns true when the value is a `ReviewerSlot` object (not the string back-compat form). */
export function isReviewerSlotObject(value: unknown): value is ReviewerSlot {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as ReviewerSlot).review_gates) &&
    typeof (value as ReviewerSlot).agent_name === 'string'
  );
}

// ---------------------------------------------------------------------------
// SPEC-019-4-03: Sequential execution with chained context + failure modes
// ---------------------------------------------------------------------------

/**
 * String-literal alias for the `FailureMode` enum values.
 *
 * Manifest authors and audit serializers use the bare string form; the enum
 * is preserved for in-engine call sites that prefer the symbolic constants.
 *
 * Cross-reference: SPEC-019-4-03 Type Additions.
 */
export type FailureModeStr = 'block' | 'warn' | 'ignore';

/**
 * Per-invocation context handed to a chained hook entry-point as its
 * SECOND argument (the first remains the raw, sanitized input for
 * back-compat with PLAN-019-1 hook authors that accept `(input)` only).
 *
 * Hooks observe the cumulative `previousResults` for every prior hook at
 * the same hook point — including warn/ignore failures — in execution
 * order. The collection is provided as a `ReadonlyArray`; mutating it is
 * a contract violation. The executor passes a defensive copy on each
 * iteration so attempted mutations cannot leak between hook invocations.
 *
 * Cross-reference: SPEC-019-4-03 Type Additions; TDD-019 §12.1.
 */
export interface HookContext<I = unknown> {
  /** The original input passed to executeHooks(). Read-only. */
  readonly originalContext: I;
  /** Results from all prior hooks at this hook point, in execution order. */
  readonly previousResults: ReadonlyArray<HookResult>;
}

/**
 * What a single hook returned (or recorded as a non-blocking failure).
 *
 * One of `output` (success) or `error` (failure under `warn`/`ignore`/`block`)
 * is populated. `block`-mode failures additionally short-circuit the executor
 * via `HookBlockedError`; the failing `HookResult` is carried on the error.
 *
 * Cross-reference: SPEC-019-4-03 Type Additions.
 */
export interface HookResult<O = unknown> {
  plugin_id: string;
  plugin_version: string;
  /** Stable identifier from manifest (matches `HookEntry.id`). */
  hook_id: string;
  priority: number;
  /** Set on success. */
  output?: O;
  /** Set on failure under any failure mode. */
  error?: { message: string; stack?: string; failure_mode: FailureModeStr };
  /** Wall-clock duration, milliseconds. Always non-negative. */
  duration_ms: number;
}

/**
 * Aggregated outcome from the chained-context executor variant
 * (`HookExecutor.executeHooksChained`).
 *
 * `failures` is the subset of `results` whose `error` is set under a
 * non-blocking mode (`warn` or `ignore`). `aborted` is `true` only when a
 * `block`-mode failure threw `HookBlockedError` during the run; the catching
 * caller assembles the partial result manually.
 *
 * Cross-reference: SPEC-019-4-03 Type Additions.
 */
export interface ChainedHookExecutionResult<O = unknown> {
  hook_point: string;
  results: HookResult<O>[];
  failures: HookResult<O>[];
  aborted: boolean;
}

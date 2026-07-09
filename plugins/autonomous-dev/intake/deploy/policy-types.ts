/**
 * Deploy policy document schema — issues #668 + #669.
 *
 * A `PolicyDocument` is a versioned list of typed `PolicyRule` objects.
 * Each rule declares a `when` predicate (matching a `DeployTarget` by
 * discovered attributes — never by hard-coded id), a `type` key that
 * dispatches to a registered rule-type evaluator, and an `effect`.
 *
 * **Open by design (invariant #674).**
 * - `type` is a plain `string`, NOT a closed enum. New rule types register
 *   themselves in the `RuleTypeRegistry` without modifying core files.
 * - `when` reuses the `TargetSelector` shape from `target-types.ts`, which
 *   matches on tags / kind / env / capability — never on bare instance ids.
 * - `params` is `Record<string, unknown>` so each rule type can carry its
 *   own validated sub-schema without a core PR per addition.
 *
 * **Merge semantics (implemented in `policy-engine.ts`).**
 * - deny-wins: one deny anywhere in the matched rule set blocks the request.
 * - require-approval: accumulates across all matched require-approval rules.
 * - allow: a no-op effect; present so operators can write explicit allow rules
 *   as the default when the document ends with a catch-all deny.
 *
 * **Purity.**
 * Nothing in this module performs I/O or calls `Date.now()`. The evaluator
 * receives an optional `context.now` (milliseconds since epoch) so tests can
 * inject deterministic timestamps. This invariant is checked per-file in the
 * purity proof section of the PR description.
 *
 * Cross-reference: issues #668, #669, #674.
 *
 * @module intake/deploy/policy-types
 */

import type { TargetSelector } from './target-types';

// ---------------------------------------------------------------------------
// Effect types
// ---------------------------------------------------------------------------

/**
 * The outcome a rule produces when its predicate matches.
 *
 * - `'allow'`            — Explicit permit (useful as final-allow after deny rules).
 * - `'deny'`             — Hard block; deny-wins over all other effects.
 * - `'require-approval'` — Accumulates an approval requirement; `params.approvers`
 *                          carries the required approver group ids.
 */
export type RuleEffect = 'allow' | 'deny' | 'require-approval';

// ---------------------------------------------------------------------------
// Target predicate (re-exported from target-types shape)
// ---------------------------------------------------------------------------

/**
 * Predicate that gates whether a rule applies to a given `DeployTarget`.
 *
 * Reuses `TargetSelector` from `target-types.ts` so the matching logic is
 * shared and maintained in one place. All fields are optional; omitting all
 * fields means "matches every target" (same as `TargetSelector` semantics).
 *
 * INVARIANT: never add an `id` field here that references specific instance
 * identifiers — rules must survive hardware changes (#674).
 */
export type TargetPredicate = TargetSelector;

// ---------------------------------------------------------------------------
// Policy rule
// ---------------------------------------------------------------------------

/**
 * A single policy rule.
 *
 * Evaluated in document order by the engine; effects accumulate across all
 * matching rules (deny-wins).
 */
export interface PolicyRule {
  /**
   * Unique stable identifier within the document (e.g., `'no-prod-without-gpu'`).
   * Appears in `PolicyDecision.matchedRules` and violation traces.
   */
  id: string;

  /** Optional human-readable explanation shown in CLI output + audit log. */
  description?: string;

  /**
   * Optional target predicate. When absent the rule matches every target
   * (useful for global rules, e.g., "deny deploys outside maintenance window").
   */
  when?: TargetPredicate;

  /**
   * Rule-type discriminator. Open string — new types register via
   * `registerRuleType()` in `policy-engine.ts` without a core PR.
   *
   * Built-in types (issue #669):
   *   - `'placement'`          — require/forbid based on target attributes.
   *   - `'affinity'`           — co-locate or anti-co-locate with another service.
   *   - `'quota'`              — cap concurrent deploys to a target or env.
   *   - `'blast-radius'`       — cap the number of targets an action may affect.
   *   - `'maintenance-window'` — allow/deny deploys based on time window.
   */
  type: string;

  /** Outcome when this rule matches and its type-evaluator fires. */
  effect: RuleEffect;

  /**
   * Rule-type-specific parameters. Validated and interpreted by the registered
   * `RuleTypeEvaluator` for this `type` key. `Record<string, unknown>` so each
   * evaluator carries its own sub-schema without a core type change.
   */
  params: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Policy document
// ---------------------------------------------------------------------------

/**
 * Top-level versioned policy document.
 *
 * Loaded from `deploy.yaml` under the optional `policy` key (or from a
 * separate `policy.yaml`). The `getActivePolicy()` function returns this or
 * a default `EMPTY_POLICY` when none is configured (backward compatible:
 * an empty rule list allows all deploys).
 */
export interface PolicyDocument {
  /**
   * Document format version. Currently `"1.0"`. Future incompatible changes
   * bump the major version.
   */
  version: '1.0';

  /** Ordered list of rules. Evaluated top-to-bottom; effects are merged. */
  rules: PolicyRule[];
}

// ---------------------------------------------------------------------------
// Evaluation request + decision
// ---------------------------------------------------------------------------

/**
 * Request passed to `evaluatePolicy()`.
 *
 * Contains everything the engine needs to evaluate all rules without performing
 * any I/O. Rule-type evaluators that need live state (e.g., quota counts)
 * receive it via `context`.
 */
export interface PolicyRequest {
  /** Service / artifact being deployed. */
  service: string;

  /** Resolved deploy target the service will be deployed to. */
  target: import('./target-types').DeployTarget;

  /**
   * Optional evaluation context.
   *
   * Rule-type evaluators may read these fields. All fields are optional;
   * evaluators must handle absence gracefully (fail-open or with a clear
   * violation message as appropriate).
   *
   * - `now`            — Current timestamp (ms since epoch). Injected by
   *                      callers so the evaluator stays pure (no `Date.now()`
   *                      in the pure path). Required by `maintenance-window`.
   * - `currentCounts`  — Snapshot of live deploy counts, keyed by target-id
   *                      or env name. Required by `quota` evaluators.
   * - `affectedTargets`— Number of targets (or replicas) the action touches.
   *                      Required by `blast-radius` evaluators.
   * - `colocatedServices` — Services already deployed on the same target.
   *                         Required by `affinity` evaluators.
   */
  context?: {
    now?: number;
    currentCounts?: Record<string, number>;
    affectedTargets?: number;
    colocatedServices?: string[];
    [key: string]: unknown;
  };
}

/**
 * A single violation produced when a rule fires with `effect: 'deny'` or
 * when a rule-type evaluator signals a constraint failure.
 */
export interface PolicyViolation {
  /** The rule id that produced this violation. */
  ruleId: string;

  /** The rule `type` (for routing to the right evaluator message). */
  type: string;

  /** Human-readable reason, localized for CLI / portal display. */
  message: string;
}

/**
 * Output of `evaluatePolicy()`.
 *
 * Deterministic: same inputs always produce the same output. The engine never
 * short-circuits on the first denial — it collects all violations so callers
 * can present a complete picture to operators.
 */
export interface PolicyDecision {
  /**
   * `true` iff no deny rule matched AND all require-approval gates are satisfied
   * (i.e., `requiredApprovals` is empty).
   *
   * Note: the evaluator itself does NOT resolve approvals — it only reports
   * which groups are required. Callers decide whether current approval state
   * is sufficient before acting on `allowed`.
   *
   * For the purposes of `evaluatePolicy()`, `allowed` is `true` when there
   * are no violations and no required approvals outstanding. A caller that
   * implements approval resolution may re-check after approvals are gathered.
   */
  allowed: boolean;

  /**
   * Ordered list of approver-group ids required before the deploy may proceed.
   * Empty when no `require-approval` rules matched.
   */
  requiredApprovals: string[];

  /**
   * All violations produced by deny rules. Non-empty implies `allowed: false`.
   */
  violations: PolicyViolation[];

  /**
   * Ids of all rules that had matching predicates, regardless of effect.
   * Useful for audit traces.
   */
  matchedRules: string[];
}

// ---------------------------------------------------------------------------
// Sentinel: empty policy (allow-all default)
// ---------------------------------------------------------------------------

/**
 * Default policy returned when no `deploy.policy` document is configured.
 *
 * An empty rule list produces `allowed: true` with no violations — backward
 * compatible with pre-policy deployments.
 */
export const EMPTY_POLICY: PolicyDocument = Object.freeze({
  version: '1.0' as const,
  rules: [],
});

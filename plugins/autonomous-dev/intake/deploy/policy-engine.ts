/**
 * Pure deploy policy evaluator + open rule-type registry — issues #668 + #669.
 *
 * ## Architecture
 *
 * ```
 * evaluatePolicy(request, ruleSet)
 *   └─ for each rule in ruleSet.rules
 *       ├─ predicateMatches(rule.when, request.target)   — TargetSelector match
 *       ├─ lookupEvaluator(rule.type)                    — open registry
 *       └─ evaluator.evaluate(rule, request)             — pure, no I/O
 * ```
 *
 * ## Purity guarantee
 *
 * `evaluatePolicy` and every registered `RuleTypeEvaluator` in this file are
 * PURE: they accept inputs, return outputs, and perform NO I/O, NO filesystem
 * access, and NO calls to `Date.now()`. The `maintenance-window` evaluator
 * reads `request.context.now` (injected by the caller) instead of the wall
 * clock. The module does NOT export any side-effectful function that calls
 * `Date.now()`.
 *
 * ## Open registry
 *
 * New rule types register via `registerRuleType(id, evaluator)`. Existing
 * registrations are NOT overwritten (throws) to prevent accidental shadowing.
 * External plugins can call `registerRuleType` from their `activate()` hook
 * without modifying this file.
 *
 * ## Merge semantics
 *
 * 1. A rule fires when `predicateMatches(rule.when, target)` returns `true`.
 * 2. All matching rules are collected in document order.
 * 3. deny-wins: any firing deny rule sets `allowed=false`.
 * 4. require-approval: accumulates distinct approver group ids.
 * 5. allow: no-op on `allowed` (never blocks a deny).
 * 6. An unknown `rule.type` fires as `deny` with a clear violation message
 *    (fail-safe default — unknown rules must not silently allow deploys).
 *
 * ## Determinism
 *
 * The engine evaluates rules in document order (array index order), which is
 * deterministic. The `requiredApprovals` list preserves insertion order with
 * duplicates removed. The `matchedRules` list preserves document order.
 *
 * Cross-reference: issues #668, #669, #674.
 *
 * @module intake/deploy/policy-engine
 */

import { matchesSelector } from './target-registry';
import type {
  PolicyDocument,
  PolicyDecision,
  PolicyRequest,
  PolicyRule,
  PolicyViolation,
  TargetPredicate,
} from './policy-types';
import type { DeployTarget } from './target-types';

// ---------------------------------------------------------------------------
// Rule-type evaluator contract
// ---------------------------------------------------------------------------

/**
 * Result returned by a `RuleTypeEvaluator.evaluate()` call.
 *
 * - `fires: false`  — The rule type's own condition is not met; the rule does
 *                     not contribute a violation or approval (the engine skips
 *                     it for effect purposes, but still records it in
 *                     `matchedRules` because the predicate matched).
 * - `fires: true`   — The condition is met; `effect` from `PolicyRule` is
 *                     applied. Optionally carries a `message` override and
 *                     `approvers` for `require-approval` rules.
 */
export type RuleTypeResult =
  | { fires: false }
  | {
      fires: true;
      /** Human-readable message for violation traces. */
      message?: string;
      /**
       * Approver group ids — only read when `rule.effect === 'require-approval'`.
       * Falls back to `rule.params.approvers` cast to string[] when absent here.
       */
      approvers?: string[];
    };

/**
 * Contract for a pluggable rule-type evaluator.
 *
 * Implementations MUST be pure: no I/O, no `Date.now()`, no global state
 * mutation. All context (timestamps, counts, etc.) comes through
 * `request.context`.
 */
export interface RuleTypeEvaluator {
  /**
   * Evaluate a single rule against a deploy request.
   *
   * Called only when the rule's `when` predicate already matched the target.
   *
   * @param rule    - The policy rule being evaluated (includes `params`).
   * @param request - The deploy request (includes `target` and `context`).
   * @returns `{ fires: false }` when the type-level condition is not met,
   *          or `{ fires: true, ... }` when the condition fires.
   */
  evaluate(rule: PolicyRule, request: PolicyRequest): RuleTypeResult;
}

// ---------------------------------------------------------------------------
// Open rule-type registry
// ---------------------------------------------------------------------------

const ruleTypeRegistry = new Map<string, RuleTypeEvaluator>();

/**
 * Register a new rule-type evaluator.
 *
 * Callers are plugin `activate()` hooks and this module's own built-in
 * registrations. Re-registering the same `typeId` throws to prevent
 * accidental shadowing in a multi-plugin environment.
 *
 * @param typeId    - The `rule.type` string this evaluator handles.
 * @param evaluator - Pure evaluator implementation.
 * @throws `Error` if `typeId` is already registered.
 */
export function registerRuleType(typeId: string, evaluator: RuleTypeEvaluator): void {
  if (ruleTypeRegistry.has(typeId)) {
    throw new Error(
      `Policy rule type '${typeId}' is already registered. ` +
        'Use replaceRuleType() to intentionally override.',
    );
  }
  ruleTypeRegistry.set(typeId, evaluator);
}

/**
 * Replace an existing rule-type registration.
 *
 * Use with care — intended for tests that need to mock built-in evaluators.
 * Unlike `registerRuleType`, this silently overwrites.
 *
 * @param typeId    - The `rule.type` string to override.
 * @param evaluator - Replacement evaluator.
 */
export function replaceRuleType(typeId: string, evaluator: RuleTypeEvaluator): void {
  ruleTypeRegistry.set(typeId, evaluator);
}

/**
 * Look up a registered rule-type evaluator.
 *
 * Returns `undefined` when the type is not registered; the engine treats
 * unknown types as deny (fail-safe).
 *
 * @param typeId - Rule type string.
 * @returns The evaluator or `undefined`.
 */
export function getRuleTypeEvaluator(typeId: string): RuleTypeEvaluator | undefined {
  return ruleTypeRegistry.get(typeId);
}

/**
 * Return all registered rule-type ids.
 *
 * Primarily for introspection and the `deploy policy check` CLI.
 */
export function listRuleTypes(): string[] {
  return [...ruleTypeRegistry.keys()].sort();
}

/**
 * TEST ONLY — clear all registered rule types and re-register built-ins.
 *
 * Call in `afterEach` to isolate test registrations from bleeding into
 * subsequent tests. Production code must never call this.
 */
export function resetRuleTypeRegistry(): void {
  ruleTypeRegistry.clear();
  registerBuiltinRuleTypes();
}

// ---------------------------------------------------------------------------
// Predicate matching
// ---------------------------------------------------------------------------

/**
 * Test whether a rule's `when` predicate matches a given deploy target.
 *
 * - When `predicate` is `undefined` (absent from the rule), matches always.
 * - Delegates to `matchesSelector` from `target-registry.ts` so the logic is
 *   shared and maintained once.
 *
 * INVARIANT: matching is on tags/kind/env/capability only — never on bare ids
 * (invariant #674 — rules must survive hardware changes).
 *
 * @param predicate - Optional `TargetSelector`-shaped predicate from the rule.
 * @param target    - The deploy target to test against.
 * @returns `true` when the rule's predicate matches the target.
 */
export function predicateMatches(
  predicate: TargetPredicate | undefined,
  target: DeployTarget,
): boolean {
  if (predicate === undefined) return true;
  return matchesSelector(target, predicate);
}

// ---------------------------------------------------------------------------
// Core evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a `PolicyDocument` against a deploy `PolicyRequest`.
 *
 * **Pure**: same inputs always produce the same output. No I/O, no `Date.now()`,
 * no mutation of any external state.
 *
 * **Merge semantics:**
 * 1. Evaluate each rule in document order.
 * 2. Skip rules whose `when` predicate does not match the request's target.
 * 3. For matching rules, look up the `RuleTypeEvaluator`; if not found, treat
 *    as an unknown-type deny (fail-safe).
 * 4. Aggregate effects: deny-wins, require-approval accumulates, allow is no-op.
 * 5. `allowed` is `true` iff `violations` is empty AND `requiredApprovals` is empty.
 *
 * @param request - The deploy request (service + target + optional context).
 * @param ruleSet - The policy document to evaluate against.
 * @returns A `PolicyDecision` with full violation traces and matched rule ids.
 */
export function evaluatePolicy(
  request: PolicyRequest,
  ruleSet: PolicyDocument,
): PolicyDecision {
  const matchedRules: string[] = [];
  const violations: PolicyViolation[] = [];
  const requiredApprovals: string[] = [];

  for (const rule of ruleSet.rules) {
    // 1. Check predicate.
    if (!predicateMatches(rule.when, request.target)) continue;

    // 2. Predicate matched — record the rule.
    matchedRules.push(rule.id);

    // 3. Look up the evaluator; unknown type → fail-safe deny.
    const evaluator = ruleTypeRegistry.get(rule.type);
    if (!evaluator) {
      violations.push({
        ruleId: rule.id,
        type: rule.type,
        message:
          `Unknown rule type '${rule.type}' in policy rule '${rule.id}'. ` +
          'Deploy blocked as a safety precaution (unrecognised rules are treated as deny).',
      });
      continue;
    }

    // 4. Invoke the type evaluator (pure).
    const result = evaluator.evaluate(rule, request);
    if (!result.fires) continue;

    // 5. Apply effect.
    switch (rule.effect) {
      case 'deny':
        violations.push({
          ruleId: rule.id,
          type: rule.type,
          message:
            result.message ??
            (rule.description
              ? `Denied by rule '${rule.id}': ${rule.description}`
              : `Denied by rule '${rule.id}'.`),
        });
        break;

      case 'require-approval': {
        const approvers = result.approvers ?? extractApprovers(rule.params);
        for (const a of approvers) {
          if (!requiredApprovals.includes(a)) requiredApprovals.push(a);
        }
        // Also emit a violation entry so the decision includes the reason.
        // This is informational (not a deny), but callers must check
        // `requiredApprovals` to decide whether to gate the deploy.
        break;
      }

      case 'allow':
        // Explicit allow — no violation, no additional requirement.
        break;

      default: {
        // Defensive: treat unrecognised effects as deny.
        const _exhaustive: never = rule.effect;
        void _exhaustive;
        violations.push({
          ruleId: rule.id,
          type: rule.type,
          message: `Rule '${rule.id}' has unrecognised effect '${String(rule.effect)}'; treated as deny.`,
        });
      }
    }
  }

  const allowed = violations.length === 0 && requiredApprovals.length === 0;

  return { allowed, requiredApprovals, violations, matchedRules };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract `approvers` from rule params as a `string[]`.
 *
 * Accepts `params.approvers` as `string[]` or a single `string`.
 * Returns empty array when missing or invalid.
 *
 * @param params - Rule params record.
 * @returns Array of approver group id strings.
 */
function extractApprovers(params: Record<string, unknown>): string[] {
  const raw = params['approvers'];
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw === 'string') return [raw];
  return [];
}

// ---------------------------------------------------------------------------
// Built-in rule type: placement
// ---------------------------------------------------------------------------

/**
 * `placement` rule type — require or forbid deploying to targets that match
 * (or do not match) a secondary `TargetSelector` carried in `params.require`
 * / `params.forbid`.
 *
 * Params:
 *   - `require` (TargetSelector): target MUST match this selector (fail if not).
 *   - `forbid`  (TargetSelector): target MUST NOT match this selector (fail if it does).
 *
 * At least one of `require` / `forbid` must be present; both may be set (both
 * are checked). The `effect` from the rule is applied when the condition fires.
 *
 * Examples:
 *   - "service must land on a gpu node": `{ require: { capability: 'gpu' } }`
 *   - "service must not go to prod without approval":
 *       `{ forbid: { env: 'prod' } }` with `effect: 'require-approval'`
 */
const placementEvaluator: RuleTypeEvaluator = {
  evaluate(rule, request): RuleTypeResult {
    const { require: req, forbid } = rule.params as {
      require?: TargetPredicate;
      forbid?: TargetPredicate;
    };

    let fired = false;
    const messages: string[] = [];

    if (req !== undefined) {
      if (!matchesSelector(request.target, req)) {
        fired = true;
        messages.push(
          `Target '${request.target.id}' does not satisfy placement requirement ${JSON.stringify(req)}.`,
        );
      }
    }

    if (forbid !== undefined) {
      if (matchesSelector(request.target, forbid)) {
        fired = true;
        messages.push(
          `Target '${request.target.id}' matches forbidden placement selector ${JSON.stringify(forbid)}.`,
        );
      }
    }

    if (!fired) return { fires: false };
    return { fires: true, message: messages.join(' ') };
  },
};

// ---------------------------------------------------------------------------
// Built-in rule type: affinity
// ---------------------------------------------------------------------------

/**
 * `affinity` rule type — co-location and anti-affinity between services.
 *
 * Params:
 *   - `require`  (string[]): service names that MUST already be on the same
 *                target (co-location require). Fails if any are absent.
 *   - `forbid`   (string[]): service names that MUST NOT be on the same target
 *                (anti-affinity). Fails if any are present.
 *
 * `request.context.colocatedServices` supplies the current co-location state
 * (injected by the caller — no live query in this pure path).
 */
const affinityEvaluator: RuleTypeEvaluator = {
  evaluate(rule, request): RuleTypeResult {
    const { require: req, forbid } = rule.params as {
      require?: string[];
      forbid?: string[];
    };
    const colocated = request.context?.colocatedServices ?? [];

    let fired = false;
    const messages: string[] = [];

    if (Array.isArray(req)) {
      const missing = req.filter((s) => !colocated.includes(s));
      if (missing.length > 0) {
        fired = true;
        messages.push(
          `Affinity requirement not met: services [${missing.join(', ')}] ` +
            `must be colocated on target '${request.target.id}' but are absent.`,
        );
      }
    }

    if (Array.isArray(forbid)) {
      const present = forbid.filter((s) => colocated.includes(s));
      if (present.length > 0) {
        fired = true;
        messages.push(
          `Anti-affinity violation: services [${present.join(', ')}] ` +
            `must not share target '${request.target.id}'.`,
        );
      }
    }

    if (!fired) return { fires: false };
    return { fires: true, message: messages.join(' ') };
  },
};

// ---------------------------------------------------------------------------
// Built-in rule type: quota
// ---------------------------------------------------------------------------

/**
 * `quota` rule type — cap concurrent deploy counts.
 *
 * Params:
 *   - `scope`  (`'target'` | `'env'`): what key to look up in `currentCounts`.
 *     - `'target'` → reads `currentCounts[request.target.id]`.
 *     - `'env'`    → reads `currentCounts[request.target.env ?? '']`.
 *     Defaults to `'target'` when absent.
 *   - `max`    (number): maximum allowed concurrent deploys. A count >= max fires.
 *
 * `request.context.currentCounts` must be supplied by the caller as a snapshot
 * of current deploy counts (no live queries in the pure path).
 *
 * When `currentCounts` is absent from context, the rule fires conservatively
 * (fail-safe: treat the count as 0, which never exceeds a max>0).
 */
const quotaEvaluator: RuleTypeEvaluator = {
  evaluate(rule, request): RuleTypeResult {
    const scope = (rule.params['scope'] as string | undefined) ?? 'target';
    const max = rule.params['max'];

    if (typeof max !== 'number' || max < 0) {
      // Misconfigured rule — deny as fail-safe.
      return {
        fires: true,
        message:
          `Quota rule '${rule.id}' has invalid 'max' parameter (${JSON.stringify(max)}); ` +
          'deploy blocked as a safety precaution.',
      };
    }

    const counts = request.context?.currentCounts ?? {};
    let key: string;
    if (scope === 'env') {
      key = request.target.env ?? '';
    } else {
      key = request.target.id;
    }

    const current = counts[key] ?? 0;
    if (current >= max) {
      return {
        fires: true,
        message:
          `Quota exceeded for ${scope} '${key}': current=${current}, max=${max}. ` +
          `Service '${request.service}' cannot be deployed until a slot is free.`,
      };
    }

    return { fires: false };
  },
};

// ---------------------------------------------------------------------------
// Built-in rule type: blast-radius
// ---------------------------------------------------------------------------

/**
 * `blast-radius` rule type — cap the number of targets an action may affect.
 *
 * Params:
 *   - `maxTargets` (number): maximum number of affected targets / replicas.
 *     A count > maxTargets fires.
 *
 * `request.context.affectedTargets` carries the planned impact count
 * (injected by the orchestrator — no live query in the pure path).
 *
 * When `affectedTargets` is absent, the rule does NOT fire (conservative
 * default: if we don't know the blast radius, we can't cap it here; a
 * separate gate should require the count to be provided).
 */
const blastRadiusEvaluator: RuleTypeEvaluator = {
  evaluate(rule, request): RuleTypeResult {
    const maxTargets = rule.params['maxTargets'];
    if (typeof maxTargets !== 'number' || maxTargets < 0) {
      return {
        fires: true,
        message:
          `Blast-radius rule '${rule.id}' has invalid 'maxTargets' parameter ` +
          `(${JSON.stringify(maxTargets)}); deploy blocked as a safety precaution.`,
      };
    }

    const affected = request.context?.affectedTargets;
    if (affected === undefined) return { fires: false };

    if (affected > maxTargets) {
      return {
        fires: true,
        message:
          `Blast-radius cap exceeded: this action would affect ${affected} target(s), ` +
          `but rule '${rule.id}' allows at most ${maxTargets}.`,
      };
    }

    return { fires: false };
  },
};

// ---------------------------------------------------------------------------
// Built-in rule type: maintenance-window
// ---------------------------------------------------------------------------

/**
 * Parses a UTC time string `"HH:MM"` into minutes-since-midnight.
 *
 * @param t - Time string in `"HH:MM"` format (24h UTC).
 * @returns Minutes since midnight, or `NaN` on parse failure.
 */
function parseUtcTime(t: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return NaN;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return NaN;
  return h * 60 + min;
}

/**
 * `maintenance-window` rule type — deny (or require-approval for) deploys
 * outside (or inside) a configured time window.
 *
 * Params:
 *   - `allow`  ({ start: string; end: string } | undefined):
 *     UTC window during which deploys ARE permitted. Outside this window the
 *     rule fires. `start` and `end` are `"HH:MM"` strings (24h UTC).
 *     If `end < start` the window wraps midnight.
 *   - `block`  ({ start: string; end: string } | undefined):
 *     UTC window during which deploys ARE BLOCKED. Inside this window the
 *     rule fires.
 *
 * At least one of `allow` / `block` must be present.
 *
 * **Purity**: reads `request.context.now` (ms since epoch, injected by caller).
 * Does NOT call `Date.now()`.
 */
const maintenanceWindowEvaluator: RuleTypeEvaluator = {
  evaluate(rule, request): RuleTypeResult {
    const nowMs = request.context?.now;
    if (nowMs === undefined) {
      // No clock injected — fail-safe: deny.
      return {
        fires: true,
        message:
          `Maintenance-window rule '${rule.id}' requires 'context.now' to be provided ` +
          'but it was absent. Deploy blocked as a safety precaution.',
      };
    }

    // Derive minutes-since-midnight in UTC from the injected timestamp.
    const d = new Date(nowMs);
    const nowMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();

    const { allow, block } = rule.params as {
      allow?: { start: string; end: string };
      block?: { start: string; end: string };
    };

    // --- allow window ---
    if (allow !== undefined) {
      const start = parseUtcTime(allow.start);
      const end = parseUtcTime(allow.end);
      if (isNaN(start) || isNaN(end)) {
        return {
          fires: true,
          message:
            `Maintenance-window rule '${rule.id}' has invalid 'allow' window ` +
            `("${allow.start}"–"${allow.end}"). Deploy blocked as a safety precaution.`,
        };
      }
      const inWindow = start <= end
        ? nowMinutes >= start && nowMinutes < end
        : nowMinutes >= start || nowMinutes < end; // wraps midnight
      if (!inWindow) {
        return {
          fires: true,
          message:
            `Deploy outside allowed maintenance window: ` +
            `allowed ${allow.start}–${allow.end} UTC, current time is ` +
            `${d.toISOString().slice(11, 16)} UTC.`,
        };
      }
    }

    // --- block window ---
    if (block !== undefined) {
      const start = parseUtcTime(block.start);
      const end = parseUtcTime(block.end);
      if (isNaN(start) || isNaN(end)) {
        return {
          fires: true,
          message:
            `Maintenance-window rule '${rule.id}' has invalid 'block' window ` +
            `("${block.start}"–"${block.end}"). Deploy blocked as a safety precaution.`,
        };
      }
      const inWindow = start <= end
        ? nowMinutes >= start && nowMinutes < end
        : nowMinutes >= start || nowMinutes < end;
      if (inWindow) {
        return {
          fires: true,
          message:
            `Deploy blocked during maintenance window: ` +
            `blocked ${block.start}–${block.end} UTC, current time is ` +
            `${d.toISOString().slice(11, 16)} UTC.`,
        };
      }
    }

    if (allow === undefined && block === undefined) {
      return {
        fires: true,
        message:
          `Maintenance-window rule '${rule.id}' has neither 'allow' nor 'block' params; ` +
          'deploy blocked as a safety precaution.',
      };
    }

    return { fires: false };
  },
};

// ---------------------------------------------------------------------------
// Bootstrap: register all built-in rule types
// ---------------------------------------------------------------------------

/**
 * Register all built-in rule-type evaluators.
 *
 * Called once at module load time. Also called by `resetRuleTypeRegistry()`
 * (test helper). Safe to call on a freshly-cleared registry.
 */
function registerBuiltinRuleTypes(): void {
  ruleTypeRegistry.set('placement', placementEvaluator);
  ruleTypeRegistry.set('affinity', affinityEvaluator);
  ruleTypeRegistry.set('quota', quotaEvaluator);
  ruleTypeRegistry.set('blast-radius', blastRadiusEvaluator);
  ruleTypeRegistry.set('maintenance-window', maintenanceWindowEvaluator);
}

// Register at module load (called once).
registerBuiltinRuleTypes();

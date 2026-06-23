/**
 * InheritanceResolver — merges standards artifacts across the
 * default → org → repo → request hierarchy (SPEC-021-1-02, TDD-021 §8).
 *
 * Semantics:
 *   - Defaults are the seed; org overrides defaults; repo overrides org
 *     unless the org rule is `immutable: true`; per-request overrides
 *     require admin authorization.
 *   - Defaults are always mutable (only org can mark a rule immutable).
 *   - Within a single level, last-write-wins on duplicate IDs.
 *
 * The resolver returns BOTH the winning rule and the source level it came
 * from so downstream consumers (PLAN-021-3 author injection, PLAN-020-1
 * reviewer) can tell the operator which control plane is responsible.
 *
 * @module intake/standards/resolver
 */

import type { Rule, RuleSource } from './types';
import { ValidationError, AuthorizationError } from './errors';
import { isAdminRequest } from './auth';

/** Result of `resolveStandards`: rules keyed by id plus per-id source attribution. */
export interface ResolvedStandards {
  rules: Map<string, Rule>;
  source: Map<string, RuleSource>;
}

/**
 * Merge the levels into a single rule set.
 *
 * Order of operations (each step overwrites prior matches by `rule.id`):
 *   1. defaults  → source `default`
 *   2. org       → source `org`
 *   3. project   → source `project` (ONBOARD Phase 0 #584; throws if it
 *                                    overrides an immutable org rule)
 *   4. repo      → source `repo`  (throws if it overrides an immutable org
 *                                  OR project rule)
 *   5. request   → source `request` (admin-gated; may override immutable)
 *
 * `projectRules` is an optional trailing parameter (default `[]`) so existing
 * 4-arg callers remain valid; it is applied between org and repo regardless of
 * its parameter position.
 *
 * @throws ValidationError    when a project/repo rule attempts to override an
 *                            immutable org/project rule.
 * @throws AuthorizationError when per-request overrides are present and
 *                            the caller is not an admin.
 */
export function resolveStandards(
  defaultRules: Rule[],
  orgRules: Rule[],
  repoRules: Rule[],
  requestOverrides: Rule[],
  projectRules: Rule[] = [],
): ResolvedStandards {
  const rules = new Map<string, Rule>();
  const source = new Map<string, RuleSource>();

  // Apply a tier, rejecting any override of a rule locked immutable by a
  // higher authoritative tier (org or project).
  const applyTier = (tierRules: Rule[], tier: RuleSource): void => {
    for (const r of tierRules) {
      const existing = rules.get(r.id);
      const existingSource = source.get(r.id);
      if (
        existing &&
        existing.immutable &&
        (existingSource === 'org' || existingSource === 'project')
      ) {
        throw new ValidationError(
          `Rule "${r.id}" is marked immutable at the ${existingSource} level and cannot be overridden by the ${tier}.`,
        );
      }
      rules.set(r.id, r);
      source.set(r.id, tier);
    }
  };

  // 1. Seed with defaults (always mutable).
  for (const r of defaultRules) {
    rules.set(r.id, r);
    source.set(r.id, 'default');
  }

  // 2. Apply org rules (override defaults). Defaults are always mutable.
  for (const r of orgRules) {
    rules.set(r.id, r);
    source.set(r.id, 'org');
  }

  // 3. Apply project rules; cannot override an immutable org rule.
  applyTier(projectRules, 'project');

  // 4. Apply repo rules; cannot override an immutable org or project rule.
  applyTier(repoRules, 'repo');

  // 5. Per-request overrides require admin authorization. Empty overrides
  //    skip the check so non-admin callers can pass `[]` without error.
  if (requestOverrides.length > 0 && !isAdminRequest()) {
    throw new AuthorizationError(
      'Per-request standards overrides require admin authorization.',
    );
  }
  for (const r of requestOverrides) {
    rules.set(r.id, r);
    source.set(r.id, 'request');
  }

  return { rules, source };
}

/**
 * Reviewer scheduler (SPEC-020-2-02, Task 4).
 *
 * Pure, synchronous component. Takes a resolved ReviewerEntry[] plus a
 * ChangeSetContext and returns a ScheduledExecution: an ordered list of
 * concurrency groups. The runner (SPEC-020-2-03) consumes this output
 * and runs each group via Promise.all.
 *
 * Grouping algorithm (TDD-020 §6):
 *   1. Filter out frontend-triggered reviewers when the change set is
 *      not a frontend change.
 *   2. Partition the remaining reviewers in declaration order:
 *        - built-ins (run sequentially, one group each)
 *        - frontend specialists (UX/UI + a11y — share a single group)
 *        - other specialists (run sequentially, one group each)
 *   3. Emit groups in this order:
 *        a. each built-in as its own single-element group;
 *        b. each non-frontend specialist EXCEPT
 *           rule-set-enforcement-reviewer as its own group;
 *        c. the frontend-specialist bucket as a single group (omitted
 *           if empty);
 *        d. rule-set-enforcement-reviewer (if present) as the FINAL
 *           single-element group, regardless of declared position.
 *
 * Rationale: built-ins emit findings consumed by specialists, so they
 * must finish first. Rule-set must be last because TDD-020 §6 requires
 * it to reference all prior findings. UX/UI + a11y share the
 * frontend-detection cache and are independent of each other, so
 * running them concurrently saves wall time.
 *
 * Path-mapping note: SPEC-020-2-02 documents this module at
 * `src/reviewers/scheduler.ts`. The plugin uses `intake/reviewers/...`.
 *
 * @module intake/reviewers/scheduler
 */

import type {
  ChangeSetContext,
  ReviewerEntry,
  ReviewerInvocation,
  ScheduledExecution,
} from './types';

/**
 * Reviewer name treated specially by the scheduler: it always runs LAST
 * (in its own group) regardless of declared chain position. Hardcoded
 * (rather than driven by a chain field) because the TDD-020 §6 contract
 * states unambiguously that rule-set must consume all prior findings.
 */
const RULE_SET_NAME = 'rule-set-enforcement-reviewer';

export class ReviewerScheduler {
  /**
   * Build a ScheduledExecution for `chain` against `context`.
   *
   * Pure: does not mutate inputs. Calling twice with structurally equal
   * inputs returns deeply-equal outputs.
   */
  schedule(chain: ReviewerEntry[], context: ChangeSetContext): ScheduledExecution {
    // Step 1: drop frontend-triggered reviewers when we are not on a
    // frontend change. Other triggers (none defined yet) would be
    // handled by extending this filter.
    const active = chain.filter((entry) => {
      if (entry.trigger === 'frontend' && !context.isFrontendChange) {
        return false;
      }
      return true;
    });

    // Step 2: partition. Walk once in declared order; preserve order
    // within each bucket.
    const builtIns: ReviewerEntry[] = [];
    const frontendSpecialists: ReviewerEntry[] = [];
    const otherSpecialists: ReviewerEntry[] = [];
    let ruleSet: ReviewerEntry | undefined;

    for (const entry of active) {
      if (entry.name === RULE_SET_NAME) {
        // Rule-set is partitioned out and re-emitted at the end.
        ruleSet = entry;
        continue;
      }
      if (entry.type === 'built-in') {
        builtIns.push(entry);
        continue;
      }
      // Specialist bucket selection: frontend-trigger specialists land
      // in the concurrent group; everything else runs sequentially.
      if (entry.trigger === 'frontend') {
        frontendSpecialists.push(entry);
      } else {
        otherSpecialists.push(entry);
      }
    }

    // Step 3: assemble groups.
    const groups: ReviewerInvocation[][] = [];

    // (a) built-ins: one group each, sequential.
    for (const entry of builtIns) {
      groups.push([this.invoke(entry, context)]);
    }

    // (b) non-frontend specialists (excluding rule-set): one group each.
    for (const entry of otherSpecialists) {
      groups.push([this.invoke(entry, context)]);
    }

    // (c) frontend specialists: a single concurrent group. Omit when
    // empty (do NOT emit `[]`) so the runner does not waste a tick
    // resolving an empty Promise.all.
    if (frontendSpecialists.length > 0) {
      groups.push(frontendSpecialists.map((entry) => this.invoke(entry, context)));
    }

    // (d) rule-set always last.
    if (ruleSet !== undefined) {
      groups.push([this.invoke(ruleSet, context)]);
    }

    return { groups };
  }

  /** Build a fresh ReviewerInvocation. The same `context` reference is
   *  shared across all invocations in a single schedule() call (cheap
   *  and intentional — the runner does not mutate it). */
  private invoke(entry: ReviewerEntry, context: ChangeSetContext): ReviewerInvocation {
    return { entry, context };
  }
}

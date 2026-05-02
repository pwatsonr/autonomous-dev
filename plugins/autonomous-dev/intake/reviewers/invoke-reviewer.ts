/**
 * Production InvokeReviewerFn (SPEC-020-2-04, Task 7).
 *
 * Wires reviewer names from the chain config to actual invocation
 * mechanisms. The MVP includes the 6 reviewers referenced in the
 * default chain (`config_defaults/reviewer-chains.json`):
 *
 *   built-ins:
 *     - code-reviewer
 *     - security-reviewer
 *   specialists (PLAN-020-1):
 *     - qa-edge-case-reviewer
 *     - ux-ui-reviewer
 *     - accessibility-reviewer
 *     - rule-set-enforcement-reviewer
 *
 * NOTE (TODO-PLAN-020-2-04): the Claude Agent SDK is not yet directly
 * importable from this plugin's runtime. Until SPEC-020-2-04's
 * `bin/score-evaluator.sh` integration lands a concrete dispatcher,
 * `invokeReviewer` returns a stub verdict that allows the runner +
 * aggregator to be exercised end-to-end without external dependencies.
 * The dispatcher table (`REVIEWER_REGISTRY`) is structured so swapping
 * stubs for real SDK calls is a localized change (one line per
 * reviewer).
 *
 * Tests should NOT use this stub — they inject their own
 * InvokeReviewerFn directly into `ReviewerRunner`.
 *
 * @module intake/reviewers/invoke-reviewer
 */

import type { ChangeSetContext, ReviewerEntry } from './types';
import type { InvokeReviewerFn } from './runner';

/** Internal dispatcher signature. */
type ReviewerDispatcher = (
  entry: ReviewerEntry,
  context: ChangeSetContext,
) => Promise<{ score: number; verdict: 'APPROVE' | 'REQUEST_CHANGES'; findings?: object }>;

/**
 * Stub dispatcher used by every entry until the Claude Agent SDK
 * integration lands. Returns a uniform APPROVE with score=85 so the
 * pipeline can be exercised end-to-end without external services.
 *
 * TODO(SPEC-020-2-04 production wiring): replace per-reviewer entries
 * with real SDK invocations. Each replacement should:
 *   1. Resolve `entry.name` to an agent definition path (PLAN-020-1
 *      shipped these under `agents/`).
 *   2. Invoke the agent with `{ entry, context }` as the prompt
 *      payload.
 *   3. Parse the agent's response as a `reviewer-finding-v1` payload
 *      (PLAN-020-1's schema).
 *   4. Return `{ score, verdict, findings }`.
 *   5. Throw on parse failure or SDK error so the runner records
 *      `verdict: 'ERROR'`.
 */
const stubDispatcher: ReviewerDispatcher = async (entry, _context) => {
  return {
    score: 85,
    verdict: 'APPROVE',
    findings: {
      reviewer: entry.name,
      stub: true,
      note: 'invoke-reviewer.ts stub: replace with real Claude SDK call (TODO SPEC-020-2-04)',
    },
  };
};

/**
 * Static map from reviewer name → dispatcher. Adding a new reviewer
 * is a single line. Operator-supplied / plugin reviewers are out of
 * scope for the MVP (TDD-022 covers plugin chaining).
 *
 * Unknown reviewer names fall through to a thrown error in
 * `invokeReviewer` (the runner records `verdict: 'ERROR'`); this
 * surfaces typos in chain configs immediately rather than silently
 * passing.
 */
const REVIEWER_REGISTRY: Record<string, ReviewerDispatcher> = {
  'code-reviewer': stubDispatcher,
  'security-reviewer': stubDispatcher,
  'qa-edge-case-reviewer': stubDispatcher,
  'ux-ui-reviewer': stubDispatcher,
  'accessibility-reviewer': stubDispatcher,
  'rule-set-enforcement-reviewer': stubDispatcher,
};

/** Public list of reviewer names known to the registry. */
export function getRegisteredReviewerNames(): string[] {
  return Object.keys(REVIEWER_REGISTRY);
}

/**
 * Production InvokeReviewerFn for `ReviewerRunner`. Looks up the
 * dispatcher and forwards. Throws on unknown reviewer names so the
 * runner captures `verdict: 'ERROR'` (callers see a clear failure
 * rather than a silent skip).
 */
export const invokeReviewer: InvokeReviewerFn = async (entry, context) => {
  const dispatcher = REVIEWER_REGISTRY[entry.name];
  if (dispatcher === undefined) {
    throw new Error(
      `unknown reviewer '${entry.name}'; not in REVIEWER_REGISTRY (invoke-reviewer.ts)`,
    );
  }
  return dispatcher(entry, context);
};

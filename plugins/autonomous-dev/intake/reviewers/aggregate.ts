/**
 * Multi-reviewer minimum enforcement bridge (SPEC-019-4-02, Task 3).
 *
 * Glue between the bash review-gate evaluator and the TS plugin registry.
 * `runReviewersForGate(gate, input, opts)`:
 *   1. Looks up reviewer slots for `gate` via `HookRegistry.getReviewersForGate`.
 *   2. If fewer than `minReviewers` are registered, falls back to the built-in
 *      PRD-004 reviewers (`opts.invokeBuiltIn`) and logs a structured warning.
 *      Built-in verdicts are stamped `plugin_id: 'built-in'` so audit forensics
 *      can distinguish first-party from third-party verdicts trivially.
 *   3. Otherwise, invokes each registered reviewer in registration order.
 *   4. Stamps every returned verdict with a deterministic SHA-256 fingerprint
 *      via `fingerprint.ts`.
 *
 * Cross-reference: TDD-019 §11.3 (fingerprinting), §11.4 (audit metadata).
 *
 * @module intake/reviewers/aggregate
 */

import type { HookRegistry, RegisteredHook } from '../hooks/registry';
import type { ReviewGate, Verdict } from '../hooks/types';
import { inputFingerprint, verdictFingerprint } from '../hooks/fingerprint';

/**
 * Pre-fingerprint verdict shape returned by reviewer entry-points. The
 * aggregator stamps `fingerprint` before returning to the caller.
 */
export type RawVerdict = Omit<Verdict, 'fingerprint'>;

/** Minimal logger contract; mirrors the console subset we need. */
export interface AggregateLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface RunReviewersOptions {
  registry: HookRegistry;
  /** From `extensions.min_reviewers_per_gate`. Must be ≥1. */
  minReviewers: number;
  /** Invokes one reviewer slot's entry-point and returns its raw verdict. */
  invokeReviewer: (slot: RegisteredHook, input: unknown) => Promise<RawVerdict>;
  /**
   * Built-in PRD-004 reviewer fallback. Returns one or more raw verdicts.
   * Plugin identity fields (`plugin_id`, `plugin_version`) are overridden
   * by the aggregator with `built-in` / the autonomous-dev plugin version.
   */
  invokeBuiltIn: (gate: ReviewGate, input: unknown) => Promise<RawVerdict[]>;
  /** Plugin version stamped on built-in verdicts. */
  builtInPluginVersion: string;
  logger: AggregateLogger;
}

export interface RunReviewersResult {
  verdicts: Verdict[];
  /** True if the built-in fallback was invoked due to insufficient registered reviewers. */
  usedFallback: boolean;
}

/**
 * Resolve the verdicts for a single review gate, enforcing the minimum
 * reviewer count and stamping fingerprints. Pure orchestration: all I/O
 * happens through the injected `invokeReviewer` / `invokeBuiltIn` callbacks.
 */
export async function runReviewersForGate(
  gate: ReviewGate,
  input: unknown,
  opts: RunReviewersOptions,
): Promise<RunReviewersResult> {
  if (opts.minReviewers < 1) {
    throw new Error(
      `runReviewersForGate: minReviewers must be >= 1 (got ${opts.minReviewers})`,
    );
  }
  const slots = opts.registry.getReviewersForGate(gate);
  const inputFp = inputFingerprint(input);

  if (slots.length < opts.minReviewers) {
    opts.logger.warn('reviewer-minimum-fallback', {
      gate,
      registered: slots.length,
      required: opts.minReviewers,
    });
    const builtIns = await opts.invokeBuiltIn(gate, input);
    const verdicts: Verdict[] = builtIns.map((raw) => {
      const v: Verdict = {
        verdict: raw.verdict,
        score: raw.score,
        findings: raw.findings,
        agent_name: raw.agent_name,
        plugin_id: 'built-in',
        plugin_version: opts.builtInPluginVersion,
        fingerprint: '',
      };
      v.fingerprint = verdictFingerprint({
        plugin_id: v.plugin_id,
        plugin_version: v.plugin_version,
        agent_name: v.agent_name,
        input_fingerprint: inputFp,
        verdict: { verdict: v.verdict, score: v.score, findings: v.findings },
      });
      return v;
    });
    return { verdicts, usedFallback: true };
  }

  const verdicts: Verdict[] = [];
  for (const slot of slots) {
    const raw = await opts.invokeReviewer(slot, input);
    const v: Verdict = {
      verdict: raw.verdict,
      score: raw.score,
      findings: raw.findings,
      agent_name: raw.agent_name,
      plugin_id: raw.plugin_id,
      plugin_version: raw.plugin_version,
      fingerprint: '',
    };
    v.fingerprint = verdictFingerprint({
      plugin_id: v.plugin_id,
      plugin_version: v.plugin_version,
      agent_name: v.agent_name,
      input_fingerprint: inputFp,
      verdict: { verdict: v.verdict, score: v.score, findings: v.findings },
    });
    verdicts.push(v);
  }
  return { verdicts, usedFallback: false };
}

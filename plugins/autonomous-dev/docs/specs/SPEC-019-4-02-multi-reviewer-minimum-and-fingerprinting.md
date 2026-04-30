# SPEC-019-4-02: Multi-Reviewer Minimum Enforcement + Verdict Fingerprinting

## Metadata
- **Parent Plan**: PLAN-019-4
- **Tasks Covered**: Task 3 (multi-reviewer minimum enforcement), Task 4 (verdict fingerprinting)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-4-02-multi-reviewer-minimum-and-fingerprinting.md`

## Description
Make the reviewer-slot mechanic operational at the review-gate evaluator. Two concerns: (1) when fewer than `extensions.min_reviewers_per_gate` plugin reviewers are registered for a gate, the evaluator must fall back to the built-in PRD-004 reviewers and log a structured warning; (2) every reviewer's verdict must carry a deterministic SHA-256 fingerprint so drift across iterations is detectable per TDD §11.3. This spec implements the lookup-and-aggregate flow on top of `HookRegistry.getReviewersForGate()` from SPEC-019-4-01 and introduces the standalone `fingerprint.ts` module that all current and future reviewer paths consume.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/hooks/fingerprint.ts` | Create | `canonicalize()`, `inputFingerprint()`, `verdictFingerprint()` |
| `plugins/autonomous-dev/bin/score-evaluator.sh` | Modify | Consult `getReviewersForGate()`, enforce minimum, fall back to built-in |
| `plugins/autonomous-dev/src/reviewers/aggregate.ts` | Create | Bridge between bash evaluator and TS registry; emits `Verdict[]` |
| `plugins/autonomous-dev/.claude-plugin/plugin.json` | Modify | Add `extensions.min_reviewers_per_gate` userConfig key (default 2) |
| `plugins/autonomous-dev/tests/hooks/test-fingerprint.test.ts` | Create | Determinism + collision tests (in SPEC-019-4-05's task list — schema only here) |

Note: the test file is fully authored under SPEC-019-4-05. This spec defines the module API the tests will exercise.

## Implementation Details

### `src/hooks/fingerprint.ts`

```ts
import { createHash } from 'node:crypto';
import type { Verdict, ReviewerSlot } from './types.js';

/**
 * Canonical JSON: keys sorted lexicographically at every nesting level,
 * no whitespace, no trailing newlines, NaN/Infinity rejected.
 * Throws on circular references and on non-JSON-safe values.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ':' + canonicalize((value as Record<string, unknown>)[k]),
  );
  return '{' + parts.join(',') + '}';
}

/**
 * SHA-256 of the canonicalized input. Same input (semantically) → same hash.
 */
export function inputFingerprint(input: unknown): string {
  return createHash('sha256').update(canonicalize(input)).digest('hex');
}

/**
 * Verdict fingerprint per TDD §11.3:
 *   sha256(canonicalize({plugin_id, plugin_version, agent_name,
 *                        input_fingerprint, output_verdict}))
 * `output_verdict` excludes the `fingerprint` field itself (set after) and
 * any per-run timestamps so determinism holds across reruns.
 */
export function verdictFingerprint(args: {
  plugin_id: string;
  plugin_version: string;
  agent_name: string;
  input_fingerprint: string;
  verdict: Omit<Verdict, 'fingerprint' | 'plugin_id' | 'plugin_version' | 'agent_name'>;
}): string {
  return createHash('sha256')
    .update(
      canonicalize({
        plugin_id: args.plugin_id,
        plugin_version: args.plugin_version,
        agent_name: args.agent_name,
        input_fingerprint: args.input_fingerprint,
        output_verdict: args.verdict,
      }),
    )
    .digest('hex');
}
```

### `src/reviewers/aggregate.ts`

Public function `runReviewersForGate(gate, input, options)` returns `Promise<{verdicts: Verdict[]; usedFallback: boolean}>`.

```ts
export interface RunReviewersOptions {
  registry: HookRegistry;
  minReviewers: number;          // from extensions.min_reviewers_per_gate
  invokeReviewer: (slot: HookEntry, input: unknown) => Promise<Omit<Verdict, 'fingerprint'>>;
  invokeBuiltIn: (gate: ReviewGate, input: unknown) => Promise<Omit<Verdict, 'fingerprint'>[]>;
  logger: { warn(msg: string, meta?: object): void };
}

export async function runReviewersForGate(
  gate: ReviewGate,
  input: unknown,
  opts: RunReviewersOptions,
): Promise<{verdicts: Verdict[]; usedFallback: boolean}> {
  const slots = opts.registry.getReviewersForGate(gate);
  if (slots.length < opts.minReviewers) {
    opts.logger.warn('reviewer-minimum-fallback', {
      gate, registered: slots.length, required: opts.minReviewers,
    });
    const builtIns = await opts.invokeBuiltIn(gate, input);
    const inputFp = inputFingerprint(input);
    return {
      usedFallback: true,
      verdicts: builtIns.map((v) => ({
        ...v,
        plugin_id: 'built-in',
        plugin_version: 'autonomous-dev',
        fingerprint: verdictFingerprint({
          plugin_id: 'built-in',
          plugin_version: 'autonomous-dev',
          agent_name: v.agent_name,
          input_fingerprint: inputFp,
          verdict: { verdict: v.verdict, score: v.score, findings: v.findings },
        }),
      })),
    };
  }
  const inputFp = inputFingerprint(input);
  const verdicts: Verdict[] = [];
  for (const slot of slots) {
    const raw = await opts.invokeReviewer(slot, input);
    verdicts.push({
      ...raw,
      fingerprint: verdictFingerprint({
        plugin_id: slot.plugin_id,
        plugin_version: slot.plugin_version,
        agent_name: raw.agent_name,
        input_fingerprint: inputFp,
        verdict: { verdict: raw.verdict, score: raw.score, findings: raw.findings },
      }),
    });
  }
  return { usedFallback: false, verdicts };
}
```

### Bash Evaluator Hook (`bin/score-evaluator.sh`)

The existing evaluator currently calls into the built-in reviewers directly. Modify it to:
1. Resolve `min_reviewers_per_gate` from the merged userConfig (`autonomous-dev config get extensions.min_reviewers_per_gate`, default 2).
2. Invoke the new TS bridge: `node "$PLUGIN_ROOT/dist/reviewers/aggregate-cli.js" --gate "$GATE" --input "$INPUT_FILE" --min "$MIN"`.
3. The bridge prints JSONL `Verdict` entries to stdout, one per reviewer; the evaluator aggregates them as it does today.

The bridge is a thin wrapper around `runReviewersForGate` that adapts CLI args. It is implementation detail; this spec only requires that the evaluator no longer hard-codes the built-in path.

### Manifest userConfig (`.claude-plugin/plugin.json`)

Add under `userConfig`:

```json
"extensions.min_reviewers_per_gate": {
  "type": "integer",
  "default": 2,
  "minimum": 1,
  "maximum": 10,
  "description": "Minimum number of plugin reviewers required per code-review/security-review gate before falling back to built-in reviewers."
}
```

## Acceptance Criteria

- [ ] `canonicalize({b:1, a:2}) === canonicalize({a:2, b:1})` (key order independent).
- [ ] `canonicalize` rejects `NaN`, `Infinity`, and circular references with a thrown error.
- [ ] `inputFingerprint(input)` is deterministic across 100 invocations on the same input (test asserts all 100 hashes identical).
- [ ] Two semantically different inputs produce different `inputFingerprint`s (collision-resistance smoke test).
- [ ] `verdictFingerprint` for the same `(plugin_id, plugin_version, agent_name, input, verdict-shape)` is identical across runs.
- [ ] `verdictFingerprint` for different `plugin_id` but same input + verdict produces a different hash.
- [ ] `runReviewersForGate('code-review', input, {minReviewers: 2, ...})` with one registered slot returns `usedFallback: true` and verdicts from `invokeBuiltIn`, all stamped `plugin_id: 'built-in'`.
- [ ] Same call with two registered slots returns `usedFallback: false` and verdicts from `invokeReviewer` for each slot, all with non-empty `fingerprint`.
- [ ] Setting `min_reviewers_per_gate: 1` allows a single registered slot to drive the gate (no fallback).
- [ ] Logger receives `reviewer-minimum-fallback` warning with `{gate, registered, required}` metadata when fallback triggers.
- [ ] `bin/score-evaluator.sh` consults the registry via the bridge; running the evaluator with no plugin reviewers registered produces identical scores to the pre-PLAN-019 baseline (built-in fallback is byte-equivalent).
- [ ] Manifest `extensions.min_reviewers_per_gate` parses with default 2; values outside `[1, 10]` are rejected by the loader.

## Dependencies

- **Blocked by**: SPEC-019-4-01 (`getReviewersForGate`, `Verdict`, `ReviewerSlot`, `ReviewGate`).
- **Consumed by**: SPEC-019-4-04 (audit-writer stamps `verdict.fingerprint` into entries), SPEC-019-4-05 (full unit-test coverage).
- **External**: PRD-004 review-gate evaluator (existing); plugin userConfig loader (Claude Code).

## Notes

- The fingerprint covers `verdict.score`, `verdict.findings`, and `verdict.verdict` but **not** any timestamps, request IDs, or run IDs. This is critical for the determinism test in SPEC-019-4-05; any field that varies across runs would break the contract.
- `Verdict.findings` ordering matters for fingerprint stability. Reviewer adapters MUST sort findings by `id` before returning. The fingerprint module does not sort defensively (would mask bugs); the canonicalizer relies on input being already sorted.
- `usedFallback: true` is exposed in the return so the audit-log writer (SPEC-019-4-04) can record a `reviewer_fallback` audit entry alongside the verdicts. That wiring lives in SPEC-019-4-04, not here.
- The built-in reviewer's `plugin_id` is the literal string `built-in` and `plugin_version` is the autonomous-dev plugin version, so audit forensics can distinguish first-party from third-party verdicts trivially.
- The bridge CLI entrypoint (`aggregate-cli.js`) is intentionally not specified in detail; it is a thin argv-parsing shim around `runReviewersForGate` and not subject to acceptance criteria here.

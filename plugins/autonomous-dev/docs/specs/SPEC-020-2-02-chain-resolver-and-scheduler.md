# SPEC-020-2-02: Chain Resolver + ReviewerScheduler

## Metadata
- **Parent Plan**: PLAN-020-2
- **Tasks Covered**: Task 3 (chain resolver), Task 4 (`ReviewerScheduler` with concurrency grouping + frontend-trigger gating)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-020-2-02-chain-resolver-and-scheduler.md`

## Description
Build the two pure-logic components that turn a chain config into an ordered execution plan: (1) `chain-resolver.ts` reads either the per-repo override file or the shipped defaults and returns the resolved reviewer array for `<requestType>.<gate>`; (2) `scheduler.ts` takes that array plus a change-set context and returns concurrency groups (`groups: ReviewerInvocation[][]`) where each inner array is run via `Promise.all`. Frontend-triggered reviewers are filtered out when `detectFrontendChanges()` returns `isFrontendChange: false`; UX/UI + accessibility share the detection cache and end up in the same group.

Both components are deterministic, side-effect-free, and synchronous (the scheduler does not invoke reviewers — that is the runner in SPEC-020-2-03). They are unit-tested in isolation with mocked detection results.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/reviewers/types.ts` | Create | Shared type definitions consumed by resolver, scheduler, runner, aggregator |
| `plugins/autonomous-dev/src/reviewers/chain-resolver.ts` | Create | `resolveChain(repoPath, requestType, gate)` and helpers |
| `plugins/autonomous-dev/src/reviewers/scheduler.ts` | Create | `ReviewerScheduler` class with `schedule(chain, context)` |

## Implementation Details

### Shared Types (`types.ts`)

```typescript
export type ReviewerType = 'built-in' | 'specialist';
export type ReviewerTrigger = 'frontend';

export interface ReviewerEntry {
  name: string;
  type: ReviewerType;
  blocking: boolean;
  threshold: number;
  trigger?: ReviewerTrigger;
  enabled?: boolean;
}

export interface ChainConfig {
  version: 1;
  request_types: Record<string, Record<string, ReviewerEntry[]>>;
}

export interface ChangeSetContext {
  repoPath: string;
  changedFiles: string[];
  requestId: string;
  gate: string;
  requestType: string;
  isFrontendChange: boolean; // pre-computed by caller via detectFrontendChanges()
}

export interface ReviewerInvocation {
  entry: ReviewerEntry;
  context: ChangeSetContext;
}

export interface ScheduledExecution {
  groups: ReviewerInvocation[][];
}
```

### Chain Resolver (`chain-resolver.ts`)

API surface:

```typescript
export async function resolveChain(
  repoPath: string,
  requestType: string,
  gate: string
): Promise<ReviewerEntry[]>;

export async function loadChainConfig(repoPath: string): Promise<ChainConfig>;
```

Resolution order:
1. If `<repoPath>/.autonomous-dev/reviewer-chains.json` exists and parses, use it.
2. Otherwise, fall back to the bundled `<plugin-root>/config_defaults/reviewer-chains.json`. The plugin root is resolved via `process.env.CLAUDE_PLUGIN_ROOT` first, then a relative path from the module location as a fallback for tests.
3. Within the chosen config, look up `request_types[requestType]`. If absent, fall back to `request_types.feature` (documented behavior — feature is the canonical baseline).
4. Within the request type, look up the `gate` key. If absent, return an empty array (no reviewers run; calling code treats this as "skip gate").
5. Filter out entries with `enabled: false`.

Errors:
- Repo file present but invalid JSON: throw `ChainConfigError` with the file path and parse error. Do NOT silently fall back to defaults.
- Default file missing or invalid: throw `ChainConfigError` (this is a packaging bug; should fail loud).
- `requestType` missing AND `feature` also missing: throw `ChainConfigError` (the default config must always include `feature`).

### ReviewerScheduler (`scheduler.ts`)

API surface:

```typescript
export class ReviewerScheduler {
  schedule(chain: ReviewerEntry[], context: ChangeSetContext): ScheduledExecution;
}
```

Grouping algorithm (deterministic, single-pass):

1. **Filter** reviewers whose `trigger === 'frontend'` AND `context.isFrontendChange === false`. These are skipped entirely.
2. **Partition** the remaining reviewers into three buckets in declared chain order:
   - `built-ins`: entries with `type === 'built-in'`
   - `concurrent-specialists`: entries with `trigger === 'frontend'` (and `type === 'specialist'`) — UX/UI + a11y land here, sharing the frontend-detection cache.
   - `sequential-specialists`: remaining specialists (e.g., `qa-edge-case-reviewer`, `rule-set-enforcement-reviewer`).
3. **Emit groups** in this order:
   - Each built-in becomes its own single-element group (built-ins run sequentially so their output is part of the context for specialists).
   - Each non-frontend specialist EXCEPT `rule-set-enforcement-reviewer` becomes its own single-element group, in declared chain order.
   - The concurrent-specialists bucket becomes a single group (both run via `Promise.all` in the runner). If empty, the group is omitted.
   - `rule-set-enforcement-reviewer` (if present in chain and not filtered) becomes the final single-element group, regardless of its declared position. This enforces TDD-020's rule that rule-set runs last so it can reference all prior findings.

Examples (from PLAN-020-2 task 4 acceptance criteria):

- **Feature chain on a frontend change**:
  Input: `[code-reviewer, security-reviewer, qa-edge-case-reviewer, ux-ui-reviewer (trigger=frontend), accessibility-reviewer (trigger=frontend), rule-set-enforcement-reviewer]`
  Output groups: `[[code-reviewer], [security-reviewer], [qa-edge-case-reviewer], [ux-ui-reviewer, accessibility-reviewer], [rule-set-enforcement-reviewer]]`
- **Feature chain on a non-frontend change**: same as above MINUS the `[ux-ui-reviewer, accessibility-reviewer]` group (omitted, not empty).
- **Hotfix chain (built-ins only)**: `[[code-reviewer], [security-reviewer]]` — fully sequential, one per group.

The scheduler does NOT mutate the input chain. The returned `ReviewerInvocation` objects each contain a reference to the same `context` object.

## Acceptance Criteria

- [ ] `chain-resolver.ts` exports `resolveChain(repoPath, requestType, gate)` returning `Promise<ReviewerEntry[]>`.
- [ ] When `<repoPath>/.autonomous-dev/reviewer-chains.json` exists, repo entries take precedence over the bundled defaults.
- [ ] When the repo file does not exist, defaults from `config_defaults/reviewer-chains.json` are returned.
- [ ] When `requestType` is unknown (e.g., `chore`), the resolver falls back to the `feature` chain for the same gate.
- [ ] When the gate key is absent within the resolved request type, the resolver returns `[]` (calling code skips the gate).
- [ ] Repo config file present but malformed JSON throws `ChainConfigError` with file path and parse error message; the resolver does NOT silently fall back.
- [ ] Entries with `enabled: false` are filtered out before being returned to the caller.
- [ ] `scheduler.ts` exports a `ReviewerScheduler` class with a `schedule(chain, context)` method returning `ScheduledExecution`.
- [ ] For a feature chain on a frontend change, scheduler returns groups in this exact order: `[[code-reviewer], [security-reviewer], [qa-edge-case-reviewer], [ux-ui-reviewer, accessibility-reviewer], [rule-set-enforcement-reviewer]]`.
- [ ] For the same chain on a non-frontend change (`isFrontendChange: false`), the `[ux-ui-reviewer, accessibility-reviewer]` group is omitted entirely (not present as an empty array).
- [ ] For a chain with only built-ins (e.g., `hotfix.code_review`), all groups are single-element and ordered by declared chain order.
- [ ] `rule-set-enforcement-reviewer` is always emitted as the LAST group when present, even if it appears earlier in the declared chain.
- [ ] `ux-ui-reviewer` and `accessibility-reviewer` always appear in the SAME group (never split across groups) when both are present and triggered.
- [ ] Scheduler is pure: calling `schedule()` twice with the same input produces structurally equal output; the input chain is not mutated.

## Dependencies

- **Consumes** SPEC-020-2-01: the schema and default config file. The resolver loads the default file at runtime; an error in the schema/defaults breaks all downstream specs.
- **Consumes from PLAN-020-1**: `detectFrontendChanges()` produces the `isFrontendChange` boolean. This spec assumes the caller has already invoked it and placed the result in `context.isFrontendChange`. The runner spec (SPEC-020-2-03) wires this together.
- **Used by** SPEC-020-2-03 (runner consumes `ScheduledExecution`) and SPEC-020-2-04 (review-gate evaluator orchestrates resolver → scheduler → runner → aggregator).

## Notes

- Putting `rule-set-enforcement-reviewer` last is hardcoded in the scheduler rather than relying on chain ordering because the TDD-020 §6 contract states unambiguously that rule-set must consume all prior findings. Letting operators reorder it would break that contract silently.
- The decision to emit each built-in as its own group (rather than running built-ins concurrently) is deliberate: built-ins write findings that specialists read. Even though the current built-ins (code-reviewer, security-reviewer) do not actually share state today, the sequential ordering reserves the option to introduce inter-built-in dependencies without re-architecting the scheduler.
- `ChainConfigError` should be a typed exception class exported from `chain-resolver.ts` so the CLI (`chains validate` in SPEC-020-2-04) can format it nicely.
- The scheduler is intentionally synchronous (no `async`). All I/O happens in the resolver. This keeps the scheduling logic trivially testable and free of unnecessary promises.
- The `enabled: false` filter happens in the resolver, not the scheduler, so disabled reviewers do not appear in any debug output the scheduler might emit (e.g., the `chains show` CLI calls the resolver and prints its output).

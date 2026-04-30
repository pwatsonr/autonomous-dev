# SPEC-019-4-01: ReviewerSlot/ReviewGate/Verdict Types + HookRegistry Reviewer-Slot Lookup

## Metadata
- **Parent Plan**: PLAN-019-4
- **Tasks Covered**: Task 1 (author `ReviewerSlot` interface), Task 2 (extend `HookRegistry` with reviewer-slot lookup)
- **Estimated effort**: 3.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-4-01-reviewer-slot-types-registry.md`

## Description
Add the type-system foundation and registry indexing required for the reviewer-slot mechanic. PLAN-019-1 introduced `HookRegistry` and `src/hooks/types.ts` for hook entries; this spec extends them so plugins can declare AI reviewers (TDD §11) that the review-gate evaluator (PRD-004) can later discover by gate. No execution behavior yet — that lands in SPEC-019-4-02 (multi-reviewer enforcement) and SPEC-019-4-03 (sequential execution). The deliverable is purely declarative + lookup: types compile, the registry maintains a second index (`Map<ReviewGate, ReviewerSlot[]>`) alongside its existing hook-point index, and registering or unregistering a plugin keeps both indices consistent.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/hooks/types.ts` | Modify | Add `ReviewGate` enum, `ReviewerSlot`, `Verdict`, `Finding`, `VerdictKind` |
| `plugins/autonomous-dev/src/hooks/registry.ts` | Modify | Add reviewer-slot index + `getReviewersForGate()` + index maintenance in `register()`/`unregister()` |
| `plugins/autonomous-dev/tests/hooks/test-registry-reviewer-slots.test.ts` | Create | Unit tests for lookup, multi-gate isolation, unregister cleanup |

## Implementation Details

### Type Additions (`src/hooks/types.ts`)

Append the following exported types. JSDoc must cross-reference TDD §11:

```ts
/**
 * Review gates a `ReviewerSlot` may participate in.
 * - `code-review`, `security-review`: PRD-004 review pipeline
 * - `document-review-prd`, `document-review-tdd`, `document-review-plan`,
 *   `document-review-spec`: PLAN-017-2 document-cascade gates
 * Cross-reference: TDD-019 §11.1.
 */
export type ReviewGate =
  | 'code-review'
  | 'security-review'
  | 'document-review-prd'
  | 'document-review-tdd'
  | 'document-review-plan'
  | 'document-review-spec';

export type VerdictKind = 'APPROVE' | 'CONCERNS' | 'REQUEST_CHANGES';

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
 * Cross-reference: TDD-019 §11.3 (fingerprinting) and §11.4 (audit metadata).
 * The `fingerprint` field is populated by SPEC-019-4-02 / `fingerprint.ts`.
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
 * Reviewer-slot declaration on a hook entry. When present, the hook is also
 * indexed by review gate in the registry and discoverable via
 * `HookRegistry.getReviewersForGate(gate)`.
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
   * Optional fingerprint format hint; SPEC-019-4-02 currently ignores it
   * and uses the canonical SHA-256 format from TDD §11.3.
   */
  fingerprint_format?: 'sha256-canonical-json';
}
```

Extend the existing `HookEntry` type (added by PLAN-019-1) with an optional `reviewer_slot`:

```ts
export interface HookEntry {
  // ...existing fields from PLAN-019-1...
  reviewer_slot?: ReviewerSlot;
}
```

### Registry Changes (`src/hooks/registry.ts`)

The registry currently keeps `Map<HookPoint, HookEntry[]>`. Add a parallel index:

```ts
private reviewerIndex: Map<ReviewGate, HookEntry[]> = new Map();
```

Modify `register(entry: HookEntry)`:
1. Run existing logic (push into hook-point index).
2. If `entry.reviewer_slot` is present, for each `gate` in `reviewer_slot.review_gates`:
   - `this.reviewerIndex.get(gate) ?? []` → push `entry` → set back.
   - Reject the registration if the same `(plugin_id, gate)` pair already exists (prevents duplicate registration leaking through repeated `register()` calls).

Modify `unregister(plugin_id: string)`:
1. Run existing logic (remove from hook-point index).
2. For each `[gate, entries]` in `reviewerIndex`, filter out entries whose `plugin_id === plugin_id`. If the resulting array is empty, delete the gate key.

Add the new method:

```ts
/**
 * Return all reviewer slots registered for a given review gate, in
 * registration order. Empty array if no plugins registered for that gate.
 * O(1) lookup; the index is maintained on register()/unregister().
 */
getReviewersForGate(gate: ReviewGate): HookEntry[] {
  return [...(this.reviewerIndex.get(gate) ?? [])];
}
```

The returned array is a defensive copy so callers cannot mutate the registry's internal state.

### Test Coverage (`tests/hooks/test-registry-reviewer-slots.test.ts`)

Required test cases:
1. **Single-gate registration** — register one plugin with `review_gates: ['code-review']`, assert `getReviewersForGate('code-review')` returns one entry, all other gates return `[]`.
2. **Multi-gate registration** — register one plugin with `review_gates: ['code-review', 'security-review']`, assert both gates return that plugin and only that plugin.
3. **Multiple plugins per gate** — register plugins A and B both for `code-review`, assert lookup returns `[A, B]` in registration order.
4. **Unregister cleanup** — register plugin A for `code-review`, unregister it, assert `getReviewersForGate('code-review')` returns `[]` and the gate key is removed from the underlying map.
5. **Cross-gate isolation on unregister** — register plugin A for `code-review` and `security-review`; unregister A; assert both gates return `[]`.
6. **Duplicate-registration rejection** — register plugin A for `code-review` twice; assert the second call throws or returns an error per the existing registry contract.
7. **Defensive copy** — call `getReviewersForGate()`, mutate the returned array, call again, assert the second call returns the original entries.
8. **Hook with no reviewer slot** — register a hook lacking `reviewer_slot`; assert it does not appear in any reviewer-gate lookup but is still discoverable in its hook-point index.

## Acceptance Criteria

- [ ] All new types in `types.ts` compile with the project's strict TS config; no `any` introduced.
- [ ] `ReviewerSlot` field names and types match TDD §11.1 verbatim (`agent_name`, `review_gates`, `expertise_domains`, `minimum_threshold`, `fingerprint_format`).
- [ ] `Verdict` includes `plugin_id`, `plugin_version`, `agent_name` per TDD §11.4.
- [ ] JSDoc on `ReviewGate`, `ReviewerSlot`, `Verdict` references TDD §11 sections.
- [ ] `HookRegistry.getReviewersForGate(gate)` returns reviewers in registration order.
- [ ] Registering a hook with `reviewer_slot.review_gates: ['code-review', 'security-review']` makes it discoverable via both gates.
- [ ] Unregistering a plugin removes it from the reviewer-slot index for every gate it was registered to.
- [ ] Unregistering the last reviewer for a gate removes the gate key entirely (no zombie empty arrays).
- [ ] `getReviewersForGate()` returns a defensive copy; mutating the result does not affect subsequent lookups.
- [ ] All 8 unit-test cases above pass; coverage on the new registry methods is 100%.
- [ ] No regressions in PLAN-019-1's existing registry tests.

## Dependencies

- **Blocked by**: PLAN-019-1 (provides `HookRegistry`, `HookEntry`, `HookPoint`).
- **Consumed by**: SPEC-019-4-02 (reads `getReviewersForGate()` for minimum enforcement), SPEC-019-4-04 (audit entries reference `Verdict.fingerprint`).
- **External**: TDD-019 §11 is the contract source.

## Notes

- `ReviewGate` is intentionally a string union (not a TypeScript `enum`) because it must be JSON-serializable in plugin manifests with no runtime conversion.
- `fingerprint_format` is forward-looking; this spec ships with one implicit format (`sha256-canonical-json`). SPEC-019-4-02 will check the field and reject unknown formats.
- The duplicate-registration check uses `(plugin_id, gate)` rather than the full hook entry so that re-registering after a hot-reload (planned for a later TDD-019 deferred item) can still detect duplicates without false positives from minor version bumps.
- Document-review gates are pre-declared here even though their consumers (PLAN-017-2) lie outside PLAN-019 scope; this avoids a follow-up type-system bump.

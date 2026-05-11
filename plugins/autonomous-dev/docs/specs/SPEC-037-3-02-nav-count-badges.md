# SPEC-037-3-02: RailNav — count badges for Approvals, Requests, Agents

## Metadata
- **Parent Plan**: PLAN-037-3-rail-and-nav-completeness
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Tasks Covered**: PLAN-037-3 Scope item 4
- **Estimated effort**: 0.25 day
- **Dependencies**: SPEC-037-3-01 (7-item RailNav)
- **Priority**: P0
- **Status**: Draft
- **Date**: 2026-05-10

## Objective

Extend `RailNavProps` with two additional badge inputs — `requestsCount`, `agentsAlertCount` — and render `<span class="count">N</span>` on the matching nav item whenever the value is `> 0`. Preserves the existing `approvalsCount` contract from SPEC-035-1-02.

**Homelab badge intentionally omitted.** The Homelab nav entry will be contributed by `autonomous-dev-homelab` via a future plugin-contribution mechanism; its badge is the contributing plugin's responsibility, not the portal core's.

## Acceptance Criteria

- **AC-01**: `RailNavProps` is extended with two optional numeric fields: `requestsCount?: number`, `agentsAlertCount?: number`. Defaults are `undefined` (no badge).
- **AC-02**: `renderItem` consults a small map of `{ href → propName }`: `/approvals` → `approvalsCount`, `/requests` → `requestsCount`, `/settings#agents` → `agentsAlertCount`. Other items never render a badge.
- **AC-03**: Badge renders only when the resolved value is a `number` AND `> 0`. Zero, undefined, NaN, and negative all suppress it.
- **AC-04**: Badge markup is exactly `<span class="count">{value}</span>` placed after the label span. No formatting (e.g. `99+`) — raw integer rendered.
- **AC-05**: Approvals badge from SPEC-035-1-02 remains structurally identical (no behavior regression). Existing tests N-04/N-05/N-06 still pass.
- **AC-06**: `aria-label` on the anchor is augmented when a badge is present: `aria-label="Approvals (3 pending)"` / `"Requests (5 active)"` / `"Agents (4)"` for screen-reader clarity.

## Implementation

Files modified:
1. `plugins/autonomous-dev-portal/server/components/rail-nav.tsx` — extend props, add badge-resolution map, update `renderItem`.

Steps:
1. Add a private `BADGE_MAP` constant mapping href → prop key.
2. In `renderItem`, look up the value from a `counts` object passed in (avoid threading 3 separate args).
3. Introduce an internal `RailNavCounts` type aliasing the three optional badge fields and pass it into `renderItem(item, activePath, counts)`.
4. Compute the badge aria suffix from a small `BADGE_LABEL` map keyed by href.

## Tests

Extend `plugins/autonomous-dev-portal/tests/unit/components/rail-nav.test.tsx`:

| ID | Assertion |
|----|-----------|
| N-13 | `requestsCount={5}` renders `<span class="count">5</span>` inside the `/requests` anchor only |
| N-14 | `agentsAlertCount={4}` renders the badge on the `/settings#agents` anchor only |
| N-15 | All three badge props at 0 → no `.count` spans anywhere |
| N-16 | `requestsCount={NaN}` and `requestsCount={-1}` both suppress the badge |
| N-17 | When a badge renders, the anchor's `aria-label` contains the count value |
| N-18 | `homelabFailingCount` is NOT a prop on `RailNavProps` (TypeScript type check) |

## Verification

```bash
cd plugins/autonomous-dev-portal
npm test -- tests/unit/components/rail-nav.test.tsx
# After SPEC-037-3-05 wires the props, run a live render check:
curl -s http://127.0.0.1:19280/ | grep -oE 'class="count">[0-9]+' | head
```

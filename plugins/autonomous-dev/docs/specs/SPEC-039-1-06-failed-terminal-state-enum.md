# SPEC-039-1-06: `failed` terminal state enum

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-031
- **Dependencies**: none
- **Estimated effort**: 2 hours
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

Resolve OQ-039-2: extend PRD-019's status enum to include `failed` as a terminal state when `MAX_RETRIES_PER_PHASE` is exhausted. Operator semantics differ from `cancelled` (user-driven). Spec covers PRD amendment, validator and type updates, and portal display routing for the new state.

## Acceptance Criteria

1. Resolves OQ-039-2.
2. PRD-019 amended: status enum is `{queued, running, gate, done, cancelled, failed}`.
3. Validator (`intake/db/validators.ts`) accepts `failed` and rejects unknown values.
4. State machine in `bin/supervisor-loop.sh` `advance_phase()` writes `status='failed'` when retry budget exhausted.
5. Portal renders `failed` requests with a dedicated style + retry-count hint (consumed in SPEC-039-3-01).
6. `failed` is terminal: daemon's `select_request()` excludes rows with `status='failed'`.

## Implementation

**Files modified**
- `plugins/autonomous-dev/docs/prd/PRD-019-intake-to-deploy-e2e-pipeline.md` — append an "Amendment: failed status (PLAN-039)" section.
- `plugins/autonomous-dev/intake/db/validators.ts` — extend `REQUEST_STATUS_VALUES`.
- `plugins/autonomous-dev/bin/supervisor-loop.sh` — `advance_phase()` retry-exhausted branch writes `status='failed'`, `error='MAX_RETRIES_EXCEEDED'`, `failed_at=<iso>`.
- `plugins/autonomous-dev-portal/server/types/request.ts` (or equivalent) — extend `RequestStatus` union.

**Validator contract**
```ts
export const REQUEST_STATUS_VALUES = ['queued','running','gate','done','cancelled','failed'] as const;
export type RequestStatus = typeof REQUEST_STATUS_VALUES[number];
export function isValidRequestStatus(s: string): s is RequestStatus;
```

**State-machine contract** — `advance_phase()` on `phase_result.status=='fail'`:
- Reads `escalation_count` from state.json.
- If `escalation_count >= MAX_RETRIES_PER_PHASE` (default 3): atomic-writes `status='failed'`, emits `failed` event to `events.jsonl`, triggers portal sync, returns.
- Else: existing retry behaviour (increment escalation_count, re-dispatch).

**PRD amendment text** — single new subsection after the existing status definition, ~5 lines:
> Amendment (PLAN-039): The status enum is extended to `{queued, running, gate, done, cancelled, failed}`. The new `failed` value indicates that the agent exhausted `MAX_RETRIES_PER_PHASE` attempts at a phase and the request is terminal pending operator action. It is distinct from `cancelled` (user-driven termination).

## Tests

**Files created**
- `plugins/autonomous-dev/tests/bats/failed_state.bats`

**Test cases**
1. `retry_exhausted_sets_failed_status` — drive 3 phase failures; assert state.json has `status=failed`, `error=MAX_RETRIES_EXCEEDED`.
2. `failed_is_terminal` — daemon `--once` on a `failed` row does not dispatch.
3. `failed_event_in_events_jsonl` — event with `event=failed` written.
4. `status_validator_accepts_failed` — `isValidRequestStatus('failed')` is true.
5. `portal_action_for_failed` — portal-action file reflects `status=failed`.

## Verification

- `bun run typecheck`
- `bats tests/bats/failed_state.bats`
- Manual: force 3 consecutive review failures in a smoke run; observe state machine transition to `failed`.

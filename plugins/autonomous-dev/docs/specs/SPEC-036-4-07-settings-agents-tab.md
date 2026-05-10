# SPEC-036-4-07: Settings Agents Tab

## Metadata
- **Parent Plan**: PLAN-036-4
- **Parent TDD**: TDD-036-portal-redesign-surfaces (v1.1, §6.5 — Agent factory tab + inspect modal)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-20: agent factory)
- **Tasks Covered**: PLAN-036-4 Task 9 (`agent-table.tsx` + inspect modal) + PLAN-036-4 Task 12 (`settings-modals.js`)
- **Estimated effort**: 0.75 day
- **Dependencies**: SPEC-035-2 (`Btn`, `Chip`), SPEC-035-3 (`ConfirmModal`), SPEC-036-4-01 (route + tab shell)
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Render the Agents tab as a full-width table listing the 18 registered
agents (per the autonomous-dev plugin's agent registry) and an Inspect
modal showing per-agent stats plus a recent-runs mini-table populated
from a new `AgentRecord.recentRuns: AgentRunRef[]` field on the data
shape. The modal uses the `ConfirmModal` helper from SPEC-035-3 and is
opened/closed by `static/js/settings-modals.js`. Promote / Shadow /
Freeze actions are wired to the existing daemon routes; this spec ports
the markup only.

## Acceptance Criteria

| ID    | Criterion |
|-------|-----------|
| AC-01 | `fragments/agent-table.tsx` renders a `<table class="tbl">` with columns: Name, Role (`Chip variant="role"`), State (`Chip variant="status"` — `tone="ok"` for active, `warn` for shadow, `muted` for frozen), Approval (mono %), Precision (mono %), Recall (mono %), Version (mono), Action (`Btn kind="ghost" size="sm">Inspect</Btn>` with `data-modal-open="inspect-agent-modal-<name>"`). The 18 agents from the registry render in alphabetical order by name. |
| AC-02 | `types/render.ts` gains `AgentRecord` (per TDD-036 §5.3) and `AgentRunRef` with the new field `AgentRecord.recentRuns: AgentRunRef[]`. The TypeScript type guarantees `recentRuns` is non-undefined (defaults to `[]` in stub loader). |
| AC-03 | One `<dialog id="inspect-agent-modal-<name>">` per agent renders as a top-level sibling of the panel sections (per SPEC-036-4-01 AC-05). Each dialog contains: stats grid (approval/precision/recall/version + last-trained timestamp), recent-runs mini-table (3 most recent rows from `agent.recentRuns`, sorted desc by `startedAt`), and three action buttons (Promote / Shadow / Freeze) wired via `hx-post` to existing daemon routes. |
| AC-04 | The inspect modal markup uses the `ConfirmModal` helper from SPEC-035-3 — `ConfirmModal({ id, title, body, confirmLabel?, confirmKind? })`. Inspect is a "view-only" variant: `confirmLabel` is omitted; the dialog renders only a Close `Btn` plus the inline action buttons. |
| AC-05 | Each action button (Promote / Shadow / Freeze) shows a nested `ConfirmModal` ("Promote <agent> to active? This will route 100% of <role> traffic to this agent.") before the POST. Two-modal nesting is permitted by the native `<dialog>` element (modal stack); ESC dismisses the topmost only. |
| AC-06 | `static/js/settings-modals.js` binds: `click` of `[data-modal-open="<id>"]` → `document.getElementById('<id>').showModal()`; `click` of `[data-modal-close]` inside a dialog → `dialog.close()`. ESC and backdrop dismiss are native `<dialog>` behavior — no JS required. The script is idempotent (`dataset.bound` sentinel). |
| AC-07 | **Server-side validation** (action POSTs): role traffic must sum to 100% across active+shadow per role; promoting to a state that would violate this returns 400 with `{ error: 'Promotion would leave <role> with no active agent' }` and the modal stays open showing the error. **Client-side validation**: action buttons disabled when the agent is already in the target state (e.g. Promote disabled if already active). Both paths enforce the same invariant. |
| AC-08 | Empty `recentRuns` renders the kit's empty state ("No runs yet") inside the modal mini-table per TDD-036 §6.5. Stub loader caps `recentRuns` to 5 entries per agent (PLAN-036-4 risk row 6); the modal renders only the first 3. |

## Implementation

- Agent table fragment is server-side rendered with all 18 agents from `stubs/settings.ts` (or daemon registry once wired). No client-side fetching.
- Modals are hoisted to top-level `<main>` siblings of the tab panels per SPEC-036-4-01 AC-05; data-`<id>` correspondence is the only coupling between table and modal.
- `settings-modals.js` is a generic open/close handler — no agent-specific logic. It works for the Edit Standard modals from the standards tab as well.
- `AgentRunRef` shape: `{ id: string; startedAt: ISODate; status: 'success'|'failed'|'cancelled'; durationMs: number; cost: number }`.

## Tests

- **Snapshot (`tests/snapshot/agent-table.test.ts`)**: 18 agents in alphabetical order; mixed states (5 active, 8 shadow, 5 frozen).
- **Snapshot (`tests/snapshot/agent-inspect-modal.test.ts`)**: agent with 5 recentRuns (renders 3); agent with 0 recentRuns (renders empty state); agent in each of the three states (action buttons reflect disabled invariants).
- **Modal JS (`tests/clientside/settings-modals.test.ts`)**: clicking `[data-modal-open="inspect-agent-modal-coder"]` calls `showModal()` on that dialog; clicking `[data-modal-close]` inside calls `close()`; ESC dispatches `cancel` on the topmost dialog; nested modal dismiss only closes the top.
- **Integration (`tests/integration/settings-agents.test.ts`)**: GET `/settings?tab=agents` renders 18 rows + 18 dialogs; POST to promote an agent that would zero out a role → 400 with the role-coverage error; valid promote → 200 + table swap. Client-side: action button is disabled when current state == target state.

## Verification

- `bun test` for the four test files passes.
- Manual smoke: visit `/settings?tab=agents`, click Inspect on three different agents, observe correct dialog opens with correct recent runs; click Promote on an agent in shadow, confirm via nested modal, observe table refresh; attempt to promote the only active agent of a role to frozen — observe inline error and dialog stays open.

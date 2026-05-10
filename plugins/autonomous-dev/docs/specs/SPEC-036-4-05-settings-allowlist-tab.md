# SPEC-036-4-05: Settings Allowlist Tab

## Metadata
- **Parent Plan**: PLAN-036-4
- **Parent TDD**: TDD-036-portal-redesign-surfaces (v1.1, §6.5 — repo allowlist)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-20: allowlist management)
- **Tasks Covered**: Allowlist subset of PLAN-036-4 Task 5 (General tab) + reuse of fragments/standards-table style
- **Estimated effort**: 0.5 day
- **Dependencies**: SPEC-035-2 (`Btn`, `Chip`, `Card`), SPEC-035-3 (`ConfirmModal`), SPEC-036-4-01 (route + tab shell)
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Render the repo Allowlist content within the Settings General panel: a
table of allowlisted repos with add/remove controls. New entries
require a path that resolves to a git repository (validated client-side
heuristically and server-side authoritatively). Validation is
**bidirectional** — the server walks the path with `git rev-parse
--is-inside-work-tree` (authoritative), and the client validates the
shape of the path string before submission.

## Acceptance Criteria

| ID    | Criterion |
|-------|-----------|
| AC-01 | The General panel includes a `Card` titled "Repo allowlist" containing a `<table class="tbl">` with columns: Path (mono), Status (`Chip` — `ok`/`missing`/`not-a-repo`), Added at, Action (`Btn kind="ghost" size="sm"` for remove). Empty state renders "No repos allowlisted" with a primary CTA. |
| AC-02 | An "Add repo" form below the table contains `<input type="text" id="allowlist-new-path">` and a `Btn kind="primary">Add</Btn>`. The form posts via HTMX `hx-post="/api/settings/allowlist"` and `hx-target` swaps the table region. |
| AC-03 | **Client-side validation** (`form-validation.js`): on `input` of `#allowlist-new-path`, validators run: (a) empty → no error (Add button disabled); (b) starts with `~` or `$` → "use absolute path or a tilde-resolved path"; (c) contains `..` → "path must not contain `..`"; (d) length > 4096 → "path too long". Insert `<span class="field-error">` accordingly. Add button disabled while any error present. |
| AC-04 | **Server-side validation** (`POST /api/settings/allowlist`): expand `~`, resolve to absolute, run `git -C <path> rev-parse --is-inside-work-tree`. Failure returns 400 with `{ errors: { 'allowlist-new-path': 'not a git repo' \| 'path does not exist' \| 'permission denied' } }`. Duplicate entry returns 400 with `'already in allowlist'`. Server is authoritative. |
| AC-05 | Remove action triggers a `ConfirmModal` ("Remove <path> from allowlist? Active requests for this repo will be aborted.") before POSTing `DELETE /api/settings/allowlist/:id`. ESC and backdrop click dismiss. |
| AC-06 | Status `Chip` tone mapping: `ok` → `tone="ok"`, `missing` (path no longer exists) → `tone="warn"`, `not-a-repo` (path no longer a git repo) → `tone="err"`. The status comes from a periodic server-side health check, not from the client. |
| AC-07 | The allowlist drives the per-repo trust override `<datalist>` from SPEC-036-4-03 — a `data-allowlist` attribute on the table mirrors the current set so trust-tab client validators can reference it without re-querying the DOM. |

## Implementation

- Allowlist table fragment: `fragments/allowlist-table.tsx` for snapshot testability and reuse by trust-tab.
- Server validator: extend `server/routes/settings.ts` with the `git rev-parse` shell-out; never trust the path string alone.
- Client predicate: shape validation only (no filesystem access). Lives in `static/js/form-validation.js`.

## Tests

- **Snapshot (`tests/snapshot/allowlist-table.test.ts`)**: 0, 1, and 5 entries with mixed statuses (ok/missing/not-a-repo).
- **Server validation (`tests/integration/settings-allowlist.test.ts`)**: POST `~/not-a-repo` → 400 `not-a-repo`; POST a valid repo → 200 + table swap; POST a duplicate → 400 `already in allowlist`; POST `/no/such/path` → 400 `path does not exist`; DELETE existing → 200 + table swap.
- **Client (`tests/clientside/form-validation-allowlist.test.ts`)**: input `..` → error; input `~/repos/foo` → no error; input `' '*5000` → "path too long"; empty → Add disabled.

## Verification

- `bun test` for the three test files passes.
- Manual smoke: add a valid repo, observe row appended; add a non-repo path, observe server 400 + inline error; remove a repo, observe ConfirmModal then row removal.

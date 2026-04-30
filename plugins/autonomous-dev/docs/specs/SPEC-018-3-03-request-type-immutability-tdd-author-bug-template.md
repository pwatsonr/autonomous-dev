# SPEC-018-3-03: `request_type` Immutability & TDD-Author Bug-Mode Extension

## Metadata
- **Parent Plan**: PLAN-018-3
- **Tasks Covered**: Task 5 (request_type immutability), Task 6 (TDD-author bug extension + bug template)
- **Estimated effort**: 4.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-018-3-03-request-type-immutability-tdd-author-bug-template.md`

## Description
Lock down two contract boundaries that bug-typed requests depend on. First, enforce that `request_type` is immutable after submission — operators may edit priority, description, and labels on an existing request, but flipping a feature into a bug (or vice versa) is rejected by the `request edit` subcommand and audited. Second, extend the `tdd-author` agent prompt with a "BUG MODE" branch that activates when invoked with `--bug-context-path`, reading the bug context from state and emitting a TDD that follows the bug-specific template structure (Bug Analysis Summary → Reproduction Analysis → Technical Investigation → Root Cause → Fix Strategy → Regression Tests).

Together these guarantee that once a request is typed as a bug, the rest of the pipeline (daemon routing from PLAN-018-2, the agent prompt here) treats it consistently from intake to TDD. The bug template is checked in as a static file under `templates/`; the agent reads it at runtime rather than embedding the template inline so operators can fork it.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/cli/commands/request-edit.ts` | Modify | Reject `--type` argument when target field is `request_type`; audit-log all rejections |
| `plugins/autonomous-dev/src/services/audit-log.ts` | Modify | Add `request.edit_rejected` event type with payload `{request_id, attempted_field, reason}` |
| `plugins/autonomous-dev/agents/tdd-author.md` | Modify | Add "BUG MODE" conditional block driven by `--bug-context-path` flag |
| `plugins/autonomous-dev/templates/tdd-bug.md` | Create | Bug-specific TDD template per TDD-018 §9.3 (verbatim) |

## Implementation Details

### `request-edit.ts` — Immutability Enforcement

The existing `request edit` command accepts `--<field> <value>` pairs. Add an explicit reject for `--type` and any other immutable field:

```typescript
const IMMUTABLE_FIELDS = ['request_type', 'id', 'created_at', 'source_channel'] as const;

for (const field of IMMUTABLE_FIELDS) {
  if (field in opts.changes) {
    await auditLog.write({
      type: 'request.edit_rejected',
      request_id: opts.id,
      attempted_field: field,
      reason: `${field} is immutable after submission`,
      timestamp: new Date().toISOString(),
    });
    process.stderr.write(`Error: ${field} is immutable after submission\n`);
    process.exit(1);
  }
}
```

`opts.changes` is the parsed set of fields the operator passed. The `--type` flag from SPEC-018-3-01's `request submit` is **also** accepted by `request edit` syntactically (Commander parses it identically) — the rejection happens after parsing, before any state mutation. Mutable fields (`priority`, `description`, `labels`, `user_impact`) continue to work unchanged.

### Audit Log Schema

Add to the `audit-log.ts` event type union:

```typescript
type AuditEvent =
  | { type: 'request.created'; ... }
  | { type: 'request.edited'; ... }
  | { type: 'request.edit_rejected'; request_id: string; attempted_field: string; reason: string; timestamp: string }
  | ...;
```

Persistence path is unchanged — events append to the existing audit log file (per PLAN-011-1's audit infrastructure).

### `tdd-author.md` — BUG MODE Extension

Insert the following section into the agent prompt, immediately after the existing "Process" header and before the PRD-driven steps:

```markdown
## Mode Selection

You may be invoked in one of two modes:

**BUG MODE** — activated when the orchestrator passes `--bug-context-path <state-file>`.
In BUG MODE you MUST:
1. Read the bug context from the supplied state file (JSON; key `bug_context`, conforming to `schemas/bug-report.json`).
2. Acknowledge bug context in your first response with one sentence: "I have received a bug report titled '<title>' with severity <severity>."
3. Use the bug-specific template at `templates/tdd-bug.md` as your TDD skeleton.
4. Do NOT read or reference a parent PRD; bug-typed requests have no PRD.
5. Produce a TDD whose first H1 heading is exactly `# Bug Analysis Summary`.

**STANDARD MODE** — activated when `--bug-context-path` is absent.
Follow the existing PRD-driven flow described below.
```

The existing PRD-driven content remains unchanged below this block. The agent must explicitly check for the flag's presence rather than inferring mode from state contents — this guards against the daemon forgetting to pass the flag (the agent will then loudly fail in PRD mode rather than silently producing a wrong-shaped TDD).

### `templates/tdd-bug.md` — Bug TDD Template

Verbatim per TDD-018 §9.3:

```markdown
# Bug Analysis Summary

<One-paragraph summary of the bug, its symptoms, and observed scope.>

# Reproduction Analysis

<Distilled reproduction recipe. Reference the BugReport's reproduction_steps; note any preconditions, environment caveats, or non-determinism.>

# Technical Investigation

<Code paths walked, hypotheses ruled in/out, instrumentation added. Cite file paths and line ranges.>

# Root Cause

<The single, falsifiable root cause. If multiple causes are entangled, list each separately.>

# Fix Strategy

<The minimum-viable change that addresses the root cause without expanding scope. Include affected files, signature changes, and rollback plan.>

# Regression Tests

<Specific test cases that would have caught this bug. Cover the exact reproduction recipe plus at least two adjacent edge cases.>
```

Snapshot-test this file in PLAN-018-3 task 6 to lock the section list and order.

## Acceptance Criteria

- [ ] `autonomous-dev request edit REQ-000001 --type infra` (REQ-000001 is currently `bug`) exits 1 with stderr: `Error: request_type is immutable after submission`.
- [ ] The same invocation appends an event of `{type: 'request.edit_rejected', request_id: 'REQ-000001', attempted_field: 'request_type', reason: 'request_type is immutable after submission'}` to the audit log.
- [ ] `autonomous-dev request edit REQ-000001 --priority high` succeeds and persists the priority change.
- [ ] Attempting to edit `--id` or `--created_at` is rejected with the same pattern (each producing its own audit event).
- [ ] `agents/tdd-author.md` contains a "## Mode Selection" section with both BUG MODE and STANDARD MODE branches as documented above.
- [ ] When invoked with `--bug-context-path /tmp/state.json` (where state contains a valid `bug_context`), the agent's first response begins with `I have received a bug report titled '<title>' with severity <severity>.`.
- [ ] The agent in BUG MODE produces a TDD whose first H1 is exactly `# Bug Analysis Summary` (verified via fixture-based smoke test).
- [ ] When invoked **without** `--bug-context-path`, the agent's behavior is byte-identical to its pre-extension behavior on a regression PRD-driven fixture (snapshot test in SPEC-018-3-05).
- [ ] `templates/tdd-bug.md` exists and contains exactly six H1 headings, in the documented order, with no body text other than the bracketed instructions.
- [ ] `templates/tdd-bug.md` matches TDD-018 §9.3 byte-for-byte (lockable via diff in CI).

## Dependencies

- **Blocking**: SPEC-018-3-01 (RequestType enum, BugReport schema).
- **Blocking**: SPEC-018-3-02 (`bug_context` is populated in state by the time `request edit` would be called).
- **Blocking**: PLAN-018-2 (daemon passes `--bug-context-path` flag when spawning the tdd-author session).
- Existing `request edit` command (PLAN-011-1).
- Existing audit log infrastructure.

## Notes

- Immutability is enforced on `request_type`, `id`, `created_at`, and `source_channel`. The list is hardcoded; future immutable fields require updating the constant array and adding a test case.
- The audit event for rejected edits is intentionally non-fatal in the sense that it always writes; even if the audit log itself is read-only the CLI still rejects the change. The rejection is the contract; the audit is observability.
- The TDD-018 NG-04 documented workaround for type changes (cancel + resubmit) must be referenced in the error message in a future operator-docs spec, not here. The error text above is locked.
- The agent prompt's mode-selection block uses an explicit flag check rather than content sniffing because the daemon is the source of truth for mode, not the state file. If the flag is missing the agent fails loudly in PRD mode — this is intentional per TDD-018 §10 (no silent fallbacks).
- The bug template lives under `templates/` (not under the agent's directory) so other agents (e.g. a future regression-test-author) can read the same file. Path is `plugins/autonomous-dev/templates/tdd-bug.md`.

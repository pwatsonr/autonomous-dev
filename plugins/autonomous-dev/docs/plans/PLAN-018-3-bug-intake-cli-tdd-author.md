# PLAN-018-3: Bug Intake Schema + CLI Integration + TDD-Author Bug Extension

## Metadata
- **Parent TDD**: TDD-018-request-types-pipeline-variants
- **Estimated effort**: 3 days
- **Dependencies**: []
- **Blocked by**: [PLAN-018-1, PLAN-018-2]
- **Priority**: P0

## Objective
Deliver the user-facing surface for bug-typed requests: the `BugReport` TypeScript interface and JSON schema, the CLI `--type` parameter integration with `autonomous-dev request submit`, the structured bug-intake prompts (interactive CLI flow + non-interactive flag-based form), and the TDD-author agent prompt extension that processes `bug_context` instead of a parent PRD. This plan completes the TDD-018 user story end-to-end: a developer can submit a bug via CLI, the daemon routes it through the bug-typed pipeline (skipping PRD), and the TDD-author writes a bug-fix TDD using the structured context.

## Scope
### In Scope
- `BugReport` TypeScript interface in `src/types/bug-report.ts` per TDD §6.1: required fields `title`, `description`, `reproduction_steps`, `expected_behavior`, `actual_behavior`, `error_messages`, `environment`; optional `affected_components`, `severity`, `labels`, `user_impact`
- JSON schema `schemas/bug-report.json` per TDD §6.2 covering all fields with format constraints (e.g., `severity` enum: `low|medium|high|critical`, `reproduction_steps` minimum 1 item)
- CLI `--type <feature|bug|infra|refactor|hotfix>` flag added to `autonomous-dev request submit` (extends PLAN-011-1's CLI dispatcher)
- Bug-specific CLI subcommand `autonomous-dev request submit-bug` per TDD §6.3 with interactive prompts for each required field, OR non-interactive flag-based form (`--repro-step`, `--expected`, `--actual`, `--error-message`, `--severity`, etc.)
- Validation: invalid type strings rejected at the CLI level with helpful error messages listing valid values
- Validation: bug-typed submissions require `bug_context` (CLI either prompts for it or rejects the submission)
- Immutability enforcement: once submitted, the request_type cannot be changed; the daemon rejects any attempt to mutate it via the request-edit subcommand
- TDD-author agent prompt extension at `agents/tdd-author.md` per TDD §9.1: when invoked with `--bug-context-path <state-file>`, the agent reads `bug_context` from state and uses the bug-specific prompt template instead of the PRD-driven flow
- Bug-specific TDD template at `templates/tdd-bug.md` per TDD §9.3: sections for "Bug Analysis Summary", "Reproduction Analysis", "Technical Investigation", "Root Cause", "Fix Strategy", "Regression Tests"
- Multi-channel parity: the same `--type` and bug-intake fields work via the Claude App slash command (`/submit-bug`), Discord (`/submit-bug`), and Slack (`/hotfix` etc.) — extending PLAN-011-2/3/4
- Unit tests covering: CLI parsing for all five types, bug-form validation, immutability enforcement, agent prompt-routing logic
- E2E test: submit a bug via CLI, watch the daemon process it, verify the TDD-author received `bug_context` and produced a TDD using the bug template

### Out of Scope
- `RequestType` enum, state.json v1.1 schema, migration -- PLAN-018-1
- Daemon `select_request` changes -- PLAN-018-2
- Hook system extension that could customize bug-intake -- TDD-019 / PLAN-019-*
- Reviewer agent updates for bug-typed requests (uses standard reviewer with `--expedited` flag) -- PRD-004 follow-up
- Bug triage / deduplication / similarity detection -- separate concern
- Web portal bug-submission form -- PLAN-013-3 / PLAN-015-2 follow-up

## Tasks

1. **Author `BugReport` interface and JSON schema** -- Create `src/types/bug-report.ts` with the interface per TDD §6.1 and `schemas/bug-report.json` per TDD §6.2. The schema validates the example from TDD §7.2 (the `bug_context` portion).
   - Files to create: `plugins/autonomous-dev/src/types/bug-report.ts`, `plugins/autonomous-dev/schemas/bug-report.json`
   - Acceptance criteria: TypeScript compiles. JSON schema validates the TDD §7.2 example clean. Missing `reproduction_steps` fails validation. Invalid `severity` value (`'urgent'`) fails with enum error.
   - Estimated effort: 2h

2. **Add `--type` flag to `request submit`** -- Modify the CLI dispatcher (PLAN-011-1) to accept `--type <type>` and pass it through to the request-creation logic. Default to `feature` when omitted. Reject invalid types with a clear error listing valid values.
   - Files to modify: `plugins/autonomous-dev/src/cli/commands/request-submit.ts`
   - Acceptance criteria: `autonomous-dev request submit --repo /path --description "..." --type bug` produces a request with `request_type: 'bug'`. Invalid type (`--type xyz`) exits 1 with `Error: invalid type 'xyz'. Valid: feature, bug, infra, refactor, hotfix`. No `--type` flag defaults to `feature`. Help text (`--help`) lists all five values.
   - Estimated effort: 1.5h

3. **Implement `submit-bug` interactive CLI flow** -- Add subcommand `autonomous-dev request submit-bug` per TDD §6.3 that prompts (via `inquirer` or similar) for each required `BugReport` field. Interactive mode is triggered when stdin is a TTY; non-interactive mode reads flags (`--repro-step` repeatable, `--expected`, `--actual`, etc.).
   - Files to create: `plugins/autonomous-dev/src/cli/commands/submit-bug.ts`
   - Acceptance criteria: Running `autonomous-dev request submit-bug --repo /path` in a terminal prompts for title, description, reproduction steps (multi-line), expected, actual, errors, severity. Pressing Ctrl-C cancels without writing state. Non-interactive mode (`echo "" | autonomous-dev request submit-bug --repo /path --title "X" --description "Y" --repro-step "1" --expected "Z" --actual "W"`) succeeds without prompting.
   - Estimated effort: 4h

4. **Validate bug submissions** -- Bug-typed requests must include a fully-populated `bug_context`. The CLI rejects submissions that pass `--type bug` without the required fields, with a message pointing the user to `submit-bug` for the interactive form.
   - Files to modify: `plugins/autonomous-dev/src/cli/commands/request-submit.ts`
   - Acceptance criteria: `autonomous-dev request submit --type bug --description "X"` (without `--bug-context-path` or interactive answers) exits 1 with `Error: bug-typed requests require bug context. Use 'autonomous-dev request submit-bug' or pass --bug-context-path <file>`. Same submission with `--bug-context-path /path/to/bug.json` (containing a valid BugReport JSON) succeeds.
   - Estimated effort: 2h

5. **Enforce request_type immutability** -- The request-edit / request-update subcommands must refuse any attempt to change `request_type` on an existing request. Other fields (priority, description) remain mutable.
   - Files to modify: `plugins/autonomous-dev/src/cli/commands/request-edit.ts` (or wherever edit lives)
   - Acceptance criteria: `autonomous-dev request edit REQ-id --type infra` (when REQ-id is currently bug) exits 1 with `Error: request_type is immutable after submission`. Editing other fields succeeds. Audit log records all rejected attempts.
   - Estimated effort: 1.5h

6. **Extend TDD-author prompt for bug context** -- Update `agents/tdd-author.md` per TDD §9.1 with a conditional block: when invoked with `--bug-context-path`, read the bug context, use the bug-specific prompt that requests sections for "Bug Analysis Summary", "Reproduction Analysis", "Technical Investigation", "Root Cause", "Fix Strategy", "Regression Tests" (per TDD §9.3 template). When the flag is absent, use the existing PRD-driven prompt.
   - Files to modify: `plugins/autonomous-dev/agents/tdd-author.md`
   - Files to create: `plugins/autonomous-dev/templates/tdd-bug.md`
   - Acceptance criteria: Agent prompt has a clearly delineated "BUG MODE" block. The bug template at `templates/tdd-bug.md` matches TDD §9.3 verbatim. Manual smoke test: invoke the agent with a sample state file containing `bug_context`, verify the agent produces a TDD that uses the bug template structure (not the PRD-driven structure).
   - Estimated effort: 3h

7. **Multi-channel parity (Claude App / Discord / Slack)** -- Add bug-submission slash commands to the three other channels: Claude App `/submit-bug` slash command (writes a stub markdown to the requests dir), Discord `/submit-bug` and `/hotfix` slash commands in the bot, Slack `/submit-bug` and `/hotfix` slash commands. Each channel routes through the same intake-router endpoint introduced in PLAN-015-2.
   - Files to create: `plugins/autonomous-dev/commands/submit-bug.md`, modifications to `plugins/autonomous-dev/src/services/discord-bot.ts`, `plugins/autonomous-dev/src/services/slack-app.ts`
   - Acceptance criteria: Each channel produces an identically-shaped state file once the request lands in the daemon's queue. A test fixture submits the same bug via all four channels and asserts the resulting state files are bit-identical except for `id`, `created_at`, and source-channel metadata.
   - Estimated effort: 4h

8. **Unit tests for CLI parsing and validation** -- `tests/cli/test-request-submit-types.test.ts` covering: all five types accepted, invalid type rejected with helpful message, default to feature, immutability enforcement, bug-context required for bug type. Coverage target ≥90% on the modified CLI commands.
   - Files to create: `plugins/autonomous-dev/tests/cli/test-request-submit-types.test.ts`
   - Acceptance criteria: All test cases pass. The bug-context-required error message is asserted character-for-character. Help-text test asserts all five types appear in `--help` output.
   - Estimated effort: 2.5h

9. **Unit tests for `submit-bug` interactive flow** -- `tests/cli/test-submit-bug-interactive.test.ts` using a mock TTY and a fixture-driven prompt sequence. Tests cover: complete flow, abort on Ctrl-C, validation rejection (e.g., empty repro_steps), non-interactive mode with all flags.
   - Files to create: `plugins/autonomous-dev/tests/cli/test-submit-bug-interactive.test.ts`
   - Acceptance criteria: All cases pass. Interactive flow is tested without a real TTY (uses `inquirer-test` or equivalent). Non-interactive flag mode is tested via the same harness with stdin set to closed.
   - Estimated effort: 3h

10. **E2E test: bug submission through TDD generation** -- `tests/e2e/test-bug-end-to-end.test.ts` that submits a bug via CLI, runs the supervisor for one iteration (in test mode), and asserts: the request advanced from `intake` to `tdd`, a TDD was written, the TDD's first heading is "Bug Analysis Summary" (proving the bug template was used). Captures cost in test mode (mock Claude responses).
    - Files to create: `plugins/autonomous-dev/tests/e2e/test-bug-end-to-end.test.ts`
    - Acceptance criteria: Test passes deterministically (Claude mock returns fixed bug-template TDD). Asserts the TDD starts with the bug-mode H1 section. Asserts no PRD file was written. Asserts `bug_context` survives intact in state.json after the iteration.
    - Estimated effort: 4h

## Dependencies & Integration Points

**Exposes to other plans:**
- The `--type` CLI flag pattern reusable by future request types (e.g., `compliance`, `documentation`).
- The `submit-bug` subcommand UX pattern for any future structured-submission subcommand.
- The `--bug-context-path` agent flag consumed by the TDD-author and any future agent that wants structured bug context (e.g., a future regression-test-author).
- Multi-channel parity test harness reused for any future request-type rollout across the four channels.

**Consumes from other plans:**
- **PLAN-018-1** (blocking): `RequestType` enum, `RequestStateV1_1` interface, JSON schemas. CLI uses these for type-checking submissions.
- **PLAN-018-2** (blocking): Daemon's `--bug-context-path` propagation in spawned sessions. Without this, the agent never sees the flag this plan adds.
- **PLAN-011-1** (existing on main): CLI dispatcher with `request submit` command this plan extends.
- **PLAN-011-2/3/4** (existing on main): Claude App / Discord / Slack adapters this plan extends with bug-submission slash commands.
- **PLAN-015-2** (open in PR #12): Intake-router HTTP client used by the multi-channel adapters.

## Testing Strategy

- **Unit tests (tasks 8, 9):** CLI parsing, validation, interactive flow. Coverage ≥90% on modified files.
- **E2E test (task 10):** Bug submission → daemon iteration → TDD generation. Uses mocked Claude responses to keep the test deterministic and free.
- **Schema validation:** AJV roundtrip for `BugReport` against the TDD §7.2 example.
- **Multi-channel parity test (task 7):** Submit the same bug via all four channels, assert resulting state files are equivalent.
- **Manual smoke (interactive):** Run `autonomous-dev request submit-bug` in a real terminal, walk through the prompts, verify the resulting state file matches what was entered.
- **Manual smoke (Discord/Slack):** Submit a bug via each channel, verify it appears in the daemon's queue with the right shape.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Interactive prompts add UX friction; users prefer copy-pasting an issue body | High | Medium -- low adoption of bug type | Provide a `--from-issue <github-url>` flag that fetches the issue via `gh` CLI and pre-populates the BugReport fields. Document the flag prominently in the help text. (Captured as a follow-up if not in initial scope.) |
| TDD-author agent ignores the `--bug-context-path` flag and produces a PRD-driven TDD anyway | Medium | High -- bug-typed requests get useless TDDs | The agent prompt has explicit BUG MODE instructions that require the agent to acknowledge bug context in its first response. Snapshot test in task 6 verifies the agent produces the bug template structure. If the agent fails the test, the fix is to strengthen the prompt — never to silently fall back. |
| Multi-channel parity drift over time (e.g., Discord adds a new field that CLI doesn't have) | High | Medium -- inconsistent UX | The shared intake-router is the source of truth. Any field added on one channel must update the BugReport schema first; the schema is the contract. PR template includes a "Did you update bug-report.json schema?" checkbox. |
| `inquirer` (or alternative) library API changes break the interactive flow | Low | Low -- pin major version | Pin to `inquirer@9.x`. CI smoke test exercises the interactive mock at least once per release. |
| Immutability enforcement breaks legitimate use cases (e.g., user wants to convert a feature request to a bug after realizing it was actually a defect) | Low | Low -- documented workaround exists | The workaround is to cancel the existing request and resubmit with the new type (per TDD-018 NG-04). Document this in the error message and in `docs/operators/request-types.md`. |
| Bug-template TDD diverges from the canonical TDD §9.3 specification | Medium | Low -- documents look weird | Template file at `templates/tdd-bug.md` is the canonical source; the agent prompt references it. Snapshot test of a sample bug TDD locks in the structure. |

## Definition of Done

- [ ] `BugReport` interface and JSON schema exist and validate the TDD §7.2 example
- [ ] `autonomous-dev request submit --type <X>` accepts all five types and rejects invalid ones with a helpful message
- [ ] `autonomous-dev request submit-bug` interactive flow works in a real terminal and validates each field
- [ ] Non-interactive flag mode for `submit-bug` works and is documented in `--help`
- [ ] Bug-typed submissions without bug context are rejected with a pointer to the right command
- [ ] `request_type` is immutable after submission (verified by edit-command test)
- [ ] TDD-author agent reads `bug_context` and uses the bug template when `--bug-context-path` is set
- [ ] Bug TDD template at `templates/tdd-bug.md` matches TDD §9.3 verbatim
- [ ] All four channels (CLI, Claude App, Discord, Slack) accept bug submissions and produce equivalent state files
- [ ] Unit tests pass with ≥90% coverage on modified CLI files
- [ ] E2E test demonstrates bug submission → daemon iteration → bug-template TDD end-to-end
- [ ] Snapshot tests lock in the bug-template structure and the agent prompt's BUG MODE block
- [ ] Operator documentation (`docs/operators/request-types.md`) explains the workflow and the cancel-and-resubmit pattern for type changes

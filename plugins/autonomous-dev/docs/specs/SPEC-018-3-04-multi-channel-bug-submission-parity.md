# SPEC-018-3-04: Multi-Channel Bug Submission Parity (CLI / Claude App / Discord / Slack)

## Metadata
- **Parent Plan**: PLAN-018-3
- **Tasks Covered**: Task 7 (multi-channel parity for bug submissions)
- **Estimated effort**: 4 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-018-3-04-multi-channel-bug-submission-parity.md`

## Description
Extend the three non-CLI submission channels — Claude App slash command, Discord bot slash command, Slack slash command — with bug-submission entry points that produce a `BugReport` payload identical in shape to what the CLI emits in SPEC-018-3-02. All four channels route through the same intake-router HTTP endpoint (introduced in PLAN-015-2), so the BugReport schema is the single contract; channel adapters are thin shells that gather fields from their native UI and POST a JSON body. Achieving parity here means an operator can file the same bug from any of the four channels and the daemon sees an indistinguishable request.

This spec deliberately focuses on the slash-command surface and adapter wiring. The deeper UI design for each channel (Discord modals, Slack Block Kit forms, Claude App prompts) is constrained only by the requirement that all `BugReport` required fields be collected before submission.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/commands/submit-bug.md` | Create | Claude App slash command stub; writes a markdown bug report to the requests dir |
| `plugins/autonomous-dev/src/services/discord-bot.ts` | Modify | Register `/submit-bug` and `/hotfix` slash commands; add modal handler |
| `plugins/autonomous-dev/src/services/slack-app.ts` | Modify | Register `/submit-bug` and `/hotfix` slash commands; add Block Kit modal handler |
| `plugins/autonomous-dev/src/adapters/intake-router-client.ts` | Modify | Accept `request_type` and `bug_context` in the payload it POSTs |
| `plugins/autonomous-dev/tests/parity/test-multi-channel-bug-parity.test.ts` | Create | Fixture-driven test asserting all four channels produce equivalent state files |

## Implementation Details

### Shared Contract

All four channels POST to the intake router with a body of shape:

```json
{
  "request_type": "bug",
  "description": "string (operator-supplied summary)",
  "bug_context": { /* BugReport — schemas/bug-report.json */ },
  "source_channel": "cli|claude-app|discord|slack",
  "priority": "high|normal|low"
}
```

The intake router (PLAN-015-2) is responsible for assigning `id`, `created_at`, and persisting state. Adapters MUST NOT generate IDs.

### Claude App: `commands/submit-bug.md`

Slash command markdown file consumed by Claude Code's command loader. Structure:

```markdown
---
name: submit-bug
description: Submit a bug report to autonomous-dev
---

# Submit Bug Report

Walk the user through collecting every field of `BugReport` (see `schemas/bug-report.json`).
For each required field, ask the user once. After all fields are collected, call:

`!autonomous-dev request submit-bug --repo $REPO --title "..." --description "..." --repro-step "..." [...]`

with all collected values. Do not proceed if any required field is missing.
```

The Claude App command runs `submit-bug` non-interactively from SPEC-018-3-02 — it does **not** open a TTY. Required fields collected by the prompt are passed as flags.

### Discord: `discord-bot.ts` Slash Commands

Register two slash commands in the existing client:

```typescript
const submitBug = new SlashCommandBuilder()
  .setName('submit-bug')
  .setDescription('Submit a bug report')
  .addStringOption(o => o.setName('title').setDescription('Bug title').setRequired(true));

const hotfix = new SlashCommandBuilder()
  .setName('hotfix')
  .setDescription('Submit a P0 bug requiring immediate attention')
  .addStringOption(o => o.setName('title').setDescription('Bug title').setRequired(true));
```

On invocation, present a Discord modal with text inputs for the remaining required fields:
- `description` (paragraph)
- `reproduction_steps` (paragraph; one step per line, parsed by `\n`)
- `expected_behavior` (paragraph)
- `actual_behavior` (paragraph)
- `error_messages` (paragraph; one per line, optional)
- `severity` (select: low/medium/high/critical; defaults to `high` for `/hotfix`)

`environment.os`, `environment.runtime`, `environment.version` default to `"discord-submitter"`, `"unknown"`, `"unknown"` if not collected; the user can override via a follow-up `/edit` command (out of scope here).

On modal submit, POST to the intake router with `source_channel: "discord"` and `priority: "high"` (for `/hotfix`) or `"normal"` (for `/submit-bug`).

### Slack: `slack-app.ts` Slash Commands

Mirror the Discord structure with Slack Block Kit:
- `/submit-bug` and `/hotfix` slash commands registered.
- On invocation, open a `views.open` modal with `plain_text_input` blocks for each field.
- Severity is a `static_select` block.
- On `view_submission`, POST to intake router with `source_channel: "slack"` and the right priority.

### Intake-Router Client (`intake-router-client.ts`)

Extend the existing `submit()` method's payload type:

```typescript
interface SubmitPayload {
  request_type: RequestType;            // new (was implicit 'feature')
  description: string;
  bug_context?: BugReport;              // new; required when request_type === 'bug'
  source_channel: SourceChannel;
  priority: Priority;
}
```

Client validates locally that `bug_context` is present when `request_type === 'bug'` and rejects with a clear error before the HTTP call (mirrors SPEC-018-3-02's CLI rejection).

### Parity Test Fixture (`test-multi-channel-bug-parity.test.ts`)

The test:
1. Defines a single `BugReport` fixture (`fixtures/bug-fixture.json`).
2. Mocks the intake router to capture every POST payload.
3. Invokes the bug-submission code path for each of the four channels with the same fixture.
4. Asserts the captured payloads are equal **except** for `id`, `created_at`, and `source_channel`.
5. Asserts the daemon-side state files written by the (mocked) intake router are bit-identical except for those same three fields.

## Acceptance Criteria

- [ ] `commands/submit-bug.md` exists, has YAML frontmatter with `name: submit-bug`, and references the CLI subcommand.
- [ ] Discord bot `/submit-bug` slash command is registered on bot startup (verified via Discord API mock).
- [ ] Discord bot `/hotfix` slash command is registered on bot startup.
- [ ] Discord modal collects all 7 required `BugReport` fields plus severity before submission.
- [ ] Discord submission POSTs to intake router with `source_channel: "discord"`.
- [ ] Slack app `/submit-bug` and `/hotfix` slash commands are registered (verified via Slack API mock).
- [ ] Slack Block Kit modal collects all 7 required fields plus severity.
- [ ] Slack submission POSTs to intake router with `source_channel: "slack"`.
- [ ] Intake-router client rejects `request_type: 'bug'` payloads with no `bug_context` before sending the HTTP request, with error: `Error: bug_context required when request_type is 'bug'`.
- [ ] Parity test runs the same `BugReport` fixture through all four channels and asserts payload equivalence (excluding `id`, `created_at`, `source_channel`).
- [ ] `/hotfix` produces a payload with `priority: "high"` regardless of channel.
- [ ] `/submit-bug` produces a payload with `priority: "normal"` regardless of channel (operator can override via channel-specific flag where supported).

## Dependencies

- **Blocking**: SPEC-018-3-01 (BugReport schema, RequestType enum).
- **Blocking**: SPEC-018-3-02 (CLI `submit-bug` non-interactive mode — Claude App invokes it).
- **Blocking**: PLAN-015-2 (intake-router HTTP endpoint).
- **Blocking**: PLAN-011-2 (Claude App command bridge).
- **Blocking**: PLAN-011-3 (Discord bot client + slash command infrastructure).
- **Blocking**: PLAN-011-4 (Slack app HTTP receiver + slash command infrastructure).
- Existing intake-router client.

## Notes

- The `bug_context` schema is the **only** contract between channels. If Discord adds a field its modal collects but Slack does not, the schema is still the truth — Slack's form is incomplete and must be updated. PR template includes a "Did you update bug-report.json schema?" checkbox per PLAN-018-3 risks table.
- Discord's modal field length limit (4000 chars per paragraph input) is more permissive than the schema's 2000-char limit on `expected_behavior`/`actual_behavior`; the schema wins.
- Slack's modal is opened via `views.open`; submission triggers `view_submission` event. Both must be wired in the existing handler dispatch table.
- Defaulting `environment.os` and friends to placeholder strings on Discord/Slack is a deliberate trade-off: collecting them through chat would balloon the modal. Operators are expected to refine via the future `/edit` command — for the initial release, the daemon accepts placeholder env values as long as the field is non-empty.
- The Claude App command writes its CLI invocation as a `!`-prefixed shell command; this assumes the operator has the `autonomous-dev` plugin installed locally. If not, the command falls back to writing a markdown file to the requests dir for the daemon to pick up via filesystem watch.
- The parity test does NOT exercise the actual Discord/Slack APIs — it mocks the SDK clients and asserts on the payloads handed to them. Live API smoke tests are manual and documented in PLAN-018-3 testing strategy.
